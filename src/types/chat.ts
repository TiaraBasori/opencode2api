/** Chat Completions DTOs (OpenAI-compatible, proxy-level view). */

export interface ChatFunctionDefinition {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  arguments?: unknown;
  [key: string]: unknown;
}

export interface ChatTool {
  type?: unknown;
  function?: ChatFunctionDefinition | null;
  name?: unknown;
  [key: string]: unknown;
}

export type ChatToolChoice = string | Record<string, unknown> | null | undefined;

export interface ChatMessageContentPart {
  type?: unknown;
  text?: unknown;
  image_url?: unknown;
  [key: string]: unknown;
}

export interface ChatMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

export interface PromptPart {
  type: string;
  text?: string;
  mime?: string;
  url?: string;
  filename?: string;
  [key: string]: unknown;
}

export interface PromptParams {
  path: { id: string };
  body: Record<string, unknown>;
}
