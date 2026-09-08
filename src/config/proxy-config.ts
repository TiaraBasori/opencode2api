// P4 TS: proxy config defaults + pure bool/config builders (ported from P3 .js, behavior identical).
import type { DisableToolsOptions, ProxyConfig, ProxyConfigOptions } from '../types/config.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
export const DEFAULT_POLL_INTERVAL_MS = 500;
// Retry policy (ported from upstream opencode session/retry.ts; see src/retry/policy.ts).
// Total attempts = 1 + maxRetries; maxRetries defaults to 3, configurable via
// OPENCODE_PROXY_RETRY_MAX_RETRIES, hard-capped at 5 (upstream ceiling).
// Delays are exponential with jitter and honor retry-after headers.
// Reasoning models can take well over 10s before emitting their first token.
// A short window here makes the event stream give up and fall back to polling on
// every request, which loses true streaming. Configurable for slow backends.
export const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS: number =
  Number(process.env['OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS']) || 30000;
export const DEFAULT_EVENT_IDLE_TIMEOUT_MS: number =
  Number(process.env['OPENCODE2API_EVENT_IDLE_TIMEOUT_MS']) || 8000;

/**
 * Normalize a boolean-ish value. Returns true/false for recognized spellings,
 * undefined for missing/invalid values so callers can fall through with ??.
 * Numbers: only 0/1 are recognized (like '0'/'1'); any other number is
 * treated as unset so it never blocks a lower-priority source.
 */
export function normalizeBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  }
  return undefined;
}

/**
 * Resolve the effective disable-tools flag.
 * Precedence: options.DISABLE_TOOLS > options.disableTools >
 * env OPENCODE_DISABLE_TOOLS (canonical) > env DISABLE_TOOLS (legacy alias
 * used by docker-compose/.env) > fallback.
 * Invalid values ('garbage', '', whitespace) are treated as unset and fall
 * through to the next source instead of coercing.
 */
export function resolveDisableTools(options?: unknown, fallback: boolean = false): boolean {
  const o = (options ?? {}) as DisableToolsOptions;
  const record = o as Record<string, unknown>;
  return (
    normalizeBool(record['DISABLE_TOOLS']) ??
    normalizeBool(record['disableTools']) ??
    normalizeBool(process.env['OPENCODE_DISABLE_TOOLS']) ??
    normalizeBool(process.env['DISABLE_TOOLS']) ??
    fallback
  );
}

/**
 * Race a promise against a timeout. The real outcome always wins: fast
 * resolutions/rejections settle the race immediately; only a never-settling
 * promise loses to the timer. A no-op handler is attached so a late rejection
 * can never surface as an unhandled rejection (which would terminate the
 * process under Node's default --unhandled-rejections=throw).
 * The timeout error message keeps the 'Request timeout' prefix so
 * transformUpstreamError maps it to 504 (not 500); the label is appended
 * for diagnosability.
 */
