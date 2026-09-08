// P4 TS: thin proxy core (ported from P3 .js, behavior identical).
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Application, Request, Response, NextFunction } from 'express';
import { buildExternalToolRegistry, findExternalToolByName } from './tool-runtime/registry.js';
import { EXTERNAL_TOOL_PREFIX } from './tool-runtime/contracts.js';
import { resolveMaxRetries, computeRetryDelay } from './retry/policy.js';
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
  estimateTokens,
} from './converters/anthropic.js';
import { buildToolExposure } from './tool-runtime/router.js';
import { evaluateToolPolicy } from './tool-runtime/policy.js';
import { validateToolCalls } from './tool-runtime/validator.js';
import {
  stripFunctionCallMarkup,
  parseExternalToolCallsFromText,
  createToolCallFilter,
  createExternalToolCallStreamParser,
} from './tool-runtime/parser.js';
import type { ExternalToolEntry } from './tool-runtime/registry.js';
import type { ValidatedToolCall } from './tool-runtime/validator.js';
import type { FinalToolCall } from './tool-runtime/parser.js';

import {
  normalizeBool,
  resolveDisableTools,
  withTimeout,
  buildProxyConfig,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './config/proxy-config.js';
import { buildBackendAuthHeaders, ensureBackend, backendState } from './backend/manager.js';
import { createCollector } from './stream/collector.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerResponsesRoutes } from './routes/responses.js';
import { registerMessagesRoutes } from './routes/messages.js';
import { registerSystemRoutes, registerNotFoundRoute } from './routes/system.js';
import type { ProxyConfig } from './types/config.js';
import type {
  AppContext,
  CreateAppResult,
  StartProxyResult,
  ForcedToolCallRequesterOptions,
  InternalToolMetrics,
} from './types/context.js';
import type { ProxyClient, ProviderInfo, ModelInfo, ResolvedModel } from './types/client.js';
import type { ResponseStateEntry } from './types/backend.js';

// P4: thin re-exports to preserve original import paths
// (tests/env-alias.test.js, stream-hardening.test.js import these from '../src/proxy.js').
export { normalizeBool, resolveDisableTools, withTimeout };

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const r = asRecord(e);
  const m: unknown = r['message'];
  return typeof m === 'string' ? m : String(e);
}

