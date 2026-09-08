import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { createOpencodeClient } from '@opencode-ai/sdk';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildExternalToolRegistry, findExternalToolByName } from './tool-runtime/registry.js';
import { EXTERNAL_TOOL_PREFIX } from './tool-runtime/contracts.js';
import {
    validateMessagesRequest,
    extractSystemText,
    anthropicMessagesToChatMessages,
    anthropicToolsToChatTools,
    anthropicToolChoiceToChat,
    anthropicThinkingToReasoningEffort,
    mapFinishToStopReason,
    buildAnthropicMessage,
    sseEvent,
    estimateTokens
} from './converters/anthropic.js';
import { buildToolExposure } from './tool-runtime/router.js';
import { evaluateToolPolicy } from './tool-runtime/policy.js';
import { validateToolCalls } from './tool-runtime/validator.js';
import {
    stripFunctionCallMarkup,
    parseExternalToolCallsFromText,
    createToolCallFilter,
    createExternalToolCallStreamParser
} from './tool-runtime/parser.js';

/**
 * Detect transient upstream provider failures that succeed on retry.
 *
 * The upstream (OpenCode Zen) occasionally mislabels throttling as billing
 * errors: a worker hits its request limit and returns
 * `401: {"message":"Insufficient balance...","type":"CreditsError"}` even
 * though the account is fine — the very next attempt succeeds. These errors
 * are surfaced to clients as bogus "insufficient balance" failures (issue #5).
 * Match them (plus generic rate-limit/5xx signatures) so the proxy can retry
 * with backoff before giving up.
 * @param {Error|object|null} error - Assistant message error or thrown error
 * @returns {boolean} true when the error looks transient
 */
function isTransientUpstreamError(error) {
    if (!error) return false;
    const message = [error.message, error.data?.message]
        .filter((part) => typeof part === 'string')
        .join(' ');
    if (!message) return false;

    const transientSignatures = [
        /insufficient balance/i,
        /credits?error/i,
        /rate.?limit/i,
        /too many requests/i,
        /worker request limit/i,
        /overloaded/i,
        /temporarily unavailable/i,
        /internal server error/i,
        /bad gateway/i,
        /service unavailable/i,
        /stream error/i
    ];
    if (transientSignatures.some((re) => re.test(message))) return true;

    // Upstream errors arrive as "<status>: {json}" strings; SDK errors may also
    // carry a numeric status on the object itself.
    const statusMatch = message.match(/\b(\d{3}):/);
    const status = statusMatch
        ? Number(statusMatch[1])
        : (error.statusCode || error.data?.status || null);
    if (typeof status === 'number') {
        if (status === 401 || status === 402 || status === 429) return true;
        if (status >= 500) return true;
    }
    return false;
}

/**
 * Transform upstream provider errors to OpenAI-compatible format
 * @param {Error} error - The error from the upstream provider
 * @returns {{statusCode: number, error: {message: string, type: string, code?: string}}} OpenAI-compatible error response
 */
function transformUpstreamError(error) {
    // Default fallback
    let statusCode = 500;
    let message = error.message || 'Internal server error';
    let type = 'internal_error';
    let code = error.code || error.constructor.name;

    // Handle timeout errors
    if (error.message && error.message.includes('Request timeout')) {
        statusCode = 504;
        type = 'timeout';
        code = 'timeout';
        message = 'Request timeout';
    }
    // Handle file access errors (Windows compatibility)
    else if (error.message && error.message.includes('ENOENT')) {
        statusCode = 500;
        type = 'internal_error';
        code = 'file_access_error';
        message = 'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
    }
    // Handle upstream provider errors (from OpenCode SDK)
    else if (error.statusCode) {
        statusCode = error.statusCode;
        
        // Map upstream error types to OpenAI-compatible types
        const upstreamType = error.code || error.type || '';
        const upstreamMessage = error.message || '';
        
        // Billing/credit errors - map to 402 Payment Required
        if (upstreamType === 'CreditsError' || 
            upstreamType === 'InsufficientBalanceError' ||
            upstreamMessage.toLowerCase().includes('insufficient balance') ||
            upstreamMessage.toLowerCase().includes('insufficient credits') ||
            upstreamMessage.toLowerCase().includes('billing') ||
            upstreamMessage.toLowerCase().includes('quota exceeded') ||
            upstreamMessage.toLowerCase().includes('credit limit')) {
            statusCode = 402;
            type = 'insufficient_quota';
            code = 'insufficient_quota';
            message = upstreamMessage || 'Insufficient balance or quota exceeded';
        }
        // Rate limit errors - map to 429
        else if (upstreamType === 'RateLimitError' ||
                 upstreamType === 'TooManyRequestsError' ||
                 statusCode === 429 ||
                 upstreamMessage.toLowerCase().includes('rate limit') ||
                 upstreamMessage.toLowerCase().includes('too many requests')) {
            statusCode = 429;
            type = 'rate_limit_exceeded';
            code = 'rate_limit_exceeded';
            message = upstreamMessage || 'Rate limit exceeded';
        }
        // Authentication errors - keep as 401
        else if (upstreamType === 'AuthenticationError' ||
                 upstreamType === 'InvalidAPIKeyError' ||
                 statusCode === 401 ||
                 upstreamMessage.toLowerCase().includes('invalid api key') ||
                 upstreamMessage.toLowerCase().includes('unauthorized') ||
                 upstreamMessage.toLowerCase().includes('authentication')) {
            statusCode = 401;
            type = 'invalid_api_key';
            code = 'invalid_api_key';
            message = upstreamMessage || 'Invalid API key';
        }
        // Permission errors - map to 403
        else if (upstreamType === 'PermissionError' ||
                 statusCode === 403 ||
                 upstreamMessage.toLowerCase().includes('permission denied') ||
                 upstreamMessage.toLowerCase().includes('access denied')) {
            statusCode = 403;
            type = 'permission_denied';
            code = 'permission_denied';
            message = upstreamMessage || 'Permission denied';
        }
        // Model not found - map to 404
        else if (upstreamType === 'NotFoundError' ||
                 statusCode === 404 ||
                 upstreamMessage.toLowerCase().includes('model not found') ||
                 upstreamMessage.toLowerCase().includes('does not exist')) {
            statusCode = 404;
            type = 'model_not_found';
            code = 'model_not_found';
            message = upstreamMessage || 'Model not found';
        }
        // Bad request - map to 400
        else if (statusCode === 400 || upstreamType === 'BadRequestError') {
            statusCode = 400;
            type = 'invalid_request_error';
            code = 'invalid_request_error';
            message = upstreamMessage || 'Invalid request';
        }
        // Server errors from upstream - map to 502/503
        else if (statusCode >= 500) {
            statusCode = 502;
            type = 'server_error';
            code = 'server_error';
            message = upstreamMessage || 'Upstream provider error';
        }
        // Default: pass through with mapped type
        else {
            type = upstreamType.toLowerCase().replace(/error$/, '_error') || 'upstream_error';
            code = upstreamType;
            message = upstreamMessage;
        }
    }

    return {
        statusCode,
        error: {
            message,
            type,
            ...(code && { code }),
            ...(error.availableModels && { available_models: error.availableModels })
        }
    };
}

