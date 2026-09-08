import {
  EXTERNAL_TOOL_PREFIX,
  TOOL_RISK_LEVELS,
  TOOL_SIDE_EFFECTS,
  normalizeRiskLevel,
  normalizeSideEffect
} from './contracts.js';
import type { ToolRiskLevel, ToolSideEffect } from './contracts.js';

/** Shared extension fields carried alongside a tool definition. */
export interface ToolDefinitionExtras {
  enabled?: unknown;
  x_proxy_side_effect?: unknown;
  x_proxy_risk_level?: unknown;
  x_proxy_requires_confirmation?: unknown;
  [key: string]: unknown;
}

/** Function payload nested under `tool.function` (Chat Completions shape). */
export interface ChatFunctionPayload extends ToolDefinitionExtras {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  input_schema?: unknown;
}

/** Shape 1 — Chat Completions nests the definition under `function`. */
export interface ChatFunctionNestedTool extends ToolDefinitionExtras {
  type: 'function';
  function: ChatFunctionPayload;
}

/** Shape 2 — Responses API keeps the definition flat. */
export interface ResponsesFlatTool extends ToolDefinitionExtras {
  type: 'function';
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  input_schema?: unknown;
  function?: unknown;
}

/** Shape 3 — Anthropic Messages shape uses `input_schema` instead of `parameters`. */
export interface AnthropicInputSchemaTool extends ToolDefinitionExtras {
  type: 'function';
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  parameters?: unknown;
  function?: unknown;
}

/** The three function-tool shapes the proxy receives. */
export type IncomingToolDefinition =
  | ChatFunctionNestedTool
  | ResponsesFlatTool
  | AnthropicInputSchemaTool;

/** Normalized view produced by {@link normalizeToolDefinition}. */
export interface NormalizedToolDefinition {
  name: string;
  description: unknown;
  parameters: unknown;
  enabled: unknown;
  x_proxy_side_effect: unknown;
  x_proxy_risk_level: unknown;
  x_proxy_requires_confirmation: unknown;
}

/** A single namespaced external tool in the request registry. */
export interface ExternalToolEntry {
  id: string;
  originalName: string;
  namespacedName: string;
  description: string;
  parameters: Record<string, unknown>;
  sideEffect: ToolSideEffect;
  riskLevel: ToolRiskLevel;
  requiresConfirmation: boolean;
  enabled: boolean;
  sourceTool: unknown;
}

export type ToolRegistry = ExternalToolEntry[];

export interface RegistryIndex {
  byOriginalName: Map<string, ExternalToolEntry>;
  byNamespacedName: Map<string, ExternalToolEntry>;
}

export interface BuildRegistryOptions {
  prefix?: unknown;
  [key: string]: unknown;
}

