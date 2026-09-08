// P4 TS: streaming collector (poll/event) + image fetch + prompt timeout (ported from P3 .js).
import http from 'http';
import https from 'https';
import { sleep } from '../backend/manager.js';
import { withTimeout, DEFAULT_POLL_INTERVAL_MS } from '../config/proxy-config.js';
import type { ProxyClient } from '../types/client.js';
import type { CollectorHandle } from '../types/context.js';

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String((e as Record<string, unknown>)?.['message'] ?? e);
}

interface CollectorDeps {
  client: ProxyClient;
  logDebug: (...args: unknown[]) => void;
}

interface BackendPart {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  tool?: unknown;
  state?: unknown;
  sessionID?: unknown;
  [key: string]: unknown;
}

interface BackendEvent {
  type?: unknown;
  properties?: unknown;
}

// --- Mutex Logic with Timeout ---
export async function getImageDataUri(url: unknown): Promise<string> {
  const urlStr = String(url ?? '');
  if (urlStr.startsWith('data:')) {
    return urlStr;
  }

  if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
    throw new Error(`Invalid URL scheme: ${urlStr}`);
  }

  return new Promise((resolve, reject) => {
    const protocol = urlStr.startsWith('https') ? https : http;

    const req = protocol.get(urlStr, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
        return;
      }

      const contentType = (res.headers['content-type'] as string) || 'image/jpeg';
      const chunks: Buffer[] = [];

      res.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
      res.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          const base64 = buffer.toString('base64');
          resolve(`data:${contentType};base64,${base64}`);
        } catch (e: unknown) {
          reject(new Error(`Failed to encode image: ${toErrorMessage(e)}`));
        }
      });
    });

    req.on('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Image fetch timeout'));
    });
  });
}

export function extractFromParts(parts: unknown): { content: string; reasoning: string; toolParts: BackendPart[] } {
  if (!Array.isArray(parts)) return { content: '', reasoning: '', toolParts: [] };
  const list = parts as BackendPart[];
  const content = list
    .filter((p) => (p as Record<string, unknown>)['type'] === 'text')
    .map((p) => String((p as Record<string, unknown>)['text'] ?? ''))
    .join('');
  const reasoning = list
    .filter((p) => (p as Record<string, unknown>)['type'] === 'reasoning')
    .map((p) => String((p as Record<string, unknown>)['text'] ?? ''))
    .join('');
  const toolParts = list.filter((p) => (p as Record<string, unknown>)['type'] === 'tool');
  return { content, reasoning, toolParts };
}

function extractMessagesList(messagesRes: unknown): unknown[] {
  const record = asRecord(messagesRes);
  const data: unknown = record['data'] ?? messagesRes;
  if (Array.isArray(data)) return data as unknown[];
  if (Array.isArray(messagesRes)) return messagesRes as unknown[];
  return [];
}

/**
 * Create per-instance collector closing over the OpenCode client + logDebug
 * (same closure semantics as the original createApp inner functions).
 */