export function withTimeout(promise: unknown, timeoutMs: unknown, label: string = 'operation'): Promise<unknown> {
  const numericMs = Number(timeoutMs);
  const ms = Number.isFinite(numericMs) ? numericMs : DEFAULT_REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Request timeout after ${ms}ms (${label})`)), ms);
  });
  const candidate = promise as { catch?: unknown } | null | undefined;
  if (candidate && typeof candidate.catch === 'function') {
    (candidate as Promise<unknown>).catch(() => {});
  }
  return Promise.race([promise as Promise<unknown>, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function readStringOption(options: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v: unknown = options[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * Build the effective proxy config from caller options + env (extracted verbatim
 * from startProxy preamble + config assembly; merge semantics unchanged).
 */
export function buildProxyConfig(options: unknown = {}): ProxyConfig {
  // Also tolerate explicit null (the = {} default only covers undefined).
  const raw: ProxyConfigOptions = (options ?? {}) as ProxyConfigOptions;
  const opts = raw as Record<string, unknown>;
  const disableTools = resolveDisableTools(raw);

  const promptMode =
    readStringOption(opts, ['PROMPT_MODE', 'promptMode']) ||
    process.env['OPENCODE_PROXY_PROMPT_MODE'] ||
    'standard';
  const externalToolsMode =
    readStringOption(opts, ['EXTERNAL_TOOLS_MODE', 'externalToolsMode']) ||
    process.env['OPENCODE_EXTERNAL_TOOLS_MODE'] ||
    'proxy-bridge';
  const externalToolsConflictPolicy =
    readStringOption(opts, ['EXTERNAL_TOOLS_CONFLICT_POLICY', 'externalToolsConflictPolicy']) ||
    process.env['OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY'] ||
    'namespace';
  const cleanupIntervalMs = Number(
    opts['CLEANUP_INTERVAL_MS'] ?? process.env['OPENCODE_PROXY_CLEANUP_INTERVAL_MS'] ?? 12 * 60 * 60 * 1000,
  );
  const cleanupMaxAgeMs = Number(
    opts['CLEANUP_MAX_AGE_MS'] ?? process.env['OPENCODE_PROXY_CLEANUP_MAX_AGE_MS'] ?? 24 * 60 * 60 * 1000,
  );

  if (externalToolsMode !== 'proxy-bridge') {
    throw new Error(`Unsupported EXTERNAL_TOOLS_MODE: ${externalToolsMode}. Supported value: proxy-bridge`);
  }
  if (externalToolsConflictPolicy !== 'namespace') {
    throw new Error(
      `Unsupported EXTERNAL_TOOLS_CONFLICT_POLICY: ${externalToolsConflictPolicy}. Supported value: namespace`,
    );
  }
  const useIsolatedRaw: unknown = opts['USE_ISOLATED_HOME'];
  const config: ProxyConfig = {
    PORT: (opts['PORT'] as number) || 10000,
    API_KEY: (opts['API_KEY'] as string) || '',
    OPENCODE_SERVER_URL: (opts['OPENCODE_SERVER_URL'] as string) || 'http://127.0.0.1:10001',
    OPENCODE_SERVER_PASSWORD:
      (opts['OPENCODE_SERVER_PASSWORD'] as string) || process.env['OPENCODE_SERVER_PASSWORD'] || '',
    OPENCODE_PATH: (opts['OPENCODE_PATH'] as string) || 'opencode',
    BIND_HOST:
      (opts['BIND_HOST'] as string) ||
      (opts['bindHost'] as string) ||
      process.env['BIND_HOST'] ||
      process.env['OPENCODE_PROXY_BIND_HOST'] ||
      '0.0.0.0',
    USE_ISOLATED_HOME:
      typeof useIsolatedRaw === 'boolean'
        ? useIsolatedRaw
        : String(useIsolatedRaw ?? '').toLowerCase() === 'true' ||
          useIsolatedRaw === '1' ||
          String(process.env['OPENCODE_USE_ISOLATED_HOME'] ?? '').toLowerCase() === 'true' ||
          process.env['OPENCODE_USE_ISOLATED_HOME'] === '1',
    REQUEST_TIMEOUT_MS: Number(
      opts['REQUEST_TIMEOUT_MS'] ?? process.env['OPENCODE_PROXY_REQUEST_TIMEOUT_MS'] ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    MANAGE_BACKEND:
      normalizeBool(opts['MANAGE_BACKEND']) ?? normalizeBool(process.env['OPENCODE_PROXY_MANAGE_BACKEND']) ?? true,
    DISABLE_TOOLS: disableTools,
    EXTERNAL_TOOLS_MODE: externalToolsMode,
    EXTERNAL_TOOLS_CONFLICT_POLICY: externalToolsConflictPolicy,
    INTERNAL_WEB_FETCH_ENABLED:
      normalizeBool(opts['INTERNAL_WEB_FETCH_ENABLED']) ??
      normalizeBool(process.env['OPENCODE_INTERNAL_WEB_FETCH_ENABLED']) ??
      false,
    INTERNAL_ALLOWED_TOOLS: Array.isArray(opts['INTERNAL_ALLOWED_TOOLS'])
      ? (opts['INTERNAL_ALLOWED_TOOLS'] as string[])
      : typeof process.env['OPENCODE_INTERNAL_ALLOWED_TOOLS'] === 'string'
        ? String(process.env['OPENCODE_INTERNAL_ALLOWED_TOOLS'])
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [],
    INTERNAL_TOOL_METRICS_ENABLED:
      normalizeBool(opts['INTERNAL_TOOL_METRICS_ENABLED']) ??
      normalizeBool(process.env['OPENCODE_INTERNAL_TOOL_METRICS_ENABLED']) ??
      true,
    INTERNAL_TOOL_DISCOVERY_FIXTURE: Array.isArray(opts['INTERNAL_TOOL_DISCOVERY_FIXTURE'])
      ? (opts['INTERNAL_TOOL_DISCOVERY_FIXTURE'] as string[])
      : typeof process.env['OPENCODE_TOOL_DISCOVERY_FIXTURE'] === 'string'
        ? String(process.env['OPENCODE_TOOL_DISCOVERY_FIXTURE'])
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [],
    HEALTH_DETAILS_ENABLED:
      normalizeBool(opts['HEALTH_DETAILS_ENABLED']) ??
      normalizeBool(process.env['OPENCODE_HEALTH_DETAILS_ENABLED']) ??
      true,
    HEALTH_DETAILS_REQUIRE_AUTH:
      normalizeBool(opts['HEALTH_DETAILS_REQUIRE_AUTH']) ??
      normalizeBool(process.env['OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH']) ??
      true,
    METRICS_ENABLED:
      normalizeBool(opts['METRICS_ENABLED']) ?? normalizeBool(process.env['OPENCODE_METRICS_ENABLED']) ?? false,
    METRICS_REQUIRE_AUTH:
      normalizeBool(opts['METRICS_REQUIRE_AUTH']) ??
      normalizeBool(process.env['OPENCODE_METRICS_REQUIRE_AUTH']) ??
      true,
    DEBUG:
      String(opts['DEBUG'] ?? '').toLowerCase() === 'true' ||
      opts['DEBUG'] === '1' ||
      String(process.env['OPENCODE_PROXY_DEBUG'] ?? '').toLowerCase() === 'true' ||
      process.env['OPENCODE_PROXY_DEBUG'] === '1',
    ZEN_API_KEY: (opts['ZEN_API_KEY'] as string) || process.env['OPENCODE_ZEN_API_KEY'] || '',
    PROMPT_MODE: promptMode,
    OMIT_SYSTEM_PROMPT:
      normalizeBool(opts['OMIT_SYSTEM_PROMPT']) ??
      normalizeBool(process.env['OPENCODE_PROXY_OMIT_SYSTEM_PROMPT']) ??
      promptMode === 'plugin-inject',
    AUTO_CLEANUP_CONVERSATIONS:
      normalizeBool(opts['AUTO_CLEANUP_CONVERSATIONS']) ??
      normalizeBool(process.env['OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS']) ??
      false,
    CLEANUP_INTERVAL_MS:
      Number.isFinite(cleanupIntervalMs) && cleanupIntervalMs > 0 ? cleanupIntervalMs : 12 * 60 * 60 * 1000,
    CLEANUP_MAX_AGE_MS:
      Number.isFinite(cleanupMaxAgeMs) && cleanupMaxAgeMs > 0 ? cleanupMaxAgeMs : 24 * 60 * 60 * 1000,
    OPENCODE_HOME_BASE: (opts['OPENCODE_HOME_BASE'] as string | null) || null,
  };
  return config;
}
