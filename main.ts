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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
};

/** 伪装的正常 API 服务首页 */
function homepage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CloudFlow API Gateway</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .container{max-width:720px;width:90%;text-align:center}
  .logo{font-size:3rem;margin-bottom:1rem}
  h1{font-size:1.8rem;font-weight:700;margin-bottom:.5rem;background:linear-gradient(135deg,#38bdf8,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .tagline{color:#94a3b8;font-size:1rem;margin-bottom:2rem}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:2.5rem}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.2rem .8rem;transition:transform .2s}
  .card:hover{transform:translateY(-2px)}
  .card .icon{font-size:1.6rem;margin-bottom:.4rem}
  .card h3{font-size:.85rem;font-weight:600;margin-bottom:.3rem}
  .card p{font-size:.72rem;color:#94a3b8;line-height:1.4}
  .endpoint{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:1.2rem;text-align:left;margin-bottom:2rem}
  .method{display:inline-block;background:#22c55e;color:#000;font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:4px;margin-right:.5rem}
  .method.post{background:#3b82f6}
  code{color:#38bdf8;font-size:.85rem}
  .footer{color:#475569;font-size:.75rem}
  .footer a{color:#64748b;text-decoration:none}
</style>
</head>
<body>
<div class="container">
  <div class="logo">&#x2601;&#xFE0F;</div>
  <h1>CloudFlow API Gateway</h1>
  <p class="tagline">High-performance API relay &amp; protocol translation service</p>
  <div class="cards">
    <div class="card"><div class="icon">&#x26A1;</div><h3>Low Latency</h3><p>Edge-deployed relay nodes for minimal round-trip time</p></div>
    <div class="card"><div class="icon">&#x1F512;</div><h3>Secure</h3><p>TLS 1.3 encryption with token-based authentication</p></div>
    <div class="card"><div class="icon">&#x1F4CA;</div><h3>Observable</h3><p>Real-time metrics and structured logging</p></div>
  </div>
  <div class="endpoint">
    <p style="margin-bottom:.6rem;font-weight:600">Available Endpoints</p>
    <p style="margin-bottom:.5rem"><span class="method">GET</span> <code>/</code> <span style="color:#94a3b8">- Service info</span></p>
    <p style="margin-bottom:.5rem"><span class="method post">POST</span> <code>/v1/chat/completions</code> <span style="color:#94a3b8">- Chat completions</span></p>
    <p><span class="method">GET</span> <code>/health</code> <span style="color:#94a3b8">- Health check</span></p>
  </div>
  <div class="footer"><p>&copy; 2025 CloudFlow &middot; <a href="#">Documentation</a> &middot; <a href="#">Status</a></p></div>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

/** 健康检查伪装 */
function healthCheck(): Response {
  return new Response(
    JSON.stringify({ status: "ok", service: "cloudflow-api", version: "1.2.0", uptime: Math.floor(Date.now() / 1000) }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

Deno.serve(async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 非 API 路径：返回伪装页面
  if (request.method === "GET") {
    if (url.pathname === "/health") return healthCheck();
    return homepage();
  }

  // API 路径路由
  const apiPath = url.pathname.replace(/^\/+v\d+/, "").replace(/\/+$/, "");

  if (request.method === "POST" && (url.pathname.includes("/chat/completions") || apiPath === "/chat/completions")) {
    return await handleChatCompletion(request);
  }

  // 其他 POST 也当作 API 请求处理
  if (request.method === "POST") {
    return await handleChatCompletion(request);
  }

  return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
});

/** 处理 chat completions 请求 */
async function handleChatCompletion(request: Request): Promise<Response> {

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
}
