// P4 TS: upstream error classification/normalization (ported from P3 .js, behavior identical).
import type { NormalizedUpstreamError, RawBackendErrorLike, TransformedUpstreamError } from '../types/errors.js';

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const v: unknown = record[key];
  return typeof v === 'string' ? v : null;
}

function collectMessageParts(error: unknown): string {
  const record = asRecord(error);
  const data = asRecord(record['data']);
  const parts: string[] = [];
  const candidates: unknown[] = [record['message'], data['message'], record['name'], record['code'], record['type']];
  for (const part of candidates) {
    if (typeof part === 'string') parts.push(part);
  }
  return parts.join(' ');
}

/**
 * Detect transient upstream provider failures that succeed on retry.
 *
 * The upstream (OpenCode Zen) occasionally mislabels throttling as billing
 * errors: a worker hits its request limit and returns
 * `401: {"message":"Insufficient balance...","type":"CreditsError"}` even
 * though the account is fine — the very next attempt succeeds. These errors
 * are surfaced to clients as bogus "insufficient balance" failures (issue #5).
 * Match them (plus generic rate-limit/5xx signatures) so the proxy can retry
 * with backoff before giving up.
 */
export function isTransientUpstreamError(error: unknown): boolean {
  if (!error) return false;
  const message = collectMessageParts(error);
  if (!message) return false;

  // Upstream opencode never retries context overflow (retry.ts); neither do we.
  // A 500 carrying a context message must surface immediately, not burn retries.
  if (/context.?length|context.?overflow|context_length_exceeded/i.test(message)) return false;

  const record = asRecord(error);
  const data = asRecord(record['data']);
  // Provider-marked retryable (SDK ApiError.data.isRetryable) is transient,
  // whatever the status code. Explicit false defers to the checks below.
  if (record['isRetryable'] === true || data['isRetryable'] === true) return true;

  // Genuine auth failures must surface immediately: a misconfigured key
  // should not burn the full backoff. The issue-#5 mislabeled billing case
  // ("Insufficient balance"/CreditsError) never carries these strings, so
  // it still retries. Placed after isRetryable so a provider-explicit
  // retryable flag keeps winning (upstream-faithful).
  if (/invalid[_\s]?api[_\s]?key|unauthorized|authentication (failed|error)|api key (expired|invalid|incorrect)/i.test(message)) return false;

  const transientSignatures: RegExp[] = [
    /insufficient balance/i,
    /credits?error/i,
    /rate.?limit/i,
    /too many requests/i,
    /worker request limit/i,
    /overloaded/i,
    /temporarily unavailable/i,
    /internal server error/i,
    /bad gateway/i,
    /service unavailable/i,
    /stream error/i,
    // Transport-layer flakes (upstream retry.ts message patterns): the main
    // reason opencode "retries many times".
    /terminated/i,
    /fetch failed/i,
    /network error/i,
    /upstream connect/i,
    /econnreset/i,
    /etimedout/i,
    /eai_again/i,
    /getaddrinfo/i,
    /socket hang up/i,
    /zlib error/i,
    /header.?timeout/i,
    /try again (?:later|in\b)/i,
    /try your request again/i,
    /retry your request/i,
    /resource exhausted/i,
    /(?:currently|temporarily) at capacity/i,
  ];
  if (transientSignatures.some((re) => re.test(message))) return true;

  // Upstream errors arrive as "<status>: {json}" strings; SDK errors may also
  // carry a numeric status on the object itself. Only accept a leading
  // "<status>:" prefix — a loose \b(\d{3}): match misfires on embedded
  // numbers like "retry after 300: ...".
  const recordStatus: unknown = record['statusCode'] ?? data['status'];
  let status: number | null = typeof recordStatus === 'number' ? recordStatus : null;
  if (typeof status !== 'number') {
    const statusCandidates: string[] = [];
    const msg: unknown = record['message'];
    const dataMsg: unknown = data['message'];
    if (typeof msg === 'string') statusCandidates.push(msg);
    if (typeof dataMsg === 'string') statusCandidates.push(dataMsg);
    for (const candidate of statusCandidates) {
      const prefixMatch = candidate.match(/^\s*(\d{3})\s*:/);
      if (prefixMatch?.[1]) {
        status = Number(prefixMatch[1]);
        break;
      }
    }
  }
  if (typeof status === 'number') {
    if (status === 401 || status === 402 || status === 429) return true;
    if (status >= 500) return true;
  }
  return false;
}

