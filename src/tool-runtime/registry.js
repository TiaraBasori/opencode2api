import {
  EXTERNAL_TOOL_PREFIX,
  TOOL_RISK_LEVELS,
  TOOL_SIDE_EFFECTS,
  normalizeRiskLevel,
  normalizeSideEffect
} from './contracts.js';

function normalizeDescription(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeParameters(parameters) {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    return parameters;
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
export function normalizeToolDefinition(tool) {
  if (!tool || tool.type !== 'function') return null;
  const definition = tool.function && typeof tool.function === 'object' ? tool.function : tool;
  const name = String(definition.name || '').trim();
  if (!name) return null;
  // Anthropic Messages shape uses `input_schema` instead of `parameters`.
  const parameters = definition.parameters ?? definition.input_schema;
  return {
    name,
    description: definition.description,
    parameters,
    enabled: definition.enabled,
    x_proxy_side_effect: definition.x_proxy_side_effect ?? tool.x_proxy_side_effect,
    x_proxy_risk_level: definition.x_proxy_risk_level ?? tool.x_proxy_risk_level,
    x_proxy_requires_confirmation:
      definition.x_proxy_requires_confirmation ?? tool.x_proxy_requires_confirmation
  };
}

function inferSideEffect(definition = {}) {
  const declared = definition.x_proxy_side_effect;
  if (declared) return normalizeSideEffect(declared, TOOL_SIDE_EFFECTS.NONE);

  const name = String(definition.name || '').toLowerCase();
  if (/^(get|list|search|find|read|fetch|lookup)/.test(name)) return TOOL_SIDE_EFFECTS.READ;
  if (/^(create|update|set|post|write|send)/.test(name)) return TOOL_SIDE_EFFECTS.WRITE;
  if (/^(delete|remove|destroy)/.test(name)) return TOOL_SIDE_EFFECTS.DELETE;
  return TOOL_SIDE_EFFECTS.NONE;
}

function inferRiskLevel(definition = {}, sideEffect = TOOL_SIDE_EFFECTS.NONE) {
  const declared = definition.x_proxy_risk_level;
  if (declared) return normalizeRiskLevel(declared, TOOL_RISK_LEVELS.LOW);
  if (sideEffect === TOOL_SIDE_EFFECTS.DELETE || sideEffect === TOOL_SIDE_EFFECTS.PAYMENT) {
    return TOOL_RISK_LEVELS.CRITICAL;
  }
  if (sideEffect === TOOL_SIDE_EFFECTS.WRITE || sideEffect === TOOL_SIDE_EFFECTS.EXTERNAL_NOTIFICATION) {
    return TOOL_RISK_LEVELS.MEDIUM;
  }
  return TOOL_RISK_LEVELS.LOW;
}

function inferRequiresConfirmation(definition = {}, sideEffect = TOOL_SIDE_EFFECTS.NONE, riskLevel = TOOL_RISK_LEVELS.LOW) {
  if (typeof definition.x_proxy_requires_confirmation === 'boolean') {
    return definition.x_proxy_requires_confirmation;
  }
  return sideEffect === TOOL_SIDE_EFFECTS.WRITE || riskLevel === TOOL_RISK_LEVELS.HIGH || riskLevel === TOOL_RISK_LEVELS.CRITICAL;
}

export function buildExternalToolRegistry(tools, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const prefix = options.prefix || EXTERNAL_TOOL_PREFIX;
  const registry = [];
  const seenNamespaced = new Set();

  tools.forEach((tool, index) => {
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

export function findExternalToolByName(registry, name) {
    if (!name || !Array.isArray(registry)) return null;
    const exact = registry.find((tool) => tool.namespacedName === name || tool.originalName === name);
    if (exact) return exact;

    // Models frequently drop separators or change case when emitting a tool name
    // (e.g. the request declares `web_fetch` but the model writes `webfetch`).
    // Fall back to a separator/case-insensitive match, but only when it is
    // unambiguous — an exact match always wins and a tie resolves to nothing.
    const normalized = normalizeToolNameForMatch(name);
    if (!normalized) return null;
    const matches = registry.filter((tool) =>
        normalizeToolNameForMatch(tool.namespacedName) === normalized ||
        normalizeToolNameForMatch(tool.originalName) === normalized
    );
    return matches.length === 1 ? matches[0] : null;
}

function normalizeToolNameForMatch(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function createRegistryIndex(registry) {
  const byOriginalName = new Map();
  const byNamespacedName = new Map();
  (registry || []).forEach((tool) => {
    byOriginalName.set(tool.originalName, tool);
    byNamespacedName.set(tool.namespacedName, tool);
  });
  return { byOriginalName, byNamespacedName };
}
