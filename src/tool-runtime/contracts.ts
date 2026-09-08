export const EXTERNAL_TOOL_PREFIX = 'external__';

export const TOOL_RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
} as const;

export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[keyof typeof TOOL_RISK_LEVELS];

export const TOOL_SIDE_EFFECTS = {
  NONE: 'none',
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  EXTERNAL_NOTIFICATION: 'external_notification',
  PAYMENT: 'payment'
} as const;

export type ToolSideEffect = (typeof TOOL_SIDE_EFFECTS)[keyof typeof TOOL_SIDE_EFFECTS];

export const TOOL_POLICY_DECISIONS = {
  ALLOW: 'allow',
  DENY: 'deny',
  REQUIRE_CONFIRMATION: 'require_confirmation'
} as const;

export type PolicyDecision = (typeof TOOL_POLICY_DECISIONS)[keyof typeof TOOL_POLICY_DECISIONS];

export const VALIDATION_STATUSES = {
  VALID: 'valid',
  REPAIRABLE: 'repairable',
  REJECTED: 'rejected'
} as const;

export type ValidationStatus = (typeof VALIDATION_STATUSES)[keyof typeof VALIDATION_STATUSES];

export interface ValidationError {
  code: string;
  message: string;
  path: string[];
}

export function normalizeRiskLevel(value: unknown, fallback: ToolRiskLevel = TOOL_RISK_LEVELS.LOW): ToolRiskLevel {
  if (!value || typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return (Object.values(TOOL_RISK_LEVELS) as string[]).includes(normalized) ? (normalized as ToolRiskLevel) : fallback;
}

export function normalizeSideEffect(value: unknown, fallback: ToolSideEffect = TOOL_SIDE_EFFECTS.NONE): ToolSideEffect {
  if (!value || typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return (Object.values(TOOL_SIDE_EFFECTS) as string[]).includes(normalized) ? (normalized as ToolSideEffect) : fallback;
}

export function createValidationError(code: string, message: string, path: string[] = []): ValidationError {
  return { code, message, path };
}