export function createApp(config: ProxyConfig): CreateAppResult {
  const {
    API_KEY,
    OPENCODE_SERVER_URL,
    OPENCODE_SERVER_PASSWORD,
    REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS,
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
    OPENCODE_HOME_BASE,
  } = config;

  // Effective retry budget: total attempts = 1 + maxRetries.
  const maxRetries = resolveMaxRetries(config.RETRY_MAX_RETRIES);
  const maxAttempts = maxRetries + 1;

  const app: Application = express();
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version'],
    }),
  );
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  const clientHeaders = buildBackendAuthHeaders(OPENCODE_SERVER_PASSWORD);
  const rawClient: OpencodeClient = createOpencodeClient({ baseUrl: OPENCODE_SERVER_URL, headers: clientHeaders });
  const client = rawClient as unknown as ProxyClient;

  const isOperationalEndpointBypassed = (req: Request): boolean => {
    if (req.path === '/health/details') {
      return Boolean(HEALTH_DETAILS_ENABLED) && !HEALTH_DETAILS_REQUIRE_AUTH;
    }
    if (req.path === '/metrics') {
      return Boolean(METRICS_ENABLED) && !METRICS_REQUIRE_AUTH;
    }
    return false;
  };
  void isOperationalEndpointBypassed;

  // Auth middleware (accepts Authorization: Bearer and x-api-key for Anthropic SDK compat)
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/' || req.path === '/health/details' || req.path === '/metrics')
      return next();
    if (API_KEY && (API_KEY as string).trim() !== '') {
      const authHeader: unknown = req.headers.authorization;
      const apiKeyHeader: unknown = req.headers['x-api-key'];
      if (!((authHeader && authHeader === `Bearer ${API_KEY}`) || (apiKeyHeader && apiKeyHeader === API_KEY))) {
        if (req.path === '/v1/messages') {
          res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized' } });
          return;
        }
        res.status(401).json({ error: { message: 'Unauthorized' } });
        return;
      }
    }
    next();
  });

  const getProvidersList = async (): Promise<ProviderInfo[]> => {
    const providersRes = (await client.config.providers()) as unknown;
    const providersRaw: unknown = asRecord(asRecord(providersRes)['data'])['providers'] ?? [];
    if (Array.isArray(providersRaw)) return providersRaw as ProviderInfo[];
    return Object.entries(asRecord(providersRaw)).map(([id, info]) => ({ ...(asRecord(info) as object), id }) as ProviderInfo);
  };

  const buildModelsList = (providersList: unknown): ModelInfo[] => {
    const models: ModelInfo[] = [];
    const list = Array.isArray(providersList) ? (providersList as ProviderInfo[]) : [];
    list.forEach((p) => {
      const modelsRaw: unknown = (p as Record<string, unknown>)['models'];
      if (modelsRaw && typeof modelsRaw === 'object') {
        Object.entries(modelsRaw as Record<string, unknown>).forEach(([mId, mData]) => {
          const md = asRecord(mData);
          models.push({
            id: `${p.id}/${mId}`,
            name: typeof mData === 'object' ? ((md['name'] ?? md['label'] ?? mId) as string) : mId,
            object: 'model',
            created: md['release_date'] ? Math.floor(new Date(String(md['release_date'])).getTime() / 1000) : 1704067200,
            owned_by: p.id,
          });
        });
      }
    });
    return models;
  };

  const normalizeModelID = (modelID: unknown): unknown => {
    if (!modelID || typeof modelID !== 'string') return modelID;
    return modelID.replace(/^gpt(\d)/i, 'gpt-$1').replace(/^o(\d)/i, 'o$1');
  };

  const resolveRequestedModel = async (requestedModel: unknown): Promise<ResolvedModel> => {
    const providersList = await getProvidersList();
    const models = buildModelsList(providersList);
    const fallbackModel = models[0]?.id || 'opencode/kimi-k2.5-free';
    const requestedStr = typeof requestedModel === 'string' && requestedModel ? requestedModel : fallbackModel;
    let [providerID, modelID] = requestedStr.split('/');
    if (!modelID) {
      modelID = providerID as string;
      providerID = 'opencode';
    }
    const originalModelID = modelID as string;
    const normalizedModelID = normalizeModelID(modelID) as string;
    const candidateModelIDs = [...new Set([modelID, normalizedModelID].filter(Boolean))] as string[];
    const exact = models.find((m) => candidateModelIDs.some((candidate) => m.id === `${providerID}/${candidate}`));
    if (exact) {
      const [, resolvedModelID] = exact.id.split('/');
      return {
        providerID: providerID as string,
        modelID: resolvedModelID as string,
        models,
        resolved: exact.id,
        ...(resolvedModelID !== originalModelID ? { aliasFrom: `${providerID}/${originalModelID}` } : {}),
      };
    }
    const sameProvider = models.filter((m) => m.owned_by === providerID);
    const suffixMatch = sameProvider.find((m) =>
      candidateModelIDs.some((candidate) => m.id.endsWith(`/${candidate}-free`) || m.id.endsWith(`/${candidate}`)),
    );
    if (suffixMatch) {
      const [, resolvedModelID] = suffixMatch.id.split('/');
      return {
        providerID: providerID as string,
        modelID: resolvedModelID as string,
        models,
        resolved: suffixMatch.id,
        aliasFrom: `${providerID}/${originalModelID}`,
      };
    }
    const error = new Error(`Model not found: ${providerID}/${modelID}`) as Error & {
      statusCode?: number;
      code?: string;
      availableModels?: string[];
    };
    error.statusCode = 400;
    error.code = 'model_not_found';
    error.availableModels = models.map((m) => m.id);
    throw error;
  };

  const logDebug = (...args: unknown[]): void => {
    if (DEBUG) {
      console.log('[Proxy][Debug]', ...args);
    }
  };

  const responseState = new Map<string, ResponseStateEntry>();
  const RESPONSE_STATE_TTL_MS = 30 * 60 * 1000;
  const RESPONSE_STATE_SWEEP_INTERVAL_MS = 60 * 1000;
  const getResponseState = (responseId: unknown): ResponseStateEntry | null => {
    if (typeof responseId !== 'string') return null;
    const state = responseState.get(responseId);
    if (!state) return null;
    if (state.expiresAt <= Date.now()) {
      responseState.delete(responseId);
      return null;
    }
    return state;
  };
  const storeResponseState = (responseId: unknown, sessionId: unknown, model: unknown): void => {
    if (!responseId || !sessionId || typeof responseId !== 'string' || typeof sessionId !== 'string') return;
    responseState.set(responseId, {
      sessionId,
      model: typeof model === 'string' ? model : String(model ?? ''),
      expiresAt: Date.now() + RESPONSE_STATE_TTL_MS,
    });
  };
  const sweepResponseState = async (): Promise<void> => {
    const now = Date.now();
    const expired: ResponseStateEntry[] = [];
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
      } catch (e: unknown) {
        logDebug('Failed to delete expired response session', { sessionId: state.sessionId, error: toErrorMessage(e) });
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
    INTERNAL_ALLOWLIST: 'internal-allowlist',
  });

  const TOOL_GUARD_MESSAGE =
    'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';
  const EXTERNAL_TOOL_GUARD_MESSAGE =
    'OpenCode internal tools remain disabled. If an external tool contract is present, use only that contract and never call or mention OpenCode internal tools.';

  const normalizeConfiguredToolNames = (entries: unknown = []): string[] => [
    ...new Set(
      (Array.isArray(entries) ? (entries as unknown[]) : [])
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean),
    ),
  ];

  const getEffectiveInternalAllowedTools = (): string[] => {
    const configuredTools = normalizeConfiguredToolNames(INTERNAL_ALLOWED_TOOLS);
    if (configuredTools.length > 0) return configuredTools;
    if (INTERNAL_WEB_FETCH_ENABLED) return ['web_fetch'];
    return [];
  };

  const SERVER_INTERNAL_ALLOWED_TOOL_NAMES = getEffectiveInternalAllowedTools();

  const buildInternalAllowlistPrompt = (allowedToolNames: unknown = []): string => {
    const list = Array.isArray(allowedToolNames) ? (allowedToolNames as string[]) : [];
    if (list.length > 0) {
      return `OpenCode internal tool access is limited for this turn. You may use only these built-in tools when truly required: ${list.join(', ')}. Do not mention or attempt any other internal tools. If the required internal tools are unavailable, answer directly and say live tool access is unavailable.`;
    }
    return 'OpenCode internal tools are unavailable for this turn. Answer directly without attempting tool usage.';
  };

  const buildSystemPrompt = (
    systemMsg: unknown,
    reasoningEffort: unknown = null,
    toolMode: unknown = TOOL_MODE.DISABLED,
    internalAllowedTools: unknown = [],
  ): string | undefined => {
    const parts: string[] = [];
    if (!OMIT_SYSTEM_PROMPT && typeof systemMsg === 'string' && systemMsg.trim()) {
      parts.push(systemMsg.trim());
    }
    if (reasoningEffort && reasoningEffort !== 'none') {
      parts.push(`[Reasoning Effort: ${String(reasoningEffort)}]`);
    }
    if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
      parts.push(buildInternalAllowlistPrompt(internalAllowedTools));
    } else if (DISABLE_TOOLS && PROMPT_MODE !== 'plugin-inject') {
      parts.push(toolMode === TOOL_MODE.EXTERNAL_BRIDGE ? EXTERNAL_TOOL_GUARD_MESSAGE : TOOL_GUARD_MESSAGE);
    }
    const finalPrompt = parts.join('\n\n').trim();
    return finalPrompt || undefined;
  };

  const normalizeReasoningEffort = (value: unknown, fallback: unknown = null): string | null => {
    if (!value || typeof value !== 'string') return fallback as string | null;
    const effortMap: Record<string, string> = {
      none: 'none',
      minimal: 'none',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'high',
    };
    return effortMap[value.toLowerCase()] ?? (fallback as string | null);
  };

  const stripFunctionCalls = (text: unknown, trim: boolean = true): unknown => {
    if (!DISABLE_TOOLS || !text) return text;
    return stripFunctionCallMarkup(String(text), trim);
  };

  const normalizeTextContent = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return (content as unknown[])
        .map((part) => {
          if (typeof part === 'string') return part;
          const pr = asRecord(part);
          if (typeof pr['text'] === 'string') return pr['text'] as string;
          if (pr['type'] === 'input_text' || pr['type'] === 'output_text' || pr['type'] === 'text')
            return String(pr['text'] ?? '');
          return '';
        })
        .join('');
    }
    const cr = asRecord(content);
    if (typeof cr['text'] === 'string') return cr['text'] as string;
    if (content === null || content === undefined) return '';
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);
    return '';
  };

  const normalizeToolArguments = (args: unknown): string => {
    if (args === undefined || args === null || args === '') return '{}';
    if (typeof args === 'string') return args;
    try {
      return JSON.stringify(args);
    } catch {
      return '{}';
    }
  };

  const normalizeToolResultContent = (content: unknown): string => {
    const text = normalizeTextContent(content);
    if (text) return text;
    if (content === null || content === undefined) return '';
    if (typeof content === 'object') {
      try {
        return JSON.stringify(content);
      } catch {
        return '';
      }
    }
    return String(content);
  };

  const createExternalToolContext = (
    tools: unknown,
    toolChoice: unknown,
  ): AppContext['createExternalToolContext'] extends (...args: never[]) => infer R ? R : never => {
    const registry = buildExternalToolRegistry(tools);
    const exposure = buildToolExposure(registry, toolChoice);
    return {
      registry,
      exposure,
      toolChoice: exposure.toolChoice,
      prompt: exposure.prompt,
      reminder: exposure.reminder,
    } as unknown as AppContext['createExternalToolContext'] extends (...args: never[]) => infer R ? R : never;
  };

  const resolveToolMode = (tools: unknown = [], effectiveInternalAllowlist: unknown = []): string => {
    if (Array.isArray(tools) && (tools as unknown[]).length > 0) {
      return TOOL_MODE.EXTERNAL_BRIDGE;
    }
    const allowlist = Array.isArray(effectiveInternalAllowlist) ? (effectiveInternalAllowlist as unknown[]) : [];
    if (allowlist.length > 0) {
      return TOOL_MODE.INTERNAL_ALLOWLIST;
    }
    return TOOL_MODE.DISABLED;
  };

  const createRequestToolContext = (
    tools: unknown,
    toolChoice: unknown,
    requestOpencodeConfig: unknown = undefined,
  ): AppContext['createRequestToolContext'] extends (...args: never[]) => infer R ? R : never => {
    let effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES;
    let requestInternalAllowlist: string[] | null = null;

    if (requestOpencodeConfig && typeof requestOpencodeConfig === 'object') {
      const cfgRecord = asRecord(requestOpencodeConfig);
      if (Array.isArray(cfgRecord['internal_allowed_tools'])) {
        requestInternalAllowlist = ((cfgRecord['internal_allowed_tools'] as unknown[]) as unknown[])
          .map((name) => String(name ?? '').trim())
          .filter(Boolean);
      }
    }

    if (requestInternalAllowlist !== null) {
      effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES.filter((name) =>
        (requestInternalAllowlist as string[]).includes(name),
      );
    }

    const deniedRequestedTools = requestInternalAllowlist
      ? requestInternalAllowlist.filter((name) => !SERVER_INTERNAL_ALLOWED_TOOL_NAMES.includes(name))
      : [];

    const mode = resolveToolMode(tools, effectiveInternalAllowlist);
    const external =
      mode === TOOL_MODE.EXTERNAL_BRIDGE
        ? createExternalToolContext(tools, toolChoice)
        : {
            registry: [],
            exposure: { tools: [], toolChoice: { mode: 'auto', requiredTool: null }, prompt: '', reminder: '' },
            toolChoice: { mode: 'auto', requiredTool: null },
            prompt: '',
            reminder: '',
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
        metricsEnabled: Boolean(INTERNAL_TOOL_METRICS_ENABLED),
      },
    } as unknown as AppContext['createRequestToolContext'] extends (...args: never[]) => infer R ? R : never;
  };

  const finalizeValidatedToolCalls = (
    parsedToolCalls: unknown,
    registry: unknown,
  ): { validCalls: ValidatedToolCall[]; invalidCalls: Array<{ call: unknown; validation: unknown }> } => {
    const { validCalls, invalidCalls } = validateToolCalls(parsedToolCalls, registry);
    invalidCalls.forEach(({ call, validation }) => {
      const callRecord = asRecord(call);
      const fn = asRecord(callRecord['function']);
      const validationRecord = asRecord(validation);
      const errorsRaw: unknown = validationRecord['errors'];
      logDebug('Rejected external tool call', {
        tool: fn['name'],
        errors: Array.isArray(errorsRaw)
          ? (errorsRaw as unknown[]).map((error) => asRecord(error)['message'])
          : undefined,
      });
    });
    const allowedCalls: ValidatedToolCall[] = [];
    validCalls.forEach((toolCall) => {
      const policyDecision = evaluateToolPolicy(toolCall.tool, toolCall.validatedArguments, { config });
      if (policyDecision.status === 'allow') {
        allowedCalls.push(toolCall);
        return;
      }
      const tcRecord = asRecord(toolCall);
      const fn = asRecord(tcRecord['function']);
      const pdRecord = asRecord(policyDecision);
      logDebug('Blocked external tool call', {
        tool: fn['name'],
        status: pdRecord['status'],
        reason: pdRecord['reason'],
      });
    });
    return { validCalls: allowedCalls, invalidCalls: invalidCalls as Array<{ call: unknown; validation: unknown }> };
  };

  const toPublicToolCalls = (toolCalls: unknown): FinalToolCall[] => {
    if (!Array.isArray(toolCalls) || (toolCalls as unknown[]).length === 0) return [];
    return ((toolCalls as unknown[]) as ValidatedToolCall[]).map((toolCall) => {
      const record = toolCall as unknown as Record<string, unknown>;
      const fn = asRecord(record['function']);
      return {
        id: String(record['id']),
        type: 'function',
        function: {
          name: String(fn['name']),
          arguments: String(fn['arguments']),
        },
      } as unknown as FinalToolCall;
    });
  };

  const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
  let cachedToolIds: string[] | null = null;
  let cachedToolIdsAt = 0;
  let cachedDisabledToolOverrides: Record<string, boolean> | null = null;
  let cachedDisabledToolOverridesAt = 0;
  const internalToolMetrics: InternalToolMetrics = {
    externalBridgeRequests: 0,
    internalAllowlistRequests: 0,
    disabledRequests: 0,
    discoveryFailures: 0,
    fallbackToDisabled: 0,
  };

  const logInternalToolEvent = (event: unknown, details: unknown = {}): void => {
    if (!DEBUG && !INTERNAL_TOOL_METRICS_ENABLED) return;
    const payload: Record<string, unknown> = {
      event,
      ...(asRecord(details) as object),
    };
    if (INTERNAL_TOOL_METRICS_ENABLED) {
      payload['metrics'] = { ...internalToolMetrics };
    }
    logDebug('Internal tool event', payload);
  };

  const trackToolMode = (toolMode: unknown, details: unknown = {}): void => {
    if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE) {
      internalToolMetrics.externalBridgeRequests += 1;
    } else if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
      internalToolMetrics.internalAllowlistRequests += 1;
    } else {
      internalToolMetrics.disabledRequests += 1;
    }
    logInternalToolEvent('tool-mode-selected', {
      toolMode,
      ...(asRecord(details) as object),
    });
  };

  const getBackendToolIds = async (): Promise<string[] | null> => {
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
      const idsRes = (await client.tool.ids()) as unknown;
      const data: unknown = asRecord(idsRes)['data'] ?? idsRes;
      const ids = Array.isArray(data) ? (data as string[]) : [];
      cachedToolIds = ids;
      cachedToolIdsAt = Date.now();
      logInternalToolEvent('backend-tool-ids-loaded', { count: ids.length });
      return ids;
    } catch (e: unknown) {
      internalToolMetrics.discoveryFailures += 1;
      logInternalToolEvent('backend-tool-ids-failed', { error: toErrorMessage(e) });
      return null;
    }
  };

  const buildDisabledToolOverrides = (ids: unknown = []): Record<string, boolean> => {
    const overrides: Record<string, boolean> = {};
    const list = Array.isArray(ids) ? (ids as unknown[]) : [];
    list.forEach((id) => {
      if (typeof id === 'string') overrides[id] = false;
    });
    return overrides;
  };

  const normalizeBackendToolIds = (ids: unknown = []): string[] =>
    (Array.isArray(ids) ? (ids as unknown[]) : []).filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));

  const matchesAllowedToolName = (toolId: unknown, allowedToolName: unknown): boolean => {
    if (!toolId || !allowedToolName || typeof toolId !== 'string' || typeof allowedToolName !== 'string') return false;
    return toolId === allowedToolName || toolId.endsWith(`.${allowedToolName}`) || toolId.endsWith(`/${allowedToolName}`);
  };

  const resolveInternalAllowedToolIds = (
    ids: unknown = [],
    allowedToolNames: unknown = [],
  ): { normalizedIds: string[]; normalizedAllowedNames: string[]; matchedToolIds: string[]; unmatchedAllowedNames: string[] } => {
    const normalizedIds = normalizeBackendToolIds(ids);
    const normalizedAllowedNames = normalizeConfiguredToolNames(allowedToolNames);
    const matchedToolIds = new Set<string>();
    const unmatchedAllowedNames: string[] = [];

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
      unmatchedAllowedNames,
    };
  };

  const getDisabledToolOverrides = async (): Promise<Record<string, boolean> | null> => {
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

  const getToolOverridesForMode = async (
    toolMode: unknown,
    internalContext: unknown = {},
  ): Promise<Record<string, boolean> | null> => {
    const ctxRecord = asRecord(internalContext);
    if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE || toolMode === TOOL_MODE.DISABLED) {
      if (toolMode === TOOL_MODE.DISABLED) {
        const allowed = ctxRecord['allowedToolNames'] ?? SERVER_INTERNAL_ALLOWED_TOOL_NAMES;
        logInternalToolEvent('internal-tools-disabled', {
          configuredAllowlist: allowed,
        });
      }
      return getDisabledToolOverrides();
    }
    if (toolMode !== TOOL_MODE.INTERNAL_ALLOWLIST) {
      return null;
    }
    const ids = await getBackendToolIds();
    if (!Array.isArray(ids) || (ids as unknown[]).length === 0) return null;
    const resolution = resolveInternalAllowedToolIds(
      ids,
      (ctxRecord['allowedToolNames'] ?? SERVER_INTERNAL_ALLOWED_TOOL_NAMES) as unknown,
    );
    const { normalizedIds, normalizedAllowedNames, matchedToolIds, unmatchedAllowedNames } = resolution;
    if (matchedToolIds.length === 0) {
      internalToolMetrics.fallbackToDisabled += 1;
      logInternalToolEvent('internal-allowlist-unavailable', {
        configuredAllowlist: normalizedAllowedNames,
        availableToolIds: normalizedIds,
        unmatchedAllowlist: unmatchedAllowedNames,
        fallback: 'disabled',
      });
      return buildDisabledToolOverrides(normalizedIds);
    }
    const overrides: Record<string, boolean> = {};
    normalizedIds.forEach((id) => {
      overrides[id] = matchedToolIds.includes(id);
    });
    logInternalToolEvent('internal-allowlist-overrides-loaded', {
      configuredAllowlist: normalizedAllowedNames,
      matchedToolIds,
      unmatchedAllowlist: unmatchedAllowedNames,
      availableToolIdsCount: normalizedIds.length,
    });
    return overrides;
  };

  const getCleanupRoots = (): string[] => {
    const roots: string[] = [];
    const add = (dir: unknown): void => {
      if (!dir || typeof dir !== 'string') return;
      if (!roots.includes(dir)) roots.push(dir);
    };
    add(OPENCODE_HOME_BASE ? path.join(String(OPENCODE_HOME_BASE), '.local', 'share', 'opencode', 'storage') : null);
    add('/home/node/.local/share/opencode/storage');
    return roots;
  };

  const cleanupConversationFiles = async (): Promise<{ removed: number; scanned: number }> => {
    if (!AUTO_CLEANUP_CONVERSATIONS) return { removed: 0, scanned: 0 };
    const now = Date.now();
    let removed = 0;
    let scanned = 0;
    for (const storageRoot of getCleanupRoots()) {
      for (const sub of ['message', 'session']) {
        const dir = path.join(storageRoot, sub);
        if (!fs.existsSync(dir)) continue;
        let entries: import('fs').Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          let stat: import('fs').Stats;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          scanned += 1;
          const mtime = stat.mtimeMs || stat.ctimeMs || now;
          if (now - mtime < Number(CLEANUP_MAX_AGE_MS)) continue;
          try {
            fs.rmSync(full, { recursive: true, force: true });
            removed += 1;
          } catch (e: unknown) {
            logDebug('Cleanup remove failed', { full, error: toErrorMessage(e) });
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
      cleanupConversationFiles().catch((e: unknown) => logDebug('Cleanup run failed', { error: toErrorMessage(e) }));
    }, 3000);
    const cleanupTimer = setInterval(() => {
      cleanupConversationFiles().catch((e: unknown) => logDebug('Cleanup run failed', { error: toErrorMessage(e) }));
    }, Number(CLEANUP_INTERVAL_MS));
    if (cleanupTimer.unref) cleanupTimer.unref();
  }

  const createForcedToolCallRequester =
    (options: ForcedToolCallRequesterOptions): (() => Promise<Record<string, unknown> | null>) => {
      const {
        mode,
        sessionId,
        systemWithGuard,
        requiredTool,
        providerID,
        modelID,
        toolOverrides,
        requestTimeoutMs,
        forbidThinkBlock = false,
      } = options;
      return async (): Promise<Record<string, unknown> | null> => {
        if (mode !== 'required') return null;
        if (!requiredTool) return null;
        const forcedPromptParams: { path: { id: string }; body: Record<string, unknown> } = {
          path: { id: sessionId },
          body: {
            model: { providerID, modelID },
            ...(systemWithGuard ? { system: systemWithGuard } : {}),
            parts: [
              {
                type: 'text',
                text: `SYSTEM: Your previous reply did not emit the required external tool call. Reply now with ONLY <function_calls>{"name":"${requiredTool}","arguments":{}}</function_calls> or an array inside <function_calls>...</function_calls>. Do not output any prose, reasoning, markdown${forbidThinkBlock ? ', or <think> block' : ''}. Infer the correct arguments from the conversation so far.`,
              },
            ],
          },
        };
        if (toolOverrides && Object.keys(toolOverrides).length > 0) {
          forcedPromptParams.body['tools'] = toolOverrides;
        }
        await promptWithTimeout(forcedPromptParams, requestTimeoutMs);
        return pollForAssistantResponse(sessionId, requestTimeoutMs) as Promise<Record<string, unknown>>;
      };
    };

  // P3: per-instance stream collector (prompt/poll/collect close over client+logDebug,
  // same closure semantics as the original createApp inner functions).
  const collector = createCollector({ client, logDebug });
  const { promptWithTimeout, pollForAssistantResponse, collectFromEvents, extractFromParts } = collector;

  const ctx: AppContext = {
    client,
    config,
    API_KEY: String(API_KEY ?? ''),
    OPENCODE_SERVER_URL: String(OPENCODE_SERVER_URL ?? ''),
    OPENCODE_SERVER_PASSWORD: String(OPENCODE_SERVER_PASSWORD ?? ''),
    REQUEST_TIMEOUT_MS: Number(REQUEST_TIMEOUT_MS),
    DEBUG: Boolean(DEBUG),
    DISABLE_TOOLS: Boolean(DISABLE_TOOLS),
    INTERNAL_WEB_FETCH_ENABLED: Boolean(INTERNAL_WEB_FETCH_ENABLED),
    INTERNAL_ALLOWED_TOOLS: Array.isArray(INTERNAL_ALLOWED_TOOLS) ? (INTERNAL_ALLOWED_TOOLS as string[]) : [],
    INTERNAL_TOOL_METRICS_ENABLED: Boolean(INTERNAL_TOOL_METRICS_ENABLED),
    INTERNAL_TOOL_DISCOVERY_FIXTURE: Array.isArray(INTERNAL_TOOL_DISCOVERY_FIXTURE)
      ? (INTERNAL_TOOL_DISCOVERY_FIXTURE as string[])
      : [],
    HEALTH_DETAILS_ENABLED: Boolean(HEALTH_DETAILS_ENABLED),
    HEALTH_DETAILS_REQUIRE_AUTH: Boolean(HEALTH_DETAILS_REQUIRE_AUTH),
    METRICS_ENABLED: Boolean(METRICS_ENABLED),
    METRICS_REQUIRE_AUTH: Boolean(METRICS_REQUIRE_AUTH),
    PROMPT_MODE: String(PROMPT_MODE ?? 'standard'),
    OMIT_SYSTEM_PROMPT: Boolean(OMIT_SYSTEM_PROMPT),
    AUTO_CLEANUP_CONVERSATIONS: Boolean(AUTO_CLEANUP_CONVERSATIONS),
    CLEANUP_INTERVAL_MS: Number(CLEANUP_INTERVAL_MS),
    CLEANUP_MAX_AGE_MS: Number(CLEANUP_MAX_AGE_MS),
    OPENCODE_HOME_BASE: (OPENCODE_HOME_BASE as string | null) ?? null,
    maxRetries,
    maxAttempts,
    getProvidersList,
    buildModelsList,
    normalizeModelID,
    resolveRequestedModel,
    logDebug,
    responseState,
    getResponseState,
    storeResponseState,
    sweepResponseState,
    TOOL_MODE: TOOL_MODE as unknown as AppContext['TOOL_MODE'],
    TOOL_GUARD_MESSAGE,
    EXTERNAL_TOOL_GUARD_MESSAGE,
    normalizeConfiguredToolNames,
    getEffectiveInternalAllowedTools,
    SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
    buildInternalAllowlistPrompt,
    buildSystemPrompt,
    normalizeReasoningEffort,
    stripFunctionCalls,
    normalizeTextContent,
    normalizeToolArguments,
    normalizeToolResultContent,
    createExternalToolContext: createExternalToolContext as unknown as AppContext['createExternalToolContext'],
    resolveToolMode,
    createRequestToolContext: createRequestToolContext as unknown as AppContext['createRequestToolContext'],
    finalizeValidatedToolCalls,
    toPublicToolCalls,
    createForcedToolCallRequester: createForcedToolCallRequester as unknown as AppContext['createForcedToolCallRequester'],
    TOOL_IDS_CACHE_MS,
    internalToolMetrics,
    logInternalToolEvent,
    trackToolMode,
    getBackendToolIds,
    buildDisabledToolOverrides,
    normalizeBackendToolIds,
    matchesAllowedToolName,
    resolveInternalAllowedToolIds,
    getDisabledToolOverrides,
    getToolOverridesForMode,
    getCleanupRoots,
    cleanupConversationFiles,
    promptWithTimeout,
    collectFromEvents,
    pollForAssistantResponse,
    extractFromParts,
    getCachedToolIds: () => cachedToolIds,
    getCachedToolIdsAt: () => cachedToolIdsAt,
  };

  // P3: register routes (404 last to preserve catch-all order).
  registerSystemRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerResponsesRoutes(app, ctx);
  registerMessagesRoutes(app, ctx);
  registerNotFoundRoute(app);

  // Reference retained converter/tool-runtime helpers to preserve original module
  // wiring (no behavior change; prevents unused-import churn across P3 splits).
  void [
    findExternalToolByName,
    EXTERNAL_TOOL_PREFIX,
    computeRetryDelay,
    validateMessagesRequest,
    extractSystemText,
    anthropicMessagesToChatMessages,
    anthropicToolsToChatTools,
    anthropicToolChoiceToChat,
    anthropicThinkingToReasoningEffort,
    mapFinishToStopReason,
    buildAnthropicMessage,
    sseEvent,
    estimateTokens,
    buildToolExposure,
    evaluateToolPolicy,
    validateToolCalls,
    stripFunctionCallMarkup,
    parseExternalToolCallsFromText,
    createToolCallFilter,
    createExternalToolCallStreamParser,
  ];

  return { app, client };
}

/**
 * Starts the OpenCode-to-OpenAI Proxy server.
 */
export function startProxy(options: unknown = {}): StartProxyResult {
  // buildProxyConfig tolerates explicit null and preserves merge semantics verbatim.
  const config = buildProxyConfig((options ?? {}) as unknown);

  const { app } = createApp(config);

  const server = app.listen(config.PORT, config.BIND_HOST, () => {
    void (async (): Promise<void> => {
      console.log(`[Proxy] Active at http://${config.BIND_HOST}:${config.PORT}`);
      try {
        await ensureBackend(config);
      } catch (error: unknown) {
        console.error('[Proxy] Backend warmup failed:', toErrorMessage(error));
      }
    })();
  });

  return {
    server,
    killBackend: () => {
      const state = backendState.get(config.OPENCODE_SERVER_URL);
      if (state?.process) {
        state.process.kill();
      }
      // Cleanup temp dir (only on non-Windows where we use jail)
      if (state?.jailRoot && process.platform !== 'win32') {
        try {
          fs.rmSync(state.jailRoot, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    },
  };
}
