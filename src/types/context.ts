import type { ProxyConfig } from './config.js';
import type { ProxyClient, ResolvedModel, ModelInfo, ProviderInfo } from './client.js';
import type { ResponseStateEntry } from './backend.js';
import type { ExternalToolEntry } from '../tool-runtime/registry.js';
import type { ValidatedToolCall } from '../tool-runtime/validator.js';
import type { FinalToolCall } from '../tool-runtime/parser.js';

export type ToolModeName = string;

export interface ToolModeSet {
  DISABLED: string;
  EXTERNAL_BRIDGE: string;
  INTERNAL_ALLOWLIST: string;
}

export interface InternalToolContext {
  allowedToolNames: string[];
  requestedAllowlist: string[] | null;
  deniedRequestedTools: string[];
  resolutionPath: string;
  resultingMode: string;
  metricsEnabled: boolean;
}

export interface ExternalToolContext {
  registry: ExternalToolEntry[];
  exposure: { tools: ExternalToolEntry[]; toolChoice: { mode: string; requiredTool: string | null }; prompt: string; reminder: string };
  toolChoice: { mode: string; requiredTool: string | null };
  prompt: string;
  reminder: string;
}

export interface RequestToolContext {
  mode: string;
  external: ExternalToolContext;
  internal: InternalToolContext;
}

export interface ForcedToolCallRequesterOptions {
  mode: unknown;
  sessionId: string;
  systemWithGuard: string | undefined;
  requiredTool: string | undefined;
  providerID: string;
  modelID: string;
  toolOverrides: Record<string, boolean> | null;
  requestTimeoutMs: number;
  forbidThinkBlock?: boolean;
}

export interface CollectorHandle {
  extractFromParts: (parts: unknown) => { content: string; reasoning: string; toolParts: unknown[] };
  promptWithTimeout: (promptParams: unknown, timeoutMs: unknown) => Promise<unknown>;
  pollForAssistantResponse: (
    sessionId: string,
    timeoutMs: number,
    intervalMs?: number
  ) => Promise<{ content: string; reasoning: string; error: unknown }>;
  collectFromEvents: (
    sessionId: string,
    timeoutMs: number,
    onDelta?: ((delta: string, isReasoning?: boolean) => void) | null,
    firstDeltaTimeoutMs?: number | null,
    idleTimeoutMs?: number | null
  ) => Promise<Record<string, unknown>>;
}

export interface InternalToolMetrics {
  externalBridgeRequests: number;
  internalAllowlistRequests: number;
  disabledRequests: number;
  discoveryFailures: number;
  fallbackToDisabled: number;
}

