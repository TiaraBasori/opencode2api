import {
  TOOL_POLICY_DECISIONS,
  TOOL_RISK_LEVELS,
  TOOL_SIDE_EFFECTS
} from './contracts.js';

function toSet(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()));
}

export function createPolicyContext(config = {}) {
  return {
    mode: config.EXTERNAL_TOOL_POLICY_MODE || 'enforce',
    defaultRiskLevel: config.EXTERNAL_TOOL_DEFAULT_RISK_LEVEL || TOOL_RISK_LEVELS.LOW,
    allowlist: toSet(config.EXTERNAL_TOOL_ALLOWLIST || []),
    denylist: toSet(config.EXTERNAL_TOOL_DENYLIST || []),
    confirmationRequired: toSet(config.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR || [])
  };
}

export function evaluateToolPolicy(tool, args, context = {}) {
  if (!tool) {
    return {
      status: TOOL_POLICY_DECISIONS.DENY,
      code: 'unknown_tool',
      reason: 'Tool is not registered for this request.'
    };
  }

  const policy = createPolicyContext(context.config);
  const toolNames = [tool.originalName, tool.namespacedName].filter(Boolean);
  const inAllowlist = toolNames.some((name) => policy.allowlist.has(name));
  const inDenylist = toolNames.some((name) => policy.denylist.has(name));
  const requiresConfirmation = tool.requiresConfirmation
    || toolNames.some((name) => policy.confirmationRequired.has(name));

  if (inAllowlist) {
    return {
      status: TOOL_POLICY_DECISIONS.ALLOW,
      effectiveRisk: tool.riskLevel || policy.defaultRiskLevel
    };
  }

  if (inDenylist) {
    return {
      status: TOOL_POLICY_DECISIONS.DENY,
      code: 'tool_denied_by_policy',
      reason: `Tool ${tool.originalName} is denied by policy.`
    };
  }

  if (!inAllowlist && (tool.sideEffect === TOOL_SIDE_EFFECTS.DELETE || tool.riskLevel === TOOL_RISK_LEVELS.CRITICAL)) {
    return {
      status: TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION,
      reason: `Tool ${tool.originalName} is high risk and requires confirmation.`,
      confirmationPayload: {
        toolName: tool.originalName,
        namespacedName: tool.namespacedName,
        argumentsPreview: args,
        risk: tool.riskLevel
      }
    };
  }

  if (requiresConfirmation && policy.mode !== 'report-only') {
    return {
      status: TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION,
      reason: `Tool ${tool.originalName} requires confirmation before execution.`,
      confirmationPayload: {
        toolName: tool.originalName,
        namespacedName: tool.namespacedName,
        argumentsPreview: args,
        risk: tool.riskLevel
      }
    };
  }

  return {
    status: TOOL_POLICY_DECISIONS.ALLOW,
    effectiveRisk: tool.riskLevel || policy.defaultRiskLevel
  };
}
