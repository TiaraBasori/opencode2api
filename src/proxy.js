import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { spawn } from 'child_process';
import { createOpencodeClient } from '@opencode-ai/sdk';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildExternalToolRegistry, findExternalToolByName } from './tool-runtime/registry.js';
import { buildToolExposure } from './tool-runtime/router.js';
import { evaluateToolPolicy } from './tool-runtime/policy.js';
import { validateToolCalls } from './tool-runtime/validator.js';
import {
    stripFunctionCallMarkup,
    parseExternalToolCallsFromText,
    createToolCallFilter,
    createExternalToolCallStreamParser
} from './tool-runtime/parser.js';

async function getImageDataUri(url) {
    if (url.startsWith('data:')) {
        return url;
    }
    
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`Invalid URL scheme: ${url}`);
    }
    
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const req = protocol.get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
            }
            
            const contentType = res.headers['content-type'] || 'image/jpeg';
            const chunks = [];
            
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    resolve(`data:${contentType};base64,${base64}`);
                } catch (e) {
                    reject(new Error(`Failed to encode image: ${e.message}`));
                }
            });
        });
        
        req.on('error', (e) => reject(e));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Image fetch timeout'));
        });
    });
}

// --- Mutex Logic with Timeout ---
const queue = [];
let isProcessing = false;

const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = 4000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 8000;

const OPENCODE_BASENAME = 'opencode';

function splitPathEnv() {
    const raw = process.env.PATH || '';
    return raw.split(path.delimiter).filter(Boolean);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushDir(list, dir) {
    if (!dir) return;
    if (!list.includes(dir)) list.push(dir);
}

function pushExistingDir(list, dir) {
    if (!dir) return;
    if (!fs.existsSync(dir)) return;
    if (!list.includes(dir)) list.push(dir);
}

function addVersionedDirs(list, baseDir, subpath) {
    if (!baseDir || !fs.existsSync(baseDir)) return;
    let entries = [];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    entries.forEach((entry) => {
        if (!entry.isDirectory()) return;
        const full = path.join(baseDir, entry.name, subpath || '');
        pushExistingDir(list, full);
    });
}

function prefixToBin(prefix) {
    if (!prefix) return null;
    return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

function getOpencodeCandidateNames() {
    if (process.platform === 'win32') {
        return [`${OPENCODE_BASENAME}.cmd`, `${OPENCODE_BASENAME}.exe`, `${OPENCODE_BASENAME}.bat`, OPENCODE_BASENAME];
    }
    return [OPENCODE_BASENAME];
}

function findExecutableInDirs(dirs, names) {
    for (const dir of dirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (fs.existsSync(full)) {
                return full;
            }
        }
    }
    return null;
}

function resolveOpencodePath(requestedPath) {
    const input = (requestedPath || '').trim();
    const names = getOpencodeCandidateNames();

    if (input) {
        const looksLikePath = path.isAbsolute(input) || input.includes('/') || input.includes('\\');
        if (looksLikePath) {
            if (fs.existsSync(input)) return { path: input, source: 'config' };
            const resolved = path.resolve(process.cwd(), input);
            if (fs.existsSync(resolved)) return { path: resolved, source: 'config' };
        }
    }

    const pathDirs = splitPathEnv();
    const fromPath = findExecutableInDirs(pathDirs, names);
    if (fromPath) return { path: fromPath, source: 'PATH' };

    const extraDirs = [];
    if (process.env.OPENCODE_HOME) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_HOME, 'bin'));
    }
    if (process.env.OPENCODE_DIR) {
        pushDir(extraDirs, path.join(process.env.OPENCODE_DIR, 'bin'));
    }
    pushDir(extraDirs, prefixToBin(process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX));
    pushDir(extraDirs, process.env.PNPM_HOME);
    if (process.env.YARN_GLOBAL_FOLDER) {
        pushDir(extraDirs, path.join(process.env.YARN_GLOBAL_FOLDER, 'bin'));
    }
    if (process.env.VOLTA_HOME) {
        pushDir(extraDirs, path.join(process.env.VOLTA_HOME, 'bin'));
    }
    pushDir(extraDirs, process.env.NVM_BIN);
    pushDir(extraDirs, path.dirname(process.execPath));

    const home = os.homedir();
    if (home) {
        pushDir(extraDirs, path.join(home, '.opencode', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.npm', 'bin'));
        pushDir(extraDirs, path.join(home, '.pnpm-global', 'bin'));
        pushDir(extraDirs, path.join(home, '.local', 'share', 'pnpm'));
        pushDir(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1', 'installations'));
        pushDir(extraDirs, path.join(home, '.asdf', 'shims'));
    }

    if (process.platform === 'win32') {
        pushDir(extraDirs, process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null);
        pushDir(extraDirs, process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : null);
        pushDir(extraDirs, process.env.NVM_HOME);
        pushDir(extraDirs, process.env.NVM_SYMLINK);
        pushDir(extraDirs, process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : null);
        pushDir(extraDirs, process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : null);
    } else {
        pushDir(extraDirs, '/usr/local/bin');
        pushDir(extraDirs, '/usr/bin');
        pushDir(extraDirs, '/bin');
        pushDir(extraDirs, '/opt/homebrew/bin');
        pushDir(extraDirs, '/snap/bin');
    }

    // nvm (unix) versions
    const nvmDir = process.env.NVM_DIR || (home ? path.join(home, '.nvm') : null);
    if (nvmDir) {
        addVersionedDirs(extraDirs, path.join(nvmDir, 'versions', 'node'), 'bin');
    }

    // asdf nodejs installs
    const asdfDir = process.env.ASDF_DATA_DIR || (home ? path.join(home, '.asdf') : null);
    if (asdfDir) {
        addVersionedDirs(extraDirs, path.join(asdfDir, 'installs', 'nodejs'), 'bin');
    }

    // fnm installs
    if (home) {
        addVersionedDirs(extraDirs, path.join(home, '.fnm', 'node-versions', 'v1'), 'installation' + path.sep + 'bin');
    }

    const fromExtras = findExecutableInDirs(extraDirs, names);
    if (fromExtras) return { path: fromExtras, source: 'known-locations' };

    return { path: null, source: 'not-found' };
}

function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const { task, timeout, resolve, reject } = queue.shift();
    let settled = false;
    const timeoutMs = timeout || 120000;
    const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
        .then(() => task())
        .then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(result);
        })
        .catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            reject(err);
        })
        .finally(() => {
            isProcessing = false;
            if (queue.length > 0) {
                queueMicrotask(processQueue);
            }
        });
}

function lock(task, timeout = 120000) {
    return new Promise((resolve, reject) => {
        queue.push({ task, timeout, resolve, reject });
        processQueue();
    });
}

/**
 * Robust Health Check Helper
 */
