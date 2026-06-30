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

/** AI 研究网站伪装首页 */
function homepage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NeuralBridge AI Research Lab</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:"Inter","SF Pro Display",system-ui,sans-serif;background:#09090b;color:#fafafa;min-height:100vh;overflow-x:hidden}
  nav{display:flex;align-items:center;justify-content:space-between;padding:1.2rem 3rem;border-bottom:1px solid #1c1c1f}
  .nav-brand{font-size:1.1rem;font-weight:700;letter-spacing:-.02em}
  .nav-brand span{background:linear-gradient(135deg,#a78bfa,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .nav-links{display:flex;gap:2rem;font-size:.82rem;color:#71717a}
  .nav-links a{color:#71717a;text-decoration:none;transition:color .2s}
  .nav-links a:hover{color:#fafafa}
  .hero{padding:6rem 3rem 4rem;text-align:center;max-width:900px;margin:0 auto}
  .badge{display:inline-block;font-size:.7rem;font-weight:600;padding:.35rem .9rem;border-radius:999px;background:rgba(167,139,250,.12);color:#a78bfa;border:1px solid rgba(167,139,250,.2);margin-bottom:1.5rem;letter-spacing:.04em;text-transform:uppercase}
  h1{font-size:3.2rem;font-weight:800;line-height:1.15;margin-bottom:1.2rem;letter-spacing:-.03em}
  h1 em{font-style:normal;background:linear-gradient(135deg,#a78bfa,#60a5fa,#34d399);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .subtitle{font-size:1.05rem;color:#71717a;line-height:1.7;max-width:600px;margin:0 auto 3rem}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.5rem;max-width:900px;margin:0 auto 5rem;padding:0 3rem}
  .card{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:2rem 1.5rem;transition:border-color .3s}
  .card:hover{border-color:#3f3f46}
  .card-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;margin-bottom:1.2rem}
  .card-icon.purple{background:rgba(167,139,250,.12);color:#a78bfa}
  .card-icon.blue{background:rgba(96,165,250,.12);color:#60a5fa}
  .card-icon.green{background:rgba(52,211,153,.12);color:#34d399}
  .card h3{font-size:.95rem;font-weight:600;margin-bottom:.5rem}
  .card p{font-size:.82rem;color:#71717a;line-height:1.6}
  .section{max-width:900px;margin:0 auto;padding:0 3rem 5rem}
  .section-title{font-size:1.6rem;font-weight:700;text-align:center;margin-bottom:.6rem;letter-spacing:-.02em}
  .section-sub{text-align:center;color:#71717a;font-size:.9rem;margin-bottom:3rem}
  .pub-list{display:flex;flex-direction:column;gap:1rem}
  .pub{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:1.2rem 1.5rem;display:flex;align-items:center;gap:1.2rem;transition:border-color .3s}
  .pub:hover{border-color:#3f3f46}
  .pub-tag{font-size:.65rem;font-weight:600;padding:.25rem .6rem;border-radius:6px;white-space:nowrap}
  .pub-tag.nlp{background:rgba(167,139,250,.15);color:#a78bfa}
  .pub-tag.vision{background:rgba(96,165,250,.15);color:#60a5fa}
  .pub-tag.infra{background:rgba(52,211,153,.15);color:#34d399}
  .pub-info h4{font-size:.88rem;font-weight:600;margin-bottom:.25rem}
  .pub-info p{font-size:.75rem;color:#71717a}
  .team{display:grid;grid-template-columns:repeat(4,1fr);gap:1.2rem;max-width:900px;margin:0 auto;padding:0 3rem 5rem}
  .member{text-align:center}
  .avatar{width:56px;height:56px;border-radius:50%;margin:0 auto .7rem;background:#27272a;display:flex;align-items:center;justify-content:center;font-size:1.2rem}
  .member h4{font-size:.82rem;font-weight:600}
  .member p{font-size:.7rem;color:#71717a}
  footer{text-align:center;padding:2rem;border-top:1px solid #1c1c1f;color:#3f3f46;font-size:.72rem}
  footer a{color:#52525b;text-decoration:none}
</style>
</head>
<body>
<nav>
  <div class="nav-brand"><span>NeuralBridge</span></div>
  <div class="nav-links">
    <a href="#">Research</a><a href="#">Publications</a><a href="#">Team</a><a href="#">Blog</a><a href="#">Careers</a>
  </div>
</nav>
<div class="hero">
  <div class="badge">Research Lab &mdash; Est. 2024</div>
  <h1>Advancing <em>Intelligence</em> Through Open Research</h1>
  <p class="subtitle">We study large language models, multi-modal reasoning, and efficient inference architectures. Our work bridges foundational research and real-world deployment.</p>
</div>
<div class="grid">
  <div class="card">
    <div class="card-icon purple">&#x1F9E0;</div>
    <h3>Language Models</h3>
    <p>Exploring instruction tuning, alignment techniques, and long-context reasoning for next-generation LLMs.</p>
  </div>
  <div class="card">
    <div class="card-icon blue">&#x1F441;</div>
    <h3>Multi-Modal Perception</h3>
    <p>Building unified models that understand text, images, and audio with cross-modal attention mechanisms.</p>
  </div>
  <div class="card">
    <div class="card-icon green">&#x2699;&#xFE0F;</div>
    <h3>Inference Infrastructure</h3>
    <p>Designing low-latency serving systems, speculative decoding pipelines, and edge deployment frameworks.</p>
  </div>
</div>
<div class="section">
  <div class="section-title">Recent Publications</div>
  <div class="section-sub">Selected works from our research team</div>
  <div class="pub-list">
    <div class="pub">
      <div class="pub-tag nlp">NLP</div>
      <div class="pub-info"><h4>Efficient Long-Context Transformers via Adaptive Sparse Attention</h4><p>NeuralBridge &middot; arXiv 2025 &middot; Under Review</p></div>
    </div>
    <div class="pub">
      <div class="pub-tag vision">Vision</div>
      <div class="pub-info"><h4>Cross-Modal Alignment Without Paired Data: A Self-Supervised Approach</h4><p>NeuralBridge &middot; ICML 2025</p></div>
    </div>
    <div class="pub">
      <div class="pub-tag infra">Infra</div>
      <div class="pub-info"><h4>Latency-Aware Scheduling for Heterogeneous LLM Inference</h4><p>NeuralBridge &middot; OSDI 2025</p></div>
    </div>
  </div>
</div>
<div class="team">
  <div class="member"><div class="avatar">&#x1F468;&#x200D;&#x1F4BB;</div><h4>Alex Chen</h4><p>Research Lead</p></div>
  <div class="member"><div class="avatar">&#x1F469;&#x200D;&#x1F4BB;</div><h4>Sarah Liu</h4><p>NLP Researcher</p></div>
  <div class="member"><div class="avatar">&#x1F468;&#x200D;&#x1F4BB;</div><h4>David Park</h4><p>Infra Engineer</p></div>
  <div class="member"><div class="avatar">&#x1F469;&#x200D;&#x1F4BB;</div><h4>Mei Wang</h4><p>ML Researcher</p></div>
</div>
<footer>&copy; 2025 NeuralBridge AI Research &middot; <a href="#">Privacy</a> &middot; <a href="#">Terms</a></footer>
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
    JSON.stringify({
      status: "ok",
      service: "neuralbridge-ai",
      version: "1.2.0",
      uptime: Math.floor(Date.now() / 1000),
    }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    },
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

  if (
    request.method === "POST" &&
    (url.pathname.includes("/chat/completions") ||
      apiPath === "/chat/completions")
  ) {
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
