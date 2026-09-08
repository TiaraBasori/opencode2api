/**
 * Anthropic Messages (/v1/messages) converters.
 *
 * Pure functions only: no express, no SDK imports.
 * Borrowed patterns from CLIProxyAPI (openai/claude request/response) and
 * LiteLLM (LiteLLMAnthropicMessagesAdapter + sanitize trio), adapted to this
 * repo's external-bridge (text <function_calls> markup) model.
 */

export function sanitizeClaudeToolId(id) {
    const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (s) return s;
    return generateClaudeToolCallId();
}

export function generateClaudeToolCallId() {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return `toolu_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
    } catch {}
    return `toolu_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function anthropicError(type, message, statusCode = 400) {
    return { statusCode, body: { type: 'error', error: { type, message } } };
}

export function validateMessagesRequest(body = {}) {
    if (!body || typeof body !== 'object') return anthropicError('invalid_request_error', 'request body must be an object');
    if (!body.model || typeof body.model !== 'string') return anthropicError('invalid_request_error', 'model is required');
    if (body.max_tokens === undefined || body.max_tokens === null) return anthropicError('invalid_request_error', 'max_tokens is required');
    if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) return anthropicError('invalid_request_error', 'max_tokens must be a positive number');
    if (!Array.isArray(body.messages) || body.messages.length === 0) return anthropicError('invalid_request_error', 'messages array is required');
    if (body.messages[0]?.role !== 'user') return anthropicError('invalid_request_error', 'first message must use role "user"');
    return null;
}

function textOfBlock(block) {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    return '';
}

export function extractSystemText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.map(textOfBlock).filter(Boolean).join('\n\n');
    return '';
}

function normalizeToolArguments(args) {
    if (args === undefined || args === null || args === '') return '{}';
    if (typeof args === 'string') return args;
    try {
        return JSON.stringify(args);
    } catch {
        return '{}';
    }
}

/**
 * Convert Anthropic messages[] to OpenAI-chat-like messages[] so the existing
 * prompt builder (ROLE: text / ASSISTANT <function_calls> / TOOL_RESULT) can be reused.
 * Preserves tool_use.id (toolu_xxx) verbatim for round-trip.
 */
export function anthropicMessagesToChatMessages(anthropicMessages = []) {
    const chatMessages = [];
    for (const m of anthropicMessages) {
        const role = m?.role === 'assistant' ? 'assistant' : 'user';
        const content = m?.content;
        if (typeof content === 'string') {
            chatMessages.push({ role, content });
            continue;
        }
        if (!Array.isArray(content)) continue;
        const textParts = [];
        const toolCalls = [];
        const ordered = [];
        const flushText = () => {
            if (textParts.length) {
                ordered.push({ role, content: textParts.join('\n\n') });
                textParts.length = 0;
            }
        };
        for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text') {
                if (block.text) textParts.push(block.text);
            } else if (block.type === 'image') {
                const src = block.source || {};
                if (src.type === 'base64' && src.data) {
                    const mime = src.media_type || 'image/png';
                    // Flush pending text first so [text, image, text] keeps its order.
                    // No marker text: the image_url part alone carries the image downstream.
                    flushText();
                    ordered.push({
                        role,
                        content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${src.data}` } }]
                    });
                } else if (src.type === 'url' && src.url) {
                    flushText();
                    ordered.push({ role, content: [{ type: 'image_url', image_url: { url: src.url } }] });
                }
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id || generateClaudeToolCallId(),
                    type: 'function',
                    function: { name: block.name, arguments: normalizeToolArguments(block.input) }
                });
            } else if (block.type === 'tool_result') {
                const inner = Array.isArray(block.content)
                    ? block.content.map(textOfBlock).filter(Boolean).join('\n')
                    : (typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
                const prefix = block.is_error ? 'ERROR: ' : '';
                flushText();
                ordered.push({
                    role: 'tool',
                    tool_call_id: block.tool_use_id,
                    name: 'unknown',
                    content: `${prefix}${inner}`
                });
            } else if (block.type === 'thinking') {
                // Thinking blocks from client history are not re-fed as reasoning;
                // keep text if present to preserve context.
                if (block.thinking) textParts.push(block.thinking);
            }
        }
        if (toolCalls.length) {
            chatMessages.push(...ordered);
            chatMessages.push({ role: 'assistant', tool_calls: toolCalls, content: textParts.join('\n\n') || null });
        } else {
            flushText();
            chatMessages.push(...ordered);
        }
    }
    return chatMessages.filter((m) => m && (m.content || m.tool_calls));
}

export function anthropicToolsToChatTools(tools) {
    if (!Array.isArray(tools)) return [];
    return tools
        .filter((t) => t && typeof t.name === 'string')
        .map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || { type: 'object', properties: {} }
            }
        }));
}

export function anthropicToolChoiceToChat(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') return toolChoice;
    const t = String(toolChoice.type || '').toLowerCase();
    if (t === 'auto') return 'auto';
    if (t === 'none') return 'none';
    if (t === 'any') return 'required';
    if (t === 'tool' && toolChoice.name) return { type: 'function', function: { name: toolChoice.name } };
    if (t === 'tool') return 'required';
    return undefined;
}

export function anthropicThinkingToReasoningEffort(thinking) {
    if (!thinking || typeof thinking !== 'object') return null;
    if (thinking.type === 'disabled') return 'none';
    if (thinking.type === 'enabled') {
        const budget = typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 0;
        if (budget >= 24000) return 'high';
        if (budget >= 8000) return 'medium';
        return 'low';
    }
    return null;
}

export function mapFinishToStopReason(finish, hasToolCalls) {
    if (hasToolCalls) return 'tool_use';
    if (finish === 'tool') return 'tool_use';
    if (finish === 'length' || finish === 'max_tokens') return 'max_tokens';
    if (finish === 'stop_sequence') return 'stop_sequence';
    return 'end_turn';
}

export function buildAnthropicMessage({ messageId, model, text, reasoning, toolCalls, stopReason, inputTokens, outputTokens }) {
    const content = [];
    if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' });
    if (text) content.push({ type: 'text', text });
    for (const tc of toolCalls || []) {
        let input = {};
        try {
            input = JSON.parse(tc.function?.arguments || '{}');
        } catch {
            input = {};
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || tc.name, input });
    }
    return {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    };
}

export function sseEvent(event, payload) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}
