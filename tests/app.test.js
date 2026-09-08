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
    toolIds: jest.fn(async () => ({
        data: ['web_fetch', 'filesystem', 'bash']
    })),
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
        tool: {
            ids: sdkMocks.toolIds
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
        sdkMocks.toolIds.mockResolvedValue({ data: ['web_fetch', 'filesystem', 'bash'] });
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            const promptText = args.body.prompt || args.body.parts?.map(part => part.text || '').join(' ') || '';
            const parts = [{ type: 'text', text: 'Mock response' }];

            if (promptText.includes('reasoning')) {
                parts.unshift({ type: 'reasoning', text: 'Thinking process...' });
            }

            return { data: { parts } };
        });
        sdkMocks.sessionMessages.mockImplementation(async () => ([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'text', text: 'Mock response' }
                ]
            }
        ]));
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
        expect(sdkMocks.toolIds).not.toHaveBeenCalled();
    });

    test('POST /v1/chat/completions parses <function=name>/<parameter=key> tool markup and normalizes the tool name', async () => {
        // Regression test for issue #6: models emit their native <function=webfetch> dialect
        // (with a name that drops the request's underscore) inside <tool_call> markup. This
        // must surface as a proper OpenAI `tool_calls` array with `finish_reason: tool_calls`,
        // with the reasoning separated into `reasoning_content` and the markup stripped from
        // `content`.
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'The user wants the page title. Use the fetch tool.' },
                    {
                        type: 'text',
                        text: '<tool_call>\n<function=webfetch>\n<parameter=url>https://example.com</parameter>\n<parameter=format>html</parameter>\n</function>\n</tool_call>'
                    }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com title' }],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_fetch',
                            description: 'Fetch a URL',
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
        expect(res.body.choices[0].message.content).toBeNull();
        expect(res.body.choices[0].message.reasoning_content).toContain('The user wants the page title');
        expect(res.body.choices[0].message.tool_calls).toHaveLength(1);
        expect(res.body.choices[0].message.tool_calls[0].function.name).toEqual('web_fetch');
        expect(JSON.parse(res.body.choices[0].message.tool_calls[0].function.arguments)).toMatchObject({ url: 'https://example.com' });
    });

    test('POST /v1/chat/completions enables internal allowlist tools when client tools are omitted', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Fetched content summary' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message).toEqual({
            role: 'assistant',
            content: 'Fetched content summary'
        });

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: web_fetch, filesystem');
        expect(promptCall.body.system).not.toContain('External tools are virtualized by this proxy. They are not OpenCode tools.');
        expect(promptCall.body.tools).toEqual({
            web_fetch: true,
            filesystem: true,
            bash: false
        });
        expect(sdkMocks.toolIds).toHaveBeenCalledTimes(1);
    });

    test('POST /v1/chat/completions preserves backward compatibility for INTERNAL_WEB_FETCH_ENABLED', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_WEB_FETCH_ENABLED: true
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Fetched content summary' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com' }]
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: web_fetch');
        expect(promptCall.body.tools).toEqual({
            web_fetch: true,
            filesystem: false,
            bash: false
        });
    });

    test('POST /v1/chat/completions falls back to fully disabled native tools when internal allowlist tools are unavailable', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem']
        }).app;
        sdkMocks.toolIds.mockResolvedValueOnce({ data: ['bash'] });
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Live tool access is unavailable.' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Fetch https://example.com' }]
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toEqual({
            bash: false
        });
    });

    test('POST /v1/chat/completions applies request-level allowlist narrowing (intersection)', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem', 'bash']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Narrowed tool access' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Use filesystem' }],
                opencode: {
                    internal_allowed_tools: ['filesystem', 'unconfigured_tool']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: filesystem');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: true,
            bash: false
        });
    });

    test('POST /v1/chat/completions ignores request-level allowlist when external tools are present', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['filesystem']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'External bridge active' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Use external tool' }],
                tools: [{ type: 'function', function: { name: 'external_fetch', description: 'test' } }],
                opencode: {
                    internal_allowed_tools: ['filesystem']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy');
        expect(promptCall.body.system).not.toContain('You may use only these built-in tools');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: false,
            bash: false
        });
    });

    test('GET /health/details returns diagnostics when enabled and authorized', async () => {
        const diagnosticsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem'],
            HEALTH_DETAILS_ENABLED: true,
            HEALTH_DETAILS_REQUIRE_AUTH: true
        }).app;

        const res = await request(diagnosticsApp)
            .get('/health/details')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.body.internal_tools.config.allowed_tools).toEqual(['web_fetch', 'filesystem']);
        expect(res.body.internal_tools.audit.fields).toEqual(expect.arrayContaining([
            'requestedAllowlist',
            'allowedToolNames',
            'deniedRequestedTools',
            'resolutionPath',
            'resultingMode'
        ]));
    });

    test('GET /health/details returns 401 when auth is required and missing', async () => {
        const diagnosticsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            HEALTH_DETAILS_ENABLED: true,
            HEALTH_DETAILS_REQUIRE_AUTH: true
        }).app;

        const res = await request(diagnosticsApp).get('/health/details');
        expect(res.statusCode).toEqual(401);
    });

    test('GET /health/details returns 404 when diagnostics are disabled', async () => {
        const diagnosticsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            HEALTH_DETAILS_ENABLED: false
        }).app;

        const res = await request(diagnosticsApp).get('/health/details');
        expect(res.statusCode).toEqual(404);
    });

    test('GET /metrics returns prometheus text when enabled and authorized', async () => {
        const metricsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            METRICS_ENABLED: true,
            METRICS_REQUIRE_AUTH: true
        }).app;

        const res = await request(metricsApp)
            .get('/metrics')
            .set('Authorization', 'Bearer test-key');

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/plain');
        expect(res.text).toContain('opencode_internal_tool_mode_requests_total');
        expect(res.text).toContain('opencode_internal_tool_discovery_failures_total');
    });

    test('GET /metrics returns 401 when auth is required and missing', async () => {
        const metricsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            METRICS_ENABLED: true,
            METRICS_REQUIRE_AUTH: true
        }).app;

        const res = await request(metricsApp).get('/metrics');
        expect(res.statusCode).toEqual(401);
    });

    test('GET /metrics returns 404 when metrics are disabled', async () => {
        const metricsApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            METRICS_ENABLED: false
        }).app;

        const res = await request(metricsApp).get('/metrics');
        expect(res.statusCode).toEqual(404);
    });

    test('POST /v1/chat/completions request-level narrowing emits richer audit fields in diagnostics-aware runtime', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: true,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem', 'bash']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Narrowed tool access' }]
            }
        ]);

        const res = await request(internalApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Use filesystem' }],
                opencode: {
                    internal_allowed_tools: ['filesystem', 'unconfigured_tool']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: filesystem');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: true,
            bash: false
        });
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

    test('POST /v1/chat/completions streaming separates reasoning and answer from message.part.delta events', async () => {
        // Regression test for issue #9: newer OpenCode servers stream deltas as
        // `message.part.delta` events that carry only a `partID`. The part type is announced
        // by the preceding `message.part.updated` event. Without resolving the partID to its
        // type, reasoning and answer text could not be told apart and the answer was dropped.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [
                {
                    type: 'message.part.updated',
                    properties: { part: { id: 'part-reasoning', type: 'reasoning', sessionID: sessionId } }
                },
                { type: 'message.part.delta', properties: { sessionID: sessionId, partID: 'part-reasoning', field: 'text', delta: '3+5=' } },
                {
                    type: 'message.part.updated',
                    properties: { part: { id: 'part-text', type: 'text', sessionID: sessionId } }
                },
                { type: 'message.part.delta', properties: { sessionID: sessionId, partID: 'part-text', field: 'text', delta: '8' } },
                { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
            ];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is 3+5?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);

        const deltas = [];
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta;
            if (delta) deltas.push(delta);
        }
        const reasoning = deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('');
        const content = deltas.filter((d) => d.content).map((d) => d.content).join('');
        expect(reasoning).toContain('3+5=');
        expect(content).toContain('8');
        expect(content).not.toContain('3+5=');
    });

    test('POST /v1/chat/completions streaming recovers answer from snapshot when every delta is tagged reasoning', async () => {
        // Regression test for issue #9: some OpenCode servers tag every streaming delta as
        // reasoning (even the final answer), leaving `content` empty. The message snapshot
        // separates reasoning and text correctly, so the proxy reconciles the missing answer
        // from the snapshot instead of returning an empty content.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [
                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: 'Let me think: ' } },
                { type: 'message.part.updated', properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: '8' } },
                { type: 'message.updated', properties: { info: { sessionID: sessionId, finish: 'stop' } } }
            ];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'Let me think: ' },
                    { type: 'text', text: '8' }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is 3+5?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);

        const deltas = [];
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta;
            if (delta) deltas.push(delta);
        }
        const reasoning = deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('');
        const content = deltas.filter((d) => d.content).map((d) => d.content).join('');
        expect(reasoning).toContain('Let me think');
        // The answer must still reach the client even though the stream tagged it as reasoning.
        expect(content).toContain('8');
    });

    test('POST /v1/chat/completions streaming waits for internal tool execution instead of truncating', async () => {
        // Regression test for issue #3: a streaming response that triggers an internal tool
        // call (e.g. web_fetch) was truncated at the planning text. The collector resolved on
        // an intermediate 'stop' snapshot (or idle-timed-out) while the tool was still running,
        // so the final answer was dropped. The stream must stay open until the answer arrives.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [
                {
                    type: 'message.part.updated',
                    properties: { part: { type: 'text', sessionID: sessionId }, delta: 'I need to search. ' }
                },
                {
                    type: 'message.updated',
                    properties: {
                        info: {
                            sessionID: sessionId,
                            finish: 'stop',
                            parts: [
                                { type: 'text', text: 'I need to search. ' },
                                { type: 'tool', id: 'call_internal_1', tool: 'web_fetch', state: { status: 'pending', input: { url: 'https://example.com/weather' } } }
                            ]
                        }
                    }
                },
                {
                    type: 'message.part.updated',
                    properties: { part: { type: 'text', sessionID: sessionId }, delta: 'The weather is 14C.' }
                },
                {
                    type: 'message.updated',
                    properties: {
                        info: {
                            sessionID: sessionId,
                            finish: 'stop',
                            parts: [
                                { type: 'tool', id: 'call_internal_1', tool: 'web_fetch', state: { status: 'completed', input: { url: 'https://example.com/weather' }, output: '14C' } },
                                { type: 'text', text: 'The weather is 14C.' }
                            ]
                        }
                    }
                }
            ];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) {
                        yield event;
                    }
                })()
            };
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('data: [DONE]');

        const chunks = res.text.split('\n').filter(l => l.startsWith('data:') && !l.includes('[DONE]'));
        let streamed = '';
        for (const line of chunks) {
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
            if (delta) streamed += delta;
        }
        // The full answer must be streamed, not just the planning text.
        expect(streamed).toEqual('I need to search. The weather is 14C.');
    });

    test('polling fallback waits for the assistant message to finish instead of returning a partial snapshot', async () => {
        // Regression test: pollForAssistantResponse returned as soon as any part had text.
        // A reasoning model emits its reasoning part before the text part, so the first
        // snapshot is reasoning-only and unfinished. Returning it dropped the entire answer
        // and produced a response consisting of nothing but a thinking block.
        let call = 0;
        sdkMocks.sessionMessages.mockImplementation(async () => {
            call += 1;
            if (call < 3) {
                return [{
                    info: { role: 'assistant' },
                    parts: [{ type: 'reasoning', text: 'Let me read the file.' }]
                }];
            }
            return [{
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'Let me read the file.' },
                    { type: 'text', text: 'The file says hello.' }
                ]
            }];
        });
        // Force the polling fallback: the event stream yields nothing usable.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            throw new Error('event stream unavailable');
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Read a.txt' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        let streamed = '';
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) streamed += delta;
        }
        expect(streamed).toContain('The file says hello.');
        expect(call).toBeGreaterThanOrEqual(3);
    });

    test('polling fallback treats finish=tool as unfinished and keeps waiting', async () => {
        // finish === 'tool' is an intermediate turn that pauses for a tool result. Treating
        // it as terminal cut the response off before the post-tool answer arrived.
        let call = 0;
        sdkMocks.sessionMessages.mockImplementation(async () => {
            call += 1;
            if (call < 2) {
                return [{
                    info: { role: 'assistant', finish: 'tool' },
                    parts: [{ type: 'text', text: 'Calling a tool. ' }]
                }];
            }
            return [{
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Calling a tool. Done: 42.' }]
            }];
        });
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            throw new Error('event stream unavailable');
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Compute something' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        let streamed = '';
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) streamed += delta;
        }
        expect(streamed).toContain('Done: 42.');
    });

    test('polling fallback returns the last partial snapshot when the timeout is reached', async () => {
        // If the message never reports completion, the partial text still beats throwing a
        // timeout error and losing everything the model produced.
        sdkMocks.sessionMessages.mockImplementation(async () => ([{
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Partial answer that never completes' }]
        }]));
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            throw new Error('event stream unavailable');
        });

        const shortTimeoutApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 1200,
            DISABLE_TOOLS: false,
            DEBUG: false
        }).app;

        const res = await request(shortTimeoutApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('Partial answer that never completes');
    });

    test('streaming surfaces an upstream message error without waiting out the first-delta window', async () => {
        // A message that the upstream aborts never emits another delta. The collector used to
        // sit through the entire first-delta timeout before polling rediscovered the error.
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [{
                type: 'message.updated',
                properties: {
                    info: {
                        sessionID: sessionId,
                        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } }
                    }
                }
            }];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });
        sdkMocks.sessionMessages.mockImplementation(async () => ([{
            info: { role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } },
            parts: []
        }]));

        const startedAt = Date.now();
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('MessageAbortedError');
        // Must not have burned the full first-delta window (30s by default).
        expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    test('POST /v1/chat/completions streams reasoning_content separately from content', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Test with reasoning' }],
                stream: true
            });

        expect(res.text).toContain('reasoning_content');
        // Reasoning must not be wrapped in <think> tags inside content.
        expect(res.text).not.toContain('<think>');
        expect(res.text).not.toContain('</think>');
    });

    test('POST /v1/chat/completions streaming keeps reasoning out of content', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Test with reasoning' }],
                stream: true
            });

        const deltas = [];
        for (const line of res.text.split('\n')) {
            if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
            const json = JSON.parse(line.slice(5).trim());
            const delta = json.choices?.[0]?.delta;
            if (delta) deltas.push(delta);
        }
        const reasoning = deltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('');
        const content = deltas.filter((d) => d.content).map((d) => d.content).join('');
        expect(reasoning).toContain('Thinking');
        expect(content).toContain('Mock response');
        // Reasoning and answer must never bleed into each other.
        expect(content).not.toContain('Thinking');
        expect(reasoning).not.toContain('Mock');
    });

    test('POST /v1/chat/completions non-stream returns reasoning_content without think wrapping', async () => {
        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    { type: 'reasoning', text: 'Thinking process...' },
                    { type: 'text', text: 'Plain assistant reply' }
                ]
            }
        ]);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Test with reasoning' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('Plain assistant reply');
        expect(res.body.choices[0].message.reasoning_content).toEqual('Thinking process...');
        expect(res.body.choices[0].message.content).not.toContain('<think>');
    });

    test('POST /v1/chat/completions supports reasoning_effort', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                reasoning_effort: 'high'
            });

        expect(res.statusCode).toEqual(200);
    });

    test('POST /v1/chat/completions supports reasoning object', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                reasoning: { effort: 'high' }
            });

        expect(res.statusCode).toEqual(200);
    });

    test('POST /v1/chat/completions emits tool_calls finish_reason in streaming for external tools', async () => {
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
                        delta: '<function_calls>[{"id":"call_weather_stream_1","name":"external__weather_lookup","arguments":{"city":"Tokyo","unit":"celsius"}}]</function_calls>'
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
                stream: true,
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
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('"tool_calls"');
        expect(res.text).toContain('"finish_reason":"tool_calls"');
        expect(res.text).not.toContain('external__weather_lookup');
        expect(res.text).toContain('"name":"weather_lookup"');
    });

    test('POST /v1/chat/completions strips denied external tool calls from non-stream output', async () => {
        const restrictedApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false,
            EXTERNAL_TOOL_DENYLIST: ['delete_ticket']
        }).app;

        sdkMocks.sessionMessages.mockResolvedValueOnce([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [
                    {
                        type: 'text',
                        text: '<function_calls>[{"id":"call_delete_1","name":"delete_ticket","arguments":{"id":"123"}}]</function_calls>'
                    }
                ]
            }
        ]);

        const res = await request(restrictedApp)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Delete ticket 123' }],
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
        expect(res.body.choices[0].finish_reason).toEqual('stop');
        expect(res.body.choices[0].message.tool_calls).toBeUndefined();
        expect(res.body.choices[0].message.content).toEqual('');
    });

    test('POST /v1/responses returns assistant response', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Hello from responses'
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].content[0].text).toBeDefined();
    });

    test('POST /v1/responses reports mid-stream failures on the open stream instead of crashing', async () => {
        // Regression test: the /v1/responses catch block called res.json() unconditionally.
        // After the SSE headers were sent that throws ERR_HTTP_HEADERS_SENT, which escaped the
        // async handler as an unhandled rejection and killed the proxy process. Users saw the
        // service "stop working" mid-session; the container restarted behind them.
        sdkMocks.sessionMessages.mockImplementation(async () => {
            throw new Error('upstream exploded after headers were sent');
        });
        sdkMocks.sessionPrompt.mockImplementation(async () => {
            throw new Error('upstream exploded after headers were sent');
        });
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            throw new Error('event stream unavailable');
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Hello',
                stream: true
            });

        // Headers were already flushed as SSE, so the status stays 200 and the failure is
        // reported as a stream event. The important part is that no exception escapes.
        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('data: [DONE]');
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
        expect(sdkMocks.toolIds).not.toHaveBeenCalled();
    });

    test('POST /v1/responses enables internal allowlist tools when client tools are omitted', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem']
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'Fetched via internal allowlist tools' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Fetch https://example.com'
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.status).toEqual('completed');
        expect(res.body.created_at).toEqual(expect.any(Number));
        expect(res.body.created).toEqual(res.body.created_at);
        expect(res.body.error).toBeNull();
        expect(res.body.incomplete_details).toBeNull();
        expect(res.body.output).toEqual([
            {
                id: expect.any(String),
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                    {
                        type: 'output_text',
                        text: 'Fetched via internal allowlist tools',
                        annotations: []
                    }
                ]
            }
        ]);

        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: web_fetch, filesystem');
        expect(promptCall.body.system).not.toContain('External tools are virtualized by this proxy. They are not OpenCode tools.');
        expect(promptCall.body.tools).toEqual({
            web_fetch: true,
            filesystem: true,
            bash: false
        });
        expect(sdkMocks.toolIds).toHaveBeenCalledTimes(1);
    });

    test('POST /v1/responses preserves backward compatibility for INTERNAL_WEB_FETCH_ENABLED', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_WEB_FETCH_ENABLED: true
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'Fetched via internal web_fetch compatibility mode' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Fetch https://example.com'
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: web_fetch');
        expect(promptCall.body.tools).toEqual({
            web_fetch: true,
            filesystem: false,
            bash: false
        });
    });

    test('POST /v1/responses falls back to fully disabled native tools when internal allowlist tools are unavailable', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem']
        }).app;
        sdkMocks.toolIds.mockResolvedValueOnce({ data: ['bash'] });
        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'Live tool access is unavailable.' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Fetch https://example.com'
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.tools).toEqual({
            bash: false
        });
    });

    test('POST /v1/responses applies request-level allowlist narrowing (intersection)', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['web_fetch', 'filesystem', 'bash']
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'Narrowed tool access' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Use filesystem',
                opencode: {
                    internal_allowed_tools: ['filesystem', 'unconfigured_tool']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('You may use only these built-in tools when truly required: filesystem');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: true,
            bash: false
        });
    });

    test('POST /v1/responses ignores request-level allowlist when external tools are present', async () => {
        const internalApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: true,
            DEBUG: false,
            INTERNAL_ALLOWED_TOOLS: ['filesystem']
        }).app;

        sdkMocks.sessionPrompt.mockResolvedValueOnce({
            data: {
                parts: [{ type: 'text', text: 'External bridge active' }]
            }
        });

        const res = await request(internalApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Use external tool',
                tools: [{ type: 'function', function: { name: 'external_fetch', description: 'test' } }],
                opencode: {
                    internal_allowed_tools: ['filesystem']
                }
            });

        expect(res.statusCode).toEqual(200);
        const promptCall = sdkMocks.sessionPrompt.mock.calls.at(-1)?.[0];
        expect(promptCall.body.system).toContain('External tools are virtualized by this proxy');
        expect(promptCall.body.system).not.toContain('You may use only these built-in tools');
        expect(promptCall.body.tools).toEqual({
            web_fetch: false,
            filesystem: false,
            bash: false
        });
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
        expect(res.body.status).toEqual('completed');
        expect(res.body.created_at).toEqual(expect.any(Number));
        expect(res.body.created).toEqual(res.body.created_at);
        expect(res.body.error).toBeNull();
        expect(res.body.incomplete_details).toBeNull();
        expect(res.body.output).toEqual([
            {
                id: expect.any(String),
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                    {
                        type: 'output_text',
                        text: 'The weather in Tokyo is 22°C and sunny.',
                        annotations: []
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
                stream: true,
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
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('response.output_item.added');
        expect(res.text).toContain('resp_call_weather_stream_1');
        expect(res.text).toContain('"name":"weather_lookup"');
        expect(res.text).not.toContain('"text":"<function_calls>');
        expect(res.text).toContain('response.completed');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses strips denied external function calls from streaming output', async () => {
        const restrictedApp = createApp({
            PORT: 10000,
            API_KEY: 'test-key',
            OPENCODE_SERVER_URL: 'http://127.0.0.1:10001',
            REQUEST_TIMEOUT_MS: 5000,
            DISABLE_TOOLS: false,
            DEBUG: false,
            EXTERNAL_TOOL_DENYLIST: ['delete_ticket']
        }).app;

        sdkMocks.eventSubscribe.mockResolvedValueOnce({
            stream: (async function* () {
                const sessionId = 'test-session-id';
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'text', sessionID: sessionId },
                        delta: '<function_calls>[{"id":"resp_call_delete_stream_1","name":"external__delete_ticket","arguments":{"id":"123"}}]</function_calls>'
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        });

        const res = await request(restrictedApp)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Delete ticket 123',
                stream: true,
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
        expect(res.text).not.toContain('"name":"delete_ticket"');
        expect(res.text).toContain('response.completed');
    });

    test('POST /v1/responses strips denied external function calls from non-stream output', async () => {
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

    /**
     * The Responses API declares function tools flat: { type:'function', name, parameters }.
     * buildExternalToolRegistry only read tool.function.name, so every tool from a Responses
     * client was dropped. An empty registry means no tool contract is added to the prompt and
     * no tool-call markup is parsed back out, so the model appears to ignore tools entirely.
     */
    test('external tool registry accepts flat Responses-API tool definitions', () => {
        const flat = buildExternalToolRegistry([{
            type: 'function',
            name: 'read',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }]);

        expect(flat).toHaveLength(1);
        expect(flat[0].originalName).toBe('read');
        expect(flat[0].namespacedName).toBe('external__read');
        expect(flat[0].description).toBe('Read a file');
        expect(flat[0].parameters.required).toEqual(['path']);
        // Side-effect inference keyed off the name must still work on the flat shape.
        expect(flat[0].sideEffect).toBe('read');
    });

    test('external tool registry keeps accepting nested Chat-Completions tool definitions', () => {
        const nested = buildExternalToolRegistry([{
            type: 'function',
            function: {
                name: 'read',
                description: 'Read a file',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
            }
        }]);

        expect(nested).toHaveLength(1);
        expect(nested[0].namespacedName).toBe('external__read');
        expect(nested[0].description).toBe('Read a file');
    });

    test('POST /v1/responses advertises flat tools to the model and parses their calls back', async () => {
        let sentSystem = '';
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            sentSystem = args.body.system || '';
            return {
                data: {
                    parts: [{
                        type: 'text',
                        text: '<function_calls>{"name":"external__read","arguments":{"path":"a.txt"}}</function_calls>'
                    }]
                }
            };
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Read a.txt',
                tools: [{
                    type: 'function',
                    name: 'read',
                    description: 'Read a file',
                    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
                }]
            });

        expect(res.statusCode).toEqual(200);
        // The tool contract must reach the model.
        expect(sentSystem).toContain('external__read');
        const functionCalls = res.body.output.filter(item => item.type === 'function_call');
        expect(functionCalls).toHaveLength(1);
        expect(functionCalls[0].name).toBe('read');
        expect(JSON.parse(functionCalls[0].arguments)).toEqual({ path: 'a.txt' });
    });

    test('POST /v1/responses honours a flat tool_choice forcing a specific tool', async () => {
        let sentSystem = '';
        sdkMocks.sessionPrompt.mockImplementation(async (args) => {
            sentSystem = args.body.system || '';
            return {
                data: {
                    parts: [{
                        type: 'text',
                        text: '<function_calls>{"name":"external__read","arguments":{"path":"a.txt"}}</function_calls>'
                    }]
                }
            };
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                input: 'Read a.txt',
                tools: [{
                    type: 'function',
                    name: 'read',
                    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
                }],
                tool_choice: { type: 'function', name: 'read' }
            });

        expect(res.statusCode).toEqual(200);
        expect(sentSystem).toContain('You MUST call external__read');
    });

    test('streaming retries once on transient upstream CreditsError and recovers', async () => {
        // Issue #5: upstream workers mislabel throttling as 401 "Insufficient balance"
        // (CreditsError). The very next attempt succeeds, so the proxy must rotate the
        // session and retry instead of surfacing the bogus billing error.
        sdkMocks.sessionMessages.mockReset();
        sdkMocks.sessionMessages.mockImplementation(async () => ([{
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'Recovered response' }]
        }]));
        sdkMocks.eventSubscribe.mockReset();
        sdkMocks.eventSubscribe.mockImplementationOnce(async () => {
            const sessionId = 'test-session-id';
            const mockEvents = [{
                type: 'message.updated',
                properties: {
                    info: {
                        sessionID: sessionId,
                        error: { name: 'CreditsError', data: { message: '401: {"message":"Insufficient balance. Manage your billing here: https://example.ai","type":"CreditsError","param":"","code":null}', responseHeaders: { 'retry-after-ms': '10' } } }
                    }
                }
            }];
            return {
                stream: (async function* () {
                    for (const event of mockEvents) yield event;
                })()
            };
        });
        // Subsequent calls fall through to the default mock (successful stream).

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('Recovered response');
        expect(res.text).not.toContain('Insufficient balance');
        // The failed attempt's session must have been rotated before retrying.
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'test-session-id' } });
    });

    test('non-streaming retries once on transient upstream CreditsError and recovers', async () => {
        // Same mislabeled billing failure, polling path: first snapshot reports the
        // CreditsError with no usable content, the retry succeeds.
        sdkMocks.sessionMessages.mockReset();
        sdkMocks.sessionMessages
            .mockResolvedValueOnce([{
                info: {
                    role: 'assistant',
                    error: { name: 'CreditsError', data: { message: '401: Insufficient balance', responseHeaders: { 'retry-after-ms': '10' } } }
                },
                parts: []
            }])
            .mockResolvedValue([{
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Recovered response' }]
            }]);
        sdkMocks.eventSubscribe.mockReset();

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-key')
            .send({
                model: 'opencode/kimi-k2.5',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: false
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toBe('Recovered response');
        expect(sdkMocks.sessionDelete).toHaveBeenCalledWith({ path: { id: 'test-session-id' } });
    });
describe('Proxy Responses API previous_response_id', () => {
    test('chains follow-up turns onto the stored session without recreating it', async () => {
        sdkMocks.sessionMessages.mockReset();
        sdkMocks.sessionMessages.mockResolvedValue([
            {
                info: { role: 'assistant', finish: 'stop' },
                parts: [{ type: 'text', text: 'Mock response' }]
            }
        ]);
        sdkMocks.eventSubscribe.mockReset();
        sdkMocks.sessionCreate.mockClear();
        sdkMocks.sessionDelete.mockClear();
        sdkMocks.configUpdate.mockClear();

        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ model: 'opencode/kimi-k2.5', input: 'Hello' });

        expect(first.statusCode).toEqual(200);
        expect(first.body.id).toMatch(/^resp_/);
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);

        const followUp = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({
                input: 'And a follow-up question',
                previous_response_id: first.body.id
            });

        expect(followUp.statusCode).toEqual(200);
        // The stored OpenCode session is reused; no new session, no teardown.
        expect(sdkMocks.sessionCreate).toHaveBeenCalledTimes(1);
        expect(sdkMocks.sessionDelete).not.toHaveBeenCalled();
        // Model falls back to the one recorded with the previous response.
        const lastUpdate = sdkMocks.configUpdate.mock.calls.at(-1)?.[0];
        expect(lastUpdate?.body?.activeModel).toEqual({ providerID: 'opencode', modelID: 'kimi-k2.5' });
    });

    test('rejects an invalid previous_response_id', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-key')
            .send({ input: 'Hello', previous_response_id: 'resp_does-not-exist' });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.message).toContain('previous_response_id');
    });
});
});