/**
 * Normalize a backend error into a real Error instance.
 *
 * The OpenCode backend surfaces failures as plain objects
 * ({name, data:{message, statusCode?}}, see SDK types.gen AssistantMessage
 * error union), never as Error instances. Throwing one raw makes
 * transformUpstreamError fall back to 500/"Internal server error"/code
 * "Object" and drops the real message. Normalizing once at the throw
 * site (or poll exit) keeps every downstream reader working.
 */
export function normalizeBackendError(raw: unknown): NormalizedUpstreamError {
  if (raw instanceof Error) return raw as NormalizedUpstreamError;
  const record = asRecord(raw);
  const data = asRecord(record['data']);
  let message: unknown = data['message'] ?? record['message'] ?? record['name'] ?? null;
  if (typeof message !== 'string' || !message) {
    try {
      const jsoned: unknown = JSON.stringify(raw);
      message = typeof jsoned === 'string' ? jsoned : String(record['name'] ?? 'Upstream provider error');
      if (!message) message = String(record['name'] ?? 'Upstream provider error');
    } catch {
      message = String(record['name'] ?? 'Upstream provider error');
    }
  }
  const messageStr = String(message);
  let statusCode: unknown = record['statusCode'] ?? data['statusCode'] ?? data['status'] ?? null;
  if (typeof statusCode !== 'number') {
    const m = messageStr.match(/^\s*(\d{3})\s*:/);
    if (m?.[1]) statusCode = Number(m[1]);
  }
  if (typeof statusCode !== 'number') {
    const s = messageStr.toLowerCase();
    if (/insufficient balance|credits?error|insufficient credits|billing|quota exceeded|credit limit/.test(s)) statusCode = 402;
    else if (/rate.?limit|too many requests|worker request limit/.test(s)) statusCode = 429;
    else if (/invalid api key|unauthorized|authentication/.test(s)) statusCode = 401;
  }
  const err = new Error(messageStr) as NormalizedUpstreamError;
  if (typeof statusCode === 'number') err.statusCode = statusCode;
  const codeRaw: unknown = record['code'] ?? record['type'] ?? record['name'] ?? 'upstream_error';
  const typeRaw: unknown = record['type'] ?? record['code'] ?? record['name'] ?? 'upstream_error';
  err.code = typeof codeRaw === 'string' ? codeRaw : String(codeRaw);
  err.type = typeof typeRaw === 'string' ? typeRaw : String(typeRaw);
  if (record['data'] !== undefined) err.data = record['data'];
  // Preserve provider retry signals for the retry policy (see src/retry/policy.ts):
  // responseHeaders (retry-after-ms / retry-after) and isRetryable live on
  // ApiError.data in the SDK type union.
  const responseHeaders: unknown = record['responseHeaders'] ?? data['responseHeaders'] ?? null;
  if (responseHeaders && typeof responseHeaders === 'object') {
    err.responseHeaders = responseHeaders as Record<string, string | number | undefined>;
  }
  if (typeof record['isRetryable'] === 'boolean') err.isRetryable = record['isRetryable'] as boolean;
  else if (typeof data['isRetryable'] === 'boolean') err.isRetryable = data['isRetryable'] as boolean;
  err.cause = raw;
  return err;
}

/**
 * Transform upstream provider errors to OpenAI-compatible format
 */