// --- Mutex Logic with Timeout ---
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
// Backoff base for transient upstream error retries (issue #5): 800ms, 1600ms.
const RETRY_BACKOFF_BASE_MS = 800;
const RETRY_MAX_ATTEMPTS = 3;
// Reasoning models can take well over 10s before emitting their first token.
// A short window here makes the event stream give up and fall back to polling on
// every request, which loses true streaming. Configurable for slow backends.
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = Number(process.env.OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS) || 30000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = Number(process.env.OPENCODE2API_EVENT_IDLE_TIMEOUT_MS) || 8000;

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
        HEALTH_DETAILS_ENABLED = true,
        HEALTH_DETAILS_REQUIRE_AUTH = true,
        METRICS_ENABLED = false,
        METRICS_REQUIRE_AUTH = true,
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
        allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version']
    }));
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

    const clientHeaders = buildBackendAuthHeaders(OPENCODE_SERVER_PASSWORD);
    const client = createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL, headers: clientHeaders });

    const isOperationalEndpointBypassed = (req) => {
        if (req.path === '/health/details') {
            return HEALTH_DETAILS_ENABLED && !HEALTH_DETAILS_REQUIRE_AUTH;
        }
        if (req.path === '/metrics') {
            return METRICS_ENABLED && !METRICS_REQUIRE_AUTH;
        }
        return false;
    };

    // Auth middleware (accepts Authorization: Bearer and x-api-key for Anthropic SDK compat)
    app.use((req, res, next) => {
        if (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/' || req.path === '/health/details' || req.path === '/metrics') return next();
        if (API_KEY && API_KEY.trim() !== '') {
            const authHeader = req.headers.authorization;
            const apiKeyHeader = req.headers['x-api-key'];
            if (!((authHeader && authHeader === `Bearer ${API_KEY}`) || (apiKeyHeader && apiKeyHeader === API_KEY))) {
                if (req.path === '/v1/messages') {
                    return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized' } });
                }
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

    // Responses API state store (previous_response_id): maps a returned response id
    // to the OpenCode session that produced it, so stateful clients can continue a
    // conversation without resending full history. Entries expire after
    // RESPONSE_STATE_TTL_MS; the sweep then best-effort deletes the upstream session
    // once no live entry still references it, so statefulness never leaks sessions.
    const responseState = new Map();
    const RESPONSE_STATE_TTL_MS = 30 * 60 * 1000;
    const RESPONSE_STATE_SWEEP_INTERVAL_MS = 60 * 1000;
    const getResponseState = (responseId) => {
        const state = responseState.get(responseId);
        if (!state) return null;
        if (state.expiresAt <= Date.now()) {
            responseState.delete(responseId);
            return null;
        }
        return state;
    };
    const storeResponseState = (responseId, sessionId, model) => {
        if (!responseId || !sessionId) return;
        responseState.set(responseId, {
            sessionId,
            model,
            expiresAt: Date.now() + RESPONSE_STATE_TTL_MS
        });
    };
    const sweepResponseState = async () => {
        const now = Date.now();
        const expired = [];
        for (const [id, state] of responseState.entries()) {
            if (state.expiresAt <= now) {
                expired.push(state);
                responseState.delete(id);
            }
        }
        if (!expired.length) return;
        const liveSessionIds = new Set([...responseState.values()].map((s) => s.sessionId));
        for (const state of expired) {
            if (liveSessionIds.has(state.sessionId)) continue;
            try {
                await client.session.delete({ path: { id: state.sessionId } });
            } catch (e) {
                logDebug('Failed to delete expired response session', { sessionId: state.sessionId, error: e.message });
            }
        }
    };
    const responseStateSweepTimer = setInterval(() => {
        sweepResponseState().catch(() => {});
    }, RESPONSE_STATE_SWEEP_INTERVAL_MS);
    if (typeof responseStateSweepTimer.unref === 'function') responseStateSweepTimer.unref();

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

    const SERVER_INTERNAL_ALLOWED_TOOL_NAMES = getEffectiveInternalAllowedTools();

    const buildInternalAllowlistPrompt = (allowedToolNames = []) => {
        if (allowedToolNames.length > 0) {
            return `OpenCode internal tool access is limited for this turn. You may use only these built-in tools when truly required: ${allowedToolNames.join(', ')}. Do not mention or attempt any other internal tools. If the required internal tools are unavailable, answer directly and say live tool access is unavailable.`;
        }
        return 'OpenCode internal tools are unavailable for this turn. Answer directly without attempting tool usage.';
    };

    const buildSystemPrompt = (systemMsg, reasoningEffort = null, toolMode = TOOL_MODE.DISABLED, internalAllowedTools = []) => {
        const parts = [];
        if (!OMIT_SYSTEM_PROMPT && systemMsg && systemMsg.trim()) {
            parts.push(systemMsg.trim());
        }
        if (reasoningEffort && reasoningEffort !== 'none') {
            parts.push(`[Reasoning Effort: ${reasoningEffort}]`);
        }
        if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
            parts.push(buildInternalAllowlistPrompt(internalAllowedTools));
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
        if (args === undefined || args === null || args === '') return '{}';
        if (typeof args === 'string') return args;
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
            prompt: exposure.prompt,
            reminder: exposure.reminder
        };
    };

    const resolveToolMode = (tools = [], effectiveInternalAllowlist = []) => {
        if (Array.isArray(tools) && tools.length > 0) {
            return TOOL_MODE.EXTERNAL_BRIDGE;
        }
        if (effectiveInternalAllowlist.length > 0) {
            return TOOL_MODE.INTERNAL_ALLOWLIST;
        }
        return TOOL_MODE.DISABLED;
    };

    const createRequestToolContext = (tools, toolChoice, requestOpencodeConfig = undefined) => {
        let effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES;
        let requestInternalAllowlist = null;

        if (requestOpencodeConfig && typeof requestOpencodeConfig === 'object') {
            if (Array.isArray(requestOpencodeConfig.internal_allowed_tools)) {
                requestInternalAllowlist = requestOpencodeConfig.internal_allowed_tools
                    .map(name => String(name || '').trim())
                    .filter(Boolean);
            }
        }

        if (requestInternalAllowlist !== null) {
            effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES.filter(name => 
                requestInternalAllowlist.includes(name)
            );
        }

        const deniedRequestedTools = requestInternalAllowlist
            ? requestInternalAllowlist.filter(name => !SERVER_INTERNAL_ALLOWED_TOOL_NAMES.includes(name))
            : [];

        const mode = resolveToolMode(tools, effectiveInternalAllowlist);
        const external = mode === TOOL_MODE.EXTERNAL_BRIDGE
            ? createExternalToolContext(tools, toolChoice)
            : {
                registry: [],
                exposure: { tools: [], toolChoice: { mode: 'auto', requiredTool: null }, prompt: '', reminder: '' },
                toolChoice: { mode: 'auto', requiredTool: null },
                prompt: '',
                reminder: ''
            };

        return {
            mode,
            external,
            internal: {
                allowedToolNames: effectiveInternalAllowlist,
                requestedAllowlist: requestInternalAllowlist,
                deniedRequestedTools,
                resolutionPath: requestInternalAllowlist ? 'request-intersection' : 'server-default',
                resultingMode: mode,
                metricsEnabled: INTERNAL_TOOL_METRICS_ENABLED
            }
        };


        return {
            mode,
            external,
            internal: {
                allowedToolNames: effectiveInternalAllowlist,
                requestedAllowlist: requestInternalAllowlist,
                deniedRequestedTools,
                resolutionPath: requestInternalAllowlist ? 'request-intersection' : 'server-default',
                resultingMode: mode,
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
                    configuredAllowlist: internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES
                });
            }
            return getDisabledToolOverrides();
        }
        if (toolMode !== TOOL_MODE.INTERNAL_ALLOWLIST) {
            return null;
        }
        const ids = await getBackendToolIds();
        if (!Array.isArray(ids) || ids.length === 0) return null;
        const resolution = resolveInternalAllowedToolIds(ids, internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES);
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
        if (!Array.isArray(parts)) return { content: '', reasoning: '', toolParts: [] };
        const content = parts.filter(p => p.type === 'text').map(p => p.text).join('');
        const reasoning = parts.filter(p => p.type === 'reasoning').map(p => p.text).join('');
        const toolParts = parts.filter(p => p.type === 'tool');
        return { content, reasoning, toolParts };
    }

    async function pollForAssistantResponse(sessionId, timeoutMs, intervalMs = DEFAULT_POLL_INTERVAL_MS) {
        const pollStart = Date.now();
        const startedAt = Date.now();
        // Best-effort snapshot of the most recent in-flight assistant message. Polling
        // observes partial messages: a reasoning model emits its reasoning part first and
        // the text part only afterwards, so returning on the first non-empty snapshot
        // truncates the answer to the reasoning alone. Keep the partial around purely as
        // a timeout fallback and otherwise wait for the message to actually finish.
        let lastPartial = null;
        while (Date.now() - startedAt < timeoutMs) {
            const messagesRes = await client.session.messages({ path: { id: sessionId } });
            const messages = messagesRes?.data || messagesRes || [];
            if (Array.isArray(messages) && messages.length) {
                for (let i = messages.length - 1; i >= 0; i -= 1) {
                    const entry = messages[i];
                    const info = entry?.info;
                    if (info?.role !== 'assistant') continue;
                    const { content, reasoning, toolParts } = extractFromParts(entry?.parts || []);
                    const error = info?.error || null;
                    // finish === 'tool' marks an intermediate turn that pauses for a tool
                    // result; the assistant is not done producing output yet.
                    const finished = info.finish && info.finish !== 'tool';
                    const done = Boolean(finished || info.time?.completed || error);
                    if (toolParts.length > 0) {
                        logDebug('Polling found tool parts', {
                            sessionId,
                            count: toolParts.length,
                            parts: toolParts.map(p => ({
                                id: p.id,
                                tool: p.tool,
                                status: p.state?.status,
                                input: p.state?.input
                            }))
                        });
                    }
                    if (done) {
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
                    if (content || reasoning) {
                        lastPartial = { content, reasoning, error: null };
                    }
                    break;
                }
            }
            await sleep(intervalMs);
        }
        if (lastPartial) {
            logDebug('Polling timeout with partial response', {
                sessionId,
                ms: Date.now() - pollStart,
                contentLen: lastPartial.content.length,
                reasoningLen: lastPartial.reasoning.length
            });
            return lastPartial;
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
        // Tracks internal OpenCode tool calls that are still pending/running. While any
        // tool call is active, the stream must stay open even if no text deltas arrive
        // (the backend is executing the tool). Resolving early here is what previously
        // truncated streaming responses that relied on internal tool execution.
        const activeToolCallIds = new Set();
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
                    // A tool call is still executing on the backend. Keep the stream open
                    // and wait instead of cutting the response short; the follow-up text
                    // (or the final completion) will arrive once the tool finishes.
                    if (activeToolCallIds.size > 0) {
                        logDebug('Event idle while internal tool call is active, continuing to wait', {
                            sessionId,
                            ms: Date.now() - startedAt,
                            activeTools: activeToolCallIds.size
                        });
                        scheduleIdleTimer();
                        return;
                    }
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

            const trackToolActivity = (part) => {
                if (!part || part.type !== 'tool') return;
                const status = part.state?.status;
                if (status === 'pending' || status === 'running') {
                    if (part.id) activeToolCallIds.add(part.id);
                } else if (status === 'completed' || status === 'error') {
                    if (part.id) activeToolCallIds.delete(part.id);
                }
                // Tool activity means the session is still working; treat it as progress
                // so the idle timer does not terminate the stream mid-execution.
                receivedDelta = true;
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                scheduleIdleTimer();
            };

            // Newer OpenCode servers stream deltas as `message.part.delta` events that
            // carry only a `partID` (no `part.type`). The part type is announced by the
            // preceding `message.part.updated` event, so we key partID -> type here and
            // resolve each delta against it. Without this, reasoning and answer text can
            // never be told apart and the answer is mis-routed (or dropped) entirely.
            const partTypeById = new Map();
            const rememberPartType = (part) => {
                if (part && part.id && typeof part.type === 'string') {
                    partTypeById.set(part.id, part.type);
                }
            };
            const applyTextDelta = (partType, delta) => {
                receivedDelta = true;
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                scheduleIdleTimer();
                if (!firstDeltaAt) {
                    firstDeltaAt = Date.now();
                    logDebug('SSE first delta', {
                        sessionId,
                        ms: firstDeltaAt - startedAt,
                        type: partType
                    });
                }
                if (partType === 'reasoning') {
                    reasoning += delta;
                    if (onDelta) onDelta(delta, true);
                } else {
                    content += delta;
                    if (onDelta) onDelta(delta, false);
                }
                deltaChars += delta.length;
            };

            (async () => {
                try {
                    for await (const event of eventStream) {
                        if (event.type === 'message.part.updated' && event.properties.part?.sessionID === sessionId) {
                            const { part, delta } = event.properties;
                            rememberPartType(part);
                            trackToolActivity(part);
                            // Older OpenCode servers carried the streaming delta directly on
                            // message.part.updated; newer servers emit message.part.delta.
                            if (delta) applyTextDelta(part.type, delta);
                            continue;
                        }
                        if (event.type === 'message.part.delta' && event.properties?.sessionID === sessionId) {
                            const { partID, delta, field } = event.properties;
                            // Text and reasoning deltas both stream through field === 'text'.
                            // Tool-input deltas surface via message.part.updated tool state.
                            if (typeof delta === 'string' && field === 'text') {
                                const partType = partTypeById.get(partID);
                                if (partType === 'reasoning' || partType === 'text') {
                                    applyTextDelta(partType, delta);
                                }
                            }
                            continue;
                        }
                        if (event.type === 'message.updated' &&
                            event.properties.info?.sessionID === sessionId) {
                            const info = event.properties.info;
                            const finish = info.finish;
                            // An aborted or failed message never produces another delta. Without
                            // this, the collector waits out the whole first-delta window before
                            // polling rediscovers the same error.
                            if (info.error && !finished) {
                                finished = true;
                                clearTimeout(timeoutId);
                                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                if (idleTimer) clearTimeout(idleTimer);
                                logDebug('SSE upstream message error', {
                                    sessionId,
                                    ms: Date.now() - startedAt,
                                    error: info.error.name || 'UnknownError'
                                });
                                resolve({ content, reasoning, error: info.error });
                                break;
                            }
                            // Reconcile active tool calls from the full message snapshot so we
                            // detect pending tools even when only message.updated fires.
                            if (Array.isArray(info.parts)) {
                                for (const part of info.parts) {
                                    rememberPartType(part);
                                    if (part && part.type === 'tool') {
                                        const status = part.state?.status;
                                        if (status === 'pending' || status === 'running') {
                                            if (part.id) activeToolCallIds.add(part.id);
                                        } else if (status === 'completed' || status === 'error') {
                                            if (part.id) activeToolCallIds.delete(part.id);
                                        }
                                    }
                                }
                            }
                            if (finish === 'tool') {
                                // Assistant turn ended pending a tool call; keep waiting for the result.
                                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                                scheduleIdleTimer();
                                continue;
                            }
                            if (finish === 'stop') {
                                // Only treat the stream as completed when no tool call is still
                                // pending. OpenCode may emit an intermediate 'stop' snapshot while a
                                // tool call is in flight; resolving on it would drop the final answer.
                                if (activeToolCallIds.size > 0) {
                                    logDebug('Ignoring intermediate stop while tools are active', {
                                        sessionId,
                                        activeTools: activeToolCallIds.size
                                    });
                                    continue;
                                }
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
                let id = `chatcmpl-${crypto.randomUUID()}`;
                let keepaliveInterval = null;

                try {
                    const { messages, model, tools = [], tool_choice, stream: requestStream, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stop, reasoning_effort, reasoning, opencode: requestOpencodeConfig } = req.body;
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

                    const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig);
                    const toolMode = requestToolContext.mode;
                    const externalToolContext = requestToolContext.external;
                    const externalToolRegistry = externalToolContext.registry;
                    const externalToolChoice = externalToolContext.toolChoice;
                    const internalToolContext = requestToolContext.internal;
            trackToolMode(toolMode, {
                configuredAllowlist: internalToolContext.allowedToolNames,
                requestedAllowlist: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode,
                route: '/v1/chat/completions'
            });

                    const { parts, system: systemMsg, fullPromptText, lastUserMsg } = await buildPromptParts(messages, externalToolRegistry);
                    const systemWithGuard = buildSystemPrompt(
                        [systemMsg, externalToolContext.prompt].filter(Boolean).join('\n\n'),
                        requestParams.reasoning_effort,
                        toolMode,
                        internalToolContext.allowedToolNames
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
                        internalAllowedTools: internalToolContext.allowedToolNames,
                        requestedInternalTools: internalToolContext.requestedAllowlist,
                        deniedRequestedTools: internalToolContext.deniedRequestedTools,
                        resolutionPath: internalToolContext.resolutionPath,
                        resultingMode: internalToolContext.resultingMode
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

                    id = `chatcmpl-${crypto.randomUUID()}`;
                    keepaliveInterval = null;
                    let completionTokens = 0;
                    let reasoningTokens = 0;

                    const promptParams = {
                        path: { id: sessionId },
                        body: {
                            model: { providerID: pID, modelID: mID },
                            system: systemWithGuard,
                            // Append a short contract reminder as the last part so the model
                            // sees it immediately before generating. With the contract only in
                            // the 16KB+ system prompt it gets buried; position matters a lot for
                            // compliance. deepseek-v4-flash-free: 50% → 100% call rate.
                            parts: externalToolContext.reminder
                                ? [...parts, { type: 'text', text: externalToolContext.reminder }]
                                : parts,
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

                    const makeForcedChatToolCallRequester = () => createForcedToolCallRequester({
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
                    let requestForcedChatToolCall = makeForcedChatToolCallRequester();

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
                                streamedReasoning += filtered;
                                reasoningTokens += Math.ceil(filtered.length / 4);
                            } else {
                                streamedContent += filtered;
                                completionTokens += Math.ceil(filtered.length / 4);
                            }
                            // Reasoning and answer are streamed as separate fields so clients
                            // that read `reasoning_content` (DeepSeek/Qwen-style) see the thinking
                            // without it polluting `content`.
                            const deltaField = isReasoning
                                ? { reasoning_content: filtered }
                                : { content: filtered };
                            const chunk = {
                                id,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: `${pID}/${mID}`,
                                choices: [{ index: 0, delta: deltaField, finish_reason: null }]
                            };
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        };

                        let collected = null;
                        for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                            if (attempt > 1) {
                                // Retry on a fresh session: the failed attempt left an errored
                                // assistant message in the old one, and re-prompting the same
                                // session would append a duplicate user turn to the context.
                                // Safe to rotate because nothing has been streamed yet.
                                try {
                                    await client.session.delete({ path: { id: sessionId } });
                                } catch (e) {
                                    logDebug('Failed to delete retried session', { sessionId, error: e.message });
                                }
                                const retrySessionRes = await client.session.create();
                                sessionId = retrySessionRes.data?.id;
                                if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
                                promptParams.path.id = sessionId;
                                requestForcedChatToolCall = makeForcedChatToolCallRequester();
                                streamedContent = '';
                                streamedReasoning = '';
                                rawStreamedContent = '';
                                rawStreamedReasoning = '';
                                streamedToolCalls.length = 0;
                                completionTokens = 0;
                                reasoningTokens = 0;
                                await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                            }
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

                            const attemptError = collected?.error || collected?.__error || null;
                            const nothingStreamed = !rawStreamedContent
                                && !rawStreamedReasoning
                                && streamedToolCalls.length === 0;
                            if (
                                attemptError
                                && nothingStreamed
                                && attempt < RETRY_MAX_ATTEMPTS
                                && isTransientUpstreamError(attemptError)
                            ) {
                                console.warn(`[Proxy] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`, attemptError.data?.message || attemptError.message || attemptError.name || 'unknown');
                                continue;
                            }
                            break;
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
                        } else if (streamedReasoning && !streamedContent) {
                            // Reconciliation for reasoning models: the reasoning streamed but the
                            // answer text never arrived because every delta was tagged as reasoning
                            // (issue #9). The message snapshot separates the two correctly, so
                            // recover the missing answer from it instead of returning empty content.
                            logDebug('Reasoning streamed but no content, reconciling from snapshot', { sessionId });
                            const snapshot = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS).catch(() => null);
                            if (snapshot && snapshot.content) {
                                const remainingContent = rawStreamedContent
                                    ? snapshot.content.slice(rawStreamedContent.length)
                                    : snapshot.content;
                                if (remainingContent) sendDelta(remainingContent, false);
                            }
                        }

                        // Flush held buffers from the stream parsers and filters before final batch parse.
                        const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
                        const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
                        const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
                        const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
                        const finalReasoningText = rawStreamedReasoning + flushedReasoningText;
                        const finalContentText = rawStreamedContent + flushedContentText;

                        // Parse each channel, then retry on the two joined. Models sometimes open a
                        // block in reasoning and close it in content, leaving neither channel with a
                        // complete block. The joined retry only runs when nothing was found, so a
                        // block contained in one channel is never counted twice.
                        const parseStreamedToolCalls = () => {
                            if (externalToolRegistry.length === 0) return [];
                            const perChannel = [
                                ...flushedReasoningCalls,
                                ...flushedContentCalls,
                                ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText)
                            ];
                            if (perChannel.length > 0) return perChannel;
                            return parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText);
                        };

                        let parsedToolCalls = streamedToolCalls.length > 0
                            ? streamedToolCalls
                            : parseStreamedToolCalls();
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
                        let content = '';
                        let reasoning = '';
                        let error = null;
                        for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                            if (attempt > 1) {
                                // Retry on a fresh session: the failed attempt left an errored
                                // assistant message in the old one, and re-prompting the same
                                // session would append a duplicate user turn to the context.
                                try {
                                    await client.session.delete({ path: { id: sessionId } });
                                } catch (e) {
                                    logDebug('Failed to delete retried session', { sessionId, error: e.message });
                                }
                                const retrySessionRes = await client.session.create();
                                sessionId = retrySessionRes.data?.id;
                                if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
                                promptParams.path.id = sessionId;
                                requestForcedChatToolCall = makeForcedChatToolCallRequester();
                                await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                            }
                            const attemptStart = Date.now();
                            await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                            logDebug('Prompt sent', { sessionId, ms: Date.now() - attemptStart, attempt });
                            const collected = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            content = collected.content || '';
                            reasoning = collected.reasoning || '';
                            error = collected.error || null;
                            // Bounded retry for upstream throttling mislabeled as billing
                            // errors (401 CreditsError etc.); only when nothing usable was
                            // produced, so real failures still surface after RETRY_MAX_ATTEMPTS.
                            if (
                                error
                                && !content
                                && !reasoning
                                && attempt < RETRY_MAX_ATTEMPTS
                                && isTransientUpstreamError(error)
                            ) {
                                console.warn(`[Proxy] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`, error.data?.message || error.message || error.name || 'unknown');
                                continue;
                            }
                            break;
                        }
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

                        const publicValidatedToolCalls = toPublicToolCalls(validatedToolCalls);
                        // Reasoning is emitted in its own `reasoning_content` field so clients
                        // can surface the thinking without it being wrapped in <think> tags and
                        // mixed into the answer `content`.
                        const assistantMessage = {
                            role: 'assistant',
                            content: publicValidatedToolCalls.length > 0
                                ? (safeContent || null)
                                : safeContent,
                            ...(safeReasoning ? { reasoning_content: safeReasoning } : {})
                        };
                        if (publicValidatedToolCalls.length > 0) {
                            assistantMessage.tool_calls = publicValidatedToolCalls;
                        }

                        res.json({
                            id: `chatcmpl-${crypto.randomUUID()}`,
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

                    if (keepaliveInterval) clearInterval(keepaliveInterval);

                    if (!res.headersSent) {
                        const transformed = transformUpstreamError(error);
                        res.status(transformed.statusCode).json(transformed.error);
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

    const hasValidBearerAuth = (req) => {
        if (!API_KEY || API_KEY.trim() === '') return true;
        const authHeader = req.headers.authorization;
        const apiKeyHeader = req.headers['x-api-key'];
        return Boolean((authHeader && authHeader === `Bearer ${API_KEY}`) || (apiKeyHeader && apiKeyHeader === API_KEY));
    };

    const shouldAllowOperationalEndpoint = (req, { enabled, requireAuth }) => {
        if (!enabled) return false;
        if (!requireAuth) return true;
        return hasValidBearerAuth(req);
    };

    app.get('/health', (_req, res) => res.json({
        status: 'ok',
        proxy: true
    }));

    app.get('/health/details', (req, res) => {
        if (!shouldAllowOperationalEndpoint(req, {
            enabled: HEALTH_DETAILS_ENABLED,
            requireAuth: HEALTH_DETAILS_REQUIRE_AUTH
        })) {
            return res.status(HEALTH_DETAILS_ENABLED ? 401 : 404).json({
                error: { message: HEALTH_DETAILS_ENABLED ? 'Unauthorized' : 'Not found' }
            });
        }
        const metricsSnapshot = INTERNAL_TOOL_METRICS_ENABLED ? { ...internalToolMetrics } : null;
        res.json({
            status: 'ok',
            proxy: true,
            internal_tools: {
                config: {
                    allowed_tools: SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
                    metrics_enabled: INTERNAL_TOOL_METRICS_ENABLED,
                    discovery_fixture: normalizeConfiguredToolNames(INTERNAL_TOOL_DISCOVERY_FIXTURE)
                },
                metrics: metricsSnapshot,
                cache: {
                    tool_ids_cached: !!cachedToolIds,
                    tool_id_count: cachedToolIds ? cachedToolIds.length : 0,
                    age_ms: cachedToolIdsAt ? Date.now() - cachedToolIdsAt : null
                },
                audit: {
                    available: true,
                    fields: [
                        'requestedAllowlist',
                        'allowedToolNames',
                        'deniedRequestedTools',
                        'resolutionPath',
                        'resultingMode'
                    ]
                }
            }
        });
    });

    app.get('/metrics', (req, res) => {
        if (!shouldAllowOperationalEndpoint(req, {
            enabled: METRICS_ENABLED,
            requireAuth: METRICS_REQUIRE_AUTH
        })) {
            return res.status(METRICS_ENABLED ? 401 : 404).send(METRICS_ENABLED ? 'Unauthorized' : 'Not found');
        }

        const metricsLines = [
            '# HELP opencode_internal_tool_mode_requests_total Count of internal tool mode selections by mode.',
            '# TYPE opencode_internal_tool_mode_requests_total counter',
            `opencode_internal_tool_mode_requests_total{mode="external_bridge"} ${internalToolMetrics.externalBridgeRequests}`,
            `opencode_internal_tool_mode_requests_total{mode="internal_allowlist"} ${internalToolMetrics.internalAllowlistRequests}`,
            `opencode_internal_tool_mode_requests_total{mode="disabled"} ${internalToolMetrics.disabledRequests}`,
            '# HELP opencode_internal_tool_discovery_failures_total Count of backend tool discovery failures.',
            '# TYPE opencode_internal_tool_discovery_failures_total counter',
            `opencode_internal_tool_discovery_failures_total ${internalToolMetrics.discoveryFailures}`,
            '# HELP opencode_internal_tool_fallback_disabled_total Count of allowlist resolutions that fell back to disabled.',
            '# TYPE opencode_internal_tool_fallback_disabled_total counter',
            `opencode_internal_tool_fallback_disabled_total ${internalToolMetrics.fallbackToDisabled}`,
            '# HELP opencode_internal_tool_cache_ids Number of cached backend tool IDs.',
            '# TYPE opencode_internal_tool_cache_ids gauge',
            `opencode_internal_tool_cache_ids ${cachedToolIds ? cachedToolIds.length : 0}`
        ];

        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(`${metricsLines.join('\n')}\n`);
    });

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
                prompt,
                previous_response_id: previousResponseId,
                opencode: requestOpencodeConfig
            } = req.body;

            // Stateful continuation: reuse the session behind a previous response so the
            // client only needs to send the new turn (OpenAI Responses API semantics).
            const previousState = previousResponseId ? getResponseState(previousResponseId) : null;
            if (previousResponseId && !previousState) {
                return res.status(400).json({ error: { message: 'Invalid or expired previous_response_id' } });
            }

            const reasoningLevel = normalizeReasoningEffort(
                reasoning_effort || requestReasoning?.effort,
                null
            );

            const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig);
            const toolMode = requestToolContext.mode;
            const internalToolContext = requestToolContext.internal;
            trackToolMode(toolMode, {
                configuredAllowlist: internalToolContext.allowedToolNames,
                requestedAllowlist: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode,
                route: '/v1/responses'
            });
            logDebug('Responses API request', { 
                model, 
                reasoning_effort: reasoning_effort || requestReasoning?.effort,
                reasoningLevel,
                max_output_tokens,
                toolMode,
                internalAllowedTools: internalToolContext.allowedToolNames,
                requestedInternalTools: internalToolContext.requestedAllowlist,
                deniedRequestedTools: internalToolContext.deniedRequestedTools,
                resolutionPath: internalToolContext.resolutionPath,
                resultingMode: internalToolContext.resultingMode
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

            const resolvedModel = await resolveRequestedModel(model || previousState?.model);
            const pID = resolvedModel.providerID;
            const mID = resolvedModel.modelID;

            await ensureBackend(config);

            try {
                await client.config.update({
                    body: { activeModel: { providerID: pID, modelID: mID } }
                });
            } catch (e) { }

            // Continue the stored session when chaining from previous_response_id;
            // otherwise start a fresh one.
            let sessionId = previousState?.sessionId || null;
            if (!sessionId) {
                const sessionRes = await client.session.create();
                sessionId = sessionRes.data?.id;
                if (!sessionId) {
                    throw new Error('Failed to create OpenCode session');
                }
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
                toolMode,
                internalToolContext.allowedToolNames
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
                    parts: externalToolContext.reminder
                        ? [...parts, { type: 'text', text: externalToolContext.reminder }]
                        : parts,
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

            const buildResponsesMessageOutputItem = (text, messageId = `msg_${crypto.randomUUID()}`) => {
                if (!text) return null;
                return {
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                        {
                            type: 'output_text',
                            text,
                            annotations: []
                        }
                    ]
                };
            };

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                const responseId = `resp_${crypto.randomUUID()}`;
                const messageOutputIndex = 0;
                const reasoningOutputIndex = 1;
                const contentIndex = 0;
                const outputItemId = `msg_${crypto.randomUUID()}`;
                const reasoningItemId = 'reasoning-0';
                let nextOutputIndex = 2;
                let sequenceNumber = 0;
                let announcedOutput = false;
                let announcedContent = false;
                let announcedReasoning = false;
                const nextSeq = () => sequenceNumber++;
                const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

                const createdAt = Math.floor(Date.now() / 1000);
                emit({
                    type: 'response.created',
                    sequence_number: nextSeq(),
                    response: { id: responseId, object: 'response', created: createdAt, created_at: createdAt, status: 'in_progress', model: `${pID}/${mID}` }
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
                            part: { type: 'output_text', text: '', annotations: [] }
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
                    if (parsedDeltaToolCalls.length > 0) {
                        const { validCalls: allowedDeltaToolCalls } = finalizeValidatedToolCalls(parsedDeltaToolCalls, externalToolRegistry);
                        allowedDeltaToolCalls.forEach((toolCall) => emitResponsesFunctionCall(toolCall));
                    }
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
                        part: { type: 'output_text', text: content, annotations: [] }
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
                            content: [{ type: 'output_text', text: content, annotations: [] }]
                        }
                    });
                }

                let polledForToolCalls = null;
                if (externalToolRegistry.length > 0 && streamedToolCalls.length === 0) {
                    try {
                        polledForToolCalls = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                    } catch (e) { }
                }

                // Flush held buffers from the stream parsers and filters before final batch parse.
                const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
                const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
                const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
                const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
                const finalReasoningText = (polledForToolCalls?.reasoning || rawReasoning) + flushedReasoningText;
                const finalContentText = (polledForToolCalls?.content || rawContent) + flushedContentText;

                // Parse each channel, then retry on the two joined. See the matching comment
                // in /v1/chat/completions for why the joined retry is gated on finding nothing.
                const parseStreamedToolCalls = () => {
                    if (externalToolRegistry.length === 0) return [];
                    const perChannel = [
                        ...flushedReasoningCalls,
                        ...flushedContentCalls,
                        ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText)
                    ];
                    if (perChannel.length > 0) return perChannel;
                    return parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText);
                };

                let parsedToolCalls = streamedToolCalls.length > 0
                    ? streamedToolCalls
                    : parseStreamedToolCalls();
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
                const streamMessageOutputItem = buildResponsesMessageOutputItem(safeContent && safeContent.trim() ? safeContent : '', outputItemId);
                if (streamMessageOutputItem) streamOutput.push(streamMessageOutputItem);
                validatedStreamedToolCalls.forEach((toolCall) => {
                    streamOutput.push(buildResponsesFunctionCallOutputItem(toolCall));
                });
                const promptTokens = Math.ceil(fullPromptText.length / 4);
                const completionTokens = Math.ceil(content.length / 4);
                const reasoningTokens = Math.ceil(reasoning.length / 4);
                const completedAt = Math.floor(Date.now() / 1000);
                const response = {
                    id: responseId,
                    object: 'response',
                    created: completedAt,
                    created_at: completedAt,
                    status: 'completed',
                    model: `${pID}/${mID}`,
                    reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
                    output: streamOutput,
                    error: null,
                    incomplete_details: null,
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
                storeResponseState(responseId, sessionId, `${pID}/${mID}`);
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

            const responseId = `resp_${crypto.randomUUID()}`;
            const createdAt = Math.floor(Date.now() / 1000);
            const response = {
                id: responseId,
                object: 'response',
                created: createdAt,
                created_at: createdAt,
                status: 'completed',
                model: `${pID}/${mID}`,
                reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
                output,
                error: null,
                incomplete_details: null,
                usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens + reasoningTokens,
                    total_tokens: promptTokens + completionTokens + reasoningTokens,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: reasoningTokens }
                }
            };

            storeResponseState(responseId, sessionId, `${pID}/${mID}`);

            return res.json(response);
        } catch (error) {
            console.error('[Proxy] Responses API Error:', error?.message || error?.data?.message || error?.name || error);
            const transformed = transformUpstreamError(error);
            // Once the SSE headers are out, res.json() throws ERR_HTTP_HEADERS_SENT. That throw
            // escapes this async handler as an unhandled rejection, which terminates the whole
            // process under Node's default --unhandled-rejections=throw. Report the failure on
            // the already-open stream instead.
            if (res.headersSent) {
                try {
                    const failedAt = Math.floor(Date.now() / 1000);
                    res.write(`data: ${JSON.stringify({
                        type: 'response.failed',
                        response: { id: `resp_${crypto.randomUUID()}`, object: 'response', created: failedAt, created_at: failedAt, status: 'failed', error: transformed.error.error || transformed.error }
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                } catch (writeError) {
                    logDebug('Failed to report error on open response stream', { error: writeError.message });
                }
                return res.end();
            }
            return res.status(transformed.statusCode).json(transformed.error);
        }
    });

    // Anthropic Messages API (P0: non-stream + stream via shared opencode backend)
    app.post('/v1/messages', async (req, res) => {
        try {
            await lock(async () => {
                let sessionId = null;
                let keepaliveInterval = null;
                try {
                    const validationError = validateMessagesRequest(req.body);
                    if (validationError) {
                        return res.status(validationError.statusCode).json(validationError.body);
                    }
                    const {
                        model, system, messages, tools = [], tool_choice,
                        stream: requestStream, temperature, top_p, top_k,
                        max_tokens, stop_sequences, thinking
                    } = req.body;
                    const stream = Boolean(requestStream);
                    const chatMessages = anthropicMessagesToChatMessages(messages);
                    const systemText = extractSystemText(system);
                    if (systemText) chatMessages.unshift({ role: 'system', content: systemText });
                    const chatTools = anthropicToolsToChatTools(tools);
                    const chatToolChoice = anthropicToolChoiceToChat(tool_choice);
                    const reasoningLevel = anthropicThinkingToReasoningEffort(thinking)
                        || normalizeReasoningEffort(undefined, null);

                    const requestParams = {
                        temperature: typeof temperature === 'number' ? temperature : 0.7,
                        max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
                        top_p: typeof top_p === 'number' ? top_p : 1.0,
                        stop: Array.isArray(stop_sequences) ? stop_sequences : null,
                        reasoning_effort: reasoningLevel
                    };
                    if (top_k !== undefined) logDebug('Ignoring top_k (no opencode equivalent)', { top_k });

                    const resolvedModel = await resolveRequestedModel(model);
                    const pID = resolvedModel.providerID;
                    const mID = resolvedModel.modelID;
                    const publicModel = `${pID}/${mID}`;

                    const requestToolContext = createRequestToolContext(chatTools, chatToolChoice, undefined);
                    const toolMode = requestToolContext.mode;
                    const externalToolContext = requestToolContext.external;
                    const externalToolRegistry = externalToolContext.registry;
                    const externalToolChoice = externalToolContext.toolChoice;
                    const internalToolContext = requestToolContext.internal;
                    trackToolMode(toolMode, { route: '/v1/messages' });

                    // Reuse chat-style prompt flattening for the converted messages.
                    const parts = [];
                    const systemChunks = [];
                    const assistantToolCalls = new Map();
                    const formatRoleLine = (role, name, text) => `${String(role).toUpperCase()}${name ? `(${name})` : ''}: ${text}`;
                    for (const m of chatMessages) {
                        const role = (m?.role || 'user').toLowerCase();
                        const content = m?.content;
                        if (role === 'system') {
                            const text = normalizeTextContent(content);
                            if (text) systemChunks.push(text);
                            continue;
                        }
                        if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
                            const serialized = m.tool_calls.map((tc, i) => ({
                                id: tc?.id || `toolu_${i + 1}`,
                                name: findExternalToolByName(externalToolRegistry, tc?.function?.name || tc?.name)?.namespacedName || tc?.function?.name || tc?.name,
                                arguments: normalizeToolArguments(tc?.function?.arguments ?? tc?.arguments)
                            })).filter((tc) => tc.name);
                            serialized.forEach((tc) => assistantToolCalls.set(tc.id, tc.name));
                            if (serialized.length) parts.push({ type: 'text', text: `ASSISTANT: <function_calls>${JSON.stringify(serialized)}</function_calls>` });
                        }
                        if (role === 'tool') {
                            const text = normalizeTextContent(content);
                            if (text) {
                                const mapped = findExternalToolByName(externalToolRegistry, m?.name)
                                    || findExternalToolByName(externalToolRegistry, assistantToolCalls.get(m?.tool_call_id));
                                const toolName = mapped?.namespacedName || assistantToolCalls.get(m?.tool_call_id) || m?.name || `${EXTERNAL_TOOL_PREFIX}unknown`;
                                parts.push({ type: 'text', text: `TOOL_RESULT: ${JSON.stringify({ tool_call_id: m?.tool_call_id || toolName, name: toolName, content: text })}` });
                            }
                            continue;
                        }
                        if (!content) continue;
                        if (typeof content === 'string') {
                            parts.push({ type: 'text', text: formatRoleLine(role, m?.name, content) });
                        } else if (Array.isArray(content)) {
                            for (const part of content) {
                                if (!part) continue;
                                if (part.type === 'text') parts.push({ type: 'text', text: formatRoleLine(role, m?.name, part.text || '') });
                                else if (part.type === 'image_url') {
                                    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                                    if (imageUrl) {
                                        try {
                                            const dataUri = await getImageDataUri(imageUrl);
                                            parts.push({ type: 'file', mime: dataUri.split(';')[0].split(':')[1], url: dataUri, filename: 'image' });
                                        } catch (e) { logDebug('Skipping image', { error: e.message }); }
                                    }
                                }
                            }
                        }
                    }
                    if (!parts.length) return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages must include at least one text message' } });

                    const systemWithGuard = buildSystemPrompt(
                        [systemChunks.join('\n\n'), externalToolContext.prompt].filter(Boolean).join('\n\n'),
                        requestParams.reasoning_effort, toolMode, internalToolContext.allowedToolNames
                    );
                    await ensureBackend(config);
                    try {
                        await client.config.update({ body: { activeModel: { providerID: pID, modelID: mID } } });
                    } catch (e) { logDebug('Failed to set active model', { error: e.message }); }
                    const sessionRes = await client.session.create();
                    sessionId = sessionRes.data?.id;
                    if (!sessionId) throw new Error('Failed to create OpenCode session');

                    const promptParams = {
                        path: { id: sessionId },
                        body: {
                            model: { providerID: pID, modelID: mID },
                            system: systemWithGuard,
                            parts: externalToolContext.reminder ? [...parts, { type: 'text', text: externalToolContext.reminder }] : parts,
                            ...(requestParams.max_tokens && { max_tokens: requestParams.max_tokens }),
                            ...(requestParams.temperature !== undefined && { temperature: requestParams.temperature }),
                            ...(requestParams.top_p !== undefined && { top_p: requestParams.top_p }),
                            ...(requestParams.stop && { stop: requestParams.stop })
                        }
                    };
                    const toolOverrides = await getToolOverridesForMode(toolMode, internalToolContext);
                    if (toolOverrides && Object.keys(toolOverrides).length > 0) promptParams.body.tools = toolOverrides;

                    const fullPromptText = parts.map((p) => p.text || '').join('\n\n');
                    const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
                    const inputTokens = estimateTokens(fullPromptText + (systemWithGuard || ''));

                    const makeForcedMessagesToolCallRequester = () => createForcedToolCallRequester({
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
                    let requestForcedMessagesToolCall = makeForcedMessagesToolCallRequester();

                    const finalizeAnthropic = (content, reasoning, validatedToolCalls) => {
                        const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                        const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));
                        const publicCalls = toPublicToolCalls(validatedToolCalls);
                        // Map public tool calls back to Anthropic tool_use (preserve toolu_ ids from history when possible).
                        const anthropicTools = publicCalls.map((tc) => {
                            let input = {};
                            try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
                            return { id: tc.id, function: { name: tc.function.name, arguments: tc.function.arguments }, _input: input };
                        });
                        // Token counts are estimates (chars/4); the backend does not surface
                        // real usage or a truncation signal, so stop_reason is derived from
                        // tool calls only and never inferred from max_tokens.
                        const outputTokens = estimateTokens(safeContent + safeReasoning + JSON.stringify(anthropicTools));
                        const stopReason = mapFinishToStopReason('stop', anthropicTools.length > 0);
                        return buildAnthropicMessage({
                            messageId, model: publicModel, text: safeContent || '',
                            reasoning: safeReasoning || '', toolCalls: anthropicTools,
                            stopReason, inputTokens, outputTokens
                        });
                    };

                    if (!stream) {
                        let content = '';
                        let reasoning = '';
                        let error = null;
                        for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                            if (attempt > 1) {
                                try { await client.session.delete({ path: { id: sessionId } }); } catch {}
                                const r = await client.session.create();
                                sessionId = r.data?.id;
                                promptParams.path.id = sessionId;
                                requestForcedMessagesToolCall = makeForcedMessagesToolCallRequester();
                                await sleep(RETRY_BACKOFF_BASE_MS * attempt);
                            }
                            await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                            const collected = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                            content = collected.content || '';
                            reasoning = collected.reasoning || '';
                            error = collected.error || null;
                            if (error && !content && !reasoning && attempt < RETRY_MAX_ATTEMPTS && isTransientUpstreamError(error)) continue;
                            break;
                        }
                        if (error && !content && !reasoning) {
                            const t = transformUpstreamError(error);
                            return res.status(502).json({ type: 'error', error: { type: 'api_error', message: t.error?.error?.message || t.error?.message || 'Upstream error' } });
                        }
                        let parsed = externalToolRegistry.length > 0 ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content) : [];
                        if (parsed.length === 0 && externalToolChoice.mode === 'required') {
                            const forcedResponse = await requestForcedMessagesToolCall();
                            if (forcedResponse) {
                                content = forcedResponse.content || content;
                                reasoning = forcedResponse.reasoning || reasoning;
                                parsed = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
                            }
                        }
                        const { validCalls } = finalizeValidatedToolCalls(parsed, externalToolRegistry);
                        return res.json(finalizeAnthropic(content, reasoning, validCalls));
                    }

                    // Stream: Anthropic SSE (message_start/content_block_*/message_delta/message_stop, no [DONE])
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    keepaliveInterval = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
                    const reqClosed = new Promise((resolve) => req.on('close', () => resolve(true)));
                    let streamedText = '';
                    let streamedReasoning = '';
                    let rawContent = '';
                    let rawReasoning = '';
                    const streamedToolCalls = [];
                    const filterContent = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: externalToolRegistry.length > 0 });
                    const filterReasoning = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: externalToolRegistry.length > 0 });
                    const parseContent = createExternalToolCallStreamParser(externalToolRegistry);
                    const parseReason = createExternalToolCallStreamParser(externalToolRegistry);
                    let textBlockOpen = false;
                    let thinkingBlockOpen = false;
                    let nextBlockIndex = 0;
                    let textIndex = null;
                    let thinkingIndex = null;
                    const ensureTextIndex = () => {
                        if (textIndex === null) textIndex = nextBlockIndex++;
                        return textIndex;
                    };
                    const ensureThinkingIndex = () => {
                        if (thinkingIndex === null) thinkingIndex = nextBlockIndex++;
                        return thinkingIndex;
                    };
                    res.write(sseEvent('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: publicModel, content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }));
                    const sendTextDelta = (delta) => {
                        if (!delta) return;
                        const idx = ensureTextIndex();
                        if (!textBlockOpen) {
                            res.write(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }));
                            textBlockOpen = true;
                        }
                        streamedText += delta;
                        res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: delta } }));
                    };
                    const sendReasoningDelta = (delta) => {
                        if (!delta) return;
                        const idx = ensureThinkingIndex();
                        if (!thinkingBlockOpen) {
                            res.write(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } }));
                            thinkingBlockOpen = true;
                        }
                        streamedReasoning += delta;
                        res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: delta } }));
                    };
                    const sendDelta = (delta, isReasoning = false) => {
                        if (!delta) return;
                        if (isReasoning) rawReasoning += delta; else rawContent += delta;
                        const parsedCalls = isReasoning ? parseReason(delta) : parseContent(delta);
                        parsedCalls.forEach((tc) => streamedToolCalls.push(tc));
                        const filtered = isReasoning ? filterReasoning(delta) : filterContent(delta);
                        if (!filtered) return;
                        if (isReasoning) sendReasoningDelta(filtered);
                        else sendTextDelta(filtered);
                    };
                    let collected = null;
                    const collectPromise = collectFromEvents(sessionId, REQUEST_TIMEOUT_MS, sendDelta, DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS, DEFAULT_EVENT_IDLE_TIMEOUT_MS)
                        .catch((err) => ({ __error: err }));
                    client.session.prompt(promptParams).catch((err) => logDebug('Prompt error:', err.message));
                    collected = await Promise.race([collectPromise, reqClosed.then(() => ({ __cancelled: true }))]);
                    if (collected?.__cancelled) {
                        if (keepaliveInterval) clearInterval(keepaliveInterval);
                        try { if (sessionId) await client.session.delete({ path: { id: sessionId } }); } catch (e) { logDebug('Failed to cleanup cancelled messages session', { error: e.message }); }
                        try { if (!res.destroyed) res.end(); } catch {}
                        return;
                    }
                    if (collected?.__error) {
                        const { content, reasoning } = await pollForAssistantResponse(sessionId, REQUEST_TIMEOUT_MS);
                        if (content && !rawContent) sendTextDelta(stripFunctionCallMarkup(content));
                        if (reasoning && !rawReasoning) sendReasoningDelta(stripFunctionCallMarkup(reasoning));
                    }
                    if (textBlockOpen) res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
                    if (thinkingBlockOpen) res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: thinkingIndex }));
                    // Flush held buffers before final parse (mirrors /v1/chat/completions).
                    const flushedReasoningCalls = parseReason.flush ? parseReason.flush() : [];
                    const flushedContentCalls = parseContent.flush ? parseContent.flush() : [];
                    const flushedReasoningText = filterReasoning.flush ? filterReasoning.flush() : '';
                    const flushedContentText = filterContent.flush ? filterContent.flush() : '';
                    const finalReasoningText = rawReasoning + flushedReasoningText;
                    const finalContentText = rawContent + flushedContentText;
                    const parseStreamedToolCalls = () => {
                        if (externalToolRegistry.length === 0) return [];
                        const perChannel = [
                            ...flushedReasoningCalls,
                            ...flushedContentCalls,
                            ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText)
                        ];
                        if (perChannel.length > 0) return perChannel;
                        return parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText);
                    };
                    // Exclusive: incremental hits already describe the same markup that a
                    // full re-parse would find again, so never combine both (else 1 call -> 2 blocks).
                    let parsedToolCalls = streamedToolCalls.length > 0
                        ? [...streamedToolCalls, ...flushedReasoningCalls, ...flushedContentCalls]
                        : parseStreamedToolCalls();
                    if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                        const forcedResponse = await requestForcedMessagesToolCall();
                        if (forcedResponse) {
                            parsedToolCalls = parseExternalToolCallsFromText(
                                externalToolRegistry,
                                forcedResponse.reasoning,
                                forcedResponse.content
                            );
                        }
                    }
                    const { validCalls: finalValidated } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
                    let toolBlockIndex = nextBlockIndex;
                    for (const tc of toPublicToolCalls(finalValidated)) {
                        res.write(sseEvent('content_block_start', { type: 'content_block_start', index: toolBlockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } }));
                        res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: toolBlockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } }));
                        res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: toolBlockIndex }));
                        toolBlockIndex += 1;
                    }
                    const outputTokens = estimateTokens(streamedText + streamedReasoning);
                    const stopReason = mapFinishToStopReason('stop', finalValidated.length > 0);
                    res.write(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }));
                    res.write(sseEvent('message_stop', { type: 'message_stop' }));
                    if (keepaliveInterval) clearInterval(keepaliveInterval);
                    return res.end();
                } catch (error) {
                    if (keepaliveInterval) clearInterval(keepaliveInterval);
                    if (sessionId) {
                        try { await client.session.delete({ path: { id: sessionId } }); } catch (e) { logDebug('Failed to cleanup messages session on error', { error: e.message }); }
                    }
                    if (!res.headersSent) {
                        const t = transformUpstreamError(error);
                        return res.status(t.statusCode).json({ type: 'error', error: { type: 'api_error', message: t.error?.error?.message || t.error?.message || error.message } });
                    }
                    try {
                        res.write(sseEvent('error', { type: 'error', error: { type: 'api_error', message: error.message } }));
                    } catch {}
                    return res.end();
                }
            }, REQUEST_TIMEOUT_MS + 20000);
        } catch (error) {
            if (!res.headersSent) res.status(500).json({ type: 'error', error: { type: 'api_error', message: error.message } });
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
        INTERNAL_WEB_FETCH_ENABLED: normalizeBool(options.INTERNAL_WEB_FETCH_ENABLED) ??
            normalizeBool(process.env.OPENCODE_INTERNAL_WEB_FETCH_ENABLED) ??
            false,
        INTERNAL_ALLOWED_TOOLS: Array.isArray(options.INTERNAL_ALLOWED_TOOLS)
            ? options.INTERNAL_ALLOWED_TOOLS
            : typeof process.env.OPENCODE_INTERNAL_ALLOWED_TOOLS === 'string'
                ? process.env.OPENCODE_INTERNAL_ALLOWED_TOOLS.split(',').map(entry => entry.trim()).filter(Boolean)
                : [],
        INTERNAL_TOOL_METRICS_ENABLED: normalizeBool(options.INTERNAL_TOOL_METRICS_ENABLED) ??
            normalizeBool(process.env.OPENCODE_INTERNAL_TOOL_METRICS_ENABLED) ??
            true,
        INTERNAL_TOOL_DISCOVERY_FIXTURE: Array.isArray(options.INTERNAL_TOOL_DISCOVERY_FIXTURE)
            ? options.INTERNAL_TOOL_DISCOVERY_FIXTURE
            : typeof process.env.OPENCODE_TOOL_DISCOVERY_FIXTURE === 'string'
                ? process.env.OPENCODE_TOOL_DISCOVERY_FIXTURE.split(',').map(entry => entry.trim()).filter(Boolean)
                : [],
        HEALTH_DETAILS_ENABLED: normalizeBool(options.HEALTH_DETAILS_ENABLED) ??
            normalizeBool(process.env.OPENCODE_HEALTH_DETAILS_ENABLED) ??
            true,
        HEALTH_DETAILS_REQUIRE_AUTH: normalizeBool(options.HEALTH_DETAILS_REQUIRE_AUTH) ??
            normalizeBool(process.env.OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH) ??
            true,
        METRICS_ENABLED: normalizeBool(options.METRICS_ENABLED) ??
            normalizeBool(process.env.OPENCODE_METRICS_ENABLED) ??
            false,
        METRICS_REQUIRE_AUTH: normalizeBool(options.METRICS_REQUIRE_AUTH) ??
            normalizeBool(process.env.OPENCODE_METRICS_REQUIRE_AUTH) ??
            true,
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

// --- Mutex Logic with Timeout ---
