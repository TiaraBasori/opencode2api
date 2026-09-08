// P4 TS: POST /v1/messages (Anthropic, ported from P3 .js, behavior identical).
import crypto from 'crypto';
import { findExternalToolByName } from '../tool-runtime/registry.js';
import { EXTERNAL_TOOL_PREFIX } from '../tool-runtime/contracts.js';
import { computeRetryDelay } from '../retry/policy.js';
import {
  validateMessagesRequest,
  extractSystemText,
  anthropicMessagesToChatMessages,
  anthropicToolsToChatTools,
  anthropicToolChoiceToChat,
  anthropicThinkingToReasoningEffort,
  mapFinishToStopReason,
  buildAnthropicMessage,
  sseEvent,
  estimateTokens,
} from '../converters/anthropic.js';
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
import { sleep, lock, ensureBackend } from '../backend/manager.js';
import { getImageDataUri } from '../stream/collector.js';
import type { Application, Request, Response } from 'express';
import type { AppContext } from '../types/context.js';
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

export function registerMessagesRoutes(app: Application, ctx: AppContext): void {
  const {
    client,
    config,
    REQUEST_TIMEOUT_MS,
    DISABLE_TOOLS,
    maxAttempts,
    resolveRequestedModel,
    logDebug,
    buildSystemPrompt,
    normalizeReasoningEffort,
    stripFunctionCalls,
    normalizeTextContent,
    normalizeToolArguments,
    createRequestToolContext,
    finalizeValidatedToolCalls,
    toPublicToolCalls,
    createForcedToolCallRequester,
    trackToolMode,
    getToolOverridesForMode,
    promptWithTimeout,
    collectFromEvents,
    pollForAssistantResponse,
  } = ctx;

  app.post('/v1/messages', async (req: Request, res: Response): Promise<void> => {
    try {
      await lock(async (): Promise<void> => {
        let sessionId: string | null = null;
        let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
        try {
          const rawBody: unknown = (req as unknown as { body: unknown }).body;
          const validationError = validateMessagesRequest(rawBody);
          if (validationError) {
            res.status(validationError.statusCode).json(validationError.body);
            return;
          }
          const body = asRecord(rawBody);
          const model: unknown = body['model'];
          const system: unknown = body['system'];
          const messagesRaw: unknown = body['messages'];
          const toolsRaw: unknown = body['tools'];
          const tools: unknown[] = Array.isArray(toolsRaw) ? (toolsRaw as unknown[]) : [];
          const tool_choice: unknown = body['tool_choice'];
          const requestStream: unknown = body['stream'];
          const temperature: unknown = body['temperature'];
          const top_p: unknown = body['top_p'];
          const top_k: unknown = body['top_k'];
          const max_tokens: unknown = body['max_tokens'];
          const stop_sequences: unknown = body['stop_sequences'];
          const thinking: unknown = body['thinking'];
          const stream = Boolean(requestStream);
          const chatMessages = anthropicMessagesToChatMessages(messagesRaw);
          const systemText = extractSystemText(system);
          if (systemText) chatMessages.unshift({ role: 'system', content: systemText } as unknown as (typeof chatMessages)[number]);
          const chatTools = anthropicToolsToChatTools(tools);
          const chatToolChoice = anthropicToolChoiceToChat(tool_choice);
          const reasoningLevel = anthropicThinkingToReasoningEffort(thinking) || normalizeReasoningEffort(undefined, null);

          const requestParams: Record<string, unknown> = {
            temperature: typeof temperature === 'number' ? temperature : 0.7,
            max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
            top_p: typeof top_p === 'number' ? top_p : 1.0,
            stop: Array.isArray(stop_sequences) ? stop_sequences : null,
            reasoning_effort: reasoningLevel,
          };
          if (top_k !== undefined) logDebug('Ignoring top_k (no opencode equivalent)', { top_k });

          const resolvedModel = (await withTimeout(resolveRequestedModel(model), REQUEST_TIMEOUT_MS, 'resolve model')) as unknown as {
            providerID: string;
            modelID: string;
          };
          const pID = String(asRecord(resolvedModel)['providerID']);
          const mID = String(asRecord(resolvedModel)['modelID']);
          const publicModel = `${pID}/${mID}`;

          const requestToolContext = createRequestToolContext(chatTools, chatToolChoice, undefined);
          const toolMode: string = requestToolContext.mode;
          const externalToolContext = requestToolContext.external;
          const externalToolRegistry = externalToolContext.registry;
          const externalToolChoice = externalToolContext.toolChoice;
          const internalToolContext = requestToolContext.internal;
          trackToolMode(toolMode, { route: '/v1/messages' });

          const parts: Record<string, unknown>[] = [];
          const systemChunks: string[] = [];
          const assistantToolCalls = new Map<string, string>();
          const formatRoleLine = (role: unknown, name: unknown, text: unknown): string =>
            `${String(role).toUpperCase()}${name ? `(${String(name)})` : ''}: ${String(text ?? '')}`;
          for (const m of chatMessages) {
            const mr = asRecord(m);
            const role = String(mr['role'] ?? 'user').toLowerCase();
            const content: unknown = mr['content'];
            if (role === 'system') {
              const text = normalizeTextContent(content);
              if (text) systemChunks.push(text);
              continue;
            }
            const toolCallsRaw: unknown = mr['tool_calls'];
            if (role === 'assistant' && Array.isArray(toolCallsRaw) && (toolCallsRaw as unknown[]).length) {
              const serialized = ((toolCallsRaw as unknown[]) as unknown[])
                .map((tc: unknown, i: number) => {
                  const tcr = asRecord(tc);
                  const fn = asRecord(tcr['function']);
                  const rawName: unknown = fn['name'] ?? tcr['name'];
                  const mapped = findExternalToolByName(externalToolRegistry, rawName);
                  return {
                    id: typeof tcr['id'] === 'string' ? (tcr['id'] as string) : `toolu_${i + 1}`,
                    name: (mapped?.namespacedName ?? (fn['name'] as string) ?? (tcr['name'] as string)) as string,
                    arguments: normalizeToolArguments(fn['arguments'] ?? tcr['arguments']),
                  };
                })
                .filter((tc) => (tc as { name: unknown }).name);
              serialized.forEach((tc) => {
                const s = tc as { id: string; name: string };
                assistantToolCalls.set(s.id, s.name);
              });
              if (serialized.length) parts.push({ type: 'text', text: `ASSISTANT: <function_calls>${JSON.stringify(serialized)}</function_calls>` });
            }
            if (role === 'tool') {
              const text = normalizeTextContent(content);
              if (text) {
                const mapped =
                  findExternalToolByName(externalToolRegistry, mr['name']) ||
                  findExternalToolByName(externalToolRegistry, assistantToolCalls.get(String(mr['tool_call_id'] ?? '')));
                const toolName =
                  mapped?.namespacedName ||
                  assistantToolCalls.get(String(mr['tool_call_id'] ?? '')) ||
                  (typeof mr['name'] === 'string' ? (mr['name'] as string) : `${EXTERNAL_TOOL_PREFIX}unknown`);
                parts.push({
                  type: 'text',
                  text: `TOOL_RESULT: ${JSON.stringify({ tool_call_id: mr['tool_call_id'] ?? toolName, name: toolName, content: text })}`,
                });
              }
              continue;
            }
            if (!content) continue;
            if (typeof content === 'string') {
              parts.push({ type: 'text', text: formatRoleLine(role, mr['name'], content) });
            } else if (Array.isArray(content)) {
              for (const part of content as unknown[]) {
                if (!part) continue;
                const pr = asRecord(part);
                if (pr['type'] === 'text') parts.push({ type: 'text', text: formatRoleLine(role, mr['name'], (pr['text'] as string) || '') });
                else if (pr['type'] === 'image_url') {
                  const imageUrlRaw: unknown = pr['image_url'];
                  const imageUrl =
                    typeof imageUrlRaw === 'string' ? imageUrlRaw : (asRecord(imageUrlRaw)['url'] as string | undefined);
                  if (imageUrl) {
                    try {
                      const dataUri = await getImageDataUri(imageUrl);
                      parts.push({ type: 'file', mime: String(dataUri.split(';')[0]?.split(':')[1]), url: dataUri, filename: 'image' });
                    } catch (e: unknown) {
                      logDebug('Skipping image', { error: toErrorMessage(e) });
                    }
                  }
                }
              }
            }
          }
          if (!parts.length) {
            res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages must include at least one text message' } });
            return;
          }

          const systemWithGuard = buildSystemPrompt(
            [systemChunks.join('\n\n'), externalToolContext.prompt].filter(Boolean).join('\n\n'),
            requestParams['reasoning_effort'],
            toolMode,
            internalToolContext.allowedToolNames,
          );
          await ensureBackend(config);
          try {
            await client.config.update({ body: { activeModel: { providerID: pID, modelID: mID } } });
          } catch (e: unknown) {
            logDebug('Failed to set active model', { error: toErrorMessage(e) });
          }
          const sessionRes = (await withTimeout(client.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
          sessionId = (asRecord(asRecord(sessionRes)['data'])['id'] as string | undefined) ?? null;
          if (!sessionId) throw new Error('Failed to create OpenCode session');

          const promptParams: { path: { id: string }; body: Record<string, unknown> } = {
            path: { id: sessionId },
            body: {
              model: { providerID: pID, modelID: mID },
              system: systemWithGuard,
              parts: externalToolContext.reminder ? [...parts, { type: 'text', text: externalToolContext.reminder }] : parts,
              ...(requestParams['max_tokens'] ? { max_tokens: requestParams['max_tokens'] } : {}),
              ...(requestParams['temperature'] !== undefined ? { temperature: requestParams['temperature'] } : {}),
              ...(requestParams['top_p'] !== undefined ? { top_p: requestParams['top_p'] } : {}),
              ...(requestParams['stop'] ? { stop: requestParams['stop'] } : {}),
            },
          };
          const toolOverrides = (await withTimeout(
            getToolOverridesForMode(toolMode, internalToolContext),
            REQUEST_TIMEOUT_MS,
            'load tool overrides',
          )) as Record<string, boolean> | null;
          if (toolOverrides && Object.keys(toolOverrides).length > 0) promptParams.body['tools'] = toolOverrides;

          const fullPromptText = parts.map((p) => String(p['text'] ?? '')).join('\n\n');
          const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
          const inputTokens = estimateTokens(fullPromptText + (systemWithGuard || ''));

          const makeForcedMessagesToolCallRequester = (): (() => Promise<Record<string, unknown> | null>) =>
            createForcedToolCallRequester({
              mode: externalToolChoice.mode,
              sessionId: sessionId as string,
              systemWithGuard,
              requiredTool: externalToolChoice.requiredTool ?? externalToolRegistry[0]?.namespacedName,
              providerID: pID,
              modelID: mID,
              toolOverrides,
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
              forbidThinkBlock: true,
            });
          let requestForcedMessagesToolCall = makeForcedMessagesToolCallRequester();

          const finalizeAnthropic = (
            content: unknown,
            reasoning: unknown,
            validatedToolCalls: unknown,
          ): Record<string, unknown> => {
            const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content) as string) as string;
            const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning) as string) as string;
            const publicCalls = toPublicToolCalls(validatedToolCalls);
            const anthropicTools = publicCalls.map((tc) => {
              const tcr = tc as unknown as Record<string, unknown>;
              const fn = asRecord(tcr['function']);
              let input: unknown = {};
              try {
                input = JSON.parse(String(fn['arguments'] || '{}')) as unknown;
              } catch {
                input = {};
              }
              return { id: tcr['id'], function: { name: fn['name'], arguments: fn['arguments'] }, _input: input };
            });
            const outputTokens = estimateTokens(safeContent + safeReasoning + JSON.stringify(anthropicTools));
            const stopReason = mapFinishToStopReason('stop', anthropicTools.length > 0);
            return buildAnthropicMessage({
              messageId,
              model: publicModel,
              text: safeContent || '',
              reasoning: safeReasoning || '',
              toolCalls: anthropicTools as unknown as Array<{ id?: unknown; name?: unknown; function?: { name?: unknown; arguments?: unknown } | null }>,
              stopReason,
              inputTokens,
              outputTokens,
            }) as unknown as Record<string, unknown>;
          };

          if (!stream) {
            let content = '';
            let reasoning = '';
            let error: unknown = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
              if (res.writableEnded || res.destroyed) {
                logDebug('Client gone, stop retrying', { sessionId, attempt });
                return;
              }
              if (attempt > 1) {
                try {
                  await client.session.delete({ path: { id: sessionId } });
                } catch {
                  // ignore
                }
                const r = (await withTimeout(client.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
                sessionId = (asRecord(asRecord(r)['data'])['id'] as string | undefined) ?? null;
                if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
                promptParams.path.id = sessionId;
                requestForcedMessagesToolCall = makeForcedMessagesToolCallRequester();
                await sleep(computeRetryDelay(attempt - 1, error));
              }
              try {
                await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                const collected = await pollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS);
                content = collected.content || '';
                reasoning = collected.reasoning || '';
                error = collected.error || null;
              } catch (promptError: unknown) {
                content = '';
                reasoning = '';
                error = promptError;
              }
              if (error && !content && !reasoning && attempt < maxAttempts && isTransientUpstreamError(error)) continue;
              break;
            }
            if (error && !content && !reasoning) {
              const t = transformUpstreamError(error);
              res.status(t.statusCode).json({
                type: 'error',
                error: {
                  type: t.error.type || 'api_error',
                  message: t.error.message || 'Upstream error',
                  ...(t.error.code ? { code: t.error.code } : {}),
                },
              });
              return;
            }
            let parsed: FinalToolCall[] =
              externalToolRegistry.length > 0 ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content) : [];
            if (parsed.length === 0 && externalToolChoice.mode === 'required') {
              const forcedResponse = await requestForcedMessagesToolCall();
              if (forcedResponse) {
                content = String(forcedResponse['content'] ?? content);
                reasoning = String(forcedResponse['reasoning'] ?? reasoning);
                parsed = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
              }
            }
            const { validCalls } = finalizeValidatedToolCalls(parsed, externalToolRegistry);
            res.json(finalizeAnthropic(content, reasoning, validCalls));
            return;
          }

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          keepaliveInterval = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
          }, 15000);
          const resClosed = new Promise<boolean>((resolve) =>
            res.once('close', () => {
              if (!res.writableEnded) resolve(true);
            }),
          );
          let streamedText = '';
          let streamedReasoning = '';
          let rawContent = '';
          let rawReasoning = '';
          const streamedToolCalls: FinalToolCall[] = [];
          const filterContent = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: externalToolRegistry.length > 0 });
          const filterReasoning = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: externalToolRegistry.length > 0 });
          const parseContent = createExternalToolCallStreamParser(externalToolRegistry);
          const parseReason = createExternalToolCallStreamParser(externalToolRegistry);
          let textBlockOpen = false;
          let thinkingBlockOpen = false;
          let nextBlockIndex = 0;
          let textIndex: number | null = null;
          let thinkingIndex: number | null = null;
          const ensureTextIndex = (): number => {
            if (textIndex === null) textIndex = nextBlockIndex++;
            return textIndex;
          };
          const ensureThinkingIndex = (): number => {
            if (thinkingIndex === null) thinkingIndex = nextBlockIndex++;
            return thinkingIndex;
          };
          res.write(
            sseEvent('message_start', {
              type: 'message_start',
              message: { id: messageId, type: 'message', role: 'assistant', model: publicModel, content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
            }),
          );
          const sendTextDelta = (delta: string): void => {
            if (!delta) return;
            const idx = ensureTextIndex();
            if (!textBlockOpen) {
              res.write(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }));
              textBlockOpen = true;
            }
            streamedText += delta;
            res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: delta } }));
          };
          const sendReasoningDelta = (delta: string): void => {
            if (!delta) return;
            const idx = ensureThinkingIndex();
            if (!thinkingBlockOpen) {
              res.write(sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } }));
              thinkingBlockOpen = true;
            }
            streamedReasoning += delta;
            res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: delta } }));
          };
          const sendDelta = (delta: string, isReasoning: boolean = false): void => {
            if (!delta) return;
            if (isReasoning) rawReasoning += delta;
            else rawContent += delta;
            const parsedCalls = isReasoning ? parseReason(delta) : parseContent(delta);
            parsedCalls.forEach((tc) => streamedToolCalls.push(tc));
            const filtered = isReasoning ? filterReasoning(delta) : filterContent(delta);
            if (!filtered) return;
            if (isReasoning) sendReasoningDelta(filtered);
            else sendTextDelta(filtered);
          };
          let collected: Record<string, unknown> | null = null;
          const collectPromise = collectFromEvents(
            sessionId as string,
            REQUEST_TIMEOUT_MS,
            sendDelta,
            DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
            DEFAULT_EVENT_IDLE_TIMEOUT_MS,
          ).catch((err: unknown) => ({ __error: err }));
          client.session.prompt(promptParams).catch((err: unknown) => logDebug('Prompt error:', toErrorMessage(err)));
          const raced = (await Promise.race([collectPromise, resClosed.then(() => ({ __cancelled: true }))])) as Record<string, unknown>;
          collected = raced;
          if (raced['__cancelled']) {
            if (keepaliveInterval) clearInterval(keepaliveInterval);
            try {
              if (sessionId) await client.session.delete({ path: { id: sessionId } });
            } catch (e: unknown) {
              logDebug('Failed to cleanup cancelled messages session', { error: toErrorMessage(e) });
            }
            try {
              if (!res.destroyed) res.end();
            } catch {
              // ignore
            }
            return;
          }
          if (raced['error'] && !rawContent && !rawReasoning) throw normalizeBackendError(raced['error']);
          if (raced['__error']) {
            const polled = await pollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS);
            if (polled.error && !polled.content && !polled.reasoning && !rawContent && !rawReasoning)
              throw normalizeBackendError(polled.error);
            const { content, reasoning } = polled;
            if (content && !rawContent) sendTextDelta(stripFunctionCallMarkup(content) as string);
            if (reasoning && !rawReasoning) sendReasoningDelta(stripFunctionCallMarkup(reasoning) as string);
          }
          if (textBlockOpen) res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
          if (thinkingBlockOpen) res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: thinkingIndex }));
          const flushedReasoningCalls = parseReason.flush ? parseReason.flush() : [];
          const flushedContentCalls = parseContent.flush ? parseContent.flush() : [];
          const flushedReasoningText = filterReasoning.flush ? filterReasoning.flush() : '';
          const flushedContentText = filterContent.flush ? filterContent.flush() : '';
          const finalReasoningText = rawReasoning + flushedReasoningText;
          const finalContentText = rawContent + flushedContentText;
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
            streamedToolCalls.length > 0
              ? [...streamedToolCalls, ...flushedReasoningCalls, ...flushedContentCalls]
              : parseStreamedToolCalls();
          if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
            const forcedResponse = await requestForcedMessagesToolCall();
            if (forcedResponse) {
              parsedToolCalls = parseExternalToolCallsFromText(
                externalToolRegistry,
                forcedResponse['reasoning'] as string,
                forcedResponse['content'] as string,
              );
            }
          }
          const { validCalls: finalValidated } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
          let toolBlockIndex = nextBlockIndex;
          for (const tc of toPublicToolCalls(finalValidated)) {
            const tcr = tc as unknown as Record<string, unknown>;
            const fn = asRecord(tcr['function']);
            res.write(
              sseEvent('content_block_start', {
                type: 'content_block_start',
                index: toolBlockIndex,
                content_block: { type: 'tool_use', id: tcr['id'], name: fn['name'], input: {} },
              }),
            );
            res.write(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: toolBlockIndex,
                delta: { type: 'input_json_delta', partial_json: (fn['arguments'] as string) || '{}' },
              }),
            );
            res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: toolBlockIndex }));
            toolBlockIndex += 1;
          }
          const outputTokens = estimateTokens(streamedText + streamedReasoning);
          const stopReason = mapFinishToStopReason('stop', finalValidated.length > 0);
          res.write(
            sseEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: outputTokens },
            }),
          );
          res.write(sseEvent('message_stop', { type: 'message_stop' }));
          if (keepaliveInterval) clearInterval(keepaliveInterval);
          res.end();
          return;
        } catch (error: unknown) {
          if (keepaliveInterval) clearInterval(keepaliveInterval);
          if (sessionId) {
            try {
              await client.session.delete({ path: { id: sessionId } });
            } catch (e: unknown) {
              logDebug('Failed to cleanup messages session on error', { error: toErrorMessage(e) });
            }
          }
          if (!res.headersSent) {
            const t = transformUpstreamError(error);
            res.status(t.statusCode).json({
              type: 'error',
              error: {
                type: t.error.type || 'api_error',
                message: t.error.message || toErrorMessage(error) || 'Upstream error',
                ...(t.error.code ? { code: t.error.code } : {}),
              },
            });
            return;
          }
          try {
            const t = transformUpstreamError(error);
            res.write(
              sseEvent('error', {
                type: 'error',
                error: { type: t.error.type || 'api_error', message: t.error.message, ...(t.error.code ? { code: t.error.code } : {}) },
              }),
            );
          } catch {
            // ignore
          }
          res.end();
          return;
        }
      }, REQUEST_TIMEOUT_MS + 20000);
    } catch (error: unknown) {
      if (!res.headersSent)
        res.status(500).json({ type: 'error', error: { type: 'api_error', message: toErrorMessage(error) } });
    }
  });
}