export function createCollector(deps: CollectorDeps): CollectorHandle {
  const { client, logDebug } = deps;
  async function promptWithTimeout(promptParams: unknown, timeoutMs: unknown): Promise<unknown> {
    // Single timeout implementation: withTimeout clears its timer and
    // swallows late rejections (old inline race leaked timers and could
    // surface unhandled rejections). Message keeps 'Request timeout' so
    // transformUpstreamError maps it to 504.
    return withTimeout(client.session.prompt(promptParams), timeoutMs, 'prompt backend');
  }

  async function pollForAssistantResponse(
    sessionId: string,
    timeoutMs: number,
    intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ): Promise<{ content: string; reasoning: string; error: unknown }> {
    const pollStart = Date.now();
    const startedAt = Date.now();
    // Best-effort snapshot of the most recent in-flight assistant message. Polling
    // observes partial messages: a reasoning model emits its reasoning part first and
    // the text part only afterwards, so returning on the first non-empty snapshot
    // truncates the answer to the reasoning alone. Keep the partial around purely as
    // a timeout fallback and otherwise wait for the message to actually finish.
    let lastPartial: { content: string; reasoning: string; error: null } | null = null;
    while (Date.now() - startedAt < timeoutMs) {
      const messagesRes: unknown = await client.session.messages({ path: { id: sessionId } });
      const messages = extractMessagesList(messagesRes);
      if (Array.isArray(messages) && messages.length) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const entry = asRecord(messages[i]);
          const info = asRecord(entry['info']);
          if (info['role'] !== 'assistant') continue;
          const { content, reasoning, toolParts } = extractFromParts(entry['parts'] ?? []);
          const error: unknown = info['error'] ?? null;
          // finish === 'tool' marks an intermediate turn that pauses for a tool
          // result; the assistant is not done producing output yet.
          const finish: unknown = info['finish'];
          const time = asRecord(info['time']);
          const finished = info['finish'] != null && finish !== 'tool';
          const done = Boolean(finished || time['completed'] || error);
          if (toolParts.length > 0) {
            logDebug('Polling found tool parts', {
              sessionId,
              count: toolParts.length,
              parts: toolParts.map((p) => {
                const pr = asRecord(p);
                const state = asRecord(pr['state']);
                return {
                  id: pr['id'],
                  tool: pr['tool'],
                  status: state['status'],
                  input: state['input'],
                };
              }),
            });
          }
          if (done) {
            if (error) {
              const errRecord = asRecord(error);
              console.error('[Proxy] OpenCode assistant error:', error);
              void errRecord;
            }
            logDebug('Polling completed', {
              sessionId,
              ms: Date.now() - pollStart,
              done,
              contentLen: content.length,
              reasoningLen: reasoning.length,
              error: error ? (asRecord(error)['name'] as unknown) : null,
            });
            return { content, reasoning, error };
          }
          if (content || reasoning) {
            lastPartial = { content, reasoning, error: null };
          }
          break;
        }
      }
      await sleep(intervalMs);
    }
    if (lastPartial) {
      logDebug('Polling timeout with partial response', {
        sessionId,
        ms: Date.now() - pollStart,
        contentLen: lastPartial.content.length,
        reasoningLen: lastPartial.reasoning.length,
      });
      return lastPartial;
    }
    logDebug('Polling timeout', { sessionId, ms: Date.now() - pollStart });
    throw new Error(`Request timeout after ${timeoutMs}ms`);
  }

  async function collectFromEvents(
    sessionId: string,
    timeoutMs: number,
    onDelta?: ((delta: string, isReasoning?: boolean) => void) | null,
    firstDeltaTimeoutMs?: number | null,
    idleTimeoutMs?: number | null,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const eventStreamResult: unknown = await client.event.subscribe({ signal: controller.signal });
    const eventStream = asRecord(eventStreamResult)['stream'] as AsyncIterable<BackendEvent>;
    let finished = false;
    let content = '';
    let reasoning = '';
    let receivedDelta = false;
    let deltaChars = 0;
    let firstDeltaAt: number | null = null;
    // Tracks internal OpenCode tool calls that are still pending/running. While any
    // tool call is active, the stream must stay open even if no text deltas arrive
    // (the backend is executing the tool). Resolving early here is what previously
    // truncated streaming responses that relied on internal tool execution.
    const activeToolCallIds = new Set<string>();
    const startedAt = Date.now();

    const finishPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;
        controller.abort();
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const firstDeltaTimer = firstDeltaTimeoutMs
        ? setTimeout(() => {
            if (finished || receivedDelta) return;
            finished = true;
            controller.abort();
            logDebug('No event data received', { sessionId, ms: Date.now() - startedAt });
            resolve({ content: '', reasoning: '', noData: true });
          }, firstDeltaTimeoutMs)
        : null;

      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleIdleTimer = (): void => {
        if (!idleTimeoutMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (finished) return;
          // A tool call is still executing on the backend. Keep the stream open
          // and wait instead of cutting the response short; the follow-up text
          // (or the final completion) will arrive once the tool finishes.
          if (activeToolCallIds.size > 0) {
            logDebug('Event idle while internal tool call is active, continuing to wait', {
              sessionId,
              ms: Date.now() - startedAt,
              activeTools: activeToolCallIds.size,
            });
            scheduleIdleTimer();
            return;
          }
          finished = true;
          controller.abort();
          logDebug('Event idle timeout', {
            sessionId,
            ms: Date.now() - startedAt,
            deltaChars,
          });
          resolve({
            content,
            reasoning,
            idleTimeout: true,
            receivedDelta,
          });
        }, idleTimeoutMs);
      };

      const trackToolActivity = (part: unknown): void => {
        const pr = asRecord(part);
        if (pr['type'] !== 'tool') return;
        const state = asRecord(pr['state']);
        const status = state['status'];
        const id = typeof pr['id'] === 'string' ? (pr['id'] as string) : null;
        if (status === 'pending' || status === 'running') {
          if (id) activeToolCallIds.add(id);
        } else if (status === 'completed' || status === 'error') {
          if (id) activeToolCallIds.delete(id);
        }
        // Tool activity means the session is still working; treat it as progress
        // so the idle timer does not terminate the stream mid-execution.
        receivedDelta = true;
        if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
        scheduleIdleTimer();
      };

      // Newer OpenCode servers stream deltas as `message.part.delta` events that
      // carry only a `partID` (no `part.type`). The part type is announced by the
      // preceding `message.part.updated` event, so we key partID -> type here and
      // resolve each delta against it. Without this, reasoning and answer text can
      // never be told apart and the answer is mis-routed (or dropped) entirely.
      const partTypeById = new Map<string, string>();
      const rememberPartType = (part: unknown): void => {
        const pr = asRecord(part);
        if (pr['id'] != null && typeof pr['type'] === 'string') {
          partTypeById.set(String(pr['id']), pr['type'] as string);
        }
      };
      const applyTextDelta = (partType: unknown, delta: unknown): void => {
        const deltaStr = typeof delta === 'string' ? delta : String(delta ?? '');
        receivedDelta = true;
        if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
        scheduleIdleTimer();
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          logDebug('SSE first delta', {
            sessionId,
            ms: firstDeltaAt - startedAt,
            type: partType,
          });
        }
        if (partType === 'reasoning') {
          reasoning += deltaStr;
          if (onDelta) onDelta(deltaStr, true);
        } else {
          content += deltaStr;
          if (onDelta) onDelta(deltaStr, false);
        }
        deltaChars += deltaStr.length;
      };

      (async (): Promise<void> => {
        try {
          for await (const event of eventStream) {
            const evType: unknown = (event as Record<string, unknown>)['type'];
            const props = asRecord((event as Record<string, unknown>)['properties']);
            if (evType === 'message.part.updated' && asRecord(props['part'])['sessionID'] === sessionId) {
              const part = asRecord(props['part']);
              rememberPartType(part);
              trackToolActivity(part);
              // Older OpenCode servers carried the streaming delta directly on
              // message.part.updated; newer servers emit message.part.delta.
              const delta: unknown = props['delta'];
              if (typeof delta === 'string' && delta) applyTextDelta(part['type'], delta);
              continue;
            }
            if (evType === 'message.part.delta' && props['sessionID'] === sessionId) {
              const partID: unknown = props['partID'];
              const delta: unknown = props['delta'];
              const field: unknown = props['field'];
              // Text and reasoning deltas both stream through field === 'text'.
              // Tool-input deltas surface via message.part.updated tool state.
              if (typeof delta === 'string' && field === 'text') {
                const partType = typeof partID === 'string' ? partTypeById.get(partID) : undefined;
                if (partType === 'reasoning' || partType === 'text') {
                  applyTextDelta(partType, delta);
                }
              }
              continue;
            }
            if (evType === 'message.updated' && asRecord(props['info'])['sessionID'] === sessionId) {
              const info = asRecord(props['info']);
              const finish: unknown = info['finish'];
              // An aborted or failed message never produces another delta. Without
              // this, the collector waits out the whole first-delta window before
              // polling rediscovers the same error.
              const infoError: unknown = info['error'];
              if (infoError && !finish) {
                finished = true;
                clearTimeout(timeoutId);
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                if (idleTimer) clearTimeout(idleTimer);
                logDebug('SSE upstream message error', {
                  sessionId,
                  ms: Date.now() - startedAt,
                  error: (asRecord(infoError)['name'] as unknown) || 'UnknownError',
                });
                resolve({ content, reasoning, error: infoError });
                break;
              }
              // Reconcile active tool calls from the full message snapshot so we
              // detect pending tools even when only message.updated fires.
              if (Array.isArray(info['parts'])) {
                for (const part of info['parts'] as unknown[]) {
                  rememberPartType(part);
                  const pr = asRecord(part);
                  if (pr['type'] === 'tool') {
                    const status = asRecord(pr['state'])['status'];
                    const id = typeof pr['id'] === 'string' ? (pr['id'] as string) : null;
                    if (status === 'pending' || status === 'running') {
                      if (id) activeToolCallIds.add(id);
                    } else if (status === 'completed' || status === 'error') {
                      if (id) activeToolCallIds.delete(id);
                    }
                  }
                }
              }
              if (finish === 'tool') {
                // Assistant turn ended pending a tool call; keep waiting for the result.
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                scheduleIdleTimer();
                continue;
              }
              if (finish === 'stop') {
                // Only treat the stream as completed when no tool call is still
                // pending. OpenCode may emit an intermediate 'stop' snapshot while a
                // tool call is in flight; resolving on it would drop the final answer.
                if (activeToolCallIds.size > 0) {
                  logDebug('Ignoring intermediate stop while tools are active', {
                    sessionId,
                    activeTools: activeToolCallIds.size,
                  });
                  continue;
                }
                if (!finished) {
                  finished = true;
                  clearTimeout(timeoutId);
                  if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                  if (idleTimer) clearTimeout(idleTimer);
                  logDebug('SSE completed', {
                    sessionId,
                    ms: Date.now() - startedAt,
                    deltaChars,
                  });
                  resolve({ content, reasoning });
                }
                break;
              }
            }
          }
        } catch (e: unknown) {
          if (!finished) {
            finished = true;
            clearTimeout(timeoutId);
            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
            if (idleTimer) clearTimeout(idleTimer);
            reject(e);
          }
        }
      })();
    });

    try {
      return await finishPromise;
    } finally {
      controller.abort();
    }
  }

  return { extractFromParts, promptWithTimeout, pollForAssistantResponse, collectFromEvents };
}
