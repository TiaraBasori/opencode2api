import { VALIDATION_STATUSES, createValidationError } from './contracts.js';
import type { ValidationError } from './contracts.js';
import { findExternalToolByName } from './registry.js';
import type { ExternalToolEntry } from './registry.js';

/** A single parsed tool call awaiting validation. */
export interface ParsedCallFunction {
  name?: unknown;
  arguments?: unknown;
  [key: string]: unknown;
}

export interface ParsedCall {
  id?: unknown;
  type?: unknown;
  function?: ParsedCallFunction | null;
  [key: string]: unknown;
}

/** `valid` branch of the validation discriminated union. */
export interface ValidValidationResult {
  status: typeof VALIDATION_STATUSES.VALID;
  normalizedArguments: Record<string, unknown>;
  tool: ExternalToolEntry;
}

/** `repairable` branch (malformed JSON arguments, tool known). */
export interface RepairableValidationResult {
  status: typeof VALIDATION_STATUSES.REPAIRABLE;
  errors: ValidationError[];
  tool: ExternalToolEntry;
}

/** `rejected` branch (unknown tool or schema violations). */
export interface RejectedValidationResult {
  status: typeof VALIDATION_STATUSES.REJECTED;
  errors: ValidationError[];
  tool: ExternalToolEntry | null;
}

export type ValidationResult = ValidValidationResult | RepairableValidationResult | RejectedValidationResult;

export type SafeParseSuccess = { ok: true; value: Record<string, unknown> };
export type SafeParseFailure = { ok: false; error: string };
export type SafeParseResult = SafeParseSuccess | SafeParseFailure;

/** A validated call, enriched with normalized arguments and its registry entry. */
export interface ValidatedToolCall {
  id?: unknown;
  type?: unknown;
  function: { name?: unknown; arguments: string; [key: string]: unknown };
  validatedArguments: Record<string, unknown>;
  tool: ExternalToolEntry;
  validation: ValidValidationResult;
  [key: string]: unknown;
}

export interface InvalidCallEntry {
  call: ParsedCall;
  validation: ValidationResult;
}

export interface ValidateToolCallsResult {
  validCalls: ValidatedToolCall[];
  invalidCalls: InvalidCallEntry[];
}

function safeParseJsonObject(raw: unknown): SafeParseResult {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: {} };
  }
  if (typeof raw === 'object') {
    return Array.isArray(raw)
      ? { ok: false, error: 'arguments must be a JSON object' }
      : { ok: true, value: raw as Record<string, unknown> };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'arguments must be a JSON string or object' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'arguments must decode to a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function validateAgainstSchema(args: Record<string, unknown>, schema: unknown = {}): ValidationError[] {
  const errors: ValidationError[] = [];
  const normalizedSchema: Record<string, unknown> =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : {};
  const rawProperties: unknown = normalizedSchema['properties'];
  const properties: Record<string, unknown> =
    rawProperties && typeof rawProperties === 'object' && !Array.isArray(rawProperties)
      ? (rawProperties as Record<string, unknown>)
      : {};
  const rawRequired: unknown = normalizedSchema['required'];
  const required: unknown[] = Array.isArray(rawRequired) ? (rawRequired as unknown[]) : [];

  required.forEach((key: unknown) => {
    const field = String(key);
    if (!(field in args) || args[field] === undefined || args[field] === null || args[field] === '') {
      errors.push(createValidationError('missing_required_field', `Missing required field: ${String(key)}`, [String(key)]));
    }
  });

  Object.entries(properties).forEach(([key, definition]: [string, unknown]) => {
    if (!(key in args) || args[key] === undefined || args[key] === null) return;
    const value: unknown = args[key];
    const defRecord: Record<string, unknown> =
      definition && typeof definition === 'object' && !Array.isArray(definition)
        ? (definition as Record<string, unknown>)
        : {};
    const expectedType: unknown = defRecord['type'];
    if (expectedType === 'string' && typeof value !== 'string') {
      errors.push(createValidationError('invalid_type', `Field ${key} must be a string`, [key]));
    }
    if (expectedType === 'number' && typeof value !== 'number') {
      errors.push(createValidationError('invalid_type', `Field ${key} must be a number`, [key]));
    }
    if (expectedType === 'integer' && !Number.isInteger(value)) {
      errors.push(createValidationError('invalid_type', `Field ${key} must be an integer`, [key]));
    }
    if (expectedType === 'boolean' && typeof value !== 'boolean') {
      errors.push(createValidationError('invalid_type', `Field ${key} must be a boolean`, [key]));
    }
    if (expectedType === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
      errors.push(createValidationError('invalid_type', `Field ${key} must be an object`, [key]));
    }
    const enumRaw: unknown = defRecord['enum'];
    if (Array.isArray(enumRaw) && !(enumRaw as unknown[]).includes(value)) {
      errors.push(createValidationError('invalid_enum', `Field ${key} must be one of: ${(enumRaw as unknown[]).join(', ')}`, [key]));
    }
  });

  return errors;
}

