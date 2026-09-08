/** Anthropic Messages DTOs (proxy-level view, strict shapes live in converters). */

export interface AnthropicRequestBody {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  max_tokens?: unknown;
  stop_sequences?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
}

export interface ResponsesRequestBody {
  model?: unknown;
  input?: unknown;
  reasoning_effort?: unknown;
  reasoning?: unknown;
  max_output_tokens?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  instructions?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stream?: unknown;
  messages?: unknown;
  prompt?: unknown;
  previous_response_id?: unknown;
  opencode?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionsRequestBody {
  messages?: unknown;
  model?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  top_p?: unknown;
  frequency_penalty?: unknown;
  presence_penalty?: unknown;
  stop?: unknown;
  reasoning_effort?: unknown;
  reasoning?: unknown;
  opencode?: unknown;
  [key: string]: unknown;
}
