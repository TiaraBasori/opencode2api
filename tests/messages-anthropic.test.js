import request from 'supertest';
import { jest } from '@jest/globals';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: {
            providers: [{ id: 'opencode', models: { 'muse-spark-1.3-contributor-free': { name: 'Muse Spark' }, 'kimi-k2.5': { name: 'Kimi' } } }]
        }
    })),
    configUpdate: jest.fn(async () => ({})),
    toolIds: jest.fn(async () => ({ data: [] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'msg-session' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'Hello!' }] } })),
    sessionMessages: jest.fn(async () => ([{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Hello!' }] }])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({
        stream: (async function* () {
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: 'Hello' } };
            yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'msg-session' }, delta: '!' } };
            yield { type: 'message.updated', properties: { info: { sessionID: 'msg-session', finish: 'stop' } } };
        })()
    }))
};

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = { statusCode: 200, headers: { 'content-type': 'image/png' }, on: jest.fn((event, handler) => { if (event === 'data') handler(Buffer.from('x')); if (event === 'end') handler(); }) };
            callback(res);
            return { on: jest.fn(), destroy: jest.fn() };
        })
    }
}));

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            // checkHealth path -> 200; image downloads -> empty
            if (String(url).includes('/health')) {
                const res = { statusCode: 200, headers: {}, on: jest.fn() };
                callback(res);
                return { on: jest.fn(), destroy: jest.fn(), setTimeout: jest.fn() };
            }
            const response = { statusCode: 200, headers: {}, on: jest.fn() };
            callback(response);
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
import {
    validateMessagesRequest,
    anthropicMessagesToChatMessages,
    anthropicToolsToChatTools,
    anthropicToolChoiceToChat,
    mapFinishToStopReason
} from '../src/converters/anthropic.js';

describe('Anthropic /v1/messages converters', () => {
    test('validation requires model/max_tokens/messages', () => {
        expect(validateMessagesRequest({})).not.toBeNull();
        expect(validateMessagesRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })).toBeNull();
        expect(validateMessagesRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'assistant', content: 'hi' }] }).statusCode).toBe(400);
    });
    test('tool_use/tool_result round-trip preserves toolu_ id', () => {
        const chat = anthropicMessagesToChatMessages([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_abc', name: 'weather_lookup', input: { city: 'Tokyo' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'sunny' }] }
        ]);
        const flat = JSON.stringify(chat);
        expect(flat).toContain('toolu_abc');
        expect(flat).toContain('tool_call_id');
    });
    test('tools input_schema and tool_choice mapping', () => {
        expect(anthropicToolsToChatTools([{ name: 'w', input_schema: { type: 'object' } }])[0].function.parameters).toEqual({ type: 'object' });
        expect(anthropicToolChoiceToChat({ type: 'any' })).toBe('required');
        expect(anthropicToolChoiceToChat({ type: 'tool', name: 'w' })).toEqual({ type: 'function', function: { name: 'w' } });
        expect(mapFinishToStopReason('stop', true)).toBe('tool_use');
    });
});

describe('POST /v1/messages', () => {
    let app;
    beforeEach(() => {
        jest.clearAllMocks();
        const config = { PORT: 10000, API_KEY: 'test-key', OPENCODE_SERVER_URL: 'http://127.0.0.1:10001', REQUEST_TIMEOUT_MS: 5000, DISABLE_TOOLS: true, DEBUG: false };
        app = createApp(config).app;
    });
    test('non-stream returns Anthropic message shape', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        expect(res.body.type).toBe('message');
        expect(res.body.role).toBe('assistant');
        expect(Array.isArray(res.body.content)).toBe(true);
        expect(res.body.stop_reason).toBe('end_turn');
        expect(res.body.usage.input_tokens).toBeGreaterThanOrEqual(0);
    });
    test('401 without key', async () => {
        const res = await request(app).post('/v1/messages')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(401);
        expect(res.body.type).toBe('error');
    });
    test('tiny max_tokens does not fake max_tokens stop_reason (usage is estimated)', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        // Backend does not surface truncation; stop_reason comes from tool calls only.
        expect(res.body.stop_reason).toBe('end_turn');
    });
    test('missing max_tokens -> 400', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(400);
    });
    test('x-api-key auth works', async () => {
        const res = await request(app).post('/v1/messages')
            .set('x-api-key', 'test-key')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
    });
    test('stream emits message_start/delta/stop without [DONE]', async () => {
        const res = await request(app).post('/v1/messages')
            .set('Authorization', 'Bearer test-key')
            .set('Accept', 'text/event-stream')
            .send({ model: 'opencode/muse-spark-1.3-contributor-free', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toBe(200);
        expect(res.text).toContain('event: message_start');
        expect(res.text).toContain('event: message_stop');
        expect(res.text).not.toContain('[DONE]');
    });
});
