import { VALIDATION_STATUSES, createValidationError } from './contracts.js';
import { findExternalToolByName } from './registry.js';

function safeParseJsonObject(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: {} };
  }
  if (typeof raw === 'object') {
    return Array.isArray(raw)
      ? { ok: false, error: 'arguments must be a JSON object' }
      : { ok: true, value: raw };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'arguments must be a JSON string or object' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'arguments must decode to a JSON object' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function validateAgainstSchema(args, schema = {}) {
  const errors = [];
  const normalizedSchema = schema && typeof schema === 'object' ? schema : {};
  const properties = normalizedSchema.properties && typeof normalizedSchema.properties === 'object'
    ? normalizedSchema.properties
    : {};
  const required = Array.isArray(normalizedSchema.required) ? normalizedSchema.required : [];

  required.forEach((key) => {
    if (!(key in args) || args[key] === undefined || args[key] === null || args[key] === '') {
      errors.push(createValidationError('missing_required_field', `Missing required field: ${key}`, [key]));
    }
  });

  Object.entries(properties).forEach(([key, definition]) => {
    if (!(key in args) || args[key] === undefined || args[key] === null) return;
    const value = args[key];
    const expectedType = definition?.type;
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
    if (Array.isArray(definition?.enum) && !definition.enum.includes(value)) {
      errors.push(createValidationError('invalid_enum', `Field ${key} must be one of: ${definition.enum.join(', ')}`, [key]));
    }
  });

  return errors;
}

export function validateToolCall(parsedCall, registry) {
  const tool = findExternalToolByName(registry, parsedCall?.function?.name);
  if (!tool) {
    return {
      status: VALIDATION_STATUSES.REJECTED,
      errors: [createValidationError('unknown_tool', `Unknown external tool: ${parsedCall?.function?.name || 'unknown'}`)],
      tool: null
    };
  }

  const parsedArgs = safeParseJsonObject(parsedCall?.function?.arguments);
  if (!parsedArgs.ok) {
    return {
      status: VALIDATION_STATUSES.REPAIRABLE,
      errors: [createValidationError('invalid_arguments_json', `Invalid JSON arguments for ${tool.originalName}: ${parsedArgs.error}`)],
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

export function validateToolCalls(parsedCalls, registry) {
  if (!Array.isArray(parsedCalls) || parsedCalls.length === 0) {
    return { validCalls: [], invalidCalls: [] };
  }

  const validCalls = [];
  const invalidCalls = [];
  parsedCalls.forEach((call) => {
    const validation = validateToolCall(call, registry);
    if (validation.status === VALIDATION_STATUSES.VALID) {
      validCalls.push({
        ...call,
        validatedArguments: validation.normalizedArguments,
        function: {
          ...call.function,
          arguments: JSON.stringify(validation.normalizedArguments)
        },
        tool: validation.tool,
        validation
      });
      return;
    }
    invalidCalls.push({
      call,
      validation
    });
  });

  return { validCalls, invalidCalls };
}
