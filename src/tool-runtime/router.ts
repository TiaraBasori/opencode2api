import { EXTERNAL_TOOL_PREFIX } from './contracts.js';
import { findExternalToolByName } from './registry.js';
import type { ExternalToolEntry } from './registry.js';

/** String shorthand accepted by Chat Completions (`auto` / `none` / `required`). */
export type ChatStringToolChoice = 'auto' | 'none' | 'required';

/** Chat Completions object shape: `{ type:'function', function:{ name } }` (nested). */
export interface ChatNestedFunctionToolChoice {
  type: 'function';
  function?: { name?: unknown; [key: string]: unknown } | null;
  name?: unknown;
  [key: string]: unknown;
}

/** Responses API object shape: `{ type:'function', name }` (flat). */
export interface ChatFlatFunctionToolChoice {
  type: 'function';
  name?: unknown;
  function?: unknown;
  [key: string]: unknown;
}

/** Anthropic Messages shapes: `{ type: 'auto' | 'any' | 'tool' | 'none', name? }`. */
export interface AnthropicAutoToolChoice {
  type: 'auto';
  name?: unknown;
  [key: string]: unknown;
}

export interface AnthropicNoneToolChoice {
  type: 'none';
  name?: unknown;
  [key: string]: unknown;
}

export interface AnthropicAnyToolChoice {
  type: 'any';
  name?: unknown;
  [key: string]: unknown;
}

export interface AnthropicSpecificToolChoice {
  type: 'tool';
  name?: unknown;
  [key: string]: unknown;
}

/** Fallback for case-variant or otherwise unknown object shapes. */
export interface UnknownObjectToolChoice {
  type?: unknown;
  name?: unknown;
  function?: unknown;
  [key: string]: unknown;
}

/**
 * Every `tool_choice` shape the proxy accepts: Chat string/object forms plus
 * Anthropic Messages object forms.
 */
export type ExternalToolChoice =
  | ChatStringToolChoice
  | ChatNestedFunctionToolChoice
  | ChatFlatFunctionToolChoice
  | AnthropicAutoToolChoice
  | AnthropicNoneToolChoice
  | AnthropicAnyToolChoice
  | AnthropicSpecificToolChoice
  | UnknownObjectToolChoice;

export type ToolChoiceMode = 'auto' | 'none' | 'required';

export interface NormalizedChoice {
  mode: ToolChoiceMode;
  requiredTool: string | null;
}

export interface ToolExposure {
  tools: ExternalToolEntry[];
  toolChoice: NormalizedChoice;
  prompt: string;
  reminder: string;
}

function asRegistryList(registry: unknown): ExternalToolEntry[] {
  return Array.isArray(registry) ? (registry as ExternalToolEntry[]) : [];
}

export function normalizeExternalToolChoice(toolChoice: unknown, registry: unknown): NormalizedChoice {
  const list = asRegistryList(registry);
  if (!toolChoice || !Array.isArray(registry) || list.length === 0) {
    return { mode: 'auto', requiredTool: null };
  }
  if (toolChoice === 'auto' || toolChoice === 'none') {
    return { mode: toolChoice, requiredTool: null };
  }
  if (toolChoice === 'required') {
    return { mode: 'required', requiredTool: null };
  }
  if (toolChoice && typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    const candidate = toolChoice as UnknownObjectToolChoice & Record<string, unknown>;
    // Anthropic Messages shape: { type: 'auto' | 'any' | 'tool' | 'none', name? }.
    if (typeof candidate['type'] === 'string' && candidate['function'] === undefined) {
      const t = String(candidate['type']).toLowerCase();
      if (t === 'auto') return { mode: 'auto', requiredTool: null };
      if (t === 'none') return { mode: 'none', requiredTool: null };
      if (t === 'any') return { mode: 'required', requiredTool: null };
      if (t === 'tool' && candidate['name']) {
        const requested = candidate['name'] as string;
        const mappedTool = findExternalToolByName(list, requested);
        return {
          mode: 'required',
          requiredTool: mappedTool?.namespacedName || `${EXTERNAL_TOOL_PREFIX}${String(requested)}`
        };
      }
      if (t === 'tool') return { mode: 'required', requiredTool: null };
    }
    // Chat Completions sends { type:'function', function:{ name } }; the Responses API sends
    // { type:'function', name }. Accept both so a forced tool choice is not silently ignored.
    const fnRecord: unknown = candidate['function'];
    const fnName: unknown =
      fnRecord && typeof fnRecord === 'object' && !Array.isArray(fnRecord)
        ? (fnRecord as Record<string, unknown>)['name']
        : undefined;
    const requestedName: unknown = fnName || candidate['name'];
    if (candidate['type'] === 'function' && requestedName) {
      const mappedTool = findExternalToolByName(list, requestedName);
      return {
        mode: 'required',
        requiredTool: mappedTool?.namespacedName || `${EXTERNAL_TOOL_PREFIX}${String(requestedName)}`
      };
    }
  }
  return { mode: 'auto', requiredTool: null };
}

