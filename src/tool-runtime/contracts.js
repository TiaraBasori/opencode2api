export const EXTERNAL_TOOL_PREFIX = 'external__';

export const TOOL_RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

export const TOOL_SIDE_EFFECTS = {
  NONE: 'none',
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  EXTERNAL_NOTIFICATION: 'external_notification',
  PAYMENT: 'payment'
};

export const TOOL_POLICY_DECISIONS = {
  ALLOW: 'allow',
  DENY: 'deny',
  REQUIRE_CONFIRMATION: 'require_confirmation'
};

export const VALIDATION_STATUSES = {
  VALID: 'valid',
  REPAIRABLE: 'repairable',
  REJECTED: 'rejected'
};

export function normalizeRiskLevel(value, fallback = TOOL_RISK_LEVELS.LOW) {
  if (!value || typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return Object.values(TOOL_RISK_LEVELS).includes(normalized) ? normalized : fallback;
}

export function normalizeSideEffect(value, fallback = TOOL_SIDE_EFFECTS.NONE) {
  if (!value || typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return Object.values(TOOL_SIDE_EFFECTS).includes(normalized) ? normalized : fallback;
}

export function createValidationError(code, message, path = []) {
  return { code, message, path };
}
