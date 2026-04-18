import request from 'supertest';
import { jest } from '@jest/globals';
import { buildExternalToolRegistry } from '../src/tool-runtime/registry.js';
import { normalizeExternalToolChoice, buildToolExposure } from '../src/tool-runtime/router.js';
import { evaluateToolPolicy } from '../src/tool-runtime/policy.js';
import { validateToolCall, validateToolCalls } from '../src/tool-runtime/validator.js';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
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
    configUpdate: jest.fn(async () => ({})),
    sessionCreate: jest.fn(async () => ({
        data: { id: 'test-session-id' }
    })),
    sessionPrompt: jest.fn(async (args) => {
        const promptText = args.body.prompt || args.body.parts?.map(part => part.text || '').join(' ') || '';
        const parts = [{ type: 'text', text: 'Mock response' }];

        if (promptText.includes('reasoning')) {
            parts.unshift({ type: 'reasoning', text: 'Thinking process...' });
        }

        return { data: { parts } };
    }),
    sessionMessages: jest.fn(async () => ([
        {
            info: { role: 'assistant', finish: 'stop' },
            parts: [
                { type: 'text', text: 'Mock response' }
            ]
        }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => {
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
};

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

jest.unstable_mockModule('http', () => ({
    default: {
        get: jest.fn((url, options, callback) => {
            const response = {
                statusCode: 200,
                headers: {},
                on: jest.fn()
            };

            callback(response);

            return {
                on: jest.fn(),
                destroy: jest.fn(),
                setTimeout: jest.fn()
            };
        })
    }
}));

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: {
            providers: sdkMocks.configProviders,
            update: sdkMocks.configUpdate
        },
        session: {
            create: sdkMocks.sessionCreate,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete
        },
        event: {
            subscribe: sdkMocks.eventSubscribe
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
        jest.clearAllMocks();
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

    test('POST /v1/chat/completions keeps normal non-tool responses unchanged when no external tools are provided', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'text', text: 'Plain assistant reply' }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message).toEqual({
            role: 'assistant',
            content: 'Plain assistant reply'
        });
        expect(res.body.choices[0].message.tool_calls).toBeUndefined();
    });

    test('POST /v1/chat/completions returns OpenAI-compatible tool_calls for external tools', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"call_weather_1","name":"weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                    }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(res.body.choices[0].message.role).toEqual('assistant');
        expect(res.body.choices[0].message.content).toBeNull();
        expect(res.body.choices[0].message.tool_calls).toEqual([
            {
                id: 'call_weather_1',
                type: 'function',
                function: {
                    name: 'weather_lookup',
                    arguments: JSON.stringify({ city: 'Tokyo', unit: 'celsius' })
                }
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy. They are not OpenCode tools.');
        expect(promptCall.body.system).toContain('external__weather_lookup');
        expect(promptCall.body.system).toContain('client_name');
    });

    test('POST /v1/chat/completions keeps external web_fetch isolated from internal tool semantics', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"call_web_fetch_1","name":"web_fetch","arguments":{"url":"https://example.com"}}]</function_calls>'
                    }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'External fetch tool',
                            parameters: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' }
                                },
                                required: ['url']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(res.body.choices[0].message.tool_calls).toEqual([
            {
                id: 'call_web_fetch_1',
                type: 'function',
                function: {
                    name: 'web_fetch',
                    arguments: JSON.stringify({ url: 'https://example.com' })
                }
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('Use only the namespaced names listed below. Do not use original client tool names inside function calls.');
        expect(promptCall.body.system).toContain('external__web_fetch');
        expect(promptCall.body.tools).toBeUndefined();
    });

    test('POST /v1/chat/completions continues after tool result messages with matching tool_call_id', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'text', text: 'The weather in Tokyo is 22°C and sunny.' }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: { city: { type: 'string' } },
                                required: ['city']
                            }
                        }
                    }
                ],
                messages: [
                    { role: 'user', content: 'What is the weather in Tokyo?' },
                    {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call_weather_1',
                                type: 'function',
                                function: {
                                    name: 'weather_lookup',
                                    arguments: JSON.stringify({ city: 'Tokyo' })
                                }
                            }
                        ]
                    },
                    {
                        role: 'tool',
                        tool_call_id: 'call_weather_1',
                        content: '22°C and sunny',
                        name: 'weather_lookup'
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message).toEqual({
            role: 'assistant',
            content: 'The weather in Tokyo is 22°C and sunny.'
        });

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'text',
                text: expect.stringContaining('ASSISTANT: <function_calls>')
            }),
            expect.objectContaining({
                type: 'text',
                text: 'TOOL_RESULT: {"tool_call_id":"call_weather_1","name":"external__weather_lookup","content":"22°C and sunny"}'
            })
        ]));
        expect(promptCall.body.parts[1].text).toContain('external__weather_lookup');
        expect(promptCall.body.parts[1].text).toContain('call_weather_1');
        expect(promptCall.body.parts[1].text).toContain('{\\"city\\":\\"Tokyo\\"}');
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

    test('POST /v1/chat/completions streaming emits tool_call chunks for external tools without leaking raw function markup', async () => {
        sdkMocks.eventSubscribe.mockResolvedValueOnce({
            stream: (async function* () {
                const sessionId = 'test-session-id';
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'reasoning', sessionID: sessionId },
                        delta: 'Thinking...'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '<function_calls>[{"id":"call_weather_stream_1","name":"external__weather_lookup","arguments":'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('<think>');
        expect(res.text).toContain('"tool_calls":[{"index":0,"id":"call_weather_stream_1","type":"function","function":{"name":"weather_lookup"');
        expect(res.text).toContain('"arguments":"{\\"city\\":\\"Tokyo\\",\\"unit\\":\\"celsius\\"}"');
        expect(res.text).toContain('"finish_reason":"tool_calls"');
        expect(res.text).not.toContain('<function_calls>');
        expect(res.text).not.toContain('external__weather_lookup');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions streaming preserves same-name collision isolation for external tools', async () => {
        sdkMocks.eventSubscribe.mockResolvedValueOnce({
            stream: (async function* () {
                const sessionId = 'test-session-id';
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '<function_calls>[{"id":"call_collision_1","name":"external__web_fetch_2","arguments":{"url":"https://example.com/collision"}}]</function_calls>'
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Use the second web_fetch tool' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'First external fetch tool',
                            parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
                        }
                    },
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'Second external fetch tool',
                            parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
                        }
                    }
                ],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"tool_calls":[{"index":0,"id":"call_collision_1","type":"function","function":{"name":"web_fetch"');
        expect(res.text).toContain('https://example.com/collision');
        expect(res.text).not.toContain('external__web_fetch_2');
        expect(res.text).not.toContain('<function_calls>');
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('external__web_fetch');
        expect(promptCall.body.system).toContain('external__web_fetch_2');
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

    test('POST /v1/responses returns external function_call output items for non-stream requests', async () => {
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"resp_call_weather_1","name":"external__weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                    }
                ]
            }
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'What is the weather in Tokyo?',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output).toEqual([
            {
                type: 'function_call',
                status: 'completed',
                id: 'resp_call_weather_1',
                call_id: 'resp_call_weather_1',
                name: 'weather_lookup',
                arguments: JSON.stringify({ city: 'Tokyo', unit: 'celsius' })
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy. They are not OpenCode tools.');
        expect(promptCall.body.system).toContain('external__weather_lookup');
        expect(promptCall.body.system).toContain('client_name');
    });

    test('POST /v1/responses keeps external web_fetch isolated from internal tool semantics', async () => {
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"resp_call_web_fetch_1","name":"external__web_fetch","arguments":{"url":"https://example.com"}}]</function_calls>'
                    }
                ]
            }
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Fetch https://example.com',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'External fetch tool',
                            parameters: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' }
                                },
                                required: ['url']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output).toEqual([
            {
                type: 'function_call',
                status: 'completed',
                id: 'resp_call_web_fetch_1',
                call_id: 'resp_call_web_fetch_1',
                name: 'web_fetch',
                arguments: JSON.stringify({ url: 'https://example.com' })
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('Use only the namespaced names listed below. Do not use original client tool names inside function calls.');
        expect(promptCall.body.system).toContain('external__web_fetch');
        expect(promptCall.body.tools).toBeUndefined();
    });

    test('POST /v1/responses continues after function_call_output input and returns assistant text', async () => {
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    { type: 'text', text: 'The weather in Tokyo is 22°C and sunny.' }
                ]
            }
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: { city: { type: 'string' } },
                                required: ['city']
                            }
                        }
                    }
                ],
                input: [
                    {
                        type: 'message',
                        role: 'user',
                        content: [
                            { type: 'input_text', text: 'What is the weather in Tokyo?' }
                        ]
                    },
                    {
                        type: 'function_call',
                        call_id: 'resp_call_weather_1',
                        name: 'weather_lookup',
                        arguments: { city: 'Tokyo' }
                    },
                    {
                        type: 'function_call_output',
                        call_id: 'resp_call_weather_1',
                        output: '22°C and sunny'
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output).toEqual([
            {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                    {
                        type: 'output_text',
                        text: 'The weather in Tokyo is 22°C and sunny.'
                    }
                ]
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.parts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'text',
                text: 'What is the weather in Tokyo?'
            }),
            expect.objectContaining({
                type: 'text',
                text: expect.stringContaining('ASSISTANT: <function_calls>')
            }),
            expect.objectContaining({
                type: 'text',
                text: 'TOOL_RESULT: {"tool_call_id":"resp_call_weather_1","name":"external__weather_lookup","content":"22°C and sunny"}'
            })
        ]));
        expect(promptCall.body.parts[1].text).toContain('external__weather_lookup');
        expect(promptCall.body.parts[1].text).toContain('resp_call_weather_1');
        expect(promptCall.body.parts[1].text).toContain('{\\"city\\":\\"Tokyo\\"}');
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

    test('POST /v1/responses streaming emits function_call output items for external tools without leaking raw function markup', async () => {
        sdkMocks.eventSubscribe.mockResolvedValueOnce({
            stream: (async function* () {
                const sessionId = 'test-session-id';
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'reasoning', sessionID: sessionId },
                        delta: 'Thinking...'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '<function_calls>[{"id":"resp_call_weather_stream_1","name":"external__weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'What is the weather in Tokyo?',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('response.reasoning_summary_text.delta');
        expect(res.text).toContain('response.output_item.added');
        expect(res.text).toContain('"output_index":2,"item":{"id":"resp_call_weather_stream_1","type":"function_call","status":"in_progress","call_id":"resp_call_weather_stream_1","name":"weather_lookup"');
        expect(res.text).toContain('"output_index":2,"item":{"id":"resp_call_weather_stream_1","type":"function_call","status":"completed","call_id":"resp_call_weather_stream_1","name":"weather_lookup"');
        expect(res.text).toContain('"arguments":"{\\"city\\":\\"Tokyo\\",\\"unit\\":\\"celsius\\"}"');
        expect(res.text).toContain('response.completed');
        expect(res.text).not.toContain('<function_calls>');
        expect(res.text).not.toContain('external__weather_lookup');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses streaming preserves same-name collision isolation for external tools', async () => {
        sdkMocks.eventSubscribe.mockResolvedValueOnce({
            stream: (async function* () {
                const sessionId = 'test-session-id';
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '<function_calls>[{"id":"resp_call_collision_1","name":"external__web_fetch_2","arguments":{"url":"https://example.com/collision"}}]</function_calls>'
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Use the second web_fetch tool',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'First external fetch tool',
                            parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
                        }
                    },
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'Second external fetch tool',
                            parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
                        }
                    }
                ],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"output_index":2,"item":{"id":"resp_call_collision_1","type":"function_call","status":"completed","call_id":"resp_call_collision_1","name":"web_fetch"');
        expect(res.text).toContain('https://example.com/collision');
        expect(res.text).not.toContain('external__web_fetch_2');
        expect(res.text).not.toContain('<function_calls>');
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('external__web_fetch');
        expect(promptCall.body.system).toContain('external__web_fetch_2');
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

    test('runtime validator rejects malformed JSON arguments as repairable', () => {
        const registry = buildExternalToolRegistry([
            {
                type: 'function',
                function: {
                    name: 'weather_lookup',
                    description: 'Look up weather by city',
                    parameters: {
                        type: 'object',
                        properties: { city: { type: 'string' } },
                        required: ['city']
                    }
                }
            }
        ]);

        const result = validateToolCall({
            type: 'function',
            function: {
                name: 'weather_lookup',
                arguments: '{"city":"Tokyo"'
            }
        }, registry);

        expect(result.status).toEqual('repairable');
        expect(result.errors[0].code).toEqual('invalid_arguments_json');
    });

    test('runtime validator rejects missing required fields and invalid enums', () => {
        const registry = buildExternalToolRegistry([
            {
                type: 'function',
                function: {
                    name: 'weather_lookup',
                    description: 'Look up weather by city',
                    parameters: {
                        type: 'object',
                        properties: {
                            city: { type: 'string' },
                            unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
                        },
                        required: ['city']
                    }
                }
            }
        ]);

        const missingField = validateToolCall({
            type: 'function',
            function: {
                name: 'weather_lookup',
                arguments: JSON.stringify({ unit: 'kelvin' })
            }
        }, registry);

        expect(missingField.status).toEqual('rejected');
        expect(missingField.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['missing_required_field', 'invalid_enum']));
    });

    test('runtime validator normalizes valid arguments and separates invalid calls', () => {
        const registry = buildExternalToolRegistry([
            {
                type: 'function',
                function: {
                    name: 'weather_lookup',
                    description: 'Look up weather by city',
                    parameters: {
                        type: 'object',
                        properties: {
                            city: { type: 'string' },
                            unit: { type: 'string' }
                        },
                        required: ['city']
                    }
                }
            }
        ]);

        const { validCalls, invalidCalls } = validateToolCalls([
            {
                id: 'valid_call',
                type: 'function',
                function: {
                    name: 'weather_lookup',
                    arguments: { city: 'Tokyo', unit: 'celsius' }
                }
            },
            {
                id: 'invalid_call',
                type: 'function',
                function: {
                    name: 'weather_lookup',
                    arguments: JSON.stringify({ unit: 'celsius' })
                }
            }
        ], registry);

        expect(validCalls).toHaveLength(1);
        expect(validCalls[0].function.arguments).toEqual(JSON.stringify({ city: 'Tokyo', unit: 'celsius' }));
        expect(validCalls[0].validatedArguments).toEqual({ city: 'Tokyo', unit: 'celsius' });
        expect(invalidCalls).toHaveLength(1);
        expect(invalidCalls[0].validation.status).toEqual('rejected');
    });

    test('runtime policy enforces denylist, confirmation, and allowlist overrides', () => {
        const registry = buildExternalToolRegistry([
            {
                type: 'function',
                x_proxy_side_effect: 'delete',
                function: {
                    name: 'delete_ticket',
                    description: 'Delete a ticket',
                    parameters: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                        required: ['id']
                    }
                }
            }
        ]);
        const [tool] = registry;

        const denied = evaluateToolPolicy(tool, { id: '123' }, {
            config: { EXTERNAL_TOOL_DENYLIST: ['delete_ticket'] }
        });
        expect(denied.status).toEqual('deny');
        expect(denied.code).toEqual('tool_denied_by_policy');

        const requiresConfirmation = evaluateToolPolicy(tool, { id: '123' }, { config: {} });
        expect(requiresConfirmation.status).toEqual('require_confirmation');
        expect(requiresConfirmation.confirmationPayload.toolName).toEqual('delete_ticket');

        const allowed = evaluateToolPolicy(tool, { id: '123' }, {
            config: { EXTERNAL_TOOL_ALLOWLIST: ['delete_ticket'] }
        });
        expect(allowed.status).toEqual('allow');
    });

    test('runtime router exposes mapped required tool names and prompt metadata', () => {
        const registry = buildExternalToolRegistry([
            {
                type: 'function',
                function: {
                    name: 'weather_lookup',
                    description: 'Look up weather by city',
                    parameters: {
                        type: 'object',
                        properties: { city: { type: 'string' } },
                        required: ['city']
                    }
                }
            }
        ]);

        const normalizedChoice = normalizeExternalToolChoice({
            type: 'function',
            function: { name: 'weather_lookup' }
        }, registry);
        expect(normalizedChoice).toEqual({
            mode: 'required',
            requiredTool: 'external__weather_lookup'
        });

        const exposure = buildToolExposure(registry, 'required');
        expect(exposure.toolChoice.mode).toEqual('required');
        expect(exposure.prompt).toContain('risk_level');
        expect(exposure.prompt).toContain('requires_confirmation');
        expect(exposure.prompt).toContain('external__weather_lookup');
    });

    test('POST /v1/chat/completions drops invalid external tool calls instead of leaking malformed tool_calls', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"call_invalid_weather","name":"weather_lookup","arguments":{"unit":"celsius"}}]</function_calls>'
                    }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'weather_lookup',
                            description: 'Look up weather by city',
                            parameters: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                    unit: { type: 'string' }
                                },
                                required: ['city']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message.tool_calls).toBeUndefined();
        expect(res.body.choices[0].message.content).toEqual('');
    });

    test('POST /v1/responses drops denied external tool calls from non-stream output', async () => {
        const restrictedApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false,
            EXTERNAL_TOOL_DENYLIST: ['delete_ticket']
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"resp_call_delete_1","name":"external__delete_ticket","arguments":{"id":"123"}}]</function_calls>'
                    }
                ]
            }
        });

        const res = await request(restrictedApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Delete ticket 123',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'delete_ticket',
                            description: 'Delete a ticket',
                            parameters: {
                                type: 'object',
                                properties: { id: { type: 'string' } },
                                required: ['id']
                            }
                        }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output).toEqual([]);
    });
});
