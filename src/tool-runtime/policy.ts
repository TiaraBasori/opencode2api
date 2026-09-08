import {
  TOOL_POLICY_DECISIONS,
  TOOL_RISK_LEVELS,
  TOOL_SIDE_EFFECTS
} from './contracts.js';

/** Raw policy configuration source (env / file merge). */
export interface PolicyRawConfig {
  EXTERNAL_TOOL_POLICY_MODE?: unknown;
  EXTERNAL_TOOL_DEFAULT_RISK_LEVEL?: unknown;
  EXTERNAL_TOOL_ALLOWLIST?: unknown;
  EXTERNAL_TOOL_DENYLIST?: unknown;
  EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR?: unknown;
  [key: string]: unknown;
}

/** Normalized policy context derived from raw config. */
export interface PolicyContext {
  mode: string;
  defaultRiskLevel: unknown;
  allowlist: Set<string>;
  denylist: Set<string>;
  confirmationRequired: Set<string>;
}

/** Minimal tool surface evaluated by the policy (structural subset of ExternalToolEntry). */
export interface PolicyToolLike {
  originalName?: unknown;
  namespacedName?: unknown;
  requiresConfirmation?: unknown;
  sideEffect?: unknown;
  riskLevel?: unknown;
}

/** Wrapper carrying the raw config, mirroring the JS `{ config }` convention. */
export interface PolicyEvaluateContext {
  config?: unknown;
  [key: string]: unknown;
}

export interface PolicyAllowResult {
  status: typeof TOOL_POLICY_DECISIONS.ALLOW;
  effectiveRisk: unknown;
}

export interface PolicyDenyResult {
  status: typeof TOOL_POLICY_DECISIONS.DENY;
  code: string;
  reason: string;
}

export interface PolicyConfirmationPayload {
  toolName: unknown;
  namespacedName: unknown;
  argumentsPreview: unknown;
  risk: unknown;
}

export interface PolicyRequireConfirmationResult {
  status: typeof TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION;
  reason: string;
  confirmationPayload: PolicyConfirmationPayload;
}

export type PolicyResult = PolicyAllowResult | PolicyDenyResult | PolicyRequireConfirmationResult;

function toSet(values: unknown): Set<string> {
  if (!Array.isArray(values)) return new Set<string>();
  const out = new Set<string>();
  for (const value of values as unknown[]) {
    if (typeof value === 'string' && value.trim()) out.add(value.trim());
  }
  return out;
}

export function createPolicyContext(config: unknown = {}): PolicyContext {
  const raw: Record<string, unknown> =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  const modeRaw: unknown = raw['EXTERNAL_TOOL_POLICY_MODE'];
  const riskRaw: unknown = raw['EXTERNAL_TOOL_DEFAULT_RISK_LEVEL'];
  return {
    mode: typeof modeRaw === 'string' && modeRaw ? modeRaw : 'enforce',
    defaultRiskLevel: riskRaw || TOOL_RISK_LEVELS.LOW,
    allowlist: toSet(raw['EXTERNAL_TOOL_ALLOWLIST']),
    denylist: toSet(raw['EXTERNAL_TOOL_DENYLIST']),
    confirmationRequired: toSet(raw['EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR'])
  };
}

export function evaluateToolPolicy(tool: unknown, args: unknown, context: unknown = {}): PolicyResult {
  if (!tool) {
    return {
      status: TOOL_POLICY_DECISIONS.DENY,
      code: 'unknown_tool',
      reason: 'Tool is not registered for this request.'
    };
  }

  const ctxRecord: Record<string, unknown> =
    context && typeof context === 'object' && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : {};
  const policy = createPolicyContext(ctxRecord['config']);
  const candidate = tool as PolicyToolLike;
  const toolNames: string[] = [candidate.originalName, candidate.namespacedName].filter(
    (name): name is string => typeof name === 'string' && Boolean(name)
  );
  const inAllowlist = toolNames.some((name) => policy.allowlist.has(name));
  const inDenylist = toolNames.some((name) => policy.denylist.has(name));
  const requiresConfirmation =
    Boolean(candidate.requiresConfirmation) ||
    toolNames.some((name) => policy.confirmationRequired.has(name));

  if (inAllowlist) {
    return {
      status: TOOL_POLICY_DECISIONS.ALLOW,
      effectiveRisk: candidate.riskLevel || policy.defaultRiskLevel
    };
  }

  if (inDenylist) {
    return {
      status: TOOL_POLICY_DECISIONS.DENY,
      code: 'tool_denied_by_policy',
      reason: `Tool ${String(candidate.originalName)} is denied by policy.`
    };
  }

  if (!inAllowlist && (candidate.sideEffect === TOOL_SIDE_EFFECTS.DELETE || candidate.riskLevel === TOOL_RISK_LEVELS.CRITICAL)) {
    return {
      status: TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION,
      reason: `Tool ${String(candidate.originalName)} is high risk and requires confirmation.`,
      confirmationPayload: {
        toolName: candidate.originalName,
        namespacedName: candidate.namespacedName,
        argumentsPreview: args,
        risk: candidate.riskLevel
      }
    };
  }

  if (requiresConfirmation && policy.mode !== 'report-only') {
    return {
      status: TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION,
      reason: `Tool ${String(candidate.originalName)} requires confirmation before execution.`,
      confirmationPayload: {
        toolName: candidate.originalName,
        namespacedName: candidate.namespacedName,
        argumentsPreview: args,
        risk: candidate.riskLevel
      }
    };
  }

  return {
    status: TOOL_POLICY_DECISIONS.ALLOW,
    effectiveRisk: candidate.riskLevel || policy.defaultRiskLevel
  };
}
