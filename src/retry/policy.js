/**
 * Retry policy ported from upstream opencode
 * (`packages/opencode/src/session/retry.ts`), adapted for this gateway.
 *
 * Upstream reference values:
 * - RETRY_INITIAL_DELAY = 2000ms, RETRY_BACKOFF_FACTOR = 2,
 *   RETRY_JITTER_FACTOR = 0.25, RETRY_MAX_RETRIES = 5
 * - delay(): retry-after-ms > retry-after (seconds) > retry-after (HTTP date)
 *   > exponential backoff; capped at 30s without headers.
 *
 * Gateway deviations (deliberate, documented):
 * - All waits are capped at 30s (MAX_DELAY_NO_HEADERS_MS /
 *   MAX_HEADER_DELAY_MS). Upstream caps headerless backoff at 30s too, but
 *   honors header-directed waits almost unboundedly (up to INT32_MAX — it
 *   once waited 700s). A gateway fronting clients with their own timeouts
 *   (e.g. LiteLLM) must not sleep for hours, so header values are clamped.
 * - Max retries resolve through resolveMaxRetries(): default 3 (this proxy's
 *   historical behavior), configurable via OPENCODE_PROXY_RETRY_MAX_RETRIES,
 *   hard-capped at ABSOLUTE_MAX_RETRIES = 5 (upstream ceiling).
 *
 * All functions are pure (no express/SDK imports) for unit testing.
 */

export const DEFAULT_MAX_RETRIES = 3;
export const ABSOLUTE_MAX_RETRIES = 5;

export const RETRY_INITIAL_DELAY_MS = 2000;
export const RETRY_BACKOFF_FACTOR = 2;
export const RETRY_JITTER_FACTOR = 0.25;
export const MAX_DELAY_NO_HEADERS_MS = 30000;
export const MAX_HEADER_DELAY_MS = 30000;

/**
 * Resolve the configured max-retry count to an integer in [0, 5].
 * Non-numeric / missing values fall back to DEFAULT_MAX_RETRIES (3).
 */
export function resolveMaxRetries(value) {
    const n = typeof value === 'number' ? value : parseInt(value, 10);
    if (!Number.isFinite(n)) return DEFAULT_MAX_RETRIES;
    const floored = Math.floor(n);
    if (floored < 0) return 0;
    if (floored > ABSOLUTE_MAX_RETRIES) return ABSOLUTE_MAX_RETRIES;
    return floored;
}

/**
 * Parse a provider retry hint from response headers into milliseconds.
 * Priority (upstream order): retry-after-ms > retry-after (seconds) >
 * retry-after (HTTP date). Invalid / past values yield null (caller falls
 * back to exponential). Header names are matched case-insensitively.
 */
export function parseRetryAfterMs(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const lookup = (name) => {
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === name) return headers[key];
        }
        return undefined;
    };
    const msRaw = lookup('retry-after-ms');
    if (msRaw !== undefined) {
        const ms = Number.parseFloat(msRaw);
        if (!Number.isNaN(ms) && ms >= 0) return Math.ceil(ms);
    }
    const afterRaw = lookup('retry-after');
    if (afterRaw !== undefined && afterRaw !== null && afterRaw !== '') {
        const seconds = Number.parseFloat(afterRaw);
        if (!Number.isNaN(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
        const dateMs = Date.parse(afterRaw) - Date.now();
        if (!Number.isNaN(dateMs) && dateMs > 0) return Math.ceil(dateMs);
    }
    return null;
}

function exponentialDelay(attempt, random) {
    const base = RETRY_INITIAL_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1);
    return Math.ceil(base + base * RETRY_JITTER_FACTOR * random);
}

/**
 * Compute how long to wait before retry number `attempt` (1-based: the wait
 * preceding the 2nd overall attempt is attempt=1 → ~2000ms).
 * error may carry responseHeaders directly or under .data (backend shape).
 */
export function computeRetryDelay(attempt, error = null, random = Math.random()) {
    const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
    const safeRandom = typeof random === 'number' && random >= 0 && random <= 1 ? random : Math.random();
    const headers = error?.responseHeaders ?? error?.data?.responseHeaders ?? null;
    const hinted = parseRetryAfterMs(headers);
    if (hinted !== null) return Math.min(hinted, MAX_HEADER_DELAY_MS);
    return Math.min(exponentialDelay(safeAttempt, safeRandom), MAX_DELAY_NO_HEADERS_MS);
}