/** Per-instance context threaded through route registrars (same names as closures). */
export interface AppContext {
  client: ProxyClient;
  config: ProxyConfig;
  API_KEY: string;
  OPENCODE_SERVER_URL: string;
  OPENCODE_SERVER_PASSWORD: string;
  REQUEST_TIMEOUT_MS: number;
  DEBUG: boolean;
  DISABLE_TOOLS: boolean;
  INTERNAL_WEB_FETCH_ENABLED: boolean;
  INTERNAL_ALLOWED_TOOLS: string[];
  INTERNAL_TOOL_METRICS_ENABLED: boolean;
  INTERNAL_TOOL_DISCOVERY_FIXTURE: string[];
  HEALTH_DETAILS_ENABLED: boolean;
  HEALTH_DETAILS_REQUIRE_AUTH: boolean;
  METRICS_ENABLED: boolean;
  METRICS_REQUIRE_AUTH: boolean;
  PROMPT_MODE: string;
  OMIT_SYSTEM_PROMPT: boolean;
  AUTO_CLEANUP_CONVERSATIONS: boolean;
  CLEANUP_INTERVAL_MS: number;
  CLEANUP_MAX_AGE_MS: number;
  OPENCODE_HOME_BASE: string | null;
  maxRetries: number;
  maxAttempts: number;
  getProvidersList: () => Promise<ProviderInfo[]>;
  buildModelsList: (providersList: unknown) => ModelInfo[];
  normalizeModelID: (modelID: unknown) => unknown;
  resolveRequestedModel: (requestedModel: unknown) => Promise<ResolvedModel>;
  logDebug: (...args: unknown[]) => void;
  responseState: Map<string, ResponseStateEntry>;
  getResponseState: (responseId: unknown) => ResponseStateEntry | null;
  storeResponseState: (responseId: unknown, sessionId: unknown, model: unknown) => void;
  sweepResponseState: () => Promise<void>;
  TOOL_MODE: ToolModeSet;
  TOOL_GUARD_MESSAGE: string;
  EXTERNAL_TOOL_GUARD_MESSAGE: string;
  normalizeConfiguredToolNames: (entries?: unknown) => string[];
  getEffectiveInternalAllowedTools: () => string[];
  SERVER_INTERNAL_ALLOWED_TOOL_NAMES: string[];
  buildInternalAllowlistPrompt: (allowedToolNames?: unknown) => string;
  buildSystemPrompt: (systemMsg: unknown, reasoningEffort?: unknown, toolMode?: unknown, internalAllowedTools?: unknown) => string | undefined;
  normalizeReasoningEffort: (value: unknown, fallback?: unknown) => string | null;
  stripFunctionCalls: (text: unknown, trim?: boolean) => unknown;
  normalizeTextContent: (content: unknown) => string;
  normalizeToolArguments: (args: unknown) => string;
  normalizeToolResultContent: (content: unknown) => string;
  createExternalToolContext: (tools: unknown, toolChoice: unknown) => ExternalToolContext;
  resolveToolMode: (tools?: unknown, effectiveInternalAllowlist?: unknown) => string;
  createRequestToolContext: (tools: unknown, toolChoice: unknown, requestOpencodeConfig?: unknown) => RequestToolContext;
  finalizeValidatedToolCalls: (
    parsedToolCalls: unknown,
    registry: unknown
  ) => { validCalls: ValidatedToolCall[]; invalidCalls: Array<{ call: unknown; validation: unknown }> };
  toPublicToolCalls: (toolCalls: unknown) => FinalToolCall[];
  createForcedToolCallRequester: (options: ForcedToolCallRequesterOptions) => () => Promise<Record<string, unknown> | null>;
  TOOL_IDS_CACHE_MS: number;
  internalToolMetrics: InternalToolMetrics;
  logInternalToolEvent: (event: unknown, details?: unknown) => void;
  trackToolMode: (toolMode: unknown, details?: unknown) => void;
  getBackendToolIds: () => Promise<string[] | null>;
  buildDisabledToolOverrides: (ids?: unknown) => Record<string, boolean>;
  normalizeBackendToolIds: (ids?: unknown) => string[];
  matchesAllowedToolName: (toolId: unknown, allowedToolName: unknown) => boolean;
  resolveInternalAllowedToolIds: (
    ids?: unknown,
    allowedToolNames?: unknown
  ) => { normalizedIds: string[]; normalizedAllowedNames: string[]; matchedToolIds: string[]; unmatchedAllowedNames: string[] };
  getDisabledToolOverrides: () => Promise<Record<string, boolean> | null>;
  getToolOverridesForMode: (toolMode: unknown, internalContext?: unknown) => Promise<Record<string, boolean> | null>;
  getCleanupRoots: () => string[];
  cleanupConversationFiles: () => Promise<{ removed: number; scanned: number }>;
  promptWithTimeout: CollectorHandle['promptWithTimeout'];
  collectFromEvents: CollectorHandle['collectFromEvents'];
  pollForAssistantResponse: CollectorHandle['pollForAssistantResponse'];
  extractFromParts: CollectorHandle['extractFromParts'];
  getCachedToolIds: () => string[] | null;
  getCachedToolIdsAt: () => number;
}

export interface CreateAppResult {
  app: import('express').Application;
  client: ProxyClient;
}

export interface StartProxyResult {
  server: import('node:http').Server;
  killBackend: () => void;
}
