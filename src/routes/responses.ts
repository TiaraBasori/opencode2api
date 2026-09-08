// P4 TS: POST /v1/responses (ported from P3 .js, behavior identical).
import crypto from 'crypto';
import { findExternalToolByName } from '../tool-runtime/registry.js';
import { EXTERNAL_TOOL_PREFIX } from '../tool-runtime/contracts.js';
import { computeRetryDelay } from '../retry/policy.js';
import {
  stripFunctionCallMarkup,
  parseExternalToolCallsFromText,
  createToolCallFilter,
  createExternalToolCallStreamParser,
} from '../tool-runtime/parser.js';
import { isTransientUpstreamError, normalizeBackendError, transformUpstreamError } from '../errors/upstream.js';
import {
  withTimeout,
  DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
  DEFAULT_EVENT_IDLE_TIMEOUT_MS,
} from '../config/proxy-config.js';
import { sleep, ensureBackend } from '../backend/manager.js';
import type { Application, Request, Response } from 'express';
import type { AppContext } from '../types/context.js';
import type { ExternalToolEntry } from '../tool-runtime/registry.js';
import type { FinalToolCall } from '../tool-runtime/parser.js';

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const r = asRecord(e);
  const m: unknown = r['message'];
  return typeof m === 'string' ? m : String(e);
}

function readDataMessage(e: unknown): string {
  const r = asRecord(e);
  const data = asRecord(r['data']);
  const dm: unknown = data['message'];
  if (typeof dm === 'string') return dm;
  const m: unknown = r['message'];
  if (typeof m === 'string') return m;
  return 'unknown';
}

interface NormalizedInputMessage {
  role: string;
  content: string;
  isToolCalls?: boolean;
}

