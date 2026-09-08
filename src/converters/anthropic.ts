/**
 * Anthropic Messages (/v1/messages) converters.
 *
 * Pure functions only: no express, no SDK imports.
 * Borrowed patterns from CLIProxyAPI (openai/claude request/response) and
 * LiteLLM (LiteLLMAnthropicMessagesAdapter + sanitize trio), adapted to this
 * repo's external-bridge (text <function_calls> markup) model.
 */

export interface ChatToolCallFunction {
    name: string;
    arguments: string;
}

export interface ChatToolCall {
    id: string;
    type: 'function';
    function: ChatToolCallFunction;
}

export interface ChatContentPart {
    type: string;
    text?: string;
    image_url?: { url: string };
}

export type ChatMessageContent = string | null | ChatContentPart[];

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: ChatMessageContent;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface ChatTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: unknown;
    };
}

export type ChatToolChoice = string | { type: 'function'; function: { name: string } };

export interface AnthropicTextBlock {
    type: 'text';
    text?: unknown;
}

export interface AnthropicImageBlock {
    type: 'image';
    source?: {
        type?: unknown;
        data?: unknown;
        media_type?: unknown;
        url?: unknown;
    } | null;
}

export interface AnthropicToolUseBlock {
    type: 'tool_use';
    id?: unknown;
    name?: unknown;
    input?: unknown;
}

export interface AnthropicToolResultBlock {
    type: 'tool_result';
    tool_use_id?: unknown;
    content?: unknown;
    is_error?: unknown;
}

export interface AnthropicThinkingBlock {
    type: 'thinking';
    thinking?: unknown;
    signature?: unknown;
}

export interface AnthropicUnknownBlock {
    type: string;
}

export type AnthropicBlock =
    | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicToolUseBlock
    | AnthropicToolResultBlock
    | AnthropicThinkingBlock
    | AnthropicUnknownBlock;

export interface AnthropicMessagesRequest {
    model?: unknown;
    max_tokens?: unknown;
    messages?: unknown;
    system?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
    thinking?: unknown;
    stream?: unknown;
    [key: string]: unknown;
}

export interface AnthropicErrorShape {
    statusCode: number;
    body: { type: 'error'; error: { type: string; message: string } };
}

export interface AnthropicMessage {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: AnthropicBlock[];
    stop_reason: unknown;
    stop_sequence: null;
    usage: { input_tokens: unknown; output_tokens: unknown };
}

export interface BuildAnthropicMessageArgs {
    messageId: string;
    model: string;
    text?: unknown;
    reasoning?: unknown;
    toolCalls?: Array<{
        id?: unknown;
        name?: unknown;
        function?: { name?: unknown; arguments?: unknown } | null;
    }> | null;
    stopReason?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
}

export function sanitizeClaudeToolId(id: unknown): string {
    const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (s) return s;
    return generateClaudeToolCallId();
}

export function generateClaudeToolCallId(): string {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return `toolu_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
    } catch {}
    return `toolu_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function anthropicError(type: string, message: string, statusCode = 400): AnthropicErrorShape {
    return { statusCode, body: { type: 'error', error: { type, message } } };
}

export function validateMessagesRequest(body: unknown = {}): AnthropicErrorShape | null {
    if (!body || typeof body !== 'object') return anthropicError('invalid_request_error', 'request body must be an object');
    const req = body as AnthropicMessagesRequest;
    if (!req.model || typeof req.model !== 'string') return anthropicError('invalid_request_error', 'model is required');
    if (req.max_tokens === undefined || req.max_tokens === null) return anthropicError('invalid_request_error', 'max_tokens is required');
    if (typeof req.max_tokens !== 'number' || req.max_tokens <= 0) return anthropicError('invalid_request_error', 'max_tokens must be a positive number');
    if (!Array.isArray(req.messages) || req.messages.length === 0) return anthropicError('invalid_request_error', 'messages array is required');
    const first = req.messages[0] as { role?: unknown } | null | undefined;
    if (first?.role !== 'user') return anthropicError('invalid_request_error', 'first message must use role "user"');
    return null;
}

function textOfBlock(block: unknown): string {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === 'text') return (b.text || '') as string;
    }
    return '';
}

export function extractSystemText(system: unknown): string {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.map(textOfBlock).filter(Boolean).join('\n\n');
    return '';
}

