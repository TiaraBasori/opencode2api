/** Minimal OpenCode SDK surface used by the proxy (structural subset). */

export interface SessionNamespace {
  create: (args?: unknown) => Promise<unknown>;
  prompt: (args: unknown) => Promise<unknown>;
  messages: (args: unknown) => Promise<unknown>;
  delete: (args: unknown) => Promise<unknown>;
}

export interface ConfigNamespace {
  providers: (args?: unknown) => Promise<unknown>;
  update: (args: unknown) => Promise<unknown>;
}

export interface ToolNamespace {
  ids: (args?: unknown) => Promise<unknown>;
}

export interface EventNamespace {
  subscribe: (args: unknown) => Promise<unknown>;
}

/** Structural client used across routes/collector (real SDK cast to this). */
export interface ProxyClient {
  session: SessionNamespace;
  config: ConfigNamespace;
  tool: ToolNamespace;
  event: EventNamespace;
}

/** Provider entry used to build the /v1/models list. */
export interface ProviderInfo {
  id: string;
  models?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Normalized model list entry served by GET /v1/models. */
export interface ModelInfo {
  id: string;
  name: unknown;
  object: string;
  created: number;
  owned_by: string;
}

/** Result of resolving a requested model string to provider/model IDs. */
export interface ResolvedModel {
  providerID: string;
  modelID: string;
  models: ModelInfo[];
  resolved: string;
  aliasFrom?: string;
}