export function registerResponsesRoutes(app: Application, ctx: AppContext): void {
  const {
    client,
    config,
    REQUEST_TIMEOUT_MS,
    DISABLE_TOOLS,
    maxAttempts,
    resolveRequestedModel,
    logDebug,
    getResponseState,
    storeResponseState,
    buildSystemPrompt,
    normalizeReasoningEffort,
    stripFunctionCalls,
    normalizeTextContent,
    normalizeToolArguments,
    normalizeToolResultContent,
    createRequestToolContext,
    finalizeValidatedToolCalls,
    createForcedToolCallRequester,
    trackToolMode,
    getToolOverridesForMode,
    collectFromEvents,
    pollForAssistantResponse,
  } = ctx;

  app.post('/v1/responses', async (req: Request, res: Response): Promise<void> => {
    let responsesKeepalive: ReturnType<typeof setInterval> | null = null;
    let responsesResClosed: Promise<boolean> | null = null;
    const stopResponsesKeepalive = (): void => {
      if (responsesKeepalive) {
        clearInterval(responsesKeepalive);
        responsesKeepalive = null;
      }
    };
    try {
      const body = asRecord((req as unknown as { body: unknown }).body);
      const model: unknown = body['model'];
      const input: unknown = body['input'];
      const reasoning_effort: unknown = body['reasoning_effort'];
      const requestReasoning: unknown = body['reasoning'];
      const max_output_tokens: unknown = body['max_output_tokens'];
      const toolsRaw: unknown = body['tools'];
      const tools: unknown[] = Array.isArray(toolsRaw) ? (toolsRaw as unknown[]) : [];
      const tool_choice: unknown = body['tool_choice'];
      const instructions: unknown = body['instructions'];
      const temperature: unknown = body['temperature'];
      const top_p: unknown = body['top_p'];
      const streamRaw: unknown = body['stream'];
      const stream = Boolean(streamRaw);
      const chatMessages: unknown = body['messages'];
      const prompt: unknown = body['prompt'];
      const previousResponseId: unknown = body['previous_response_id'];
      const requestOpencodeConfig: unknown = body['opencode'];

      const previousState =
        typeof previousResponseId === 'string' && previousResponseId ? getResponseState(previousResponseId) : null;
      if (previousResponseId && !previousState) {
        res.status(400).json({ error: { message: 'Invalid or expired previous_response_id' } });
        return;
      }

      const reasoningLevel = normalizeReasoningEffort(
        (reasoning_effort as string) || (asRecord(requestReasoning)['effort'] as string),
        null,
      );

      const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig);
      const toolMode: string = requestToolContext.mode;
      const internalToolContext = requestToolContext.internal;
      trackToolMode(toolMode, {
        configuredAllowlist: internalToolContext.allowedToolNames,
        requestedAllowlist: internalToolContext.requestedAllowlist,
        deniedRequestedTools: internalToolContext.deniedRequestedTools,
        resolutionPath: internalToolContext.resolutionPath,
        resultingMode: internalToolContext.resultingMode,
        route: '/v1/responses',
      });
      logDebug('Responses API request', {
        model,
        reasoning_effort: (reasoning_effort as string) || asRecord(requestReasoning)['effort'],
        reasoningLevel,
        max_output_tokens,
        toolMode,
        internalAllowedTools: internalToolContext.allowedToolNames,
        requestedInternalTools: internalToolContext.requestedAllowlist,
        deniedRequestedTools: internalToolContext.deniedRequestedTools,
        resolutionPath: internalToolContext.resolutionPath,
        resultingMode: internalToolContext.resultingMode,
      });
      const externalToolContext = requestToolContext.external;
      const externalToolRegistry: ExternalToolEntry[] = externalToolContext.registry;
      const externalToolChoice = externalToolContext.toolChoice;
      const assistantToolCalls = new Map<string, string>();

      const rememberAssistantToolCall = (toolCallId: unknown, toolName: unknown): void => {
        if (!toolCallId || !toolName || typeof toolCallId !== 'string' || typeof toolName !== 'string') return;
        assistantToolCalls.set(toolCallId, toolName);
      };

      const buildResponsesToolResultLine = (item: unknown = {}): string | null => {
        const ir = asRecord(item);
        const text = normalizeToolResultContent(
          ir['content'] ?? ir['output'] ?? ir['result'] ?? ir['text'],
        );
        if (!text) return null;
        const callIdRaw: unknown = ir['call_id'] ?? ir['tool_call_id'];
        const mappedTool =
          findExternalToolByName(externalToolRegistry, ir['name']) ||
          findExternalToolByName(externalToolRegistry, assistantToolCalls.get(String(callIdRaw ?? '')));
        const toolName =
          mappedTool?.namespacedName ||
          assistantToolCalls.get(String(callIdRaw ?? '')) ||
          (typeof ir['name'] === 'string' ? (ir['name'] as string) : `${EXTERNAL_TOOL_PREFIX}unknown`);
        const toolCallId =
          typeof ir['call_id'] === 'string'
            ? (ir['call_id'] as string)
            : typeof ir['tool_call_id'] === 'string'
              ? (ir['tool_call_id'] as string)
              : `call_${String(toolName).replace(/[^a-zA-Z0-9_]/g, '_')}`;
        rememberAssistantToolCall(toolCallId, toolName);
        return `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`;
      };

      const buildResponsesAssistantToolCallsLine = (item: unknown = {}): string | null => {
        const ir = asRecord(item);
        const toolCallsRaw: unknown = ir['tool_calls'];
        let sourceCalls: unknown[];
        if (Array.isArray(toolCallsRaw)) sourceCalls = toolCallsRaw as unknown[];
        else if (ir['type'] === 'function_call') sourceCalls = [item];
        else sourceCalls = [];
        if (!sourceCalls.length) return null;
        const serializedToolCalls = sourceCalls
          .map((toolCall: unknown, index: number) => {
            const tcr = asRecord(toolCall);
            const fn = asRecord(tcr['function']);
            const rawName: unknown = fn['name'] ?? tcr['name'];
            const mappedTool = findExternalToolByName(externalToolRegistry, rawName);
            const namespacedName =
              mappedTool?.namespacedName ?? (typeof rawName === 'string' ? rawName : null);
            if (!namespacedName) return null;
            const toolCallId =
              typeof tcr['call_id'] === 'string'
                ? (tcr['call_id'] as string)
                : typeof tcr['id'] === 'string'
                  ? (tcr['id'] as string)
                  : `call_${index + 1}`;
            rememberAssistantToolCall(toolCallId, namespacedName);
            return {
              id: toolCallId,
              name: namespacedName,
              arguments: normalizeToolArguments(fn['arguments'] ?? tcr['arguments']),
            };
          })
          .filter((v): v is { id: string; name: string; arguments: string } => v !== null);
        if (!serializedToolCalls.length) return null;
        return `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`;
      };

      const buildResponsesInputMessages = (rawItems: unknown): NormalizedInputMessage[] => {
        const normalized: NormalizedInputMessage[] = [];
        if (!Array.isArray(rawItems)) return normalized;
        for (const item of rawItems as unknown[]) {
          if (!item) continue;
          const ir = asRecord(item);
          if (ir['type'] === 'function_call_output' || ir['type'] === 'tool_result' || ir['role'] === 'tool') {
            const toolResultLine = buildResponsesToolResultLine(item);
            if (toolResultLine) normalized.push({ role: 'tool', content: toolResultLine });
            continue;
          }
          if (ir['type'] === 'function_call') {
            const line = buildResponsesAssistantToolCallsLine(item);
            if (line) normalized.push({ role: 'assistant', content: line, isToolCalls: true });
            continue;
          }
          const toolCallsRaw: unknown = ir['tool_calls'];
          if (ir['role'] === 'assistant' && Array.isArray(toolCallsRaw) && (toolCallsRaw as unknown[]).length) {
            const line = buildResponsesAssistantToolCallsLine(item);
            if (line) normalized.push({ role: 'assistant', content: line, isToolCalls: true });
          }
          if (ir['type'] === 'message') {
            const role = typeof ir['role'] === 'string' ? (ir['role'] as string) : 'user';
            const content = normalizeTextContent(ir['content']);
            if (content) normalized.push({ role, content });
            continue;
          }
          if (ir['type'] === 'input_text') {
            if (ir['text']) normalized.push({ role: 'user', content: String(ir['text']) });
            continue;
          }
          const text = normalizeTextContent(ir['content'] ?? ir['text']);
          if (text) normalized.push({ role: typeof ir['role'] === 'string' ? (ir['role'] as string) : 'user', content: text });
        }
        return normalized;
      };

      let messages: NormalizedInputMessage[] = [];
      if (Array.isArray(chatMessages) && (chatMessages as unknown[]).length) {
        messages = buildResponsesInputMessages(chatMessages);
      } else if (typeof prompt === 'string' && prompt.trim()) {
        messages = [{ role: 'user', content: prompt }];
      } else if (typeof input === 'string') {
        messages = [{ role: 'user', content: input }];
      } else if (Array.isArray(input)) {
        messages = buildResponsesInputMessages(input);
      } else if (input && typeof input === 'object') {
        const ir = asRecord(input);
        if (ir['type'] === 'message' || ir['type'] === 'function_call' || ir['type'] === 'function_call_output' || ir['type'] === 'tool_result') {
          messages = buildResponsesInputMessages([input]);
        } else {
          const content = normalizeTextContent(ir['content'] ?? ir['text']);
          if (content) {
            messages = [{ role: typeof ir['role'] === 'string' ? (ir['role'] as string) : 'user', content }];
          }
        }
      }

      if (!messages.length) {
        res.status(400).json({ error: { message: 'input is required' } });
        return;
      }

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const flushHeaders = (res as unknown as { flushHeaders?: unknown }).flushHeaders;
        if (typeof flushHeaders === 'function') (flushHeaders as () => void).call(res);
        responsesKeepalive = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
        }, 15000);
        responsesResClosed = new Promise<boolean>((resolve) =>
          res.once('close', () => {
            if (!res.writableEnded) resolve(true);
          }),
        );
      }

      const resolvedModel = (await withTimeout(
        resolveRequestedModel(model ?? previousState?.model),
        REQUEST_TIMEOUT_MS,
        'resolve model',
      )) as unknown as { providerID: string; modelID: string };
      const pID = String(asRecord(resolvedModel)['providerID']);
      const mID = String(asRecord(resolvedModel)['modelID']);

      await ensureBackend(config);

      try {
        await client.config.update({
          body: { activeModel: { providerID: pID, modelID: mID } },
        });
      } catch {
        // ignore
      }

      let sessionId: string | null = previousState?.sessionId || null;
      if (!sessionId) {
        const sessionRes = (await withTimeout(client.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
        sessionId = (asRecord(asRecord(sessionRes)['data'])['id'] as string | undefined) ?? null;
        if (!sessionId) {
          throw new Error('Failed to create OpenCode session');
        }
      }

      const parts: Record<string, unknown>[] = [];
      const systemChunks: string[] = [];
      let fullPromptText = '';
      const formatResponsesRoleLine = (role: unknown, text: unknown): string =>
        `${String(role || 'user').toUpperCase()}: ${String(text ?? '')}`;
      for (const msg of messages) {
        if (msg.role === 'system') {
          if (msg.content) systemChunks.push(msg.content);
          continue;
        }
        if (!msg.content) continue;
        const text =
          msg.role === 'tool' || msg.content.startsWith('ASSISTANT: ') || msg.content.startsWith('TOOL_RESULT: ')
            ? msg.content
            : msg.role === 'user'
              ? msg.content
              : formatResponsesRoleLine(msg.role, msg.content);
        parts.push({ type: 'text', text });
        fullPromptText += `${text}\n\n`;
      }

      const systemWithGuard = buildSystemPrompt(
        [instructions, ...systemChunks, externalToolContext.prompt].filter(Boolean).join('\n\n'),
        reasoningLevel,
        toolMode,
        internalToolContext.allowedToolNames,
      );

      const toolOverrides = (await withTimeout(
        getToolOverridesForMode(toolMode, internalToolContext),
        REQUEST_TIMEOUT_MS,
        'load tool overrides',
      )) as Record<string, boolean> | null;
      const makeForcedResponsesToolCallRequester = (): (() => Promise<Record<string, unknown> | null>) =>
        createForcedToolCallRequester({
          mode: externalToolChoice.mode,
          sessionId: sessionId as string,
          systemWithGuard,
          requiredTool: externalToolChoice.requiredTool ?? externalToolRegistry[0]?.namespacedName,
          providerID: pID,
          modelID: mID,
          toolOverrides,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          forbidThinkBlock: false,
        });
      let requestForcedResponsesToolCall = makeForcedResponsesToolCallRequester();

      const promptParams: { path: { id: string }; body: Record<string, unknown> } = {
        path: { id: sessionId as string },
        body: {
          model: { providerID: pID, modelID: mID },
          ...(systemWithGuard ? { system: systemWithGuard } : {}),
          parts: externalToolContext.reminder ? [...parts, { type: 'text', text: externalToolContext.reminder }] : parts,
          ...(max_output_tokens ? { max_tokens: max_output_tokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(top_p !== undefined ? { top_p } : {}),
        },
      };
      if (toolOverrides && Object.keys(toolOverrides).length > 0) {
        promptParams.body['tools'] = toolOverrides;
      }

      let content = '';
      let reasoning = '';
      const buildResponsesFunctionCallOutputItem = (toolCall: FinalToolCall): Record<string, unknown> => ({
        id: toolCall.id,
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: (toolCall.function as Record<string, unknown>)['name'],
        arguments: (toolCall.function as Record<string, unknown>)['arguments'],
      });

      const buildResponsesMessageOutputItem = (
        text: unknown,
        messageId: string = `msg_${crypto.randomUUID()}`,
      ): Record<string, unknown> | null => {
        if (!text || (typeof text === 'string' && !text)) return null;
        if (typeof text === 'string' && !text.trim()) return null;
        if (!text) return null;
        return {
          id: messageId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text,
              annotations: [],
            },
          ],
        };
      };

      if (stream) {
        if (res.destroyed || res.writableEnded) {
          stopResponsesKeepalive();
          try {
            if (!res.destroyed) res.end();
          } catch {
            // ignore
          }
          return;
        }
        const responseId = `resp_${crypto.randomUUID()}`;
        const messageOutputIndex = 0;
        const reasoningOutputIndex = 1;
        const contentIndex = 0;
        const outputItemId = `msg_${crypto.randomUUID()}`;
        const reasoningItemId = 'reasoning-0';
        let nextOutputIndex = 2;
        let sequenceNumber = 0;
        let announcedOutput = false;
        let announcedContent = false;
        let announcedReasoning = false;
        const nextSeq = (): number => sequenceNumber++;
        const emit = (payload: unknown): void => {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        const createdAt = Math.floor(Date.now() / 1000);
        emit({
          type: 'response.created',
          sequence_number: nextSeq(),
          response: { id: responseId, object: 'response', created: createdAt, created_at: createdAt, status: 'in_progress', model: `${pID}/${mID}` },
        });

        const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
        const filterContentDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
        const filterReasoningDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
        const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
        const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
        const streamedToolCalls: FinalToolCall[] = [];
        let rawContent = '';
        let rawReasoning = '';
        const ensureOutputScaffold = (): void => {
          if (!announcedOutput) {
            emit({
              type: 'response.output_item.added',
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              item: { id: outputItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
            });
            announcedOutput = true;
          }
          if (!announcedContent) {
            emit({
              type: 'response.content_part.added',
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              content_index: contentIndex,
              item_id: outputItemId,
              part: { type: 'output_text', text: '', annotations: [] },
            });
            announcedContent = true;
          }
        };
        const ensureReasoningScaffold = (): void => {
          if (!announcedReasoning) {
            emit({
              type: 'response.output_item.added',
              sequence_number: nextSeq(),
              output_index: reasoningOutputIndex,
              item: { id: reasoningItemId, type: 'reasoning', status: 'in_progress', summary: [{ type: 'summary_text', text: '' }] },
            });
            announcedReasoning = true;
          }
        };
        const emitResponsesFunctionCall = (toolCall: FinalToolCall): void => {
          const outputIndex = nextOutputIndex++;
          const functionCallItem = buildResponsesFunctionCallOutputItem(toolCall);
          streamedToolCalls.push(toolCall);
          emit({
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { ...functionCallItem, status: 'in_progress' },
          });
          emit({
            type: 'response.function_call_arguments.delta',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item_id: toolCall.id,
            delta: (toolCall.function as Record<string, unknown>)['arguments'],
          });
          emit({
            type: 'response.function_call_arguments.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item_id: toolCall.id,
            arguments: (toolCall.function as Record<string, unknown>)['arguments'],
          });
          emit({
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: functionCallItem,
          });
        };
        const sendResponsesDelta = (delta: string, isReasoning: boolean = false): void => {
          if (!delta) return;
          if (isReasoning) rawReasoning += delta;
          else rawContent += delta;
          const parsedDeltaToolCalls = isReasoning ? parseReasoningToolCalls(delta) : parseContentToolCalls(delta);
          if (parsedDeltaToolCalls.length > 0) {
            const { validCalls: allowedDeltaToolCalls } = finalizeValidatedToolCalls(parsedDeltaToolCalls, externalToolRegistry);
            allowedDeltaToolCalls.forEach((toolCall) => {
              const fn = asRecord((toolCall as unknown as Record<string, unknown>)['function']);
              emitResponsesFunctionCall({
                id: String((toolCall as unknown as Record<string, unknown>)['id']),
                type: 'function',
                function: { name: fn['name'], arguments: fn['arguments'] },
              } as unknown as FinalToolCall);
            });
          }
          const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
          if (!filtered) return;
          if (isReasoning) {
            ensureReasoningScaffold();
            reasoning += filtered;
            emit({
              type: 'response.reasoning_summary_text.delta',
              sequence_number: nextSeq(),
              output_index: reasoningOutputIndex,
              item_id: reasoningItemId,
              summary_index: 0,
              delta: filtered,
            });
          } else {
            if (!filtered.trim()) {
              content += filtered;
              return;
            }
            ensureOutputScaffold();
            content += filtered;
            emit({
              type: 'response.output_text.delta',
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              content_index: contentIndex,
              item_id: outputItemId,
              delta: filtered,
            });
          }
        };

        let collected: Record<string, unknown> | null = null;
        try {
          const collectPromise = collectFromEvents(
            sessionId as string,
            REQUEST_TIMEOUT_MS,
            sendResponsesDelta,
            DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
            DEFAULT_EVENT_IDLE_TIMEOUT_MS,
          );
          const safeCollect = collectPromise.catch((err: unknown) => ({ __error: err }));
          client.session.prompt(promptParams).catch((err: unknown) => logDebug('Responses prompt error:', toErrorMessage(err)));
          const raced = responsesResClosed
            ? await Promise.race([safeCollect, responsesResClosed.then(() => ({ __cancelled: true }))])
            : await safeCollect;
          const racedRecord = asRecord(raced);
          if (racedRecord['__cancelled']) {
            stopResponsesKeepalive();
            try {
              if (sessionId) await client.session.delete({ path: { id: sessionId } });
            } catch (e: unknown) {
              logDebug('Failed to cleanup cancelled responses session', { error: toErrorMessage(e) });
            }
            try {
              if (!res.destroyed) res.end();
            } catch {
              // ignore
            }
            return;
          }
          collected = raced as Record<string, unknown>;
        } catch (e: unknown) {
          collected = { __error: e };
        }

        const collectedR = asRecord(collected);
        if (!content && !reasoning) {
          const polled = await pollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS);
          if (polled.error && !polled.content && !polled.reasoning) throw normalizeBackendError(polled.error);
          if (polled.reasoning) sendResponsesDelta(polled.reasoning, true);
          if (polled.content) sendResponsesDelta(polled.content, false);
        } else if (collected && collectedR['idleTimeout']) {
          const polled = await pollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS);
          if (polled.error && !polled.content && !polled.reasoning) throw normalizeBackendError(polled.error);
          const remainingReasoning =
            polled.reasoning && polled.reasoning.startsWith(rawReasoning)
              ? polled.reasoning.slice(rawReasoning.length)
              : polled.reasoning;
          const remainingContent =
            polled.content && polled.content.startsWith(rawContent) ? polled.content.slice(rawContent.length) : polled.content;
          if (remainingReasoning) sendResponsesDelta(remainingReasoning, true);
          if (remainingContent) sendResponsesDelta(remainingContent, false);
        } else if (collected && ((collectedR['content'] as string) || (collectedR['reasoning'] as string))) {
          if (!reasoning && collectedR['reasoning']) sendResponsesDelta(String(collectedR['reasoning']), true);
          if (!content && collectedR['content']) sendResponsesDelta(String(collectedR['content']), false);
        }

        if (announcedReasoning) {
          emit({
            type: 'response.reasoning_summary_text.done',
            sequence_number: nextSeq(),
            output_index: reasoningOutputIndex,
            item_id: reasoningItemId,
            summary_index: 0,
            text: reasoning,
          });
          emit({
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: reasoningOutputIndex,
            item: { id: reasoningItemId, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: reasoning }] },
          });
        }

        const hasMeaningfulContent = Boolean(content && content.trim());

        if (announcedContent && hasMeaningfulContent) {
          emit({
            type: 'response.output_text.done',
            sequence_number: nextSeq(),
            output_index: messageOutputIndex,
            content_index: contentIndex,
            item_id: outputItemId,
            text: content,
          });
          emit({
            type: 'response.content_part.done',
            sequence_number: nextSeq(),
            output_index: messageOutputIndex,
            content_index: contentIndex,
            item_id: outputItemId,
            part: { type: 'output_text', text: content, annotations: [] },
          });
          emit({
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: messageOutputIndex,
            item: { id: outputItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] },
          });
        }

        let polledForToolCalls: { content: string; reasoning: string; error: unknown } | null = null;
        if (externalToolRegistry.length > 0 && streamedToolCalls.length === 0) {
          try {
            polledForToolCalls = await pollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS);
          } catch {
            // ignore
          }
        }

        const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
        const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
        const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
        const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
        const finalReasoningText = (polledForToolCalls?.reasoning || rawReasoning) + flushedReasoningText;
        const finalContentText = (polledForToolCalls?.content || rawContent) + flushedContentText;

        const parseStreamedToolCalls = (): FinalToolCall[] => {
          if (externalToolRegistry.length === 0) return [];
          const perChannel = [
            ...flushedReasoningCalls,
            ...flushedContentCalls,
            ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText),
          ];
          if (perChannel.length > 0) return perChannel;
          return parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText);
        };

        let parsedToolCalls: FinalToolCall[] =
          streamedToolCalls.length > 0 ? streamedToolCalls : parseStreamedToolCalls();
        if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
          const forcedResponse = await requestForcedResponsesToolCall();
          if (forcedResponse) {
            parsedToolCalls = parseExternalToolCallsFromText(
              externalToolRegistry,
              forcedResponse['reasoning'] as string,
              forcedResponse['content'] as string,
            );
          }
        }
        const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
        const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content) as string) as string;
        const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning) as string) as string;
        if (streamedToolCalls.length === 0) {
          validatedStreamedToolCalls.forEach((toolCall) => {
            const record = toolCall as unknown as Record<string, unknown>;
            const fn = asRecord(record['function']);
            emitResponsesFunctionCall({
              id: String(record['id']),
              type: 'function',
              function: { name: fn['name'], arguments: fn['arguments'] },
            } as unknown as FinalToolCall);
          });
        }
        const streamOutput: Record<string, unknown>[] = [];
        const streamMessageOutputItem = buildResponsesMessageOutputItem(
          safeContent && safeContent.trim() ? safeContent : '',
          outputItemId,
        );
        if (streamMessageOutputItem) streamOutput.push(streamMessageOutputItem);
        validatedStreamedToolCalls.forEach((toolCall) => {
          const record = toolCall as unknown as Record<string, unknown>;
          const fn = asRecord(record['function']);
          streamOutput.push({
            id: String(record['id']),
            type: 'function_call',
            status: 'completed',
            call_id: String(record['id']),
            name: fn['name'],
            arguments: fn['arguments'],
          });
        });
        const promptTokens = Math.ceil(fullPromptText.length / 4);
        const completionTokens = Math.ceil(content.length / 4);
        const reasoningTokens = Math.ceil(reasoning.length / 4);
        const completedAt = Math.floor(Date.now() / 1000);
        const response = {
          id: responseId,
          object: 'response',
          created: completedAt,
          created_at: completedAt,
          status: 'completed',
          model: `${pID}/${mID}`,
          reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
          output: streamOutput,
          error: null,
          incomplete_details: null,
          usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens + reasoningTokens,
            total_tokens: promptTokens + completionTokens + reasoningTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: reasoningTokens },
          },
        };
        emit({ type: 'response.completed', sequence_number: nextSeq(), response });
        res.write('data: [DONE]\n\n');
        storeResponseState(responseId, sessionId, `${pID}/${mID}`);
        stopResponsesKeepalive();
        res.end();
        return;
      }

      let responseRes: unknown = null;
      let responseParts: unknown[] = [];
      let promptContent = '';
      let promptReasoning = '';
      let promptParsedToolCalls: FinalToolCall[] = [];
      let polledFilled = false;
      let lastResponsesAttemptError: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (res.writableEnded || res.destroyed) {
          logDebug('Client gone, stop retrying', { sessionId, attempt });
          return;
        }
        if (attempt > 1) {
          try {
            await client.session.delete({ path: { id: sessionId } });
          } catch (e: unknown) {
            logDebug('Failed to delete retried session', { sessionId, error: toErrorMessage(e) });
          }
          const retrySessionRes = (await withTimeout(client.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
          sessionId = (asRecord(asRecord(retrySessionRes)['data'])['id'] as string | undefined) ?? null;
          if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
          promptParams.path.id = sessionId;
          requestForcedResponsesToolCall = makeForcedResponsesToolCallRequester();
          await sleep(computeRetryDelay(attempt - 1, lastResponsesAttemptError));
        }
        let polledResponse: { content: string; reasoning: string; error: unknown } | null = null;
        try {
          responseRes = await withTimeout(client.session.prompt(promptParams), REQUEST_TIMEOUT_MS, 'prompt backend');
          const dataParts: unknown = asRecord(asRecord(responseRes)['data'])['parts'];
          responseParts = Array.isArray(dataParts) ? (dataParts as unknown[]) : [];
          promptContent = responseParts
            .filter((p) => asRecord(p)['type'] === 'text')
            .map((p) => String(asRecord(p)['text'] ?? ''))
            .join('\n');
          promptReasoning = responseParts
            .filter((p) => asRecord(p)['type'] === 'reasoning')
            .map((p) => String(asRecord(p)['text'] ?? ''))
            .join('\n');
          promptParsedToolCalls =
            externalToolRegistry.length > 0
              ? parseExternalToolCallsFromText(externalToolRegistry, promptReasoning, promptContent)
              : [];
          if (promptContent || promptReasoning) break;
          polledResponse = await pollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS);
        } catch (loopError: unknown) {
          if (attempt < maxAttempts && isTransientUpstreamError(loopError)) {
            console.warn(
              `[Proxy] Transient upstream error (attempt ${attempt}/${maxAttempts}), retrying:`,
              readDataMessage(loopError),
            );
            lastResponsesAttemptError = loopError;
            continue;
          }
          throw normalizeBackendError(loopError);
        }
        if (polledResponse && polledResponse.error && !polledResponse.content && !polledResponse.reasoning) {
          if (attempt < maxAttempts && isTransientUpstreamError(polledResponse.error)) {
            console.warn(
              `[Proxy] Transient upstream error (attempt ${attempt}/${maxAttempts}), retrying:`,
              readDataMessage(polledResponse.error),
            );
            lastResponsesAttemptError = polledResponse.error;
            continue;
          }
          throw normalizeBackendError(polledResponse.error);
        }
        if (polledResponse) {
          content = polledResponse.content || content;
          reasoning = polledResponse.reasoning || reasoning;
          polledFilled = true;
        }
        break;
      }

      if (!polledFilled) {
        content = promptParsedToolCalls.length > 0 ? '' : promptContent;
        reasoning = promptReasoning;
      }

      let promptBasedToolCalls: FinalToolCall[] = promptParsedToolCalls;
      if (polledFilled) {
        promptBasedToolCalls =
          externalToolRegistry.length > 0
            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
            : [];
      }

      if (!content && !reasoning && responseRes && promptBasedToolCalls.length === 0) {
        const data: unknown = asRecord(responseRes)['data'];
        if (typeof data === 'string') content = data;
        else {
          const dr = asRecord(data);
          content = typeof dr['message'] === 'string' ? (dr['message'] as string) : JSON.stringify(data);
        }
      }

      let parsedToolCalls: FinalToolCall[] =
        promptBasedToolCalls.length > 0
          ? promptBasedToolCalls
          : externalToolRegistry.length > 0
            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
            : [];
      if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
        const forcedResponse = await requestForcedResponsesToolCall();
        if (forcedResponse) {
          content = String(forcedResponse['content'] ?? content);
          reasoning = String(forcedResponse['reasoning'] ?? reasoning);
          parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
        }
      }
      const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
      const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content) as string) as string;
      const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning) as string) as string;

      const promptTokens = Math.ceil(fullPromptText.length / 4);
      const completionTokens = Math.ceil(content.length / 4);
      const reasoningTokens = Math.ceil(reasoning.length / 4);
      const output: Record<string, unknown>[] = [];
      const messageOutputItem = buildResponsesMessageOutputItem(safeContent);
      if (messageOutputItem) output.push(messageOutputItem);
      validatedToolCalls.forEach((toolCall) => {
        const record = toolCall as unknown as Record<string, unknown>;
        const fn = asRecord(record['function']);
        output.push({
          id: String(record['id']),
          type: 'function_call',
          status: 'completed',
          call_id: String(record['id']),
          name: fn['name'],
          arguments: fn['arguments'],
        });
      });

      const responseId = `resp_${crypto.randomUUID()}`;
      const createdAt = Math.floor(Date.now() / 1000);
      const response = {
        id: responseId,
        object: 'response',
        created: createdAt,
        created_at: createdAt,
        status: 'completed',
        model: `${pID}/${mID}`,
        reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
        output,
        error: null,
        incomplete_details: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens + reasoningTokens,
          total_tokens: promptTokens + completionTokens + reasoningTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      };

      storeResponseState(responseId, sessionId, `${pID}/${mID}`);

      res.json(response);
      return;
    } catch (error: unknown) {
      stopResponsesKeepalive();
      console.error('[Proxy] Responses API Error:', toErrorMessage(error));
      const transformed = transformUpstreamError(error);
      if (res.headersSent) {
        try {
          const failedAt = Math.floor(Date.now() / 1000);
          res.write(
            `data: ${JSON.stringify({
              type: 'response.failed',
              response: { id: `resp_${crypto.randomUUID()}`, object: 'response', created: failedAt, created_at: failedAt, status: 'failed', error: transformed.error },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
        } catch (writeError: unknown) {
          logDebug('Failed to report error on open response stream', { error: toErrorMessage(writeError) });
        }
        res.end();
        return;
      }
      res.status(transformed.statusCode).json(transformed.error);
      return;
    }
  });
}
