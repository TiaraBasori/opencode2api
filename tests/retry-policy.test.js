import {
    resolveMaxRetries,
    parseRetryAfterMs,
    computeRetryDelay,
    DEFAULT_MAX_RETRIES,
    ABSOLUTE_MAX_RETRIES,
    RETRY_INITIAL_DELAY_MS,
    MAX_DELAY_NO_HEADERS_MS,
    MAX_HEADER_DELAY_MS
} from '../src/retry/policy.js';

describe('resolveMaxRetries', () => {
    test('defaults to 3 for missing/invalid values', () => {
        expect(resolveMaxRetries(undefined)).toBe(DEFAULT_MAX_RETRIES);
        expect(resolveMaxRetries(null)).toBe(DEFAULT_MAX_RETRIES);
        expect(resolveMaxRetries('')).toBe(DEFAULT_MAX_RETRIES);
        expect(resolveMaxRetries('abc')).toBe(DEFAULT_MAX_RETRIES);
        expect(resolveMaxRetries(NaN)).toBe(DEFAULT_MAX_RETRIES);
        expect(DEFAULT_MAX_RETRIES).toBe(3);
    });
    test('accepts 0-5, clamps beyond the upstream ceiling', () => {
        expect(resolveMaxRetries(0)).toBe(0);
        expect(resolveMaxRetries(1)).toBe(1);
        expect(resolveMaxRetries(5)).toBe(5);
        expect(resolveMaxRetries(99)).toBe(ABSOLUTE_MAX_RETRIES);
        expect(resolveMaxRetries(-2)).toBe(0);
        expect(resolveMaxRetries('4')).toBe(4);
        expect(resolveMaxRetries(2.9)).toBe(2);
        expect(ABSOLUTE_MAX_RETRIES).toBe(5);
    });
});

describe('parseRetryAfterMs', () => {
    test('returns null for missing/invalid headers', () => {
        expect(parseRetryAfterMs(null)).toBeNull();
        expect(parseRetryAfterMs({})).toBeNull();
        expect(parseRetryAfterMs({ 'retry-after': 'not-a-number' })).toBeNull();
        expect(parseRetryAfterMs({ 'retry-after-ms': 'abc' })).toBeNull();
    });
    test('retry-after-ms wins (upstream priority)', () => {
        expect(parseRetryAfterMs({ 'retry-after-ms': '1500', 'retry-after': '30' })).toBe(1500);
    });
    test('retry-after seconds convert to ms', () => {
        expect(parseRetryAfterMs({ 'retry-after': '30' })).toBe(30000);
    });
    test('retry-after HTTP date uses remaining time, past dates rejected', () => {
        const future = new Date(Date.now() + 20000).toUTCString();
        const d = parseRetryAfterMs({ 'retry-after': future });
        expect(d).toBeGreaterThanOrEqual(19000);
        expect(d).toBeLessThanOrEqual(20000);
        const past = new Date(Date.now() - 5000).toUTCString();
        expect(parseRetryAfterMs({ 'retry-after': past })).toBeNull();
    });
    test('header names are case-insensitive', () => {
        expect(parseRetryAfterMs({ 'Retry-After': '2' })).toBe(2000);
    });
});

describe('computeRetryDelay', () => {
    test('exponential sequence without headers (random=0)', () => {
        expect(computeRetryDelay(1, null, 0)).toBe(RETRY_INITIAL_DELAY_MS);
        expect(computeRetryDelay(2, null, 0)).toBe(4000);
        expect(computeRetryDelay(3, null, 0)).toBe(8000);
        expect(computeRetryDelay(4, null, 0)).toBe(16000);
    });
    test('caps at 30s without headers', () => {
        expect(computeRetryDelay(10, null, 0)).toBe(MAX_DELAY_NO_HEADERS_MS);
        expect(computeRetryDelay(10, null, 1)).toBe(MAX_DELAY_NO_HEADERS_MS);
    });
    test('jitter stays within +25%', () => {
        expect(computeRetryDelay(1, null, 1)).toBe(2500);
        const d = computeRetryDelay(2, null, 0.5);
        expect(d).toBeGreaterThan(4000);
        expect(d).toBeLessThanOrEqual(5000);
    });
    test('honors retry-after headers, clamped to gateway max', () => {
        expect(computeRetryDelay(1, { responseHeaders: { 'retry-after-ms': '1500' } }, 0)).toBe(1500);
        expect(computeRetryDelay(1, { data: { responseHeaders: { 'retry-after': '5' } } }, 0)).toBe(5000);
        expect(computeRetryDelay(1, { responseHeaders: { 'retry-after': '700' } }, 0)).toBe(MAX_HEADER_DELAY_MS);
    });
});