function buildBackendAuthHeaders(password = '') {
    if (!password) return undefined;
    const token = Buffer.from(`opencode:${password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
}

function checkHealth(serverUrl, password = '') {
    return new Promise((resolve, reject) => {
        const headers = buildBackendAuthHeaders(password);
        const options = headers ? { headers } : undefined;
        const req = http.get(`${serverUrl}/health`, options, (res) => {
            if (res.statusCode === 200) resolve(true);
            else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

/**
 * Cleanup temporary directories
 */
function cleanupTempDirs() {
    // Only cleanup jail directories on non-Windows platforms
    // On Windows, we don't use isolated jail to avoid path issues
    if (process.platform === 'win32') return;

    const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail');
    try {
        if (fs.existsSync(jailRoot)) {
            fs.rmSync(jailRoot, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('[Cleanup] Failed to remove temp dirs:', e.message);
    }
}

// Register cleanup on exit
process.on('exit', cleanupTempDirs);

// Handle signals - Unix-like systems
if (process.platform !== 'win32') {
    process.on('SIGINT', () => {
        console.log('\n[Shutdown] Received SIGINT, cleaning up...');
        cleanupTempDirs();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        console.log('\n[Shutdown] Received SIGTERM, cleaning up...');
        cleanupTempDirs();
        process.exit(0);
    });
}
// Note: Windows signal handling is limited, cleanup is handled via process.on('exit')

/**
 * Create Express app with proper configuration
 */
export function createApp(config) {
    const {
        API_KEY,
        OPENCODE_SERVER_URL,
        OPENCODE_SERVER_PASSWORD,
        REQUEST_TIMEOUT_MS,
        DEBUG,
        DISABLE_TOOLS,
        INTERNAL_WEB_FETCH_ENABLED,
        INTERNAL_ALLOWED_TOOLS = [],
        INTERNAL_TOOL_METRICS_ENABLED = true,
        INTERNAL_TOOL_DISCOVERY_FIXTURE = [],
        PROMPT_MODE,
        OMIT_SYSTEM_PROMPT,
        AUTO_CLEANUP_CONVERSATIONS,
        CLEANUP_INTERVAL_MS,
        CLEANUP_MAX_AGE_MS,
        OPENCODE_HOME_BASE
    } = config;

    const app = express();
    app.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }));
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

    const clientHeaders = buildBackendAuthHeaders(OPENCODE_SERVER_PASSWORD);
    const client = createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL, headers: clientHeaders });

    // Auth middleware
    app.use((req, res, next) => {
        if (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/') return next();
        if (API_KEY && API_KEY.trim() !== '') {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
                return res.status(401).json({ error: { message: 'Unauthorized' } });
            }
        }
        next();
    });

    const getProvidersList = async () => {
        const providersRes = await client.config.providers();
        const providersRaw = providersRes.data?.providers || [];
        return Array.isArray(providersRaw)
            ? providersRaw
            : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));
    };

    const buildModelsList = (providersList) => {
        const models = [];
        providersList.forEach((p) => {
            if (p.models) {
                Object.entries(p.models).forEach(([mId, mData]) => {
                    models.push({
                        id: `${p.id}/${mId}`,
                        name: typeof mData === 'object' ? (mData.name || mData.label || mId) : mId,
                        object: 'model',
                        created: (mData && mData.release_date)
                            ? Math.floor(new Date(mData.release_date).getTime() / 1000)
                            : 1704067200,
                        owned_by: p.id
                    });
                });
            }
        });
        return models;
    };

    const normalizeModelID = (modelID) => {
        if (!modelID || typeof modelID !== 'string') return modelID;
        return modelID
            .replace(/^gpt(\d)/i, 'gpt-$1')
            .replace(/^o(\d)/i, 'o$1');
    };

    const resolveRequestedModel = async (requestedModel) => {
        const providersList = await getProvidersList();
        const models = buildModelsList(providersList);
        const fallbackModel = models[0]?.id || 'opencode/kimi-k2.5-free';
        let [providerID, modelID] = (requestedModel || fallbackModel).split('/');
        if (!modelID) {
            modelID = providerID;
            providerID = 'opencode';
        }
        const originalModelID = modelID;
        const normalizedModelID = normalizeModelID(modelID);
        const candidateModelIDs = [...new Set([modelID, normalizedModelID].filter(Boolean))];
        const exact = models.find((m) => candidateModelIDs.some((candidate) => m.id === `${providerID}/${candidate}`));
        if (exact) {
            const [, resolvedModelID] = exact.id.split('/');
            return {
                providerID,
                modelID: resolvedModelID,
                models,
                resolved: exact.id,
                ...(resolvedModelID !== originalModelID && { aliasFrom: `${providerID}/${originalModelID}` })
            };
        }
        const sameProvider = models.filter((m) => m.owned_by === providerID);
        const suffixMatch = sameProvider.find((m) => candidateModelIDs.some((candidate) => m.id.endsWith(`/${candidate}-free`) || m.id.endsWith(`/${candidate}`)));
        if (suffixMatch) {
            const [, resolvedModelID] = suffixMatch.id.split('/');
            return { providerID, modelID: resolvedModelID, models, resolved: suffixMatch.id, aliasFrom: `${providerID}/${originalModelID}` };
        }
        const error = new Error(`Model not found: ${providerID}/${modelID}`);
        error.statusCode = 400;
        error.code = 'model_not_found';
        error.availableModels = models.map((m) => m.id);
        throw error;
    };

    // Models endpoint
    app.get('/v1/models', async (_req, res) => {
        try {
            const models = buildModelsList(await getProvidersList());
            res.json({ object: 'list', data: models });
        } catch (error) {
            console.error('[Proxy] Model Fetch Error:', error.message);
            res.json({ object: 'list', data: [{ id: 'opencode/kimi-k2.5-free', object: 'model' }] });
        }
    });

    const logDebug = (...args) => {
        if (DEBUG) {
            console.log('[Proxy][Debug]', ...args);
        }
    };

    const TOOL_MODE = Object.freeze({
        DISABLED: 'disabled',
        EXTERNAL_BRIDGE: 'external-bridge',
        INTERNAL_ALLOWLIST: 'internal-allowlist'
    });

    const TOOL_GUARD_MESSAGE = 'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';
    const EXTERNAL_TOOL_GUARD_MESSAGE = 'OpenCode internal tools remain disabled. If an external tool contract is present, use only that contract and never call or mention OpenCode internal tools.';

    const normalizeConfiguredToolNames = (entries = []) => [...new Set(
        entries
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
    )];

    const getEffectiveInternalAllowedTools = () => {
        const configuredTools = normalizeConfiguredToolNames(INTERNAL_ALLOWED_TOOLS);
        if (configuredTools.length > 0) return configuredTools;
        if (INTERNAL_WEB_FETCH_ENABLED) return ['web_fetch'];
        return [];
    };

    const INTERNAL_ALLOWED_TOOL_NAMES = getEffectiveInternalAllowedTools();
    const INTERNAL_ALLOWLIST_PROMPT = INTERNAL_ALLOWED_TOOL_NAMES.length > 0
        ? `OpenCode internal tool access is limited for this turn. You may use only these built-in tools when truly required: ${INTERNAL_ALLOWED_TOOL_NAMES.join(', ')}. Do not mention or attempt any other internal tools. If the required internal tools are unavailable, answer directly and say live tool access is unavailable.`
        : 'OpenCode internal tools are unavailable for this turn. Answer directly without attempting tool usage.';

    const buildSystemPrompt = (systemMsg, reasoningEffort = null, toolMode = TOOL_MODE.DISABLED) => {
        const parts = [];
        if (!OMIT_SYSTEM_PROMPT && systemMsg && systemMsg.trim()) {
            parts.push(systemMsg.trim());
        }
        if (reasoningEffort && reasoningEffort !== 'none') {
            parts.push(`[Reasoning Effort: ${reasoningEffort}]`);
        }
        if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            parts.push(INTERNAL_ALLOWLIST_PROMPT);
        } else if (DISABLE_TOOLS && PROMPT_MODE !== 'plugin-inject') {
            parts.push(toolMode === TOOL_MODE.EXTERNAL_BRIDGE ? EXTERNAL_TOOL_GUARD_MESSAGE : TOOL_GUARD_MESSAGE);
        }
        const finalPrompt = parts.join('\n\n').trim();
        return finalPrompt || undefined;
    };

    const normalizeReasoningEffort = (value, fallback = null) => {
        if (!value || typeof value !== 'string') return fallback;
        const effortMap = {
            'none': 'none',
            'minimal': 'none',
            'low': 'low',
            'medium': 'medium',
            'high': 'high',
            'xhigh': 'high'
        };
        return effortMap[value.toLowerCase()] || fallback;
    };

    const stripFunctionCalls = (text, trim = true) => {
        if (!DISABLE_TOOLS || !text) return text;
        return stripFunctionCallMarkup(text, trim);
    };

    const normalizeTextContent = (content) => {

        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') return part?.text || '';
                return '';
            }).join('');
        }
        if (content && typeof content.text === 'string') return content.text;
        if (content === null || content === undefined) return '';
        if (typeof content === 'number' || typeof content === 'boolean') return String(content);
        return '';
    };

    const normalizeToolArguments = (args) => {
        if (typeof args === 'string') return args;
        if (args === undefined) return '{}';
        try {
            return JSON.stringify(args);
        } catch (e) {
            return '{}';
        }
    };

    const normalizeToolResultContent = (content) => {
        const text = normalizeTextContent(content);
        if (text) return text;
        if (content === null || content === undefined) return '';
        if (typeof content === 'object') {
            try {
                return JSON.stringify(content);
            } catch (e) {
                return '';
            }
        }
        return String(content);
    };


    const createExternalToolContext = (tools, toolChoice) => {
        const registry = buildExternalToolRegistry(tools);
        const exposure = buildToolExposure(registry, toolChoice);
        return {
            registry,
            exposure,
            toolChoice: exposure.toolChoice,
            prompt: exposure.prompt
        };
    };

    const resolveToolMode = (tools = []) => {
        if (Array.isArray(tools) && tools.length > 0) {
            return TOOL_MODE.EXTERNAL_BRIDGE;
        }
        if (INTERNAL_ALLOWED_TOOL_NAMES.length > 0) {
            return TOOL_MODE.INTERNAL_ALLOWLIST;
        }
        return TOOL_MODE.DISABLED;
    };

    const createRequestToolContext = (tools, toolChoice) => {
        const mode = resolveToolMode(tools);
        const external = mode === TOOL_MODE.EXTERNAL_BRIDGE
            ? createExternalToolContext(tools, toolChoice)
            : {
                registry: [],
                exposure: { tools: [], toolChoice: { mode: 'auto', requiredTool: null }, prompt: '' },
                toolChoice: { mode: 'auto', requiredTool: null },
                prompt: ''
            };

        return {
            mode,
            external,
            internal: {
                allowedToolNames: INTERNAL_ALLOWED_TOOL_NAMES,
                metricsEnabled: INTERNAL_TOOL_METRICS_ENABLED
            }
        };
    };

    const finalizeValidatedToolCalls = (parsedToolCalls, registry) => {
        const { validCalls, invalidCalls } = validateToolCalls(parsedToolCalls, registry);
        invalidCalls.forEach(({ call, validation }) => {
            logDebug('Rejected external tool call', {
                tool: call?.function?.name,
                errors: validation?.errors?.map((error) => error.message)
            });
        });
        const allowedCalls = [];
        validCalls.forEach((toolCall) => {
            const policyDecision = evaluateToolPolicy(toolCall.tool, toolCall.validatedArguments, { config });
            if (policyDecision.status === 'allow') {
                allowedCalls.push(toolCall);
                return;
            }
            logDebug('Blocked external tool call', {
                tool: toolCall.function.name,
                status: policyDecision.status,
                reason: policyDecision.reason
            });
        });
        return { validCalls: allowedCalls, invalidCalls };
    };

    const toPublicToolCalls = (toolCalls) => {
        if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
        return toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
            }
        }));
    };

    const createForcedToolCallRequester = ({
        mode,
        sessionId,
        systemWithGuard,
        requiredTool,
        providerID,
        modelID,
        toolOverrides,
        requestTimeoutMs,
        forbidThinkBlock = false
    }) => async () => {
        if (mode !== 'required') return null;
        if (!requiredTool) return null;
        const forcedPromptParams = {
            path: { id: sessionId },
            body: {
                model: { providerID, modelID },
                ...(systemWithGuard ? { system: systemWithGuard } : {}),
                parts: [{
                    type: 'text',
                    text: `SYSTEM: Your previous reply did not emit the required external tool call. Reply now with ONLY <function_calls>{\"name\":\"${requiredTool}\",\"arguments\":{}}</function_calls> or an array inside <function_calls>...</function_calls>. Do not output any prose, reasoning, markdown${forbidThinkBlock ? ', or <think> block' : ''}. Infer the correct arguments from the conversation so far.`
                }]
            }
        };
        if (toolOverrides && Object.keys(toolOverrides).length > 0) {
            forcedPromptParams.body.tools = toolOverrides;
        }
        await promptWithTimeout(forcedPromptParams, requestTimeoutMs);
        return pollForAssistantResponse(sessionId, requestTimeoutMs);
    };

    const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
    let cachedToolIds = null;
    let cachedToolIdsAt = 0;
    let cachedDisabledToolOverrides = null;
    let cachedDisabledToolOverridesAt = 0;
    const internalToolMetrics = {
        externalBridgeRequests: 0,
        internalAllowlistRequests: 0,
        disabledRequests: 0,
        discoveryFailures: 0,
        fallbackToDisabled: 0
    };

    const logInternalToolEvent = (event, details = {}) => {
        if (!DEBUG && !INTERNAL_TOOL_METRICS_ENABLED) return;
        const payload = {
            event,
            ...details
        };
        if (INTERNAL_TOOL_METRICS_ENABLED) {
            payload.metrics = { ...internalToolMetrics };
        }
        logDebug('Internal tool event', payload);
    };

    const trackToolMode = (toolMode, details = {}) => {
        if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE) {
            internalToolMetrics.externalBridgeRequests += 1;
        } else if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            internalToolMetrics.internalAllowlistRequests += 1;
        } else {
            internalToolMetrics.disabledRequests += 1;
        }
        logInternalToolEvent('tool-mode-selected', {
            toolMode,
            ...details
        });
    };

    const getBackendToolIds = async () => {
        if (cachedToolIds && Date.now() - cachedToolIdsAt < TOOL_IDS_CACHE_MS) {
            return cachedToolIds;
        }
        const fixtureIds = normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE);
        if (fixtureIds.length > 0) {
            cachedToolIds = fixtureIds;
            cachedToolIdsAt = Date.now();
            logInternalToolEvent('backend-tool-ids-fixture-loaded', { count: fixtureIds.length, fixtureIds });
            return fixtureIds;
        }
        try {
            const idsRes = await client.tool.ids();
            const ids = Array.isArray(idsRes?.data)
                ? idsRes.data
                : Array.isArray(idsRes)
                    ? idsRes
                    : [];
            cachedToolIds = ids;
            cachedToolIdsAt = Date.now();
            logInternalToolEvent('backend-tool-ids-loaded', { count: ids.length });
            return ids;
        } catch (e) {
            internalToolMetrics.discoveryFailures += 1;
            logInternalToolEvent('backend-tool-ids-failed', { error: e.message });
            return null;
        }
    };

    const buildDisabledToolOverrides = (ids = []) => {
        const overrides = {};
        ids.forEach((id) => {
            overrides[id] = false;
        });
        return overrides;
    };

    const normalizeBackendToolIds = (ids = []) => ids.filter((id) => typeof id === 'string' && id.trim());

    const matchesAllowedToolName = (toolId, allowedToolName) => {
        if (!toolId || !allowedToolName) return false;
        return toolId === allowedToolName || toolId.endsWith(`.${allowedToolName}`) || toolId.endsWith(`/${allowedToolName}`);
    };

    const resolveInternalAllowedToolIds = (ids = [], allowedToolNames = []) => {
        const normalizedIds = normalizeBackendToolIds(ids);
        const normalizedAllowedNames = normalizeConfiguredToolNames(allowedToolNames);
        const matchedToolIds = new Set();
        const unmatchedAllowedNames = [];

        normalizedAllowedNames.forEach((allowedToolName) => {
            const matches = normalizedIds.filter((toolId) => matchesAllowedToolName(toolId, allowedToolName));
            if (matches.length === 0) {
                unmatchedAllowedNames.push(allowedToolName);
                return;
            }
            matches.forEach((match) => matchedToolIds.add(match));
        });

        return {
            normalizedIds,
            normalizedAllowedNames,
            matchedToolIds: [...matchedToolIds],
            unmatchedAllowedNames
        };
    };

    const getDisabledToolOverrides = async () => {
        if (!DISABLE_TOOLS) return null;
        if (cachedDisabledToolOverrides && Date.now() - cachedDisabledToolOverridesAt < TOOL_IDS_CACHE_MS) {
            return cachedDisabledToolOverrides;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids)) return null;
        const overrides = buildDisabledToolOverrides(ids);
        cachedDisabledToolOverrides = overrides;
        cachedDisabledToolOverridesAt = Date.now();
        logInternalToolEvent('disabled-tool-overrides-loaded', { count: ids.length });
        return overrides;
    };

    const getToolOverridesForMode = async (toolMode, internalContext = {}) => {
        if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE || toolMode === TOOL_MODE.DISABLED) {
            if (toolMode === TOOL_MODE.DISABLED) {
                logInternalToolEvent('internal-tools-disabled', {
                    configuredAllowlist: internalContext.allowedToolNames || INTERNAL_ALLOWED_TOOL_NAMES
                });
            }
            return getDisabledToolOverrides();
        }
        if (toolMode !== TOOL_MODE.INTERNAL_ALLOWLIST) {
            return null;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids) || ids.length === 0) return null;
        const resolution = resolveInternalAllowedToolIds(ids, internalContext.allowedToolNames || INTERNAL_ALLOWED_TOOL_NAMES);
        const { normalizedIds, normalizedAllowedNames, matchedToolIds, unmatchedAllowedNames } = resolution;
        if (matchedToolIds.length === 0) {
            internalToolMetrics.fallbackToDisabled += 1;
            logInternalToolEvent('internal-allowlist-unavailable', {
                configuredAllowlist: normalizedAllowedNames,
                availableToolIds: normalizedIds,
                unmatchedAllowlist: unmatchedAllowedNames,
                fallback: 'disabled'
            });
            return buildDisabledToolOverrides(normalizedIds);
        }
        const overrides = {};
        normalizedIds.forEach((id) => {
            overrides[id] = matchedToolIds.includes(id);
        });
        logInternalToolEvent('internal-allowlist-overrides-loaded', {
            configuredAllowlist: normalizedAllowedNames,
            matchedToolIds,
            unmatchedAllowlist: unmatchedAllowedNames,
            availableToolIdsCount: normalizedIds.length
        });
        return overrides;
    };

    async function promptWithTimeout(promptParams, timeoutMs) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
        });
        return Promise.race([client.session.prompt(promptParams), timeoutPromise]);
    }

    const getCleanupRoots = () => {
        const roots = [];
        const add = (dir) => {
            if (!dir) return;
            if (!roots.includes(dir)) roots.push(dir);
        };
        add(OPENCODE_HOME_BASE ? path.join(OPENCODE_HOME_BASE, '.local', 'share', 'opencode', 'storage') : null);
        add('/home/node/.local/share/opencode/storage');
        return roots;
    };

    const cleanupConversationFiles = async () => {
        if (!AUTO_CLEANUP_CONVERSATIONS) return { removed: 0, scanned: 0 };
        const now = Date.now();
        let removed = 0;
        let scanned = 0;
        for (const storageRoot of getCleanupRoots()) {
            for (const sub of ['message', 'session']) {
                const dir = path.join(storageRoot, sub);
                if (!fs.existsSync(dir)) continue;
                let entries = [];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    continue;
                }
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    let stat;
                    try {
                        stat = fs.statSync(full);
                    } catch (e) {
                        continue;
                    }
                    scanned += 1;
                    const mtime = stat.mtimeMs || stat.ctimeMs || now;
                    if (now - mtime < CLEANUP_MAX_AGE_MS) continue;
                    try {
                        fs.rmSync(full, { recursive: true, force: true });
                        removed += 1;
                    } catch (e) {
                        logDebug('Cleanup remove failed', { full, error: e.message });
                    }
                }
            }
        }
        if (removed > 0) {
            logDebug('Conversation cleanup completed', { removed, scanned, maxAgeMs: CLEANUP_MAX_AGE_MS });
        }
        return { removed, scanned };
    };

    if (AUTO_CLEANUP_CONVERSATIONS) {
        setTimeout(() => {
            cleanupConversationFiles().catch((e) => logDebug('Cleanup run failed', { error: e.message }));
        }, 3000);
        const cleanupTimer = setInterval(() => {
            cleanupConversationFiles().catch((e) => logDebug('Cleanup run failed', { error: e.message }));
        }, CLEANUP_INTERVAL_MS);
        if (cleanupTimer.unref) cleanupTimer.unref();
    }

    function extractFromParts(parts) {
        if (!Array.isArray(parts)) return { content: '', reasoning: '' };
        const content = parts.filter(p => p.type === 'text').map(p => p.text).join('');
        const reasoning = parts.filter(p => p.type === 'reasoning').map(p => p.text).join('');
        return { content, reasoning };
    }

    async function pollForAssistantResponse(sessionId, timeoutMs, intervalMs = DEFAULT_POLL_INTERVAL_MS) {
        const pollStart = Date.now();
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const messagesRes = await client.session.messages({ path: { id: sessionId } });
            const messages = messagesRes?.data || messagesRes || [];
            if (Array.isArray(messages) && messages.length) {
                for (let i = messages.length - 1; i >= 0; i -= 1) {
                    const entry = messages[i];
                    const info = entry?.info;
                    if (info?.role !== 'assistant') continue;
                    const { content, reasoning } = extractFromParts(entry?.parts || []);
                    const error = info?.error || null;
                    const done = Boolean(info.finish || info.time?.completed || error);
                    if (done || content || reasoning) {
                        if (error) {
                            console.error('[Proxy] OpenCode assistant error:', error);
                        }
                        logDebug('Polling completed', {
                            sessionId,
                            ms: Date.now() - pollStart,
                            done,
                            contentLen: content.length,
                            reasoningLen: reasoning.length,
                            error: error ? error.name : null
                        });
                        return { content, reasoning, error };
                    }
                }
            }
            await sleep(intervalMs);
        }
        logDebug('Polling timeout', { sessionId, ms: Date.now() - pollStart });
        throw new Error(`Request timeout after ${timeoutMs}ms`);
    }

    async function collectFromEvents(sessionId, timeoutMs, onDelta, firstDeltaTimeoutMs, idleTimeoutMs) {
        const controller = new AbortController();
        const eventStreamResult = await client.event.subscribe({ signal: controller.signal });
        const eventStream = eventStreamResult.stream;
        let finished = false;
        let content = '';
        let reasoning = '';
        let receivedDelta = false;
        let deltaChars = 0;
        let firstDeltaAt = null;
        const startedAt = Date.now();

        const finishPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                if (finished) return;
                finished = true;
                controller.abort();
                reject(new Error(`Request timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            const firstDeltaTimer = firstDeltaTimeoutMs
                ? setTimeout(() => {
                    if (finished || receivedDelta) return;
                    finished = true;
                    controller.abort();
                    logDebug('No event data received', { sessionId, ms: Date.now() - startedAt });
                    resolve({ content: '', reasoning: '', noData: true });
                }, firstDeltaTimeoutMs)
                : null;

            let idleTimer = null;
            const scheduleIdleTimer = () => {
                if (!idleTimeoutMs) return;
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (finished) return;
                    finished = true;
                    controller.abort();
                    logDebug('Event idle timeout', {
                        sessionId,
                        ms: Date.now() - startedAt,
                        deltaChars
                    });
                    resolve({
                        content,
                        reasoning,
                        idleTimeout: true,
                        receivedDelta
                    });
                }, idleTimeoutMs);
            };

            (async () => {
                try {
                    for await (const event of eventStream) {
                        if (event.type === 'message.part.updated' && event.properties.part.sessionID === sessionId) {
                            const { part, delta } = event.properties;
                            if (delta) {
                                receivedDelta = true;
                                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                scheduleIdleTimer();
                                if (!firstDeltaAt) {
                                    firstDeltaAt = Date.now();
                                    logDebug('SSE first delta', {
                                        sessionId,
                                        ms: firstDeltaAt - startedAt,
                                        type: part.type
                                    });
                                }
                                if (part.type === 'reasoning') {
                                    reasoning += delta;
                                    if (onDelta) onDelta(delta, true);
                                } else {
                                    content += delta;
                                    if (onDelta) onDelta(delta, false);
                                }
                                deltaChars += delta.length;
                            }
                        }
                        if (event.type === 'message.updated' &&
                            event.properties.info.sessionID === sessionId &&
                            event.properties.info.finish === 'stop') {
                            if (!finished) {
                                finished = true;
                                clearTimeout(timeoutId);
                                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                if (idleTimer) clearTimeout(idleTimer);
                                logDebug('SSE completed', {
                                    sessionId,
                                    ms: Date.now() - startedAt,
                                    deltaChars
                                });
                                resolve({ content, reasoning });
                            }
                            break;
                        }
                    }
                } catch (e) {
                    if (!finished) {
                        finished = true;
                        clearTimeout(timeoutId);
                        if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                        if (idleTimer) clearTimeout(idleTimer);
                        reject(e);
                    }
                }
            })();
        });

        try {
            return await finishPromise;
        } finally {
            controller.abort();
        }
    }

    // Chat completions endpoint
    app.post('/v1/chat/completions', async (req, res) => {
        try {
            await lock(async () => {
                let sessionId = null;
                let eventStream = null;
                let stream = false;
                let pID = 'opencode';
                let mID = 'kimi-k2.5-free';
                let id = `chatcmpl-${Date.now()}`;
                let insideReasoning = false;
                let keepaliveInterval = null;

                try {
                    const { messages, model, tools = [], tool_choice, stream: requestStream, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stop, reasoning_effort, reasoning } = req.body;
                    stream = Boolean(requestStream);
                    if (!messages || !Array.isArray(messages) || messages.length === 0) {
                        return res.status(400).json({ error: { message: 'messages array is required' } });
                    }

                    const reasoningLevel = normalizeReasoningEffort(
                        reasoning_effort || reasoning?.effort,
                        null
                    );

                    const requestParams = {
                        temperature: typeof temperature === 'number' ? temperature : 0.7,
                        max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
                        top_p: typeof top_p === 'number' ? top_p : 1.0,
                        frequency_penalty: typeof frequency_penalty === 'number' ? frequency_penalty : 0,
                        presence_penalty: typeof presence_penalty === 'number' ? presence_penalty : 0,
                        stop: Array.isArray(stop) ? stop : (stop ? [stop] : null),
                        reasoning_effort: reasoningLevel
                    };

                    logDebug('Request params', { temperature: requestParams.temperature, max_tokens: requestParams.max_tokens, top_p: requestParams.top_p, reasoning_effort: reasoningLevel });

                    const resolvedModel = await resolveRequestedModel(model);
                    pID = resolvedModel.providerID;
                    mID = resolvedModel.modelID;
                    if (resolvedModel.aliasFrom) {
                        logDebug('Resolved model alias', { from: resolvedModel.aliasFrom, to: resolvedModel.resolved });
                    }

                    const normalizeMessageContent = (content) => normalizeTextContent(content);

                    const buildPromptParts = async (rawMessages, externalToolRegistry = []) => {
                        const parts = [];
                        const systemChunks = [];
                        const userContents = [];
                        const assistantToolCalls = new Map();
                        const formatRoleLine = (role, name, text) => {
                            const roleLabel = role.toUpperCase();
                            const nameSuffix = name ? `(${name})` : '';
                            return `${roleLabel}${nameSuffix}: ${text}`;
                        };
                        
                        for (const m of rawMessages) {
                            const role = (m?.role || 'user').toLowerCase();
                            const content = m?.content;
                            
                            if (role === 'system') {
                                const text = normalizeMessageContent(content);
                                if (text) systemChunks.push(text);
                                continue;
                            }
                            
                            if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
                                const serializedToolCalls = m.tool_calls.map((toolCall, index) => ({
                                    id: toolCall?.id || `call_${index + 1}`,
                                    name: findExternalToolByName(externalToolRegistry, toolCall?.function?.name || toolCall?.name)?.namespacedName || toolCall?.function?.name || toolCall?.name,
                                    arguments: normalizeToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments)
                                })).filter((toolCall) => toolCall.name);
                                if (serializedToolCalls.length) {
                                    serializedToolCalls.forEach((toolCall) => {
                                        assistantToolCalls.set(toolCall.id, toolCall.name);
                                    });
                                    parts.push({
                                        type: 'text',
                                        text: `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`
                                    });
                                }
                            }

                            if (role === 'tool') {
                                const text = normalizeMessageContent(content);
                                if (text) {
                                    const mappedTool = findExternalToolByName(externalToolRegistry, m?.name)
                                        || findExternalToolByName(externalToolRegistry, assistantToolCalls.get(m?.tool_call_id));
                                    const toolName = mappedTool?.namespacedName || assistantToolCalls.get(m?.tool_call_id) || m?.name || `${EXTERNAL_TOOL_PREFIX}unknown`;
                                    const toolCallId = m?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                                    parts.push({
                                        type: 'text',
                                        text: `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`
                                    });
                                }
                                continue;
                            }

                            if (!content) continue;

                            if (typeof content === 'string') {
                                if (role === 'user') userContents.push(content);
                                parts.push({
                                    type: 'text',
                                    text: formatRoleLine(role, m?.name, content)
                                });
                            } else if (Array.isArray(content)) {
                                for (const part of content) {
                                    if (!part) continue;
                                    
                                    if (part.type === 'text') {
                                        const text = part.text || '';
                                        if (role === 'user') userContents.push(text);
                                        parts.push({
                                            type: 'text',
                                            text: formatRoleLine(role, m?.name, text)
                                        });
                                    } else if (part.type === 'image_url') {
                                        const imageUrl = typeof part.image_url === 'string' 
                                            ? part.image_url 
                                            : part.image_url?.url;
                                        if (imageUrl) {
                                            try {
                                                const dataUri = await getImageDataUri(imageUrl);
                                                const mime = dataUri.split(';')[0].split(':')[1];
                                                parts.push({
                                                    type: 'file',
                                                    mime: mime,
                                                    url: dataUri,
                                                    filename: 'image'
                                                });
                                            } catch (imgErr) {
                                                console.warn('[Proxy] Skipping image due to error:', imgErr.message);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        return {
                            parts,
                            system: systemChunks.join('\n\n'),
                            fullPromptText: parts.map(p => p.text).join('\n\n'),
                            lastUserMsg: userContents[userContents.length - 1] || ''
                        };
                    };

                    const requestToolContext = createRequestToolContext(tools, tool_choice);
                    const toolMode = requestToolContext.mode;
                    const externalToolContext = requestToolContext.external;
                    const externalToolRegistry = externalToolContext.registry;
                    const externalToolChoice = externalToolContext.toolChoice;
                    const internalToolContext = requestToolContext.internal;
                    trackToolMode(toolMode, {
                        configuredAllowlist: internalToolContext.allowedToolNames,
                        route: '/v1/chat/completions'
                    });
                    const { parts, system: systemMsg, fullPromptText, lastUserMsg } = await buildPromptParts(messages, externalToolRegistry);
                    const systemWithGuard = buildSystemPrompt(
                        [systemMsg, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                        requestParams.reasoning_effort,
                        toolMode
                    );
                    if (!parts.length) {
                        return res.status(400).json({ error: { message: 'messages must include at least one non-system text message' } });
                    }
                    logDebug('Request start', {
                        model: `${pID}/${mID}`,
                        stream: Boolean(stream),
                        userMessages: messages.length,
                        system: Boolean(systemMsg),
                        lastUserLength: lastUserMsg?.length || 0,
                        parts: parts.length,
                        disableTools: DISABLE_TOOLS,
                        toolMode,
                        internalAllowedTools: internalToolContext.allowedToolNames
                    });

                    // Ensure backend is running
                    await ensureBackend(config);

                    // Set active model
                    try {
                        await client.config.update({
                            body: {
                                activeModel: { providerID: pID, modelID: mID }
                            }
                        });
                    } catch (confError) {
                        logDebug('Failed to set active model:', confError.message);
                    }

                    // Create session
                    const sessionRes = await client.session.create();
                    sessionId = sessionRes.data?.id;
                    if (!sessionId) throw new Error('Failed to create OpenCode session');
                    logDebug('Session created', { sessionId });

                    id = `chatcmpl-${Date.now()}`;
                    insideReasoning = false;
                    keepaliveInterval = null;
                    let completionTokens = 0;
                    let reasoningTokens = 0;

                    const promptParams = {
                        path: { id: sessionId },
                        body: {
                            model: { providerID: pID, modelID: mID },
                            system: systemWithGuard,
                            parts: parts,
                            ...(requestParams.max_tokens && { max_tokens: requestParams.max_tokens }),
                            ...(requestParams.temperature !== undefined && { temperature: requestParams.temperature }),
                            ...(requestParams.top_p !== undefined && { top_p: requestParams.top_p }),
                            ...(requestParams.stop && { stop: requestParams.stop })
                        }
                    };
                    const toolOverrides = await getToolOverridesForMode(toolMode, internalToolContext);
                    if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                        promptParams.body.tools = toolOverrides;
                    }

                    const requestForcedChatToolCall = createForcedToolCallRequester({
                        mode: externalToolChoice.mode,
                        sessionId,
                        systemWithGuard,
                        requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                        providerID: pID,
                        modelID: mID,
                        toolOverrides,
                        requestTimeoutMs: REQUEST_TIMEOUT_MS,
                        forbidThinkBlock: true
                    });

                    res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    if (stream) {
                        const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
                        const filterContentDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                        const filterReasoningDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                        const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                        const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                        let streamedContent = '';
                        let streamedReasoning = '';
                        let rawStreamedContent = '';
                        let rawStreamedReasoning = '';
                        const streamedToolCalls = [];
                        insideReasoning = false;
                        keepaliveInterval = null;
                        completionTokens = 0;
                        reasoningTokens = 0;

                        const ensureKeepalive = () => {
                            if (!keepaliveInterval) {
                                keepaliveInterval = setInterval(() => {
                                    if (!res.destroyed) {
                                        res.write(': keepalive\n\n');
                                    }
                                }, 15000);
                            }
                        };
                        ensureKeepalive();

                        const sendDelta = (delta, isReasoning = false) => {
                            if (!delta) return;
                            if (isReasoning) rawStreamedReasoning += delta;
                            else rawStreamedContent += delta;
                            const parsedDeltaToolCalls = isReasoning
                                ? parseReasoningToolCalls(delta)
                                : parseContentToolCalls(delta);
                            parsedDeltaToolCalls.forEach((toolCall) => {
                                streamedToolCalls.push(toolCall);
                                res.write(`data: ${JSON.stringify({
                                    id,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: `${pID}/${mID}`,
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            tool_calls: [{
                                                index: streamedToolCalls.length - 1,
                                                id: toolCall.id,
                                                type: 'function',
                                                function: {
                                                    name: toolCall.function.name,
                                                    arguments: toolCall.function.arguments
                                                }
                                            }]
                                        },
                                        finish_reason: null
                                    }]
                                })}\n\n`);
                            });
                            const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                            if (!filtered) return;
                            if (isReasoning) {
                                if (!insideReasoning) {
                                    res.write(`data: ${JSON.stringify({
                                        id,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: `${pID}/${mID}`,
                                        choices: [{
                                            index: 0,
                                            delta: { content: '<think>\n' },
                                            finish_reason: null
                                        }]
                                    })}\n\n`);
                                    insideReasoning = true;
                                }
                                streamedReasoning += filtered;
                                reasoningTokens += Math.ceil(filtered.length / 4);
                            } else {
                                if (insideReasoning) {
                                    res.write(`data: ${JSON.stringify({
                                        id,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: `${pID}/${mID}`,
                                        choices: [{
                                            index: 0,
                                            delta: { content: '\n</think>\n\n' },
                                            finish_reason: null
                                        }]
                                    })}\n\n`);
                                    insideReasoning = false;
                                }
                                streamedContent += filtered;
                                completionTokens += Math.ceil(filtered.length / 4);
                            }
                            const chunk = {
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: `${pID}/${mID}`,
                                choices: [{ index: 0, delta: { content: filtered }, finish_reason: null }]
                            };
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        };

                        let collected = null;
                        try {
                            const collectPromise = collectFromEvents(
                                sessionId,
                                REQUEST_TIMEOUT_MS,
                                sendDelta,
                                DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                                DEFAULT_EVENT_IDLE_TIMEOUT_MS
                            );
                            const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                            client.session.prompt(promptParams).catch(err => logDebug('Prompt error:', err.message));
                            collected = await safeCollect;
                        } catch (e) {
                            logDebug('Stream error:', e.message);
                        }

                        if (collected && collected.__error) {
                            logDebug('SSE collect error, falling back to polling', {
                                sessionId,
                                error: collected.__error?.message
                            });
                            const { content, reasoning, error } = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                if (reasoning) sendDelta(reasoning, true);
                                if (content) sendDelta(content, false);
                            }
                        } else if (collected && collected.noData) {
                            logDebug('Fallback to polling (stream)', { sessionId });
                            const { content, reasoning, error } = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                if (reasoning) sendDelta(reasoning, true);
                                if (content) sendDelta(content, false);
                            }
                        } else if (collected && collected.idleTimeout) {
                            logDebug('SSE idle timeout, polling for completion', { sessionId });
                            const { content, reasoning, error } = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                const remainingReasoning = reasoning && reasoning.startsWith(rawStreamedReasoning)
                                    ? reasoning.slice(rawStreamedReasoning.length)
                                    : reasoning;
                                const remainingContent = content && content.startsWith(rawStreamedContent)
                                    ? content.slice(rawStreamedContent.length)
                                    : content;
                                if (remainingReasoning) sendDelta(remainingReasoning, true);
                                if (remainingContent) sendDelta(remainingContent, false);
                            }
                        }

                        if (collected && !streamedContent && !streamedReasoning && (collected.reasoning || collected.content)) {
                            if (collected.reasoning) sendDelta(collected.reasoning, true);
                            if (collected.content) sendDelta(collected.content, false);
                        }

                        if (!streamedContent && !streamedReasoning) {
                            logDebug('SSE returned empty, falling back to polling', { sessionId });
                            const { content, reasoning, error } = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            if (error && !content && !reasoning) {
                                sendDelta(`[Proxy Error] ${error.name || 'OpenCodeError'}: ${error.data?.message || error.message || 'Unknown error'}`);
                            } else {
                                if (reasoning) sendDelta(reasoning, true);
                                if (content) sendDelta(content, false);
                            }
                        }

                        if (insideReasoning) {
                            res.write(`data: ${JSON.stringify({
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: `${pID}/${mID}`,
                                choices: [{
                                    index: 0,
                                    delta: { content: '\n</think>\n\n' },
                                    finish_reason: null
                                }]
                            })}\n\n`);
                        }

                        let parsedToolCalls = streamedToolCalls.length > 0
                            ? streamedToolCalls
                            : (externalToolRegistry.length > 0
                                ? parseExternalToolCallsFromText(externalToolRegistry, rawStreamedReasoning, rawStreamedContent)
                                : []);
                        if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                            const forcedResponse = await requestForcedChatToolCall();
                            if (forcedResponse) {
                                parsedToolCalls = parseExternalToolCallsFromText(
                                    externalToolRegistry,
                                    forcedResponse.reasoning,
                                    forcedResponse.content
                                );
                            }
                        }
                        const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                        const finalStreamedToolCalls = validatedStreamedToolCalls;
                        if (finalStreamedToolCalls.length > 0 && streamedToolCalls.length === 0) {
                            const toolCallDeltas = finalStreamedToolCalls.map((toolCall, index) => ({
                                index,
                                id: toolCall.id,
                                type: 'function',
                                function: {
                                    name: toolCall.function.name,
                                    arguments: toolCall.function.arguments
                                }
                            }));
                            res.write(`data: ${JSON.stringify({
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: `${pID}/${mID}`,
                                choices: [{
                                    index: 0,
                                    delta: { tool_calls: toolCallDeltas },
                                    finish_reason: null
                                }]
                            })}\n\n`);
                        }

                        if (keepaliveInterval) clearInterval(keepaliveInterval);
                        
                        const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                        const totalTokens = promptTokens + completionTokens + reasoningTokens;
                        
                        res.write(`data: ${JSON.stringify({ 
                            id, 
                            choices: [{ index: 0, delta: {}, finish_reason: finalStreamedToolCalls.length > 0 ? 'tool_calls' : 'stop' }],
                            usage: {
                                prompt_tokens: promptTokens,
                                completion_tokens: completionTokens + reasoningTokens,
                                total_tokens: totalTokens,
                                completion_tokens_details: {
                                    reasoning_tokens: reasoningTokens
                                }
                            }
                        })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        const promptStart = Date.now();
                        await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                        logDebug('Prompt sent', { sessionId, ms: Date.now() - promptStart });
                        let { content, reasoning, error } = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                        if (error && !content && !reasoning) {
                            return res.status(502).json({
                                error: {
                                    message: error.data?.message || error.message || 'OpenCode provider error',
                                    type: error.name || 'OpenCodeError'
                                }
                            });
                        }
                        let parsedToolCalls = externalToolRegistry.length > 0
                            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                            : [];
                        if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                            const forcedResponse = await requestForcedChatToolCall();
                            if (forcedResponse) {
                                content = forcedResponse.content || content;
                                reasoning = forcedResponse.reasoning || reasoning;
                                parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
                            }
                        }
                        const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                        const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                        const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));

                        const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                        const completionTokensCalc = Math.ceil((content || '').length / 4);
                        const reasoningTokensCalc = Math.ceil((reasoning || '').length / 4);
                        const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc;

                        let finalContent = safeContent;
                        if (safeReasoning) {
                            finalContent = `<think>\n${safeReasoning}\n</think>\n\n${safeContent}`;
                        }

                        const publicValidatedToolCalls = toPublicToolCalls(validatedToolCalls);
                        const assistantMessage = publicValidatedToolCalls.length > 0
                            ? {
                                role: 'assistant',
                                content: finalContent || null,
                                tool_calls: publicValidatedToolCalls
                            }
                            : { role: 'assistant', content: finalContent };

                        res.json({
                            id: `chatcmpl-${Date.now()}`,
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: `${pID}/${mID}`,
                            choices: [{
                                index: 0,
                                message: assistantMessage,
                                finish_reason: publicValidatedToolCalls.length > 0 ? 'tool_calls' : 'stop'
                            }],
                            usage: {
                                prompt_tokens: promptTokens,
                                completion_tokens: completionTokensCalc + reasoningTokensCalc,
                                total_tokens: totalTokens,
                                completion_tokens_details: {
                                    reasoning_tokens: reasoningTokensCalc
                                }
                            }
                        });
                    }
                } catch (error) {
                    console.error('[Proxy] API Error:', error.message);
                    console.error('[Proxy] Error details:', error);

                    if (stream && typeof insideReasoning !== 'undefined' && insideReasoning) {
                        res.write(`data: ${JSON.stringify({
                            id,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: `${pID}/${mID}`,
                            choices: [{
                                index: 0,
                                delta: { content: '\n\n' },
                                finish_reason: null
                            }]
                        })}\n\n`);
                    }

                    if (keepaliveInterval) clearInterval(keepaliveInterval);

                    if (!res.headersSent) {
                        let errorMessage = error.message;
                        let statusCode = 500;
                        if (error.statusCode) {
                            statusCode = error.statusCode;
                        }
                        if (error.message && error.message.includes('Request timeout')) {
                            statusCode = 504;
                        }
                        if (error.message && error.message.includes('ENOENT')) {
                            errorMessage = 'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
                        }
                        res.status(statusCode).json({
                            error: {
                                message: errorMessage,
                                type: error.code || error.constructor.name,
                                ...(error.availableModels && { available_models: error.availableModels })
                            }
                        });
                    } else if (!res.destroyed) {
                        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                        res.end();
                    }
                    if (sessionId) {
                        try {
                            await client.session.delete({ path: { id: sessionId } });
                        } catch (e) {
                            console.error('[Proxy] Failed to cleanup session on error:', e.message);
                        }
                    }
                } finally {
                    if (typeof keepaliveInterval !== 'undefined' && keepaliveInterval) clearInterval(keepaliveInterval);
                    if (eventStream && eventStream.close) {
                        eventStream.close();
                    }
                }
            }, REQUEST_TIMEOUT_MS + 20000);
        } catch (error) {
            console.error('[Proxy] Request Handler Error:', error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: { message: error.message, type: error.constructor.name } });
            }
        }
    });

    // Health check
    app.get('/health', (_req, res) => res.json({
        status: 'ok',
        proxy: true
    }));

    app.post('/v1/responses', async (req, res) => {
        try {
            const { 
                model, 
                input, 
                reasoning_effort,
                reasoning: requestReasoning,
                max_output_tokens,
                tools = [],
                tool_choice,
                instructions,
                temperature,
                top_p,
                stream = false,
                messages: chatMessages,
                prompt
            } = req.body;

            const reasoningLevel = normalizeReasoningEffort(
                reasoning_effort || requestReasoning?.effort,
                null
            );

            const requestToolContext = createRequestToolContext(tools, tool_choice);
            const toolMode = requestToolContext.mode;
            const internalToolContext = requestToolContext.internal;
            trackToolMode(toolMode, {
                configuredAllowlist: internalToolContext.allowedToolNames,
                route: '/v1/responses'
            });
            logDebug('Responses API request', { 
                model, 
                reasoning_effort: reasoning_effort || requestReasoning?.effort,
                reasoningLevel,
                max_output_tokens,
                toolMode,
                internalAllowedTools: internalToolContext.allowedToolNames
            });
            const externalToolContext = requestToolContext.external;
            const externalToolRegistry = externalToolContext.registry;
            const externalToolChoice = externalToolContext.toolChoice;
            const assistantToolCalls = new Map();

            const rememberAssistantToolCall = (toolCallId, toolName) => {
                if (!toolCallId || !toolName) return;
                assistantToolCalls.set(toolCallId, toolName);
            };

            const buildResponsesToolResultLine = (item = {}) => {
                const text = normalizeToolResultContent(item?.content ?? item?.output ?? item?.result ?? item?.text);
                if (!text) return null;
                const mappedTool = findExternalToolByName(externalToolRegistry, item?.name)
                    || findExternalToolByName(externalToolRegistry, assistantToolCalls.get(item?.call_id || item?.tool_call_id));
                const toolName = mappedTool?.namespacedName || assistantToolCalls.get(item?.call_id || item?.tool_call_id) || item?.name || `${EXTERNAL_TOOL_PREFIX}unknown`;
                const toolCallId = item?.call_id || item?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                rememberAssistantToolCall(toolCallId, toolName);
                return `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`;
            };

            const buildResponsesAssistantToolCallsLine = (item = {}) => {
                const sourceCalls = Array.isArray(item?.tool_calls)
                    ? item.tool_calls
                    : item?.type === 'function_call'
                        ? [item]
                        : [];
                if (!sourceCalls.length) return null;
                const serializedToolCalls = sourceCalls.map((toolCall, index) => {
                    const rawName = toolCall?.function?.name || toolCall?.name;
                    const mappedTool = findExternalToolByName(externalToolRegistry, rawName);
                    const namespacedName = mappedTool?.namespacedName || rawName;
                    if (!namespacedName) return null;
                    const toolCallId = toolCall?.call_id || toolCall?.id || `call_${index + 1}`;
                    rememberAssistantToolCall(toolCallId, namespacedName);
                    return {
                        id: toolCallId,
                        name: namespacedName,
                        arguments: normalizeToolArguments(toolCall?.arguments ?? toolCall?.function?.arguments)
                    };
                }).filter(Boolean);
                if (!serializedToolCalls.length) return null;
                return `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`;
            };

            const buildResponsesInputMessages = (rawItems) => {
                const normalized = [];
                if (!Array.isArray(rawItems)) return normalized;
                for (const item of rawItems) {
                    if (!item) continue;

                    if (item.type === 'function_call_output' || item.type === 'tool_result' || item.role === 'tool') {
                        const toolResultLine = buildResponsesToolResultLine(item);
                        if (toolResultLine) normalized.push({ role: 'tool', content: toolResultLine });
                        continue;
                    }

                    if (item.type === 'function_call') {
                        const assistantToolCallsLine = buildResponsesAssistantToolCallsLine(item);
                        if (assistantToolCallsLine) normalized.push({ role: 'assistant', content: assistantToolCallsLine, isToolCalls: true });
                        continue;
                    }

                    if (item.role === 'assistant' && Array.isArray(item?.tool_calls) && item.tool_calls.length) {
                        const assistantToolCallsLine = buildResponsesAssistantToolCallsLine(item);
                        if (assistantToolCallsLine) normalized.push({ role: 'assistant', content: assistantToolCallsLine, isToolCalls: true });
                    }

                    if (item.type === 'message') {
                        const role = item.role || 'user';
                        const content = normalizeTextContent(item.content);
                        if (content) normalized.push({ role, content });
                        continue;
                    }

                    if (item.type === 'input_text') {
                        if (item.text) normalized.push({ role: 'user', content: item.text });
                        continue;
                    }

                    const text = normalizeTextContent(item.content || item.text);
                    if (text) normalized.push({ role: item.role || 'user', content: text });
                }
                return normalized;
            };

            let messages = [];
            if (Array.isArray(chatMessages) && chatMessages.length) {
                messages = buildResponsesInputMessages(chatMessages);
            } else if (typeof prompt === 'string' && prompt.trim()) {
                messages = [{ role: 'user', content: prompt }];
            } else if (typeof input === 'string') {
                messages = [{ role: 'user', content: input }];
            } else if (Array.isArray(input)) {
                messages = buildResponsesInputMessages(input);
            } else if (input && typeof input === 'object') {
                if (input.type === 'message' || input.type === 'function_call' || input.type === 'function_call_output' || input.type === 'tool_result') {
                    messages = buildResponsesInputMessages([input]);
                } else {
                    const content = normalizeTextContent(input.content || input.text);
                    if (content) {
                        messages = [{ role: input.role || 'user', content }];
                    }
                }
            }

            if (!messages.length) {
                return res.status(400).json({ error: { message: 'input is required' } });
            }

            const resolvedModel = await resolveRequestedModel(model);
            const pID = resolvedModel.providerID;
            const mID = resolvedModel.modelID;

            await ensureBackend(config);

            try {
                await client.config.update({
                    body: { activeModel: { providerID: pID, modelID: mID } }
                });
            } catch (e) { }

            const sessionRes = await client.session.create();
            const sessionId = sessionRes.data?.id;
            if (!sessionId) {
                throw new Error('Failed to create OpenCode session');
            }

            const parts = [];
            const systemChunks = [];
            let fullPromptText = '';
            const formatResponsesRoleLine = (role, text) => `${String(role || 'user').toUpperCase()}: ${text}`;
            for (const msg of messages) {
                if (msg.role === 'system') {
                    if (msg.content) systemChunks.push(msg.content);
                    continue;
                }
                if (!msg.content) continue;
                const text = msg.role === 'tool' || String(msg.content).startsWith('ASSISTANT: ') || String(msg.content).startsWith('TOOL_RESULT: ')
                    ? msg.content
                    : msg.role === 'user'
                        ? msg.content
                        : formatResponsesRoleLine(msg.role, msg.content);
                parts.push({ type: 'text', text });
                fullPromptText += `${text}\n\n`;
            }

            const systemWithGuard = buildSystemPrompt(
                [instructions, ...systemChunks, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                reasoningLevel,
                toolMode
            );

            const requestForcedResponsesToolCall = createForcedToolCallRequester({
                mode: externalToolChoice.mode,
                sessionId,
                systemWithGuard,
                requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
                providerID: pID,
                modelID: mID,
                toolOverrides: await getToolOverridesForMode(toolMode, internalToolContext),
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                forbidThinkBlock: false
            });

            const promptParams = {
                path: { id: sessionId },
                body: {
                    model: { providerID: pID, modelID: mID },
                    ...(systemWithGuard ? { system: systemWithGuard } : {}),
                    parts,
                    ...(max_output_tokens && { max_tokens: max_output_tokens }),
                    ...(temperature !== undefined && { temperature }),
                    ...(top_p !== undefined && { top_p })
                }
            };
            const toolOverrides = await getToolOverridesForMode(toolMode, internalToolContext);
            if (toolOverrides && Object.keys(toolOverrides).length > 0) {
                promptParams.body.tools = toolOverrides;
            }

            let content = '';
            let reasoning = '';
            const buildResponsesFunctionCallOutputItem = (toolCall) => ({
                id: toolCall.id,
                type: 'function_call',
                status: 'completed',
                call_id: toolCall.id,
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
            });

            const buildResponsesMessageOutputItem = (text) => {
                if (!text) return null;
                return {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                        {
                            type: 'output_text',
                            text
                        }
                    ]
                };
            };

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                const responseId = `resp_${Date.now()}`;
                const messageOutputIndex = 0;
                const reasoningOutputIndex = 1;
                const contentIndex = 0;
                const outputItemId = `msg_${Date.now()}`;
                const reasoningItemId = 'reasoning-0';
                let nextOutputIndex = 2;
                let sequenceNumber = 0;
                let announcedOutput = false;
                let announcedContent = false;
                let announcedReasoning = false;
                const nextSeq = () => sequenceNumber++;
                const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

                emit({
                    type: 'response.created',
                    sequence_number: nextSeq(),
                    response: { id: responseId, object: 'response', created: Math.floor(Date.now() / 1000), model: `${pID}/${mID}` }
                });

                const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
                const filterContentDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                const filterReasoningDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                const streamedToolCalls = [];
                let rawContent = '';
                let rawReasoning = '';
                const ensureOutputScaffold = () => {
                    if (!announcedOutput) {
                        emit({
                            type: 'response.output_item.added',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            item: {
                                id: outputItemId,
                                type: 'message',
                                status: 'in_progress',
                                role: 'assistant',
                                content: []
                            }
                        });
                        announcedOutput = true;
                    }
                    if (!announcedContent) {
                        emit({
                            type: 'response.content_part.added',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            content_index: contentIndex,
                            item_id: outputItemId,
                            part: { type: 'output_text', text: '' }
                        });
                        announcedContent = true;
                    }
                };
                const ensureReasoningScaffold = () => {
                    if (!announcedReasoning) {
                        emit({
                            type: 'response.output_item.added',
                            sequence_number: nextSeq(),
                            output_index: reasoningOutputIndex,
                            item: {
                                id: reasoningItemId,
                                type: 'reasoning',
                                status: 'in_progress',
                                summary: [{ type: 'summary_text', text: '' }]
                            }
                        });
                        announcedReasoning = true;
                    }
                };
                const emitResponsesFunctionCall = (toolCall) => {
                    const outputIndex = nextOutputIndex++;
                    const functionCallItem = buildResponsesFunctionCallOutputItem(toolCall);
                    streamedToolCalls.push(toolCall);
                    emit({
                        type: 'response.output_item.added',
                        sequence_number: nextSeq(),
                        output_index: outputIndex,
                        item: {
                            ...functionCallItem,
                            status: 'in_progress'
                        }
                    });
                    emit({
                        type: 'response.function_call_arguments.delta',
                        sequence_number: nextSeq(),
                        output_index: outputIndex,
                        item_id: toolCall.id,
                        delta: toolCall.function.arguments
                    });
                    emit({
                        type: 'response.function_call_arguments.done',
                        sequence_number: nextSeq(),
                        output_index: outputIndex,
                        item_id: toolCall.id,
                        arguments: toolCall.function.arguments
                    });
                    emit({
                        type: 'response.output_item.done',
                        sequence_number: nextSeq(),
                        output_index: outputIndex,
                        item: functionCallItem
                    });
                };
                const sendResponsesDelta = (delta, isReasoning = false) => {
                    if (!delta) return;
                    if (isReasoning) rawReasoning += delta;
                    else rawContent += delta;
                    const parsedDeltaToolCalls = isReasoning
                        ? parseReasoningToolCalls(delta)
                        : parseContentToolCalls(delta);
                    parsedDeltaToolCalls.forEach((toolCall) => emitResponsesFunctionCall(toolCall));
                    const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                    if (!filtered) return;
                    if (isReasoning) {
                        ensureReasoningScaffold();
                        reasoning += filtered;
                        emit({
                            type: 'response.reasoning_summary_text.delta',
                            sequence_number: nextSeq(),
                            output_index: reasoningOutputIndex,
                            item_id: reasoningItemId,
                            summary_index: 0,
                            delta: filtered
                        });
                    } else {
                        if (!filtered.trim()) {
                            content += filtered;
                            return;
                        }
                        ensureOutputScaffold();
                        content += filtered;
                        emit({
                            type: 'response.output_text.delta',
                            sequence_number: nextSeq(),
                            output_index: messageOutputIndex,
                            content_index: contentIndex,
                            item_id: outputItemId,
                            delta: filtered
                        });
                    }
                };

                let collected = null;
                try {
                    const collectPromise = collectFromEvents(
                        sessionId,
                        REQUEST_TIMEOUT_MS,
                        sendResponsesDelta,
                        DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                        DEFAULT_EVENT_IDLE_TIMEOUT_MS
                    );
                    const safeCollect = collectPromise.catch((err) => ({ __error: err }));
                    client.session.prompt(promptParams).catch(err => logDebug('Responses prompt error:', err.message));
                    collected = await safeCollect;
                } catch (e) {
                    collected = { __error: e };
                }

                if (!content && !reasoning) {
                    const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                    if (polled.error && !polled.content && !polled.reasoning) throw polled.error;
                    if (polled.reasoning) sendResponsesDelta(polled.reasoning, true);
                    if (polled.content) sendResponsesDelta(polled.content, false);
                } else if (collected && collected.idleTimeout) {
                    const polled = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                    const remainingReasoning = polled.reasoning && polled.reasoning.startsWith(rawReasoning)
                        ? polled.reasoning.slice(rawReasoning.length)
                        : polled.reasoning;
                    const remainingContent = polled.content && polled.content.startsWith(rawContent)
                        ? polled.content.slice(rawContent.length)
                        : polled.content;
                    if (remainingReasoning) sendResponsesDelta(remainingReasoning, true);
                    if (remainingContent) sendResponsesDelta(remainingContent, false);
                } else if (collected && (collected.content || collected.reasoning)) {
                    if (!reasoning && collected.reasoning) sendResponsesDelta(collected.reasoning, true);
                    if (!content && collected.content) sendResponsesDelta(collected.content, false);
                }

                if (announcedReasoning) {
                    emit({
                        type: 'response.reasoning_summary_text.done',
                        sequence_number: nextSeq(),
                        output_index: reasoningOutputIndex,
                        item_id: reasoningItemId,
                        summary_index: 0,
                        text: reasoning
                    });
                    emit({
                        type: 'response.output_item.done',
                        sequence_number: nextSeq(),
                        output_index: reasoningOutputIndex,
                        item: {
                            id: reasoningItemId,
                            type: 'reasoning',
                            status: 'completed',
                            summary: [{ type: 'summary_text', text: reasoning }]
                        }
                    });
                }

                const hasMeaningfulContent = Boolean(content && content.trim());

                if (announcedContent && hasMeaningfulContent) {
                    emit({
                        type: 'response.output_text.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        content_index: contentIndex,
                        item_id: outputItemId,
                        text: content
                    });
                    emit({
                        type: 'response.content_part.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        content_index: contentIndex,
                        item_id: outputItemId,
                        part: { type: 'output_text', text: content }
                    });
                    emit({
                        type: 'response.output_item.done',
                        sequence_number: nextSeq(),
                        output_index: messageOutputIndex,
                        item: {
                            id: outputItemId,
                            type: 'message',
                            status: 'completed',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: content }]
                        }
                    });
                }

                let polledForToolCalls = null;
                if (externalToolRegistry.length > 0 && streamedToolCalls.length === 0) {
                    try {
                        polledForToolCalls = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                    } catch (e) { }
                }

                let parsedToolCalls = streamedToolCalls.length > 0
                    ? streamedToolCalls
                    : (externalToolRegistry.length > 0
                        ? parseExternalToolCallsFromText(
                            externalToolRegistry,
                            polledForToolCalls?.reasoning || rawReasoning,
                            polledForToolCalls?.content || rawContent
                        )
                        : []);
                if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                    const forcedResponse = await requestForcedResponsesToolCall();
                    if (forcedResponse) {
                        parsedToolCalls = parseExternalToolCallsFromText(
                            externalToolRegistry,
                            forcedResponse.reasoning,
                            forcedResponse.content
                        );
                    }
                }
                const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));
                if (streamedToolCalls.length === 0) {
                    validatedStreamedToolCalls.forEach((toolCall) => {
                        emitResponsesFunctionCall(toolCall);
                    });
                }
                const streamOutput = [];
                const streamMessageOutputItem = buildResponsesMessageOutputItem(safeContent && safeContent.trim() ? safeContent : '');
                if (streamMessageOutputItem) streamOutput.push(streamMessageOutputItem);
                validatedStreamedToolCalls.forEach((toolCall) => {
                    streamOutput.push(buildResponsesFunctionCallOutputItem(toolCall));
                });
                const promptTokens = Math.ceil(fullPromptText.length / 4);
                const completionTokens = Math.ceil(content.length / 4);
                const reasoningTokens = Math.ceil(reasoning.length / 4);
                const response = {
                    id: responseId,
                    object: 'response',
                    created: Math.floor(Date.now() / 1000),
                    model: `${pID}/${mID}`,
                    reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
                    output: streamOutput,
                    usage: {
                        input_tokens: promptTokens,
                        output_tokens: completionTokens + reasoningTokens,
                        total_tokens: promptTokens + completionTokens + reasoningTokens,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: reasoningTokens }
                    }
                };
                emit({ type: 'response.completed', sequence_number: nextSeq(), response });
                res.write('data: [DONE]\n\n');
                try {
                    await client.session.delete({ path: { id: sessionId } });
                } catch (e) { }
                return res.end();
            }

            const responseRes = await client.session.prompt(promptParams);
            const responseParts = responseRes.data?.parts || [];
            const promptContent = responseParts.filter(p => p.type === 'text').map(p => p.text).join('\n');
            const promptReasoning = responseParts.filter(p => p.type === 'reasoning').map(p => p.text).join('\n');
            const promptParsedToolCalls = externalToolRegistry.length > 0
                ? parseExternalToolCallsFromText(externalToolRegistry, promptReasoning, promptContent)
                : [];

            content = promptParsedToolCalls.length > 0 ? '' : promptContent;
            reasoning = promptReasoning;

            let promptBasedToolCalls = promptParsedToolCalls;
            const shouldPollForResponses = !promptContent && !promptReasoning;
            if (shouldPollForResponses) {
                const polledResponse = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                if (polledResponse.error && !polledResponse.content && !polledResponse.reasoning) {
                    throw polledResponse.error;
                }
                content = polledResponse.content || content;
                reasoning = polledResponse.reasoning || reasoning;
                promptBasedToolCalls = externalToolRegistry.length > 0
                    ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                    : [];
            }

            if (!content && !reasoning && responseRes.data && promptBasedToolCalls.length === 0) {
                const data = responseRes.data;
                content = typeof data === 'string' ? data : data?.message || JSON.stringify(data);
            }

            let parsedToolCalls = promptBasedToolCalls.length > 0
                ? promptBasedToolCalls
                : (externalToolRegistry.length > 0
                    ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                    : []);
            if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                const forcedResponse = await requestForcedResponsesToolCall();
                if (forcedResponse) {
                    content = forcedResponse.content || content;
                    reasoning = forcedResponse.reasoning || reasoning;
                    parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
                }
            }
            const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
            const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
            const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));

            const promptTokens = Math.ceil(fullPromptText.length / 4);
            const completionTokens = Math.ceil(content.length / 4);
            const reasoningTokens = Math.ceil(reasoning.length / 4);
            const output = [];
            const messageOutputItem = buildResponsesMessageOutputItem(safeContent);
            if (messageOutputItem) output.push(messageOutputItem);
            validatedToolCalls.forEach((toolCall) => {
                output.push(buildResponsesFunctionCallOutputItem(toolCall));
            });

            const response = {
                id: `resp_${Date.now()}`,
                object: 'response',
                created: Math.floor(Date.now() / 1000),
                model: `${pID}/${mID}`,
                reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
                output,
                usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens + reasoningTokens,
                    total_tokens: promptTokens + completionTokens + reasoningTokens,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: reasoningTokens }
                }
            };

            try {
                await client.session.delete({ path: { id: sessionId } });
            } catch (e) { }

            return res.json(response);
        } catch (error) {
            console.error('[Proxy] Responses API Error:', error.message);
            const statusCode = error.statusCode || 500;
            res.status(statusCode).json({ 
                error: { 
                    message: error.message,
                    type: error.code || error.constructor.name,
                    ...(error.availableModels && { available_models: error.availableModels })
                } 
            });
        }
    });

    app.use((req, res) => {
        res.status(404).json({
            error: {
                message: `Route not found: ${req.method} ${req.path}`,
                type: 'not_found_error'
            }
        });
    });

    return { app, client };
}