function readFunctionName(parsedCall: unknown): unknown {
  if (!parsedCall || typeof parsedCall !== 'object' || Array.isArray(parsedCall)) return undefined;
  const fn: unknown = (parsedCall as Record<string, unknown>)['function'];
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return undefined;
  return (fn as Record<string, unknown>)['name'];
}

function readFunctionArguments(parsedCall: unknown): unknown {
  if (!parsedCall || typeof parsedCall !== 'object' || Array.isArray(parsedCall)) return undefined;
  const fn: unknown = (parsedCall as Record<string, unknown>)['function'];
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return undefined;
  return (fn as Record<string, unknown>)['arguments'];
}

export function validateToolCall(parsedCall: unknown, registry: unknown): ValidationResult {
  const requestedName: unknown = readFunctionName(parsedCall);
  const tool = findExternalToolByName(registry, requestedName);
  if (!tool) {
    return {
      status: VALIDATION_STATUSES.REJECTED,
      errors: [createValidationError('unknown_tool', `Unknown external tool: ${String(requestedName || 'unknown')}`)],
      tool: null
    };
  }

  const parsedArgs = safeParseJsonObject(readFunctionArguments(parsedCall));
  if (!parsedArgs.ok) {
    const failure = parsedArgs as SafeParseFailure;
    return {
      status: VALIDATION_STATUSES.REPAIRABLE,
      errors: [createValidationError('invalid_arguments_json', `Invalid JSON arguments for ${tool.originalName}: ${failure.error}`)],
      tool
    };
  }

  const schemaErrors = validateAgainstSchema(parsedArgs.value, tool.parameters);
  if (schemaErrors.length > 0) {
    return {
      status: VALIDATION_STATUSES.REJECTED,
      errors: schemaErrors,
      tool
    };
  }

  return {
    status: VALIDATION_STATUSES.VALID,
    normalizedArguments: parsedArgs.value,
    tool
  };
}

export function validateToolCalls(parsedCalls: unknown, registry: unknown): ValidateToolCallsResult {
  if (!Array.isArray(parsedCalls) || parsedCalls.length === 0) {
    return { validCalls: [], invalidCalls: [] };
  }

  const validCalls: ValidatedToolCall[] = [];
  const invalidCalls: InvalidCallEntry[] = [];
  (parsedCalls as unknown[]).forEach((call: unknown) => {
    const validation = validateToolCall(call, registry);
    const record: Record<string, unknown> =
      call && typeof call === 'object' && !Array.isArray(call) ? (call as Record<string, unknown>) : {};
    if (validation.status === VALIDATION_STATUSES.VALID) {
      const fnRaw: unknown = record['function'];
      const fnRecord: Record<string, unknown> =
        fnRaw && typeof fnRaw === 'object' && !Array.isArray(fnRaw) ? (fnRaw as Record<string, unknown>) : {};
      validCalls.push({
        ...record,
        validatedArguments: validation.normalizedArguments,
        function: {
          ...fnRecord,
          arguments: JSON.stringify(validation.normalizedArguments)
        },
        tool: validation.tool,
        validation
      });
      return;
    }
    invalidCalls.push({
      call: (call ?? {}) as ParsedCall,
      validation
    });
  });

  return { validCalls, invalidCalls };
}