export function transformUpstreamError(error: unknown): TransformedUpstreamError {
  // Defense in depth: callers may hand us a raw backend plain object
  // ({name, data:{message}}) instead of an Error. Normalize first so the
  // mapping below sees message/statusCode/code instead of falling back
  // to 500/"Internal server error"/code "Object".
  const normalized = normalizeBackendError(error);
  const typed = normalized as NormalizedUpstreamError & Record<string, unknown>;
  // Default fallback
  let statusCode = 500;
  let message: string = normalized.message || 'Internal server error';
  let type = 'internal_error';
  let code: string = (typeof typed['code'] === 'string' ? (typed['code'] as string) : 'upstream_error') || 'upstream_error';

  // Handle timeout errors
  if (normalized.message && normalized.message.includes('Request timeout')) {
    statusCode = 504;
    type = 'timeout';
    code = 'timeout';
    message = 'Request timeout';
  } else if (normalized.message && normalized.message.includes('ENOENT')) {
    // Handle file access errors (Windows compatibility)
    statusCode = 500;
    type = 'internal_error';
    code = 'file_access_error';
    message = 'OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service.';
  } else if (typeof typed['statusCode'] === 'number') {
    // Handle upstream provider errors (from OpenCode SDK)
    statusCode = typed['statusCode'] as number;

    // Map upstream error types to OpenAI-compatible types
    const upstreamType = String(typed['code'] ?? typed['type'] ?? '');
    const upstreamMessage = normalized.message || '';

    // Billing/credit errors - map to 402 Payment Required
    if (
      upstreamType === 'CreditsError' ||
      upstreamType === 'InsufficientBalanceError' ||
      upstreamMessage.toLowerCase().includes('insufficient balance') ||
      upstreamMessage.toLowerCase().includes('insufficient credits') ||
      upstreamMessage.toLowerCase().includes('billing') ||
      upstreamMessage.toLowerCase().includes('quota exceeded') ||
      upstreamMessage.toLowerCase().includes('credit limit')
    ) {
      statusCode = 402;
      type = 'insufficient_quota';
      code = 'insufficient_quota';
      message = upstreamMessage || 'Insufficient balance or quota exceeded';
    } else if (
      upstreamType === 'RateLimitError' ||
      upstreamType === 'TooManyRequestsError' ||
      statusCode === 429 ||
      upstreamMessage.toLowerCase().includes('rate limit') ||
      upstreamMessage.toLowerCase().includes('too many requests')
    ) {
      // Rate limit errors - map to 429
      statusCode = 429;
      type = 'rate_limit_exceeded';
      code = 'rate_limit_exceeded';
      message = upstreamMessage || 'Rate limit exceeded';
    } else if (
      upstreamType === 'AuthenticationError' ||
      upstreamType === 'InvalidAPIKeyError' ||
      statusCode === 401 ||
      upstreamMessage.toLowerCase().includes('invalid api key') ||
      upstreamMessage.toLowerCase().includes('unauthorized') ||
      upstreamMessage.toLowerCase().includes('authentication')
    ) {
      // Authentication errors - keep as 401
      statusCode = 401;
      type = 'invalid_api_key';
      code = 'invalid_api_key';
      message = upstreamMessage || 'Invalid API key';
    } else if (
      upstreamType === 'PermissionError' ||
      statusCode === 403 ||
      upstreamMessage.toLowerCase().includes('permission denied') ||
      upstreamMessage.toLowerCase().includes('access denied')
    ) {
      // Permission errors - map to 403
      statusCode = 403;
      type = 'permission_denied';
      code = 'permission_denied';
      message = upstreamMessage || 'Permission denied';
    } else if (
      upstreamType === 'NotFoundError' ||
      statusCode === 404 ||
      upstreamMessage.toLowerCase().includes('model not found') ||
      upstreamMessage.toLowerCase().includes('does not exist')
    ) {
      // Model not found - map to 404
      statusCode = 404;
      type = 'model_not_found';
      code = 'model_not_found';
      message = upstreamMessage || 'Model not found';
    } else if (statusCode === 400 || upstreamType === 'BadRequestError') {
      // Bad request - map to 400
      statusCode = 400;
      type = 'invalid_request_error';
      code = 'invalid_request_error';
      message = upstreamMessage || 'Invalid request';
    } else if (statusCode >= 500) {
      // Server errors from upstream - map to 502/503
      statusCode = 502;
      type = 'server_error';
      code = 'server_error';
      message = upstreamMessage || 'Upstream provider error';
    } else {
      // Default: pass through with mapped type
      type = upstreamType.toLowerCase().replace(/error$/, '_error') || 'upstream_error';
      code = upstreamType;
      message = upstreamMessage;
    }
  }

  const availableModels: unknown = (normalized as RawBackendErrorLike & { availableModels?: unknown }).availableModels;
  return {
    statusCode,
    error: {
      message,
      type,
      ...(code ? { code } : {}),
      ...(availableModels !== undefined ? { available_models: availableModels } : {}),
    },
  };
}
