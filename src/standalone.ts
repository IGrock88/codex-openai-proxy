/*
 * 实现逻辑说明：
 * 这是给嵌入式/打包场景用的零依赖入口：不依赖 fastify 与 commander，
 * 直接用 node:http 提供给 OpenAI 兼容路由，复用同一套 transform 与 codex-client。
 *
 * Local addition: the DSH bundle vendors this build and spawns it with plain node,
 * so the package needs no installed dependencies at runtime.
 */

import http from "node:http";
import { URL } from "node:url";

import {
  getDefaultCodexAuthFilePath,
  resolveCodexAuthFilePath,
  validateCodexAuthFile,
} from "./auth.js";
import {
  collectCodexResponseEvents,
  fetchCodexModels,
  streamCodexResponseToSSE,
} from "./codex-client.js";
import {
  buildCodexResponsesRequestFromChatCompletions,
  buildCodexResponsesRequestFromResponses,
  collectTextFromCodexEvents,
  collectToolCallsFromCodexEvents,
  createChatCompletion,
  createChatCompletionChunk,
  createChatCompletionDoneChunk,
  createChatCompletionUsageChunk,
  createOpenAIResponsesOutput,
  createToolCallArgumentsChunk,
  createToolCallStartChunk,
  normalizeModelName,
  usageFromCodexEvents,
  usageFromResponse,
} from "./transform.js";
import { configureCodexClient } from "./codex-client.js";
import { createRateLimitsReader } from "./ratelimits.js";
import type { CodexEvent, OpenAIChatCompletionsRequest, OpenAIResponsesRequest } from "./types.js";

type ServerOptions = {
  host: string;
  port: number;
  authFile?: string;
  codexBin?: string;
};

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function parseArgs(argv: string[]): ServerOptions {
  const options: ServerOptions = { host: "127.0.0.1", port: 8787 };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === "--host" || arg === "-H") && next) {
      options.host = next;
      index += 1;
    } else if ((arg === "--port" || arg === "-p") && next) {
      const port = Number(next);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("port 必须是 1 到 65535 之间的整数");
      }
      options.port = port;
      index += 1;
    } else if ((arg === "--auth-file" || arg === "-a") && next) {
      options.authFile = next;
      index += 1;
    } else if (arg === "--codex-bin" && next) {
      options.codexBin = next;
      index += 1;
    }
  }

  return options;
}

async function handleChatCompletions(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  body: OpenAIChatCompletionsRequest,
) {
  const codexBody = buildCodexResponsesRequestFromChatCompletions(body);
  const model = normalizeModelName(body.model);

  if (body.stream) {
    const responseId = `chatcmpl_${Date.now()}`;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    const write = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    const toolIndexByItem = new Map<string, number>();
    let toolCount = 0;

    await streamCodexResponseToSSE(codexBody, { raw: response } as never, (event: CodexEvent) => {
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        const item = event.item;
        const key = item?.id ?? item?.call_id ?? "";
        const index = toolCount++;
        if (key) toolIndexByItem.set(key, index);
        write(createToolCallStartChunk(responseId, model, index, item?.call_id ?? item?.id ?? `call_${index}`, item?.name ?? ""));
        return;
      }

      if (event.type === "response.function_call_arguments.delta") {
        const index = event.item_id ? toolIndexByItem.get(event.item_id) : undefined;
        if (index !== undefined) write(createToolCallArgumentsChunk(responseId, model, index, event.delta ?? ""));
        return;
      }

      if (event.type === "response.output_text.delta" && event.delta) {
        write(createChatCompletionChunk(responseId, model, event.delta));
        return;
      }

      if (event.type === "response.completed") {
        write(createChatCompletionDoneChunk(responseId, model, toolCount > 0 ? "tool_calls" : "stop"));
        const usage = usageFromResponse(event.response);
        if (usage) write(createChatCompletionUsageChunk(responseId, model, usage));
      }
    });

    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  const events = await collectCodexResponseEvents(codexBody);
  const text = collectTextFromCodexEvents(events);
  const completed = events.find((event) => event.type === "response.completed") as
    | { response?: Record<string, unknown> }
    | undefined;
  const idValue = completed?.response?.id;
  const responseId = typeof idValue === "string" ? idValue : `chatcmpl_${Date.now()}`;

  sendJson(
    response,
    200,
    createChatCompletion(
      responseId,
      model,
      text,
      collectToolCallsFromCodexEvents(events),
      usageFromCodexEvents(events),
    ),
  );
}

async function handleResponses(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  body: OpenAIResponsesRequest,
) {
  const codexBody = buildCodexResponsesRequestFromResponses(body);

  if (body.stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    await streamCodexResponseToSSE(codexBody, { raw: response } as never, (event: CodexEvent) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  const events = await collectCodexResponseEvents(codexBody);
  const text = collectTextFromCodexEvents(events);
  const completed = events.find((event) => event.type === "response.completed") as
    | { response?: Record<string, unknown> }
    | undefined;
  const idValue = completed?.response?.id;
  const responseId = typeof idValue === "string" ? idValue : `resp_${Date.now()}`;

  sendJson(
    response,
    200,
    createOpenAIResponsesOutput(
      responseId,
      text,
      collectToolCallsFromCodexEvents(events),
      usageFromCodexEvents(events),
    ),
  );
}

export async function startStandaloneServer(options: ServerOptions) {
  const authFile = resolveCodexAuthFilePath(options.authFile ?? getDefaultCodexAuthFilePath());
  const validated = validateCodexAuthFile(authFile);
  configureCodexClient({ authFilePath: validated.authPath });

  // Subscription quota comes from the Codex app-server, not from the responses API.
  // `log` is silent here on purpose: /usage is read on demand, and a noisy engine
  // would be restarted by the DSH supervisor for nothing.
  const rateLimits = createRateLimitsReader({ codexBin: options.codexBin });

  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);
        const path = url.pathname;

        if (request.method === "GET" && path === "/health") {
          sendJson(response, 200, { ok: true });
          return;
        }

        if (request.method === "GET" && path === "/v1/models") {
          const result = await fetchCodexModels();
          const items = (result.models ?? []).map((model: { slug: string }) => ({
            id: model.slug,
            object: "model",
            created: 0,
            owned_by: "chatgpt-codex",
          }));
          sendJson(response, 200, { object: "list", data: items });
          return;
        }

        if (request.method === "GET" && (path === "/usage" || path === "/v1/usage" || path === "/rate-limits")) {
          try {
            const fresh = url.searchParams.get("fresh") === "1" || url.searchParams.get("fresh") === "true";
            sendJson(response, 200, await rateLimits.read(fresh));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(response, 503, { error: { message: `rate limits unavailable: ${message}` } });
          }
          return;
        }

        if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/responses")) {
          const raw = await readBody(request);
          let parsed: unknown = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            sendJson(response, 400, { error: { message: "invalid JSON body" } });
            return;
          }
          if (path === "/v1/chat/completions") {
            await handleChatCompletions(request, response, parsed as OpenAIChatCompletionsRequest);
          } else {
            await handleResponses(request, response, parsed as OpenAIResponsesRequest);
          }
          return;
        }

        sendJson(response, 404, { error: { message: `no route for ${request.method} ${path}` } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          sendJson(response, 500, { error: { message } });
        } else {
          response.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  server.on("close", () => rateLimits.dispose());

  return server;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await startStandaloneServer(options);
  console.log(`codex-openai-proxy (standalone) listening on http://${options.host}:${options.port}`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("standalone.js");
if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`启动失败: ${message}`);
    process.exit(1);
  });
}
