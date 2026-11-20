/*
 * 实现逻辑说明：
 * 这里把外部的 OpenAI 标准请求结构转换为 Codex backend-api 的 responses 请求体，
 * 并把 Codex 的事件流改写回标准 OpenAI Responses / Chat Completions 输出格式。
 *
 * Local fork additions:
 * - OpenAI tools / tool_choice / parallel_tool_calls are forwarded to Codex;
 * - assistant.tool_calls and role:"tool" history become function_call /
 *   function_call_output input items, otherwise multi-turn tool loops break;
 * - function_call stream events are rewritten into OpenAI tool_calls;
 * - Codex usage is mapped back into OpenAI usage objects.
 */

import type {
  CodexEvent,
  CodexFunctionCallItem,
  CodexFunctionCallOutputItem,
  CodexResponsesInputItem,
  CodexResponsesRequest,
  CodexToolDefinition,
  OpenAIChatCompletionsRequest,
  OpenAIChatMessage,
  OpenAIResponsesInputMessage,
  OpenAIResponsesRequest,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIToolDefinition,
  OpenAIUsage,
} from "./types.js";

const DEFAULT_MODEL = "gpt-5-codex";
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export function normalizeModelName(model?: string) {
  if (!model) return DEFAULT_MODEL;
  return model;
}

function toInputTextParts(content: OpenAIChatMessage["content"]) {
  if (!content) return [];
  if (typeof content === "string") {
    return [{ type: "input_text" as const, text: content }];
  }

  return content
    .filter((part) => part.type === "text" || part.type === "input_text")
    .map((part) => ({
      type: "input_text" as const,
      text: part.text,
    }));
}

function contentToText(content: OpenAIChatMessage["content"]) {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part?.text ?? "").join("");
}

/** OpenAI chat tools -> Codex responses tools (flat function shape). */
export function convertTools(tools?: OpenAIToolDefinition[]): CodexToolDefinition[] | undefined {
  if (!Array.isArray(tools)) return undefined;

  const converted = tools
    .map((tool): CodexToolDefinition | null => {
      if (!tool) return null;
      if (tool.type && tool.type !== "function") return null;

      const fn = tool.function ?? tool;
      if (!fn?.name) return null;

      const out: CodexToolDefinition = {
        type: "function",
        name: fn.name,
        parameters: fn.parameters ?? { type: "object", properties: {} },
      };
      if (fn.description) out.description = fn.description;
      if (typeof fn.strict === "boolean") out.strict = fn.strict;
      return out;
    })
    .filter((tool): tool is CodexToolDefinition => tool !== null);

  return converted.length > 0 ? converted : undefined;
}

export function convertToolChoice(choice?: OpenAIToolChoice): OpenAIToolChoice | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  const name = choice.name;
  return name ? { type: "function", name } : undefined;
}

export function chatCompletionsToResponsesInput(request: OpenAIChatCompletionsRequest): {
  instructions?: string;
  input: CodexResponsesInputItem[];
} {
  const instructions = request.messages
    ?.filter((message) => message.role === "system")
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join("\n");

  const input: CodexResponsesInputItem[] = [];

  for (const message of request.messages ?? []) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      const output: CodexFunctionCallOutputItem = {
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
      };
      input.push(output);
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const item: CodexFunctionCallItem = {
          type: "function_call",
          call_id: call.id,
          name: call.function?.name ?? "",
          arguments: call.function?.arguments ?? "{}",
        };
        input.push(item);
      }
    }

    const parts = toInputTextParts(message.content);
    if (parts.length > 0) {
      const item: OpenAIResponsesInputMessage = {
        type: "message",
        role: message.role,
        content: parts,
      };
      input.push(item);
    }
  }

  return {
    instructions: instructions || undefined,
    input,
  };
}

export function buildCodexResponsesRequestFromResponses(
  request: OpenAIResponsesRequest,
): CodexResponsesRequest {
  const body: CodexResponsesRequest = {
    model: normalizeModelName(request.model),
    store: false,
    stream: true,
    instructions: request.instructions || DEFAULT_INSTRUCTIONS,
    input: request.input ?? [],
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: convertToolChoice(request.tool_choice) ?? "auto",
    parallel_tool_calls: request.parallel_tool_calls ?? true,
  };

  const tools = convertTools(request.tools);
  if (tools) body.tools = tools;

  return body;
}

export function buildCodexResponsesRequestFromChatCompletions(
  request: OpenAIChatCompletionsRequest,
): CodexResponsesRequest {
  const converted = chatCompletionsToResponsesInput(request);

  const body: CodexResponsesRequest = {
    model: normalizeModelName(request.model),
    store: false,
    stream: true,
    instructions: converted.instructions || DEFAULT_INSTRUCTIONS,
    input: converted.input,
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: convertToolChoice(request.tool_choice) ?? "auto",
    parallel_tool_calls: request.parallel_tool_calls ?? true,
  };

  const tools = convertTools(request.tools);
  if (tools) body.tools = tools;

  return body;
}

