/*
 * 实现逻辑说明：
 * 这里集中定义对外兼容的 OpenAI 请求结构与对内 Codex backend-api 所需的最小类型，
 * 让路由层、转换层、后端客户端共用同一批类型，避免在不同文件里散落结构定义。
 *
 * Local fork additions: tool calling (tools / tool_calls / function_call history),
 * token usage, and the extra stream events Codex emits for function calls.
 */

export type OpenAIMessageContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "input_text";
      text: string;
    };

export type OpenAIToolFunction = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
};

/** OpenAI chat-completions tool definition (`{ type: "function", function: {...} }`). */
export type OpenAIToolDefinition = {
  type?: "function";
  function?: OpenAIToolFunction;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
};

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      name: string;
    };

export type OpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIMessageContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};

export type OpenAIResponsesInputMessage = {
  type: "message";
  role: "system" | "user" | "assistant" | "tool";
  content: Array<{
    type: "input_text" | "output_text";
    text: string;
  }>;
};

/** Replayed assistant tool call inside a Responses input list. */
export type CodexFunctionCallItem = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
};

/** Tool result fed back into the next turn. */
export type CodexFunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type CodexResponsesInputItem =
  | OpenAIResponsesInputMessage
  | CodexFunctionCallItem
  | CodexFunctionCallOutputItem;

/** Responses-style tool definition (flat function shape Codex expects). */
export type CodexToolDefinition = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

export type OpenAIResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: CodexResponsesInputItem[];
  stream?: boolean;
  temperature?: number;
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
};

export type OpenAIChatCompletionsRequest = {
  model?: string;
  messages?: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
};

export type CodexResponsesRequest = {
  model: string;
  store: false;
  stream: true;
  instructions?: string;
  input: CodexResponsesInputItem[];
  text: {
    verbosity: "low" | "medium" | "high";
  };
  include: string[];
  prompt_cache_key?: string;
  tool_choice: OpenAIToolChoice;
  parallel_tool_calls: boolean;
  tools?: CodexToolDefinition[];
};

export type CodexModelEntry = {
  slug: string;
  display_name?: string;
  description?: string;
};

export type CodexFunctionCallItemPayload = {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  status?: string;
};

export type CodexEvent =
  | {
      type: "codex.rate_limits";
      [key: string]: unknown;
    }
  | {
      type:
        | "response.created"
        | "response.in_progress"
        | "response.completed"
        | "response.failed"
        | "response.incomplete";
      response?: Record<string, unknown>;
      [key: string]: unknown;
    }
  | {
      type: "response.output_text.delta";
      delta?: string;
      [key: string]: unknown;
    }
  | {
      type: "response.output_text.done";
      text?: string;
      [key: string]: unknown;
    }
  | {
      type: "response.output_item.added";
      item?: CodexFunctionCallItemPayload;
      output_index?: number;
      [key: string]: unknown;
    }
  | {
      type: "response.output_item.done";
      item?: CodexFunctionCallItemPayload;
      output_index?: number;
      [key: string]: unknown;
    }
  | {
      type: "response.function_call_arguments.delta";
      item_id?: string;
      delta?: string;
      output_index?: number;
      [key: string]: unknown;
    }
  | {
      type: "response.function_call_arguments.done";
      item_id?: string;
      arguments?: string;
      output_index?: number;
      [key: string]: unknown;
    }
  | {
      type: "error";
      error?: {
        type?: string;
        message?: string;
      };
      status?: number;
      [key: string]: unknown;
    };