function normalizeToolArguments(args: unknown): string {
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
export function anthropicMessagesToChatMessages(anthropicMessages: unknown = []): ChatMessage[] {
    const chatMessages: ChatMessage[] = [];
    const list = anthropicMessages as Array<{ role?: unknown; content?: unknown } | null | undefined>;
    for (const m of list) {
        const role = m?.role === 'assistant' ? 'assistant' : 'user';
        const content = m?.content;
        if (typeof content === 'string') {
            chatMessages.push({ role, content });
            continue;
        }
        if (!Array.isArray(content)) continue;
        const textParts: string[] = [];
        const toolCalls: ChatToolCall[] = [];
        const ordered: ChatMessage[] = [];
        const flushText = (): void => {
            if (textParts.length) {
                ordered.push({ role, content: textParts.join('\n\n') });
                textParts.length = 0;
            }
        };
        const blocks = content as AnthropicBlock[];
        for (const block of blocks) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text') {
                const textBlock = block as AnthropicTextBlock;
                if (textBlock.text) textParts.push(textBlock.text as string);
            } else if (block.type === 'image') {
                const imageBlock = block as AnthropicImageBlock;
                const src = (imageBlock.source || {}) as { type?: unknown; data?: unknown; media_type?: unknown; url?: unknown };
                if (src.type === 'base64' && src.data) {
                    const mime = (src.media_type || 'image/png') as string;
                    // Flush pending text first so [text, image, text] keeps its order.
                    // No marker text: the image_url part alone carries the image downstream.
                    flushText();
                    ordered.push({
                        role,
                        content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${src.data}` } }]
                    });
                } else if (src.type === 'url' && src.url) {
                    flushText();
                    ordered.push({ role, content: [{ type: 'image_url', image_url: { url: src.url as string } }] });
                }
            } else if (block.type === 'tool_use') {
                const toolUseBlock = block as AnthropicToolUseBlock;
                toolCalls.push({
                    id: (toolUseBlock.id || generateClaudeToolCallId()) as string,
                    type: 'function',
                    function: { name: toolUseBlock.name as string, arguments: normalizeToolArguments(toolUseBlock.input) }
                });
            } else if (block.type === 'tool_result') {
                const resultBlock = block as AnthropicToolResultBlock;
                const inner = Array.isArray(resultBlock.content)
                    ? resultBlock.content.map(textOfBlock).filter(Boolean).join('\n')
                    : (typeof resultBlock.content === 'string' ? resultBlock.content : JSON.stringify(resultBlock.content ?? ''));
                const prefix = resultBlock.is_error ? 'ERROR: ' : '';
                flushText();
                ordered.push({
                    role: 'tool',
                    tool_call_id: resultBlock.tool_use_id as string,
                    name: 'unknown',
                    content: `${prefix}${inner}`
                });
            } else if (block.type === 'thinking') {
                // Thinking blocks from client history are not re-fed as reasoning;
                // keep text if present to preserve context.
                const thinkingBlock = block as AnthropicThinkingBlock;
                if (thinkingBlock.thinking) textParts.push(thinkingBlock.thinking as string);
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

export function anthropicToolsToChatTools(tools: unknown): ChatTool[] {
    if (!Array.isArray(tools)) return [];
    return (tools as Array<{ name?: unknown; description?: unknown; input_schema?: unknown } | null | undefined>)
        .filter((t) => t && typeof t.name === 'string')
        .map((t) => ({
            type: 'function' as const,
            function: {
                name: (t as { name?: unknown }).name as string,
                description: ((t as { description?: unknown }).description || '') as string,
                parameters: ((t as { input_schema?: unknown }).input_schema || { type: 'object', properties: {} }) as unknown
            }
        }));
}

export function anthropicToolChoiceToChat(toolChoice: unknown): ChatToolChoice | undefined {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') return toolChoice;
    const choice = toolChoice as { type?: unknown; name?: unknown };
    const t = String(choice.type || '').toLowerCase();
    if (t === 'auto') return 'auto';
    if (t === 'none') return 'none';
    if (t === 'any') return 'required';
    if (t === 'tool' && choice.name) return { type: 'function', function: { name: choice.name as string } };
    if (t === 'tool') return 'required';
    return undefined;
}

export function anthropicThinkingToReasoningEffort(thinking: unknown): string | null {
    if (!thinking || typeof thinking !== 'object') return null;
    const th = thinking as { type?: unknown; budget_tokens?: unknown };
    if (th.type === 'disabled') return 'none';
    if (th.type === 'enabled') {
        const budget = typeof th.budget_tokens === 'number' ? th.budget_tokens : 0;
        if (budget >= 24000) return 'high';
        if (budget >= 8000) return 'medium';
        return 'low';
    }
    return null;
}

export function mapFinishToStopReason(finish: unknown, hasToolCalls: unknown): string {
    if (hasToolCalls) return 'tool_use';
    if (finish === 'tool') return 'tool_use';
    if (finish === 'length' || finish === 'max_tokens') return 'max_tokens';
    if (finish === 'stop_sequence') return 'stop_sequence';
    return 'end_turn';
}

export function buildAnthropicMessage({ messageId, model, text, reasoning, toolCalls, stopReason, inputTokens, outputTokens }: BuildAnthropicMessageArgs): AnthropicMessage {
    const content: AnthropicBlock[] = [];
    if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' });
    if (text) content.push({ type: 'text', text });
    for (const tc of toolCalls || []) {
        let input: unknown = {};
        try {
            input = JSON.parse((tc.function?.arguments || '{}') as string) as unknown;
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

export function sseEvent(event: string, payload: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function estimateTokens(text: unknown): number {
    return Math.ceil(String(text || '').length / 4);
}