export function createOpenAIResponsesOutput(
  responseId: string,
  text: string,
  toolCalls: OpenAIToolCall[] = [],
  usage?: OpenAIUsage,
) {
  const output: Array<Record<string, unknown>> = [];

  for (const call of toolCalls) {
    output.push({
      id: `${responseId}_${call.id}`,
      type: "function_call",
      call_id: call.id,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
      status: "completed",
    });
  }

  if (text || output.length === 0) {
    output.push({
      id: `${responseId}_msg`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: [],
        },
      ],
    });
  }

  const result: Record<string, unknown> = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    output,
    model: DEFAULT_MODEL,
  };

  if (usage) result.usage = usage;

  return result;
}

export function createChatCompletion(
  responseId: string,
  model: string,
  text: string,
  toolCalls: OpenAIToolCall[] = [],
  usage?: OpenAIUsage,
) {
  const created = Math.floor(Date.now() / 1000);
  const hasToolCalls = toolCalls.length > 0;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: hasToolCalls ? text || null : text,
  };
  if (hasToolCalls) message.tool_calls = toolCalls;

  const result: Record<string, unknown> = {
    id: responseId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
        message,
      },
    ],
  };

  if (usage) result.usage = usage;

  return result;
}

export function createChatCompletionChunk(responseId: string, model: string, delta: string) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          content: delta,
        },
        finish_reason: null,
      },
    ],
  };
}

export function createToolCallStartChunk(
  responseId: string,
  model: string,
  index: number,
  callId: string,
  name: string,
) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: callId,
              type: "function",
              function: {
                name,
                arguments: "",
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function createToolCallArgumentsChunk(
  responseId: string,
  model: string,
  index: number,
  delta: string,
) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              function: {
                arguments: delta,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function createChatCompletionDoneChunk(
  responseId: string,
  model: string,
  finishReason: "stop" | "tool_calls" = "stop",
) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

/** Final streaming chunk carrying usage only (OpenAI sends it after the last delta). */
export function createChatCompletionUsageChunk(responseId: string, model: string, usage: OpenAIUsage) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  };
}

export function collectTextFromCodexEvents(events: CodexEvent[]) {
  return events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => (event as { delta?: string }).delta ?? "")
    .join("");
}

export function collectToolCallsFromCodexEvents(events: CodexEvent[]): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = [];
  const seen = new Set<string>();

  const push = (item?: Record<string, unknown>) => {
    if (!item || item.type !== "function_call") return;
    const key = (item.call_id as string | undefined) ?? (item.id as string | undefined);
    if (!key || seen.has(key)) return;
    seen.add(key);
    calls.push({
      id: key,
      type: "function",
      function: {
        name: (item.name as string | undefined) ?? "",
        arguments: (item.arguments as string | undefined) ?? "{}",
      },
    });
  };

  const completed = events.find((event) => event.type === "response.completed") as
    | { response?: { output?: Array<Record<string, unknown>> } }
    | undefined;
  completed?.response?.output?.forEach(push);

  for (const event of events) {
    if (event.type === "response.output_item.done") {
      push((event as { item?: Record<string, unknown> }).item);
    }
  }

  return calls;
}

/** Codex backend usage -> OpenAI usage shape. */
export function usageFromResponse(response?: Record<string, unknown>): OpenAIUsage | undefined {
  const raw = response?.usage as Record<string, unknown> | undefined;
  if (!raw) return undefined;

  const inputTokens = (raw.input_tokens as number | undefined) ?? 0;
  const outputTokens = (raw.output_tokens as number | undefined) ?? 0;

  const usage: OpenAIUsage = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: (raw.total_tokens as number | undefined) ?? inputTokens + outputTokens,
  };

  const inputDetails = raw.input_tokens_details as { cached_tokens?: number } | undefined;
  if (inputDetails?.cached_tokens !== undefined) {
    usage.prompt_tokens_details = { cached_tokens: inputDetails.cached_tokens };
  }

  const outputDetails = raw.output_tokens_details as { reasoning_tokens?: number } | undefined;
  if (outputDetails?.reasoning_tokens !== undefined) {
    usage.completion_tokens_details = { reasoning_tokens: outputDetails.reasoning_tokens };
  }

  return usage;
}

export function usageFromCodexEvents(events: CodexEvent[]): OpenAIUsage | undefined {
  const completed = events.find((event) => event.type === "response.completed") as
    | { response?: Record<string, unknown> }
    | undefined;
  return usageFromResponse(completed?.response);
}
