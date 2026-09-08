import request from 'supertest';
import { jest } from '@jest/globals';

// Hardening for slow/overloaded hosts: /v1/responses must never sit at zero
// bytes silently (no headers, no error) when the backend is stuck.
const SESSION_ID = 'harden-session';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'big-pickle': { name: 'Big Pickle' } } }] }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: [] })),
    sessionCreate: jest.fn(async () => ({ data: { id: SESSION_ID } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'Mock response' }] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Mock response' }] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: SESSION_ID }, delta: 'Mock response' } };
            yield { type: 'message.updated', properties: { info: { sessionID: SESSION_ID, finish: 'stop' } } };
        })()
    }))
};

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = { statusCode: 200, headers: {}, on: jest.fn() };
            callback(res);
            return { on: jest.fn(), destroy: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = { statusCode: 200, headers: {}, on: jest.fn() };
            callback(res);
            return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate },
        tool: { ids: sdkMocks.toolIds },
        session: { create: sdkMocks.sessionCreate, prompt: sdkMocks.sessionPrompt, messages: sdkMocks.sessionMessages, delete: sdkMocks.sessionDelete },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

const { createApp, withTimeout } = await import('../src/proxy.js');

describe('withTimeout', () => {
    test('resolves with the value on success', async () => {
        await expect(withTimeout(Promise.resolve('ok'), 1000, 't')).resolves.toBe('ok');
    });

    test('rejects with a 504-mappable Request timeout message', async () => {
        const slow = new Promise(() => {});
        await expect(withTimeout(slow, 50, 'load tool overrides')).rejects.toThrow('Request timeout after 50ms (load tool overrides)');
    });

    test('a fast rejection wins with the real error, not a timeout', async () => {
        const started = Date.now();
        await expect(withTimeout(Promise.reject(new Error('invalid model')), 5000, 'resolve model'))
            .rejects.toThrow('invalid model');
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test('a late rejection never surfaces as unhandled', async () => {
        let unhandled = null;
        const listener = (err) => { unhandled = err; };
        process.on('unhandledRejection', listener);
        try {
            let rejectLate;
            const loser = new Promise((_, reject) => { rejectLate = reject; });
            await expect(withTimeout(loser, 20, 't')).rejects.toThrow('Request timeout');
            rejectLate(new Error('boom-after-race'));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(unhandled).toBeNull();
        } finally {
            process.removeListener('unhandledRejection', listener);
        }
    });
});

describe('POST /v1/responses stream hardening', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const buildApp = (overrides = {}) => createApp({
        PORT: 10000, API_KEY: 'test-key',
        OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
        REQUEST_TIMEOUT_MS: 5000, RETRY_MAX_RETRIES: 0,
        DISABLE_TOOLS: true, DEBUG: false, ...overrides
    }).app;

    test('slow preflight still yields a complete SSE stream', async () => {
        sdkMocks.sessionCreate.mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return { data: { id: SESSION_ID } };
        });
        const res = await request(buildApp()).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'big-pickle', input: 'hi', stream: true });
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('response.created');
        expect(res.text).toContain('response.completed');
        expect(res.text).toContain('data: [DONE]');
    });
    test('hung backend prompt surfaces a 504 timeout instead of stalling', async () => {
        sdkMocks.sessionPrompt.mockImplementationOnce(() => new Promise(() => {}));
        const started = Date.now();
        const res = await request(buildApp({ REQUEST_TIMEOUT_MS: 400 })).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'big-pickle', input: 'hi' });
        expect(Date.now() - started).toBeLessThan(15000);
        expect(res.statusCode).toBe(504);
        expect(JSON.stringify(res.body)).not.toContain('"Object"');
    }, 20000);

    test('hung retry session.create surfaces a 504 instead of stalling', async () => {
        // Attempt 1 fails transiently (fast backoff via retry-after-ms),
        // then the retry's session.create hangs: must 504, not stall.
        sdkMocks.sessionCreate
            .mockImplementationOnce(async () => ({ data: { id: SESSION_ID } }))
            .mockImplementationOnce(() => new Promise(() => {}));
        sdkMocks.sessionPrompt.mockImplementationOnce(async () => {
            throw {
                name: 'CreditsError',
                data: {
                    message: '429: {"message":"Too many requests","type":"CreditsError"}',
                    responseHeaders: { 'retry-after-ms': '10' }
                }
            };
        });
        const started = Date.now();
        const res = await request(buildApp({ REQUEST_TIMEOUT_MS: 400, RETRY_MAX_RETRIES: 1 }))
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'big-pickle', input: 'hi' });
        expect(Date.now() - started).toBeLessThan(15000);
        expect(res.statusCode).toBe(504);
        expect(JSON.stringify(res.body)).not.toContain('"Object"');
    }, 20000);
});

describe('POST /v1/messages stream does not cancel itself', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('stream completes even though the request body closed long ago', async () => {
        const app = createApp({
            PORT: 10000, API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000, RETRY_MAX_RETRIES: 0,
            DISABLE_TOOLS: true, DEBUG: false
        }).app;
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .set('anthropic-version', '2023-06-01')
            .send({ model: 'big-pickle', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true });
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('message_stop');
    }, 20000);
});
