import type { ChildProcess } from 'node:child_process';

/** Per-backend lifecycle state (keyed by OPENCODE_SERVER_URL). */
export interface BackendState {
  isStarting: boolean;
  process: ChildProcess | null;
  jailRoot: string | null;
}

/** Stateful Responses continuation entry (previous_response_id). */
export interface SessionInfo {
  sessionId: string;
  model: string;
  expiresAt: number;
}

/** Alias kept for task naming (SessionInfo == response-state entry). */
export type ResponseStateEntry = SessionInfo;

/** Result of resolving the opencode binary location. */
export interface OpencodeResolveResult {
  path: string | null;
  source: string;
}