export function buildExternalToolsPrompt(registry: unknown, toolChoice: unknown = null): string {
  const list = asRegistryList(registry);
  if (!Array.isArray(registry) || list.length === 0) return '';
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const choiceInstructions: string[] = [];
  if (normalizedChoice.mode === 'required') {
    if (normalizedChoice.requiredTool) {
      choiceInstructions.push(`Tool use is REQUIRED for this turn. You MUST call ${normalizedChoice.requiredTool} before giving any final answer.`);
    } else {
      choiceInstructions.push('Tool use is REQUIRED for this turn. You MUST call an external tool before giving any final answer.');
    }
  } else if (normalizedChoice.mode === 'none') {
    choiceInstructions.push('Tool use is disabled for this turn. Do not emit <function_calls>.');
  }

  return [
    'External tools are virtualized by this proxy. They are not OpenCode tools.',
    'When you need an external tool, your entire assistant reply MUST be ONLY one or more <function_calls>...</function_calls> blocks.',
    'Do NOT output <think>, explanations, markdown, prose, or any text before or after <function_calls> blocks when making a tool call.',
    'Each block must contain JSON with this exact shape:',
    '{"name":"external__tool_name","arguments":{}}',
    'Arguments must be a valid JSON object that matches the declared schema.',
    'Use only the namespaced names listed below. Do not use original client tool names inside function calls.',
    'If tool results are later provided as TOOL_RESULT messages, use those results to continue normally.',
    ...choiceInstructions,
    `Available external tools: ${JSON.stringify(list.map((tool) => ({
      name: tool.namespacedName,
      client_name: tool.originalName,
      description: tool.description,
      parameters: tool.parameters,
      risk_level: tool.riskLevel,
      side_effect: tool.sideEffect,
      requires_confirmation: tool.requiresConfirmation
    })))}`
  ].join('\n');
}

/**
 * Short imperative restatement of the markup contract, meant to be appended as the final
 * prompt part rather than buried in the system prompt.
 *
 * Position matters more than wording here. With the contract only in the system prompt,
 * deepseek-v4-flash-free emitted parseable markup in 4/8 runs of an obvious single-tool
 * request; with this reminder as the last thing before generation it was 8/8. Harnesses
 * like pi send system prompts of 16KB or more and the contract gets lost inside them.
 */
export function buildExternalToolsReminder(registry: unknown, toolChoice: unknown = null): string {
  const list = asRegistryList(registry);
  if (!Array.isArray(registry) || list.length === 0) return '';
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  if (normalizedChoice.mode === 'none') return '';
  const first = list[0];
  if (!first) return '';
  const exampleName = normalizedChoice.requiredTool || first.namespacedName;
  return [
    'REMINDER: External tools are called by emitting markup, not through any native tool API.',
    `To call one, your entire reply must be ONLY <function_calls>{"name":"${exampleName}","arguments":{...}}</function_calls>`,
    'with no prose, no markdown and no <think> block. Otherwise answer normally.',
    `Available names: ${list.map((tool) => tool.namespacedName).join(', ')}`
  ].join('\n');
}

export function buildToolExposure(registry: unknown, toolChoice: unknown = null): ToolExposure {
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const exposedTools: ExternalToolEntry[] = Array.isArray(registry)
    ? (registry as ExternalToolEntry[]).filter((tool) => tool.enabled !== false)
    : [];
  return {
    tools: exposedTools,
    toolChoice: normalizedChoice,
    prompt: buildExternalToolsPrompt(exposedTools, toolChoice),
    reminder: buildExternalToolsReminder(exposedTools, toolChoice)
  };
}
