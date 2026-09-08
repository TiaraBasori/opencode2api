import request from 'supertest';
import { jest } from '@jest/globals';

// Regression tests for the LiteLLM 500 case:
// backend `info.error` is a plain object ({name, data:{message}}), never an
// Error. Responses route used to `throw` it raw, and transformUpstreamError
// mangled it into 500 {"message":"Internal server error","code":"Object"}.

const BACKEND_CREDITS_ERROR = {
    name: 'CreditsError',
    data: {
        message: '401: {"message":"Insufficient balance, please recharge","type":"CreditsError"}',
        // Fast retry hint so the suite never waits out real backoff delays.
        responseHeaders: { 'retry-after-ms': '10' }
    }
};

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'kimi-k2.5': { name: 'Kimi' }, 'muse-spark-1.3-contributor-free': { name: 'Muse Spark' } } }] }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: [] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'err-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop', error: BACKEND_CREDITS_ERROR }, parts: [] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield {
                type: 'message.updated',
                properties: { info: { sessionID: 'err-session', finish: 'stop', error: BACKEND_CREDITS_ERROR } }
            };
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

const { createApp } = await import('../src/proxy.js');

describe('POST /v1/responses backend plain-object error', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        app = createApp({
            PORT: 10000, API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000, DISABLE_TOOLS: true, DEBUG: false
        }).app;
    });

    test('non-stream surfaces backend message as 402, never 500/Object', async () => {
        const res = await request(app).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'muse-spark-1.3-contributor-free', input: 'test from litellm' });
        expect(res.statusCode).toBe(402);
        expect(JSON.stringify(res.body)).toContain('Insufficient balance');
        expect(JSON.stringify(res.body)).not.toContain('"Object"');
        expect(res.body.error?.message).not.toBe('Internal server error');
    });

    test('unknown backend error keeps message, no Object code', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            { info: { role: 'assistant', finish: 'stop', error: { name: 'UnknownError', data: { message: 'boom-backend' } } }, parts: [] }
        ]);
        const res = await request(app).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        expect(res.statusCode).toBe(500);
        expect(JSON.stringify(res.body)).toContain('boom-backend');
        expect(JSON.stringify(res.body)).not.toContain('"Object"');
    });

    test('stream surfaces backend message in SSE failure, no Object code', async () => {
        const res = await request(app).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'hi', stream: true });
        expect(res.text).toContain('Insufficient balance');
        expect(res.text).not.toContain('"Object"');
    });

    test('messages non-stream uses transformed status/type, not hardcoded 502', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(402);
        expect(res.body.error?.type).toBe('insufficient_quota');
        expect(JSON.stringify(res.body)).toContain('Insufficient balance');
        expect(JSON.stringify(res.body)).not.toContain('"Object"');
    });

    test('responses non-stream retries transient failure then succeeds', async () => {
        sdkMocks.sessionMessages
            .mockResolvedValueOnce([
                { info: { role: 'assistant', finish: 'stop', error: BACKEND_CREDITS_ERROR }, parts: [] }
            ])
            .mockResolvedValue([
                { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'recovered' }] }
            ]);
        const res = await request(app).post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'hi' });
        expect(res.statusCode).toBe(200);
        expect(JSON.stringify(res.body)).toContain('recovered');
        expect(sdkMocks.sessionCreate.mock.calls.length).toBe(2);
    });

    describe('RETRY_MAX_RETRIES wiring (chat non-stream)', () => {
        const fastTransientError = {
            name: 'CreditsError',
            data: {
                message: '429: {"message":"Too many requests","type":"CreditsError"}',
                responseHeaders: { 'retry-after-ms': '10' }
            }
        };
        const buildApp = (retries) => createApp({
            PORT: 10000, API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000, DISABLE_TOOLS: true, DEBUG: false,
            RETRY_MAX_RETRIES: retries
        }).app;

        test('default retries transient errors (1 initial + retries)', async () => {
            sdkMocks.sessionMessages.mockImplementation(async () => ([
                { info: { role: 'assistant', finish: 'stop', error: fastTransientError }, parts: [] }
            ]));
            const chatApp = buildApp(undefined);
            const res = await request(chatApp).post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
            // Chat surfaces backend failures as 502 with the real message (existing behavior).
            expect(res.statusCode).toBe(502);
            expect(JSON.stringify(res.body)).toContain('Too many requests');
            // 1 initial session + 3 retries on fresh sessions (deterministic mock)
            expect(sdkMocks.sessionCreate.mock.calls.length).toBe(4);
        });

        test('RETRY_MAX_RETRIES=0 disables retry (single attempt)', async () => {
            sdkMocks.sessionMessages.mockImplementation(async () => ([
                { info: { role: 'assistant', finish: 'stop', error: fastTransientError }, parts: [] }
            ]));
            const chatApp = buildApp(0);
            const res = await request(chatApp).post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
            expect(res.statusCode).toBe(502);
            expect(sdkMocks.sessionCreate.mock.calls.length).toBe(1);
        });

        test('RETRY_MAX_RETRIES clamps to upstream ceiling of 5', async () => {
            sdkMocks.sessionMessages.mockImplementation(async () => ([
                { info: { role: 'assistant', finish: 'stop', error: fastTransientError }, parts: [] }
            ]));
            const chatApp = buildApp(99);
            const res = await request(chatApp).post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-key')
                .send({ model: 'opencode/kimi-k2.5', messages: [{ role: 'user', content: 'hi' }] });
            expect(res.statusCode).toBe(502);
            // 1 initial + exactly 5 retries after clamping 99 -> 5
            expect(sdkMocks.sessionCreate.mock.calls.length).toBe(6);
        });
    });
});
