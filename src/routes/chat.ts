// P4 TS: POST /v1/chat/completions (ported from P3 .js, behavior identical).
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
import { isTransientUpstreamError, transformUpstreamError } from '../errors/upstream.js';
import {
  withTimeout,
  DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
  DEFAULT_EVENT_IDLE_TIMEOUT_MS,
} from '../config/proxy-config.js';
import { sleep, lock, ensureBackend } from '../backend/manager.js';
import { getImageDataUri } from '../stream/collector.js';
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
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
  const n: unknown = r['name'];
  if (typeof n === 'string') return n;
  return 'unknown';
}

function readErrorName(e: unknown): string {
  const r = asRecord(e);
  const n: unknown = r['name'];
  return typeof n === 'string' ? n : 'OpenCodeError';
}

export function registerChatRoutes(app: Application, ctx: AppContext): void {
  const {
    client,
    config,
    REQUEST_TIMEOUT_MS,
    DISABLE_TOOLS,
    PROMPT_MODE,
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

  // Chat completions endpoint
  app.post('/v1/chat/completions', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        await lock(async (): Promise<void> => {
          let sessionId: string | null = null;
          let eventStream: { close?: unknown } | null = null;
          let stream = false;
          let pID = 'opencode';
          let mID = 'kimi-k2.5-free';
          let id = `chatcmpl-${crypto.randomUUID()}`;
          let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

          try {
            const body = asRecord((req as unknown as { body: unknown }).body);
            const messages: unknown = body['messages'];
            const model: unknown = body['model'];
            const toolsRaw: unknown = body['tools'];
            const tools: unknown[] = Array.isArray(toolsRaw) ? (toolsRaw as unknown[]) : [];
            const tool_choice: unknown = body['tool_choice'];
            const requestStream: unknown = body['stream'];
            const temperature: unknown = body['temperature'];
            const max_tokens: unknown = body['max_tokens'];
            const top_p: unknown = body['top_p'];
            const frequency_penalty: unknown = body['frequency_penalty'];
            const presence_penalty: unknown = body['presence_penalty'];
            const stop: unknown = body['stop'];
            const reasoning_effort: unknown = body['reasoning_effort'];
            const reasoning: unknown = body['reasoning'];
            const requestOpencodeConfig: unknown = body['opencode'];
            stream = Boolean(requestStream);
            if (!messages || !Array.isArray(messages) || (messages as unknown[]).length === 0) {
              res.status(400).json({ error: { message: 'messages array is required' } });
              return;
            }

            const reasoningLevel = normalizeReasoningEffort(
              (reasoning_effort as string) || (asRecord(reasoning)['effort'] as string),
              null,
            );

            const requestParams: Record<string, unknown> = {
              temperature: typeof temperature === 'number' ? temperature : 0.7,
              max_tokens: typeof max_tokens === 'number' ? max_tokens : null,
              top_p: typeof top_p === 'number' ? top_p : 1.0,
              frequency_penalty: typeof frequency_penalty === 'number' ? frequency_penalty : 0,
              presence_penalty: typeof presence_penalty === 'number' ? presence_penalty : 0,
              stop: Array.isArray(stop) ? stop : stop ? [stop] : null,
              reasoning_effort: reasoningLevel,
            };

            logDebug('Request params', {
              temperature: requestParams['temperature'],
              max_tokens: requestParams['max_tokens'],
              top_p: requestParams['top_p'],
              reasoning_effort: reasoningLevel,
            });

            const resolvedModel = await withTimeout(
              resolveRequestedModel(model),
              REQUEST_TIMEOUT_MS,
              'resolve model',
            ) as unknown as { providerID: string; modelID: string; aliasFrom?: string; resolved?: string };
            const resolvedRecord = asRecord(resolvedModel);
            pID = String(resolvedRecord['providerID'] ?? pID);
            mID = String(resolvedRecord['modelID'] ?? mID);
            if (resolvedRecord['aliasFrom']) {
              logDebug('Resolved model alias', { from: resolvedRecord['aliasFrom'], to: resolvedRecord['resolved'] });
            }

            const normalizeMessageContent = (content: unknown): string => normalizeTextContent(content);

            const buildPromptParts = async (
              rawMessages: unknown,
              externalToolRegistry: ExternalToolEntry[] = [],
            ): Promise<{ parts: Record<string, unknown>[]; system: string; fullPromptText: string; lastUserMsg: string }> => {
              const parts: Record<string, unknown>[] = [];
              const systemChunks: string[] = [];
              const userContents: string[] = [];
              const assistantToolCalls = new Map<string, string>();
              const formatRoleLine = (role: unknown, name: unknown, text: unknown): string => {
                const roleLabel = String(role ?? '').toUpperCase();
                const nameSuffix = name ? `(${String(name)})` : '';
                return `${roleLabel}${nameSuffix}: ${String(text ?? '')}`;
              };

              for (const m of asArray(rawMessages)) {
                const mr = asRecord(m);
                const role = String(mr['role'] ?? 'user').toLowerCase();
                const content: unknown = mr['content'];

                if (role === 'system') {
                  const text = normalizeMessageContent(content);
                  if (text) systemChunks.push(text);
                  continue;
                }

                if (role === 'assistant' && Array.isArray(mr['tool_calls']) && (mr['tool_calls'] as unknown[]).length) {
                  const serializedToolCalls = ((mr['tool_calls'] as unknown[]) as unknown[])
                    .map((toolCall: unknown, index: number) => {
                      const tcr = asRecord(toolCall);
                      const fn = asRecord(tcr['function']);
                      const rawName: unknown = fn['name'] ?? tcr['name'];
                      const mapped = findExternalToolByName(externalToolRegistry, rawName);
                      const name: unknown = mapped?.namespacedName ?? fn['name'] ?? tcr['name'];
                      return {
                        id: typeof tcr['id'] === 'string' ? (tcr['id'] as string) : `call_${index + 1}`,
                        name: name as string,
                        arguments: normalizeToolArguments(fn['arguments'] ?? tcr['arguments']),
                      };
                    })
                    .filter((toolCall) => (toolCall as { name: unknown }).name);
                  if (serializedToolCalls.length) {
                    serializedToolCalls.forEach((toolCall) => {
                      const tc = toolCall as { id: string; name: string };
                      assistantToolCalls.set(tc.id, tc.name);
                    });
                    parts.push({
                      type: 'text',
                      text: `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`,
                    });
                  }
                }

                if (role === 'tool') {
                  const text = normalizeMessageContent(content);
                  if (text) {
                    const mappedTool =
                      findExternalToolByName(externalToolRegistry, mr['name']) ||
                      findExternalToolByName(externalToolRegistry, assistantToolCalls.get(String(mr['tool_call_id'] ?? '')));
                    const toolName =
                      mappedTool?.namespacedName ||
                      assistantToolCalls.get(String(mr['tool_call_id'] ?? '')) ||
                      (typeof mr['name'] === 'string' ? (mr['name'] as string) : `${EXTERNAL_TOOL_PREFIX}unknown`);
                    const toolCallId =
                      typeof mr['tool_call_id'] === 'string'
                        ? (mr['tool_call_id'] as string)
                        : `call_${String(toolName).replace(/[^a-zA-Z0-9_]/g, '_')}`;
                    parts.push({
                      type: 'text',
                      text: `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`,
                    });
                  }
                  continue;
                }

                if (!content) continue;

                if (typeof content === 'string') {
                  if (role === 'user') userContents.push(content);
                  parts.push({
                    type: 'text',
                    text: formatRoleLine(role, mr['name'], content),
                  });
                } else if (Array.isArray(content)) {
                  for (const part of content as unknown[]) {
                    if (!part) continue;
                    const pr = asRecord(part);
                    if (pr['type'] === 'text') {
                      const text = typeof pr['text'] === 'string' ? (pr['text'] as string) : '';
                      if (role === 'user') userContents.push(text);
                      parts.push({
                        type: 'text',
                        text: formatRoleLine(role, mr['name'], text),
                      });
                    } else if (pr['type'] === 'image_url') {
                      const imageUrlRaw: unknown = pr['image_url'];
                      const imageUrl =
                        typeof imageUrlRaw === 'string'
                          ? imageUrlRaw
                          : (asRecord(imageUrlRaw)['url'] as string | undefined);
                      if (imageUrl) {
                        try {
                          const dataUri = await getImageDataUri(imageUrl);
                          const mime = String(dataUri.split(';')[0]?.split(':')[1] ?? 'image/jpeg');
                          parts.push({
                            type: 'file',
                            mime,
                            url: dataUri,
                            filename: 'image',
                          });
                        } catch (imgErr: unknown) {
                          console.warn('[Proxy] Skipping image due to error:', toErrorMessage(imgErr));
                        }
                      }
                    }
                  }
                }
              }

              return {
                parts,
                system: systemChunks.join('\n\n'),
                fullPromptText: parts.map((p) => String(p['text'] ?? '')).join('\n\n'),
                lastUserMsg: userContents[userContents.length - 1] || '',
              };
            };

            const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig);
            const toolMode: string = requestToolContext.mode;
            const externalToolContext = requestToolContext.external;
            const externalToolRegistry = externalToolContext.registry;
            const externalToolChoice = externalToolContext.toolChoice;
            const internalToolContext = requestToolContext.internal;
            trackToolMode(toolMode, {
              configuredAllowlist: internalToolContext.allowedToolNames,
              requestedAllowlist: internalToolContext.requestedAllowlist,
              deniedRequestedTools: internalToolContext.deniedRequestedTools,
              resolutionPath: internalToolContext.resolutionPath,
              resultingMode: internalToolContext.resultingMode,
              route: '/v1/chat/completions',
            });

            const { parts, system: systemMsg, fullPromptText, lastUserMsg } = await buildPromptParts(
              messages,
              externalToolRegistry,
            );
            const systemWithGuard = buildSystemPrompt(
              [systemMsg, externalToolContext.prompt].filter(Boolean).join('\n\n'),
              requestParams['reasoning_effort'],
              toolMode,
              internalToolContext.allowedToolNames,
            );
            if (!parts.length) {
              res.status(400).json({ error: { message: 'messages must include at least one non-system text message' } });
              return;
            }
            logDebug('Request start', {
              model: `${pID}/${mID}`,
              stream: Boolean(stream),
              userMessages: (messages as unknown[]).length,
              system: Boolean(systemMsg),
              lastUserLength: lastUserMsg?.length || 0,
              parts: parts.length,
              disableTools: DISABLE_TOOLS,
              toolMode,
              internalAllowedTools: internalToolContext.allowedToolNames,
              requestedInternalTools: internalToolContext.requestedAllowlist,
              deniedRequestedTools: internalToolContext.deniedRequestedTools,
              resolutionPath: internalToolContext.resolutionPath,
              resultingMode: internalToolContext.resultingMode,
            });

            // Ensure backend is running
            await ensureBackend(config);

            // Set active model
            try {
              await client.config.update({
                body: {
                  activeModel: { providerID: pID, modelID: mID },
                },
              });
            } catch (confError: unknown) {
              logDebug('Failed to set active model:', toErrorMessage(confError));
            }

            // Create session (bounded: a hung backend must 504, not stall).
            const sessionRes = (await withTimeout(client.session.create(), REQUEST_TIMEOUT_MS, 'create session')) as unknown;
            sessionId = (asRecord(asRecord(sessionRes)['data'])['id'] as string | undefined) ?? null;
            if (!sessionId) throw new Error('Failed to create OpenCode session');
            logDebug('Session created', { sessionId });

            id = `chatcmpl-${crypto.randomUUID()}`;
            keepaliveInterval = null;
            let completionTokens = 0;
            let reasoningTokens = 0;

            const promptParams: { path: { id: string }; body: Record<string, unknown> } = {
              path: { id: sessionId },
              body: {
                model: { providerID: pID, modelID: mID },
                system: systemWithGuard,
                parts: externalToolContext.reminder
                  ? [...parts, { type: 'text', text: externalToolContext.reminder }]
                  : parts,
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
            if (toolOverrides && Object.keys(toolOverrides).length > 0) {
              promptParams.body['tools'] = toolOverrides;
            }

            const makeForcedChatToolCallRequester = (): (() => Promise<Record<string, unknown> | null>) =>
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
            let requestForcedChatToolCall = makeForcedChatToolCallRequester();

            res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            if (stream) {
              const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0;
              const filterContentDelta = createToolCallFilter({
                disableTools: DISABLE_TOOLS,
                forceStrip: shouldStripStreamingToolMarkup,
              });
              const filterReasoningDelta = createToolCallFilter({
                disableTools: DISABLE_TOOLS,
                forceStrip: shouldStripStreamingToolMarkup,
              });
              const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
              const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
              let streamedContent = '';
              let streamedReasoning = '';
              let rawStreamedContent = '';
              let rawStreamedReasoning = '';
              const streamedToolCalls: FinalToolCall[] = [];
              keepaliveInterval = null;
              completionTokens = 0;
              reasoningTokens = 0;

              const ensureKeepalive = (): void => {
                if (!keepaliveInterval) {
                  keepaliveInterval = setInterval(() => {
                    if (!res.destroyed) {
                      res.write(': keepalive\n\n');
                    }
                  }, 15000);
                }
              };
              ensureKeepalive();

              const sendDelta = (delta: string, isReasoning: boolean = false): void => {
                if (!delta) return;
                if (isReasoning) rawStreamedReasoning += delta;
                else rawStreamedContent += delta;
                const parsedDeltaToolCalls = isReasoning
                  ? parseReasoningToolCalls(delta)
                  : parseContentToolCalls(delta);
                parsedDeltaToolCalls.forEach((toolCall) => {
                  streamedToolCalls.push(toolCall);
                  res.write(
                    `data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: `${pID}/${mID}`,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: streamedToolCalls.length - 1,
                                id: toolCall.id,
                                type: 'function',
                                function: {
                                  name: toolCall.function.name,
                                  arguments: toolCall.function.arguments,
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    })}\n\n`,
                  );
                });
                const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                if (!filtered) return;
                if (isReasoning) {
                  streamedReasoning += filtered;
                  reasoningTokens += Math.ceil(filtered.length / 4);
                } else {
                  streamedContent += filtered;
                  completionTokens += Math.ceil(filtered.length / 4);
                }
                const deltaField = isReasoning ? { reasoning_content: filtered } : { content: filtered };
                const chunk = {
                  id,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: `${pID}/${mID}`,
                  choices: [{ index: 0, delta: deltaField, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              };

              let collected: Record<string, unknown> | null = null;
              let lastStreamAttemptError: unknown = null;
              for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                if (attempt > 1) {
                  try {
                    await client.session.delete({ path: { id: sessionId } });
                  } catch (e: unknown) {
                    logDebug('Failed to delete retried session', { sessionId, error: toErrorMessage(e) });
                  }
                  const retrySessionRes = (await withTimeout(
                    client.session.create(),
                    REQUEST_TIMEOUT_MS,
                    'create session',
                  )) as unknown;
                  sessionId = (asRecord(asRecord(retrySessionRes)['data'])['id'] as string | undefined) ?? null;
                  if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
                  promptParams.path.id = sessionId;
                  requestForcedChatToolCall = makeForcedChatToolCallRequester();
                  streamedContent = '';
                  streamedReasoning = '';
                  rawStreamedContent = '';
                  rawStreamedReasoning = '';
                  streamedToolCalls.length = 0;
                  completionTokens = 0;
                  reasoningTokens = 0;
                  await sleep(computeRetryDelay(attempt - 1, lastStreamAttemptError));
                }
                try {
                  const collectPromise = collectFromEvents(
                    sessionId as string,
                    REQUEST_TIMEOUT_MS,
                    sendDelta,
                    DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
                    DEFAULT_EVENT_IDLE_TIMEOUT_MS,
                  );
                  const safeCollect = collectPromise.catch((err: unknown) => ({ __error: err }));
                  client.session.prompt(promptParams).catch((err: unknown) => logDebug('Prompt error:', toErrorMessage(err)));
                  collected = (await safeCollect) as Record<string, unknown>;
                } catch (e: unknown) {
                  logDebug('Stream error:', toErrorMessage(e));
                }

                const collectedRecord = asRecord(collected);
                const attemptError: unknown = collectedRecord['error'] ?? collectedRecord['__error'] ?? null;
                const nothingStreamed =
                  !rawStreamedContent && !rawStreamedReasoning && streamedToolCalls.length === 0;
                if (attemptError && nothingStreamed && attempt < maxAttempts && isTransientUpstreamError(attemptError)) {
                  console.warn(
                    `[Proxy] Transient upstream error (attempt ${attempt}/${maxAttempts}), retrying:`,
                    readDataMessage(attemptError),
                  );
                  lastStreamAttemptError = attemptError;
                  continue;
                }
                break;
              }

              const collectedR = asRecord(collected);
              if (collected && collectedR['__error']) {
                logDebug('SSE collect error, falling back to polling', {
                  sessionId,
                  error: toErrorMessage(collectedR['__error']),
                });
                const { content, reasoning, error } = await pollForAssistantResponse(
                  sessionId as string,
                  REQUEST_TIMEOUT_MS,
                );
                if (error && !content && !reasoning) {
                  const er = asRecord(error);
                  sendDelta(
                    `[Proxy Error] ${String(er['name'] ?? 'OpenCodeError')}: ${String(asRecord(er['data'])['message'] ?? (er['message'] as string) ?? 'Unknown error')}`,
                  );
                } else {
                  if (reasoning) sendDelta(reasoning, true);
                  if (content) sendDelta(content, false);
                }
              } else if (collected && collectedR['noData']) {
                logDebug('Fallback to polling (stream)', { sessionId });
                const { content, reasoning, error } = await pollForAssistantResponse(
                  sessionId as string,
                  REQUEST_TIMEOUT_MS,
                );
                if (error && !content && !reasoning) {
                  const er = asRecord(error);
                  sendDelta(
                    `[Proxy Error] ${String(er['name'] ?? 'OpenCodeError')}: ${String(asRecord(er['data'])['message'] ?? (er['message'] as string) ?? 'Unknown error')}`,
                  );
                } else {
                  if (reasoning) sendDelta(reasoning, true);
                  if (content) sendDelta(content, false);
                }
              } else if (collected && collectedR['idleTimeout']) {
                logDebug('SSE idle timeout, polling for completion', { sessionId });
                const { content, reasoning, error } = await pollForAssistantResponse(
                  sessionId as string,
                  REQUEST_TIMEOUT_MS,
                );
                if (error && !content && !reasoning) {
                  const er = asRecord(error);
                  sendDelta(
                    `[Proxy Error] ${String(er['name'] ?? 'OpenCodeError')}: ${String(asRecord(er['data'])['message'] ?? (er['message'] as string) ?? 'Unknown error')}`,
                  );
                } else {
                  const remainingReasoning =
                    reasoning && reasoning.startsWith(rawStreamedReasoning)
                      ? reasoning.slice(rawStreamedReasoning.length)
                      : reasoning;
                  const remainingContent =
                    content && content.startsWith(rawStreamedContent)
                      ? content.slice(rawStreamedContent.length)
                      : content;
                  if (remainingReasoning) sendDelta(remainingReasoning, true);
                  if (remainingContent) sendDelta(remainingContent, false);
                }
              }

              if (
                collected &&
                !streamedContent &&
                !streamedReasoning &&
                ((collectedR['reasoning'] as string) || (collectedR['content'] as string))
              ) {
                if (collectedR['reasoning']) sendDelta(String(collectedR['reasoning']), true);
                if (collectedR['content']) sendDelta(String(collectedR['content']), false);
              }

              if (!streamedContent && !streamedReasoning) {
                logDebug('SSE returned empty, falling back to polling', { sessionId });
                const { content, reasoning, error } = await pollForAssistantResponse(
                  sessionId as string,
                  REQUEST_TIMEOUT_MS,
                );
                if (error && !content && !reasoning) {
                  const er = asRecord(error);
                  sendDelta(
                    `[Proxy Error] ${String(er['name'] ?? 'OpenCodeError')}: ${String(asRecord(er['data'])['message'] ?? (er['message'] as string) ?? 'Unknown error')}`,
                  );
                } else {
                  if (reasoning) sendDelta(reasoning, true);
                  if (content) sendDelta(content, false);
                }
              } else if (streamedReasoning && !streamedContent) {
                logDebug('Reasoning streamed but no content, reconciling from snapshot', { sessionId });
                const snapshot = await pollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS).catch(
                  () => null,
                );
                if (snapshot && snapshot.content) {
                  const remainingContent = rawStreamedContent
                    ? snapshot.content.slice(rawStreamedContent.length)
                    : snapshot.content;
                  if (remainingContent) sendDelta(remainingContent, false);
                }
              }

              // Flush held buffers from the stream parsers and filters before final batch parse.
              const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : [];
              const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : [];
              const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : '';
              const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : '';
              const finalReasoningText = rawStreamedReasoning + flushedReasoningText;
              const finalContentText = rawStreamedContent + flushedContentText;

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
                const forcedResponse = await requestForcedChatToolCall();
                if (forcedResponse) {
                  parsedToolCalls = parseExternalToolCallsFromText(
                    externalToolRegistry,
                    forcedResponse['reasoning'] as string,
                    forcedResponse['content'] as string,
                  );
                }
              }
              const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(
                parsedToolCalls,
                externalToolRegistry,
              );
              const finalStreamedToolCalls = validatedStreamedToolCalls;
              if (finalStreamedToolCalls.length > 0 && streamedToolCalls.length === 0) {
                const toolCallDeltas = finalStreamedToolCalls.map((toolCall, index) => ({
                  index,
                  id: toolCall.id,
                  type: 'function',
                  function: {
                    name: (toolCall.function as Record<string, unknown>)['name'],
                    arguments: (toolCall.function as Record<string, unknown>)['arguments'],
                  },
                }));
                res.write(
                  `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: `${pID}/${mID}`,
                    choices: [
                      {
                        index: 0,
                        delta: { tool_calls: toolCallDeltas },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                );
              }

              if (keepaliveInterval) clearInterval(keepaliveInterval);
              keepaliveInterval = null;

              const promptTokens = Math.ceil((fullPromptText || '').length / 4);
              const totalTokens = promptTokens + completionTokens + reasoningTokens;

              res.write(
                `data: ${JSON.stringify({
                  id,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: finalStreamedToolCalls.length > 0 ? 'tool_calls' : 'stop',
                    },
                  ],
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens + reasoningTokens,
                    total_tokens: totalTokens,
                    completion_tokens_details: {
                      reasoning_tokens: reasoningTokens,
                    },
                  },
                })}\n\n`,
              );
              res.write('data: [DONE]\n\n');
              res.end();
            } else {
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
                  } catch (e: unknown) {
                    logDebug('Failed to delete retried session', { sessionId, error: toErrorMessage(e) });
                  }
                  const retrySessionRes = (await withTimeout(
                    client.session.create(),
                    REQUEST_TIMEOUT_MS,
                    'create session',
                  )) as unknown;
                  sessionId = (asRecord(asRecord(retrySessionRes)['data'])['id'] as string | undefined) ?? null;
                  if (!sessionId) throw new Error('Failed to create OpenCode session for retry');
                  promptParams.path.id = sessionId;
                  requestForcedChatToolCall = makeForcedChatToolCallRequester();
                  await sleep(computeRetryDelay(attempt - 1, error));
                }
                const attemptStart = Date.now();
                try {
                  await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS);
                  logDebug('Prompt sent', { sessionId, ms: Date.now() - attemptStart, attempt });
                  const collected = await pollForAssistantResponse(sessionId as string, REQUEST_TIMEOUT_MS);
                  content = collected.content || '';
                  reasoning = collected.reasoning || '';
                  error = collected.error || null;
                } catch (promptError: unknown) {
                  content = '';
                  reasoning = '';
                  error = promptError;
                }
                if (error && !content && !reasoning && attempt < maxAttempts && isTransientUpstreamError(error)) {
                  console.warn(
                    `[Proxy] Transient upstream error (attempt ${attempt}/${maxAttempts}), retrying:`,
                    readDataMessage(error),
                  );
                  continue;
                }
                break;
              }
              if (error && !content && !reasoning) {
                if (/^Request timeout after/.test(toErrorMessage(error))) throw error;
                const er = asRecord(error);
                const ed = asRecord(er['data']);
                res.status(502).json({
                  error: {
                    message: String(ed['message'] ?? er['message'] ?? 'OpenCode provider error'),
                    type: String(er['name'] ?? 'OpenCodeError'),
                  },
                });
                return;
              }
              let parsedToolCalls: FinalToolCall[] =
                externalToolRegistry.length > 0
                  ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                  : [];
              if (parsedToolCalls.length === 0 && externalToolChoice.mode === 'required') {
                const forcedResponse = await requestForcedChatToolCall();
                if (forcedResponse) {
                  content = String(forcedResponse['content'] ?? content);
                  reasoning = String(forcedResponse['reasoning'] ?? reasoning);
                  parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content);
                }
              }
              const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry);
              const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content) as string) as string;
              const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning) as string) as string;

              const promptTokens = Math.ceil((fullPromptText || '').length / 4);
              const completionTokensCalc = Math.ceil((content || '').length / 4);
              const reasoningTokensCalc = Math.ceil((reasoning || '').length / 4);
              const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc;

              const publicValidatedToolCalls = toPublicToolCalls(validatedToolCalls);
              const assistantMessage: Record<string, unknown> = {
                role: 'assistant',
                content: publicValidatedToolCalls.length > 0 ? safeContent || null : safeContent,
                ...(safeReasoning ? { reasoning_content: safeReasoning } : {}),
              };
              if (publicValidatedToolCalls.length > 0) {
                assistantMessage['tool_calls'] = publicValidatedToolCalls;
              }

              res.json({
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: `${pID}/${mID}`,
                choices: [
                  {
                    index: 0,
                    message: assistantMessage,
                    finish_reason: publicValidatedToolCalls.length > 0 ? 'tool_calls' : 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokensCalc + reasoningTokensCalc,
                  total_tokens: totalTokens,
                  completion_tokens_details: {
                    reasoning_tokens: reasoningTokensCalc,
                  },
                },
              });
            }
          } catch (error: unknown) {
            console.error('[Proxy] API Error:', toErrorMessage(error));
            console.error('[Proxy] Error details:', error);

            if (keepaliveInterval) clearInterval(keepaliveInterval);

            if (!res.headersSent) {
              const transformed = transformUpstreamError(error);
              res.status(transformed.statusCode).json(transformed.error);
            } else if (!res.destroyed) {
              res.write(`data: ${JSON.stringify({ error: { message: toErrorMessage(error) } })}\n\n`);
              res.end();
            }
            if (sessionId) {
              try {
                await client.session.delete({ path: { id: sessionId } });
              } catch (e: unknown) {
                console.error('[Proxy] Failed to cleanup session on error:', toErrorMessage(e));
              }
            }
          } finally {
            if (keepaliveInterval) clearInterval(keepaliveInterval);
            const es = eventStream as unknown as { close?: unknown } | null;
            if (es && typeof es['close'] === 'function') {
              (es['close'] as () => void)();
            }
          }
        }, REQUEST_TIMEOUT_MS + 20000);
      } catch (error: unknown) {
        console.error('[Proxy] Request Handler Error:', toErrorMessage(error));
        if (!res.headersSent) {
          const er = asRecord(error);
          res.status(500).json({
            error: {
              message: toErrorMessage(error),
              type: error instanceof Error ? error.constructor.name : String(er['name'] ?? 'Error'),
            },
          });
        }
      }
    })();
  });
}