// Backend management state (per-instance)
const backendState = new Map();

/**
 * Backend Lifecycle Management
 */
async function ensureBackend(config) {
    const {
        OPENCODE_SERVER_URL,
        OPENCODE_PATH,
        USE_ISOLATED_HOME,
        ZEN_API_KEY,
        OPENCODE_SERVER_PASSWORD,
        MANAGE_BACKEND,
        PROMPT_MODE
    } = config;
    const stateKey = OPENCODE_SERVER_URL;

    if (!backendState.has(stateKey)) {
        backendState.set(stateKey, {
            isStarting: false,
            process: null,
            jailRoot: null
        });
    }

    const state = backendState.get(stateKey);

    if (state.isStarting) {
        // Wait for startup to complete
        for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
            await new Promise(r => setTimeout(r, STARTING_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                return;
            } catch (e) { }
        }
        throw new Error('Backend startup timeout');
    }

    try {
        await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
    } catch (err) {
        if (!MANAGE_BACKEND) {
            for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
                await new Promise(r => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
                try {
                    await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                    return;
                } catch (e) { }
            }
            throw err;
        }

        state.isStarting = true;
        console.log(`[Proxy] OpenCode backend not found at ${OPENCODE_SERVER_URL}. Starting...`);

        // Kill existing process if any
        if (state.process) {
            try {
                state.process.kill();
            } catch (e) { }
        }

        // Cleanup old temp dir
        if (state.jailRoot && fs.existsSync(state.jailRoot)) {
            try {
                fs.rmSync(state.jailRoot, { recursive: true, force: true });
            } catch (e) { }
        }

        const isWindows = process.platform === 'win32';
        const useIsolatedHome = typeof USE_ISOLATED_HOME === 'boolean'
            ? USE_ISOLATED_HOME
            : String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_USE_ISOLATED_HOME === '1';

        // On Windows, don't use isolated fake-home to avoid path issues
        // On Unix-like systems, use jail for isolation
        const salt = Math.random().toString(36).substring(7);
        const jailRoot = path.join(os.tmpdir(), 'opencode-proxy-jail', salt);
        state.jailRoot = jailRoot;
        config.OPENCODE_HOME_BASE = jailRoot;
        const workspace = path.join(jailRoot, 'empty-workspace');

        let envVars;
        let cwd;

        if (isWindows) {
            // Windows: use normal user home to avoid opencode storage path issues
            fs.mkdirSync(workspace, { recursive: true });
            cwd = workspace;
            envVars = {
                ...process.env,
                OPENCODE_PROJECT_DIR: workspace
            };
            console.log('[Proxy] Running on Windows, using standard user home directory');
        } else {
            fs.mkdirSync(workspace, { recursive: true });
            cwd = workspace;

            if (useIsolatedHome) {
                // Unix-like: use isolated fake-home
                const fakeHome = path.join(jailRoot, 'fake-home');

                // Create necessary opencode directories
                const opencodeDir = path.join(fakeHome, '.local', 'share', 'opencode');
                const storageDir = path.join(opencodeDir, 'storage');
                const messageDir = path.join(storageDir, 'message');
                const sessionDir = path.join(storageDir, 'session');

                [fakeHome, opencodeDir, storageDir, messageDir, sessionDir].forEach(d => {
                    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                });

                envVars = {
                    ...process.env,
                    HOME: fakeHome,
                    USERPROFILE: fakeHome,
                    OPENCODE_PROJECT_DIR: workspace
                };

                if (PROMPT_MODE === 'plugin-inject') {
                    const configDir = path.join(fakeHome, '.config', 'opencode');
                    const pluginDir = path.join(configDir, 'plugin', 'opencode2api-empty');
                    fs.mkdirSync(pluginDir, { recursive: true });
                    fs.writeFileSync(path.join(pluginDir, 'index.js'), `export const Opencode2apiEmptyPlugin = async () => ({})\nexport default Opencode2apiEmptyPlugin\n`, 'utf8');
                    fs.writeFileSync(
                        path.join(configDir, 'opencode.json'),
                        JSON.stringify({
                            plugin: [path.join(pluginDir, 'index.js')],
                            instructions: [],
                            theme: 'system'
                        }, null, 2),
                        'utf8'
                    );
                    console.log('[Proxy] Using plugin-inject prompt mode');
                }
                console.log('[Proxy] Using isolated home for OpenCode');
            } else {
                envVars = {
                    ...process.env,
                    OPENCODE_PROJECT_DIR: workspace
                };
                console.log('[Proxy] Using real HOME for OpenCode (isolation disabled)');
            }
        }

        const [, , portStr] = OPENCODE_SERVER_URL.split(':');
        const port = portStr ? portStr.split('/')[0] : '10001';
        const resolved = resolveOpencodePath(OPENCODE_PATH);
        const opencodeBin = resolved.path || OPENCODE_PATH || OPENCODE_BASENAME;
        if (resolved.path) {
            console.log(`[Proxy] Using OpenCode binary: ${opencodeBin} (source: ${resolved.source})`);
        } else {
            console.warn(`[Proxy] Unable to resolve OpenCode binary for '${OPENCODE_PATH}'. Using as-is.`);
        }

        // Cross-platform spawn options
        const useShell = process.platform === 'win32' || !resolved.path ||
            opencodeBin.endsWith('.cmd') || opencodeBin.endsWith('.bat');
        const spawnOptions = {
            stdio: 'inherit',
            cwd: cwd,
            env: envVars,
            shell: useShell  // Use shell only when needed (e.g., Windows .cmd or unresolved PATH)
        };

        const spawnArgs = ['serve', '--port', port, '--hostname', '127.0.0.1'];
        if (ZEN_API_KEY) {
            spawnArgs.push('--password', ZEN_API_KEY);
        }
        state.process = spawn(opencodeBin, spawnArgs, spawnOptions);

        // Handle spawn errors
        state.process.on('error', (err) => {
            console.error(`[Proxy] Failed to spawn OpenCode: ${err.message}`);
            if (err.code === 'ENOENT') {
                console.error(`[Proxy] Command '${OPENCODE_PATH}' not found. Please ensure OpenCode is installed and in your PATH.`);
                console.error(`[Proxy] You can specify the full path in config.json using 'OPENCODE_PATH'`);
            }
        });

        // Wait for backend to be ready
        let started = false;
        for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
            await new Promise(r => setTimeout(r, STARTUP_WAIT_INTERVAL_MS));
            try {
                await checkHealth(OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD);
                console.log('[Proxy] OpenCode backend ready.');
                started = true;
                break;
            } catch (e) { }
        }

        state.isStarting = false;

        if (!started) {
            console.warn('[Proxy] Backend start timed out.');
            throw new Error('Backend start timeout');
        }
    }
}

