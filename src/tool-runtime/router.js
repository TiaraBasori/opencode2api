import { EXTERNAL_TOOL_PREFIX } from './contracts.js';
import { findExternalToolByName } from './registry.js';

export function normalizeExternalToolChoice(toolChoice, registry) {
  if (!toolChoice || !Array.isArray(registry) || registry.length === 0) {
    return { mode: 'auto', requiredTool: null };
  }
  if (toolChoice === 'auto' || toolChoice === 'none') {
    return { mode: toolChoice, requiredTool: null };
  }
  if (toolChoice === 'required') {
    return { mode: 'required', requiredTool: null };
  }
  const requestedName = toolChoice?.function?.name;
  if (toolChoice?.type === 'function' && requestedName) {
    const mappedTool = findExternalToolByName(registry, requestedName);
    return {
      mode: 'required',
      requiredTool: mappedTool?.namespacedName || `${EXTERNAL_TOOL_PREFIX}${requestedName}`
    };
  }
  return { mode: 'auto', requiredTool: null };
}

export function buildExternalToolsPrompt(registry, toolChoice = null) {
  if (!Array.isArray(registry) || registry.length === 0) return '';
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const choiceInstructions = [];
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
    `Available external tools: ${JSON.stringify(registry.map((tool) => ({
      name: tool.namespacedName,
      client_name: tool.originalName,
      description: tool.description,
      parameters: tool.parameters,
      risk_level: tool.riskLevel,
      side_effect: tool.sideEffect,
      requires_confirmation: tool.requiresConfirmation
    })))}`,
  ].join('\n');
}

export function buildToolExposure(registry, toolChoice = null) {
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const exposedTools = Array.isArray(registry) ? registry.filter((tool) => tool.enabled !== false) : [];
  return {
    tools: exposedTools,
    toolChoice: normalizedChoice,
    prompt: buildExternalToolsPrompt(exposedTools, toolChoice)
  };
}
