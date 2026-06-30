/**
 * CodeBuddy → VS Code Copilot 代理（Deno Deploy 版）
 *
 * 使用 Deno 原生 Deno.serve() API。
 * 在 Deno Deploy 中入口点设为: main.ts
 */

const CODEBUDDY_URL = "https://copilot.tencent.com/v2/chat/completions";

const VALID_FINISH_REASONS = new Set([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  null,
]);

function convertDelta(
  cbDelta: Record<string, unknown>,
): Record<string, unknown> {
  if (!cbDelta) return {};
  const result: Record<string, unknown> = {};

  if (cbDelta.content !== undefined && cbDelta.content !== null) {
    result.content = cbDelta.content;
  }
  if (cbDelta.role !== undefined) {
    result.role = cbDelta.role;
  }
  if (Array.isArray(cbDelta.tool_calls) && cbDelta.tool_calls.length > 0) {
    result.tool_calls = cbDelta.tool_calls;
  }

  return result;
}

function convertChoice(
  cbChoice: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { index: cbChoice.index ?? 0 };

  if (cbChoice.delta) {
    result.delta = convertDelta(cbChoice.delta as Record<string, unknown>);
  }
  if (cbChoice.message) {
    const msg = cbChoice.message as Record<string, unknown>;
    result.message = {
      role: msg.role ?? "assistant",
      content: msg.content ?? null,
    };
  }

  const finishReason = cbChoice.finish_reason;
  if (VALID_FINISH_REASONS.has(finishReason as null)) {
    result.finish_reason = finishReason;
  } else if (finishReason === "" || finishReason === undefined) {
    result.finish_reason = null;
  } else {
    result.finish_reason = null;
  }

  if (cbChoice.logprobs != null) {
    result.logprobs = cbChoice.logprobs;
  }

  return result;
}

function convertResponse(
  cbData: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof cbData !== "object" || cbData === null) return cbData;
  const result: Record<string, unknown> = {};

  if (cbData.id !== undefined) result.id = cbData.id;
  if (cbData.model !== undefined) result.model = cbData.model;
  if (cbData.object !== undefined) result.object = cbData.object;
  if (cbData.created !== undefined) result.created = cbData.created;

  if (Array.isArray(cbData.choices)) {
    result.choices = cbData.choices.map((c) =>
      convertChoice(c as Record<string, unknown>),
    );
  }
  if (cbData.usage != null) {
    result.usage = cbData.usage;
  }

  return result;
}

function convertRequest(
  reqBody: Record<string, unknown>,
): Record<string, unknown> {
  return { ...reqBody };
}

async function handleStreamResponse(
  readableStream: ReadableStream<Uint8Array>,
  writableStream: WritableStream<Uint8Array>,
): Promise<void> {
  const reader = readableStream.getReader();
  const writer = writableStream.getWriter();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") {
          await writer.write(new TextEncoder().encode("\n"));
          continue;
        }
        if (trimmed === "data: [DONE]") {
          await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
          continue;
        }
        if (trimmed.startsWith("data: ")) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const converted = convertResponse(parsed);
            await writer.write(
              new TextEncoder().encode(
                `data: ${JSON.stringify(converted)}\n\n`,
              ),
            );
          } catch {
            await writer.write(new TextEncoder().encode(`${trimmed}\n\n`));
          }
        } else {
          await writer.write(new TextEncoder().encode(`${trimmed}\n`));
        }
      }
    }

    if (buffer.trim()) {
      if (buffer.trim() === "data: [DONE]") {
        await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
      } else if (buffer.trim().startsWith("data: ")) {
        try {
          const parsed = JSON.parse(buffer.trim().slice(6));
          const converted = convertResponse(parsed);
          await writer.write(
            new TextEncoder().encode(`data: ${JSON.stringify(converted)}\n\n`),
          );
        } catch {
          await writer.write(new TextEncoder().encode(`${buffer.trim()}\n\n`));
        }
      }
    }
  } catch (e) {
    console.error("Stream read error:", e);
  } finally {
    await writer.close();
  }
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
};

Deno.serve(async (request: Request): Promise<Response> => {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  // 解析请求体
  let requestObj: Record<string, unknown>;
  try {
    requestObj = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: "Invalid JSON" } }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }

  const convertedBody = convertRequest(requestObj);
  const isStream = requestObj.stream === true;

  // 构建上游请求
  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    upstreamHeaders["Authorization"] = authHeader;
  }

  const upstreamRequest = new Request(CODEBUDDY_URL, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(convertedBody),
  });

  try {
    const upstreamResponse = await fetch(upstreamRequest);

    if (isStream) {
      if (upstreamResponse.body) {
        const { readable, writable } = new TransformStream();
        handleStreamResponse(upstreamResponse.body, writable);
        return new Response(readable, {
          status: upstreamResponse.status,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }
      // fallback: no body
      return new Response(null, {
        status: upstreamResponse.status,
        headers: CORS_HEADERS,
      });
    }

    // 非流式
    const bodyText = await upstreamResponse.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return new Response(bodyText, {
        status: upstreamResponse.status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type":
            upstreamResponse.headers.get("Content-Type") ?? "application/json",
        },
      });
    }

    const converted = convertResponse(parsed as Record<string, unknown>);
    return new Response(JSON.stringify(converted), {
      status: upstreamResponse.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Upstream error:", err);
    return new Response(
      JSON.stringify({ error: { message: "Upstream request failed" } }),
      {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }
});