/**
 * Starts the OpenCode-to-OpenAI Proxy server.
 */
export function startProxy(options) {
    const normalizeBool = (value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value === 1;
        if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
            if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
        }
        return undefined;
    };

    const disableTools =
        normalizeBool(options.DISABLE_TOOLS) ??
        normalizeBool(options.disableTools) ??
        normalizeBool(process.env.OPENCODE_DISABLE_TOOLS) ??
        false;

    const promptMode = options.PROMPT_MODE || options.promptMode || process.env.OPENCODE_PROXY_PROMPT_MODE || 'standard';
    const externalToolsMode = options.EXTERNAL_TOOLS_MODE || options.externalToolsMode || process.env.OPENCODE_EXTERNAL_TOOLS_MODE || 'proxy-bridge';
    const externalToolsConflictPolicy = options.EXTERNAL_TOOLS_CONFLICT_POLICY || options.externalToolsConflictPolicy || process.env.OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY || 'namespace';
    const cleanupIntervalMs = Number(options.CLEANUP_INTERVAL_MS || process.env.OPENCODE_PROXY_CLEANUP_INTERVAL_MS || 12 * 60 * 60 * 1000);
    const cleanupMaxAgeMs = Number(options.CLEANUP_MAX_AGE_MS || process.env.OPENCODE_PROXY_CLEANUP_MAX_AGE_MS || 24 * 60 * 60 * 1000);

    if (externalToolsMode !== 'proxy-bridge') {
        throw new Error(`Unsupported EXTERNAL_TOOLS_MODE: ${externalToolsMode}. Supported value: proxy-bridge`);
    }
    if (externalToolsConflictPolicy !== 'namespace') {
        throw new Error(`Unsupported EXTERNAL_TOOLS_CONFLICT_POLICY: ${externalToolsConflictPolicy}. Supported value: namespace`);
    }

    const config = {
        PORT: options.PORT || 10000,
        API_KEY: options.API_KEY || '',
        OPENCODE_SERVER_URL: options.OPENCODE_SERVER_URL || 'http://127.0.0.1:10001',
        OPENCODE_SERVER_PASSWORD: options.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || '',
        OPENCODE_PATH: options.OPENCODE_PATH || 'opencode',
        BIND_HOST: options.BIND_HOST || options.bindHost || process.env.OPENCODE_PROXY_BIND_HOST || '0.0.0.0',
        USE_ISOLATED_HOME: typeof options.USE_ISOLATED_HOME === 'boolean'
            ? options.USE_ISOLATED_HOME
            : String(options.USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            options.USE_ISOLATED_HOME === '1' ||
            String(process.env.OPENCODE_USE_ISOLATED_HOME || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_USE_ISOLATED_HOME === '1',
        REQUEST_TIMEOUT_MS: Number(options.REQUEST_TIMEOUT_MS || process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS),
        MANAGE_BACKEND: normalizeBool(options.MANAGE_BACKEND) ??
            normalizeBool(process.env.OPENCODE_PROXY_MANAGE_BACKEND) ??
            true,
        DISABLE_TOOLS: disableTools,
        EXTERNAL_TOOLS_MODE: externalToolsMode,
        EXTERNAL_TOOLS_CONFLICT_POLICY: externalToolsConflictPolicy,
        DEBUG: String(options.DEBUG || '').toLowerCase() === 'true' ||
            options.DEBUG === '1' ||
            String(process.env.OPENCODE_PROXY_DEBUG || '').toLowerCase() === 'true' ||
            process.env.OPENCODE_PROXY_DEBUG === '1',
        ZEN_API_KEY: options.ZEN_API_KEY || process.env.OPENCODE_ZEN_API_KEY || '',
        PROMPT_MODE: promptMode,
        OMIT_SYSTEM_PROMPT: normalizeBool(options.OMIT_SYSTEM_PROMPT) ??
            normalizeBool(process.env.OPENCODE_PROXY_OMIT_SYSTEM_PROMPT) ??
            promptMode === 'plugin-inject',
        AUTO_CLEANUP_CONVERSATIONS: normalizeBool(options.AUTO_CLEANUP_CONVERSATIONS) ??
            normalizeBool(process.env.OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS) ??
            false,
        CLEANUP_INTERVAL_MS: Number.isFinite(cleanupIntervalMs) && cleanupIntervalMs > 0 ? cleanupIntervalMs : 12 * 60 * 60 * 1000,
        CLEANUP_MAX_AGE_MS: Number.isFinite(cleanupMaxAgeMs) && cleanupMaxAgeMs > 0 ? cleanupMaxAgeMs : 24 * 60 * 60 * 1000,
        OPENCODE_HOME_BASE: options.OPENCODE_HOME_BASE || null
    };

    const { app } = createApp(config);
    
    const server = app.listen(config.PORT, config.BIND_HOST, async () => {
        console.log(`[Proxy] Active at http://${config.BIND_HOST}:${config.PORT}`);
        try {
            await ensureBackend(config);
        } catch (error) {
            console.error('[Proxy] Backend warmup failed:', error.message);
        }
    });

    return {
        server,
        killBackend: () => {
            const state = backendState.get(config.OPENCODE_SERVER_URL);
            if (state && state.process) {
                state.process.kill();
            }
            // Cleanup temp dir (only on non-Windows where we use jail)
            if (state && state.jailRoot && process.platform !== 'win32') {
                try {
                    fs.rmSync(state.jailRoot, { recursive: true, force: true });
                } catch (e) { }
            }
        }
    };
}
