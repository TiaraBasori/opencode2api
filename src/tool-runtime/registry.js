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

function inferSideEffect(tool = {}) {
  const declared = tool?.x_proxy_side_effect || tool?.function?.x_proxy_side_effect;
  if (declared) return normalizeSideEffect(declared, TOOL_SIDE_EFFECTS.NONE);

  const name = String(tool?.function?.name || '').toLowerCase();
  if (/^(get|list|search|find|read|fetch|lookup)/.test(name)) return TOOL_SIDE_EFFECTS.READ;
  if (/^(create|update|set|post|write|send)/.test(name)) return TOOL_SIDE_EFFECTS.WRITE;
  if (/^(delete|remove|destroy)/.test(name)) return TOOL_SIDE_EFFECTS.DELETE;
  return TOOL_SIDE_EFFECTS.NONE;
}

function inferRiskLevel(tool = {}, sideEffect = TOOL_SIDE_EFFECTS.NONE) {
  const declared = tool?.x_proxy_risk_level || tool?.function?.x_proxy_risk_level;
  if (declared) return normalizeRiskLevel(declared, TOOL_RISK_LEVELS.LOW);
  if (sideEffect === TOOL_SIDE_EFFECTS.DELETE || sideEffect === TOOL_SIDE_EFFECTS.PAYMENT) {
    return TOOL_RISK_LEVELS.CRITICAL;
  }
  if (sideEffect === TOOL_SIDE_EFFECTS.WRITE || sideEffect === TOOL_SIDE_EFFECTS.EXTERNAL_NOTIFICATION) {
    return TOOL_RISK_LEVELS.MEDIUM;
  }
  return TOOL_RISK_LEVELS.LOW;
}

function inferRequiresConfirmation(tool = {}, sideEffect = TOOL_SIDE_EFFECTS.NONE, riskLevel = TOOL_RISK_LEVELS.LOW) {
  if (typeof tool?.x_proxy_requires_confirmation === 'boolean') {
    return tool.x_proxy_requires_confirmation;
  }
  if (typeof tool?.function?.x_proxy_requires_confirmation === 'boolean') {
    return tool.function.x_proxy_requires_confirmation;
  }
  return sideEffect === TOOL_SIDE_EFFECTS.WRITE || riskLevel === TOOL_RISK_LEVELS.HIGH || riskLevel === TOOL_RISK_LEVELS.CRITICAL;
}

export function buildExternalToolRegistry(tools, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const prefix = options.prefix || EXTERNAL_TOOL_PREFIX;
  const registry = [];
  const seenNamespaced = new Set();

  tools.forEach((tool, index) => {
    if (tool?.type !== 'function' || !tool?.function?.name) return;
    const originalName = String(tool.function.name).trim();
    if (!originalName) return;

    let namespacedName = `${prefix}${originalName}`;
    let counter = 2;
    while (seenNamespaced.has(namespacedName)) {
      namespacedName = `${prefix}${originalName}_${counter}`;
      counter += 1;
    }
    seenNamespaced.add(namespacedName);

    const sideEffect = inferSideEffect(tool);
    const riskLevel = inferRiskLevel(tool, sideEffect);
    registry.push({
      id: `external_tool_${index + 1}`,
      originalName,
      namespacedName,
      description: normalizeDescription(tool.function.description),
      parameters: normalizeParameters(tool.function.parameters),
      sideEffect,
      riskLevel,
      requiresConfirmation: inferRequiresConfirmation(tool, sideEffect, riskLevel),
      enabled: tool?.function?.enabled !== false,
      sourceTool: tool
    });
  });

  return registry;
}

export function findExternalToolByName(registry, name) {
  if (!name || !Array.isArray(registry)) return null;
  return registry.find((tool) => tool.namespacedName === name || tool.originalName === name) || null;
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
