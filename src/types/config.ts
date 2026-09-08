/** Central proxy configuration (effective config for createApp). */

export interface ProxyConfig {
  PORT: number;
  API_KEY: string;
  OPENCODE_SERVER_URL: string;
  OPENCODE_SERVER_PASSWORD: string;
  OPENCODE_PATH: string;
  BIND_HOST: string;
  USE_ISOLATED_HOME: boolean;
  REQUEST_TIMEOUT_MS: number;
  MANAGE_BACKEND: boolean;
  DISABLE_TOOLS: boolean;
  EXTERNAL_TOOLS_MODE: string;
  EXTERNAL_TOOLS_CONFLICT_POLICY: string;
  INTERNAL_WEB_FETCH_ENABLED: boolean;
  INTERNAL_ALLOWED_TOOLS: string[];
  INTERNAL_TOOL_METRICS_ENABLED: boolean;
  INTERNAL_TOOL_DISCOVERY_FIXTURE: string[];
  HEALTH_DETAILS_ENABLED: boolean;
  HEALTH_DETAILS_REQUIRE_AUTH: boolean;
  METRICS_ENABLED: boolean;
  METRICS_REQUIRE_AUTH: boolean;
  DEBUG: boolean;
  ZEN_API_KEY: string;
  PROMPT_MODE: string;
  OMIT_SYSTEM_PROMPT: boolean;
  AUTO_CLEANUP_CONVERSATIONS: boolean;
  CLEANUP_INTERVAL_MS: number;
  CLEANUP_MAX_AGE_MS: number;
  OPENCODE_HOME_BASE: string | null;
  RETRY_MAX_RETRIES?: unknown;
  [key: string]: unknown;
}

/** Caller overrides accepted by buildProxyConfig/startProxy (null tolerated). */
export interface ProxyConfigOptions {
  PORT?: unknown;
  API_KEY?: unknown;
  OPENCODE_SERVER_URL?: unknown;
  OPENCODE_SERVER_PASSWORD?: unknown;
  OPENCODE_PATH?: unknown;
  BIND_HOST?: unknown;
  bindHost?: unknown;
  USE_ISOLATED_HOME?: unknown;
  REQUEST_TIMEOUT_MS?: unknown;
  MANAGE_BACKEND?: unknown;
  DISABLE_TOOLS?: unknown;
  disableTools?: unknown;
  EXTERNAL_TOOLS_MODE?: unknown;
  externalToolsMode?: unknown;
  EXTERNAL_TOOLS_CONFLICT_POLICY?: unknown;
  externalToolsConflictPolicy?: unknown;
  INTERNAL_WEB_FETCH_ENABLED?: unknown;
  INTERNAL_ALLOWED_TOOLS?: unknown;
  INTERNAL_TOOL_METRICS_ENABLED?: unknown;
  INTERNAL_TOOL_DISCOVERY_FIXTURE?: unknown;
  HEALTH_DETAILS_ENABLED?: unknown;
  HEALTH_DETAILS_REQUIRE_AUTH?: unknown;
  METRICS_ENABLED?: unknown;
  METRICS_REQUIRE_AUTH?: unknown;
  DEBUG?: unknown;
  ZEN_API_KEY?: unknown;
  PROMPT_MODE?: unknown;
  promptMode?: unknown;
  OMIT_SYSTEM_PROMPT?: unknown;
  AUTO_CLEANUP_CONVERSATIONS?: unknown;
  CLEANUP_INTERVAL_MS?: unknown;
  CLEANUP_MAX_AGE_MS?: unknown;
  OPENCODE_HOME_BASE?: unknown;
  RETRY_MAX_RETRIES?: unknown;
  PROMPT_MODE_ALIAS?: unknown;
  [key: string]: unknown;
}

/** Options bag for resolveDisableTools (both naming conventions). */
export interface DisableToolsOptions {
  DISABLE_TOOLS?: unknown;
  disableTools?: unknown;
  [key: string]: unknown;
}