function normalizeDescription(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeParameters(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    return parameters as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

/**
 * Normalizes the two function-tool shapes the proxy receives.
 *
 * Chat Completions nests the definition:  { type:'function', function:{ name, parameters } }
 * The Responses API keeps it flat:        { type:'function', name, parameters }
 *
 * Callers used to read `tool.function.name` directly, so every Responses-API tool was
 * silently dropped from the registry. An empty registry means no tool contract reaches the
 * prompt and no tool-call markup is ever parsed back out, which is indistinguishable from
 * a model that simply refuses to call tools.
 */
export function normalizeToolDefinition(tool: unknown): NormalizedToolDefinition | null {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  const candidate = tool as IncomingToolDefinition & Record<string, unknown>;
  if (candidate['type'] !== 'function') return null;
  // Narrow the union: Chat shape carries `function` as an object; the flat and
  // Anthropic shapes are used directly.
  const maybeFn: unknown = (candidate as ChatFunctionNestedTool).function;
  const definition: Record<string, unknown> =
    maybeFn && typeof maybeFn === 'object' && !Array.isArray(maybeFn)
      ? (maybeFn as Record<string, unknown>)
      : (candidate as unknown as Record<string, unknown>);
  const name = String(definition['name'] || '').trim();
  if (!name) return null;
  // Anthropic Messages shape uses `input_schema` instead of `parameters`.
  const parameters: unknown = definition['parameters'] ?? definition['input_schema'];
  const topLevel = candidate as unknown as Record<string, unknown>;
  return {
    name,
    description: definition['description'],
    parameters,
    enabled: definition['enabled'],
    x_proxy_side_effect: definition['x_proxy_side_effect'] ?? topLevel['x_proxy_side_effect'],
    x_proxy_risk_level: definition['x_proxy_risk_level'] ?? topLevel['x_proxy_risk_level'],
    x_proxy_requires_confirmation:
      definition['x_proxy_requires_confirmation'] ?? topLevel['x_proxy_requires_confirmation']
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function inferSideEffect(definition: unknown = {}): ToolSideEffect {
  const record = asRecord(definition);
  const declared: unknown = record['x_proxy_side_effect'];
  if (declared) return normalizeSideEffect(declared, TOOL_SIDE_EFFECTS.NONE);

  const name = String(record['name'] || '').toLowerCase();
  if (/^(get|list|search|find|read|fetch|lookup)/.test(name)) return TOOL_SIDE_EFFECTS.READ;
  if (/^(create|update|set|post|write|send)/.test(name)) return TOOL_SIDE_EFFECTS.WRITE;
  if (/^(delete|remove|destroy)/.test(name)) return TOOL_SIDE_EFFECTS.DELETE;
  return TOOL_SIDE_EFFECTS.NONE;
}

function inferRiskLevel(definition: unknown = {}, sideEffect: ToolSideEffect = TOOL_SIDE_EFFECTS.NONE): ToolRiskLevel {
  const record = asRecord(definition);
  const declared: unknown = record['x_proxy_risk_level'];
  if (declared) return normalizeRiskLevel(declared, TOOL_RISK_LEVELS.LOW);
  if (sideEffect === TOOL_SIDE_EFFECTS.DELETE || sideEffect === TOOL_SIDE_EFFECTS.PAYMENT) {
    return TOOL_RISK_LEVELS.CRITICAL;
  }
  if (sideEffect === TOOL_SIDE_EFFECTS.WRITE || sideEffect === TOOL_SIDE_EFFECTS.EXTERNAL_NOTIFICATION) {
    return TOOL_RISK_LEVELS.MEDIUM;
  }
  return TOOL_RISK_LEVELS.LOW;
}

function inferRequiresConfirmation(
  definition: unknown = {},
  sideEffect: ToolSideEffect = TOOL_SIDE_EFFECTS.NONE,
  riskLevel: ToolRiskLevel = TOOL_RISK_LEVELS.LOW
): boolean {
  const record = asRecord(definition);
  if (typeof record['x_proxy_requires_confirmation'] === 'boolean') {
    return record['x_proxy_requires_confirmation'] as boolean;
  }
  return sideEffect === TOOL_SIDE_EFFECTS.WRITE || riskLevel === TOOL_RISK_LEVELS.HIGH || riskLevel === TOOL_RISK_LEVELS.CRITICAL;
}

export function buildExternalToolRegistry(tools: unknown, options: unknown = {}): ExternalToolEntry[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const opts = asRecord(options);
  const prefixRaw: unknown = opts['prefix'];
  const prefix = prefixRaw ? String(prefixRaw) : EXTERNAL_TOOL_PREFIX;
  const registry: ExternalToolEntry[] = [];
  const seenNamespaced = new Set<string>();

  (tools as unknown[]).forEach((tool: unknown, index: number) => {
    const definition = normalizeToolDefinition(tool);
    if (!definition) return;
    const originalName = definition.name;

    let namespacedName = `${prefix}${originalName}`;
    let counter = 2;
    while (seenNamespaced.has(namespacedName)) {
      namespacedName = `${prefix}${originalName}_${counter}`;
      counter += 1;
    }
    seenNamespaced.add(namespacedName);

    const sideEffect = inferSideEffect(definition);
    const riskLevel = inferRiskLevel(definition, sideEffect);
    registry.push({
      id: `external_tool_${index + 1}`,
      originalName,
      namespacedName,
      description: normalizeDescription(definition.description),
      parameters: normalizeParameters(definition.parameters),
      sideEffect,
      riskLevel,
      requiresConfirmation: inferRequiresConfirmation(definition, sideEffect, riskLevel),
      enabled: definition.enabled !== false,
      sourceTool: tool
    });
  });

  return registry;
}

export function findExternalToolByName(registry: unknown, name: unknown): ExternalToolEntry | null {
  if (!name || !Array.isArray(registry)) return null;
  const list = registry as ExternalToolEntry[];
  const exact = list.find((tool) => tool.namespacedName === name || tool.originalName === name);
  if (exact) return exact;

  // Models frequently drop separators or change case when emitting a tool name
  // (e.g. the request declares `web_fetch` but the model writes `webfetch`).
  // Fall back to a separator/case-insensitive match, but only when it is
  // unambiguous — an exact match always wins and a tie resolves to nothing.
  const normalized = normalizeToolNameForMatch(name);
  if (!normalized) return null;
  const matches = list.filter((tool) =>
    normalizeToolNameForMatch(tool.namespacedName) === normalized ||
    normalizeToolNameForMatch(tool.originalName) === normalized
  );
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

function normalizeToolNameForMatch(name: unknown): string {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function createRegistryIndex(registry: unknown): RegistryIndex {
  const byOriginalName = new Map<string, ExternalToolEntry>();
  const byNamespacedName = new Map<string, ExternalToolEntry>();
  const list: ExternalToolEntry[] = Array.isArray(registry) ? (registry as ExternalToolEntry[]) : [];
  list.forEach((tool) => {
    byOriginalName.set(tool.originalName, tool);
    byNamespacedName.set(tool.namespacedName, tool);
  });
  return { byOriginalName, byNamespacedName };
}
