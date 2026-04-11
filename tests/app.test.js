import request from 'supertest';
import { jest } from '@jest/globals';

jest.unstable_mockModule('https', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const res = {
                statusCode: 200,
                headers: { 'content-type': 'image/png' },
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler(Buffer.from('fake-image-data'));
                    if (event === 'end') handler();
                })
            };
            callback(res);
            return {
                on: jest.fn(),
                destroy: jest.fn()
            };
        })
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: {
            providers: jest.fn(async () => ({
                data: {
                    providers: [
                        {
                            id: 'opencode',
                            models: {
                                'kimi-k2.5': { name: 'Kimi k2.5', release_date: '2024-01-15' },
                                'gpt-5-nano': { name: 'GPT-5 Nano', release_date: '2025-01-15' }
                            }
                        }
                    ]
                }
            })),
            update: jest.fn(async () => ({}))
        },
        session: {
            create: jest.fn(async () => ({
                data: { id: 'test-session-id' }
            })),
            prompt: jest.fn(async (args) => {
                const promptText = args.body.prompt || args.body.parts?.map(part => part.text || '').join(' ') || '';
                const parts = [{ type: 'text', text: 'Mock response' }];
                
                if (promptText.includes('reasoning')) {
                    parts.unshift({ type: 'reasoning', text: 'Thinking process...' });
                }
                
                return { data: { parts } };
            }),
            messages: jest.fn(async () => ([
                {
                    info: { role: 'assistant', finish: 'stop' },
                    parts: [
                        { type: 'text', text: 'Mock response' }
                    ]
                }
            ])),
            delete: jest.fn(async () => ({}))
        },
        event: {
            subscribe: jest.fn(async () => {
                const sessionId = 'test-session-id';
                const mockEvents = [
                    { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: 'Thinking...' } },
                    { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: 'Mock' } },
                    { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sessionId }, delta: ' response' } },
                    { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
                ];

                return {
                    stream: (async function* () {
                        for (const event of mockEvents) {
                            yield event;
                        }
                    })()
                };
            })
        }
    }))
}));

const { createApp } = await import('../src/proxy.js');

describe('Proxy OpenAI API', () => {
    let app;

    beforeAll(() => {
        process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:10001';
        process.env.OPENCODE_PROXY_DEBUG = 'false';
    });

    beforeEach(() => {
        const config = {
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false
        };
        const result = createApp(config);
        app = result.app;
    });

    test('GET /health returns status ok', async () => {
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
        expect(res.body.status).toEqual('ok');
    });

    test('GET /v1/models returns model list', async () => {
        const res = await request(app)
            .get('/v1/models')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('list');
        expect(res.body.data[0].id).toEqual('opencode/kimi-k2.5');
    });

    test('POST /v1/chat/completions returns chat completion', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
        expect(res.body.usage).toBeDefined();
        expect(res.body.usage.prompt_tokens).toBeGreaterThan(0);
    });

    test('POST /v1/chat/completions supports streaming', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions includes reasoning tags in streaming', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Test with reasoning' }],
                stream: true
            });

        expect(res.text).toContain('<think>');
        expect(res.text).toContain('');
    });

    test('POST /v1/chat/completions streaming does not emit nonstandard reasoning_content field', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Test with reasoning' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).not.toContain('reasoning_content');
    });

    test('POST /v1/chat/completions supports multimodal content', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ 
                    role: 'user', 
                    content: [
                        { type: 'text', text: 'What is in this image?' },
                        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
                    ]
                }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toBeDefined();
    });

    test('POST /v1/responses accepts input message array', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: [
                    {
                        type: 'message',
                        role: 'user',
                        content: [
                            { type: 'input_text', text: 'Hello from responses' }
                        ]
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].content[0].text).toBeDefined();
    });

    test('POST /v1/responses accepts chat-style input array', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: [{ role: 'user', content: 'Hello from chat-style input' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].content[0].text).toBeDefined();
    });

    test('POST /v1/responses accepts chat-style messages fallback', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello from messages fallback' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].content[0].text).toBeDefined();
    });

    test('POST /v1/chat/completions falls back to first available model when model is omitted', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                messages: [{ role: 'user', content: 'Hello without model' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
    });

    test('POST /v1/responses supports streaming', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Hello from responses stream',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('response.output_item.added');
        expect(res.text).toContain('response.content_part.added');
        expect(res.text).toContain('response.output_text.delta');
        expect(res.text).toContain('response.output_item.done');
        expect(res.text).toContain('response.completed');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses supports OpenAI reasoning object and unhyphenated GPT model aliases', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'gpt5-nano',
                input: 'Hello with reasoning object',
                reasoning: { effort: 'high' },
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('opencode/gpt-5-nano');
        expect(res.text).toContain('response.reasoning_summary_text.delta');
    });

    test('POST /v1/responses returns requested reasoning effort in completed payload', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'gpt5-nano',
                input: 'Hello with reasoning object',
                reasoning: { effort: 'high' },
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"effort":"high"');
    });

    test('Rejects requests without valid API key', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(401);
    });
});