/**
 * CodeBuddy → VS Code Copilot 代理（Cloudflare Worker）
 *
 * Cloudflare Workers 不能用 Node.js 的 http/https 模块，
 * 全部用 Web 标准 fetch API。
 *
 * 部署方式：
 *   wrangler deploy
 *
 * 本地测试：
 *   wrangler dev
 *
 * 配置 chatLanguageModels.json：
 *   "url": "https://你的worker地址.workers.dev/chat/completions"
 */

const CODEBUDDY_URL = 'https://copilot.tencent.com/v2/chat/completions';

// ─── OpenAI 标准 finish_reason 值 ───
const VALID_FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter', null]);

/**
 * CodeBuddy Delta → OpenAI Delta
 */
function convertDelta(cbDelta) {
  if (!cbDelta) return {};
  const result = {};

  // content：核心文本
  if (cbDelta.content !== undefined && cbDelta.content !== null) {
    result.content = cbDelta.content;
  }

  // role：首条消息携带
  if (cbDelta.role !== undefined) {
    result.role = cbDelta.role;
  }

  // tool_calls：流式模式下跨多个 chunk 累积
  // VS Code Copilot 自己做累积拼接，我们只管透传。
  // 空数组 [] 不添加，有内容时直接透传原始对象
  if (Array.isArray(cbDelta.tool_calls) && cbDelta.tool_calls.length > 0) {
    result.tool_calls = cbDelta.tool_calls;
  }

  // 删除非标准字段：reasoning_content, extra_fields, refusal, function_call
  return result;
}

/**
 * CodeBuddy Choice → OpenAI Choice
 */
function convertChoice(cbChoice) {
  const result = { index: cbChoice.index ?? 0 };

  if (cbChoice.delta) {
    result.delta = convertDelta(cbChoice.delta);
  }

  if (cbChoice.message) {
    result.message = {
      role: cbChoice.message.role ?? 'assistant',
      content: cbChoice.message.content ?? null,
    };
  }

  // finish_reason：CodeBuddy 返回 "" → null（进行中）
  if (VALID_FINISH_REASONS.has(cbChoice.finish_reason)) {
    result.finish_reason = cbChoice.finish_reason;
  } else if (cbChoice.finish_reason === '' || cbChoice.finish_reason === undefined) {
    result.finish_reason = null;
  } else {
    result.finish_reason = null;
  }

  // logprobs：null 时删除
  if (cbChoice.logprobs != null) {
    result.logprobs = cbChoice.logprobs;
  }

  return result;
}

/**
 * CodeBuddy 响应 → OpenAI 响应
 */
function convertResponse(cbData) {
  if (typeof cbData !== 'object' || cbData === null) return cbData;
  const result = {};

  if (cbData.id !== undefined) result.id = cbData.id;
  if (cbData.model !== undefined) result.model = cbData.model;
  if (cbData.object !== undefined) result.object = cbData.object;
  if (cbData.created !== undefined) result.created = cbData.created;

  if (Array.isArray(cbData.choices)) {
    result.choices = cbData.choices.map(convertChoice);
  }

  if (cbData.usage != null) {
    result.usage = cbData.usage;
  }

  return result;
}

/**
 * 请求转换：保留 tools/tool_choice，VS Code Copilot 靠模型返回 tool_calls 来本地执行工具
 */
function convertRequest(reqBody) {
  return { ...reqBody };
}

// ─── SSE 流转换器：读取 CodeBuddy 流 → DTO 转换 → 写入输出流 ───
async function handleStreamResponse(readableStream, writer) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
          await writer.write(new TextEncoder().encode('\n'));
          continue;
        }
        if (trimmed === 'data: [DONE]') {
          await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
          continue;
        }
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const converted = convertResponse(parsed);
            await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(converted)}\n\n`));
          } catch {
            await writer.write(new TextEncoder().encode(`${trimmed}\n\n`));
          }
        } else {
          await writer.write(new TextEncoder().encode(`${trimmed}\n`));
        }
      }
    }

    // 处理 buffer 残留
    if (buffer.trim()) {
      if (buffer.trim() === 'data: [DONE]') {
        await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
      } else if (buffer.trim().startsWith('data: ')) {
        try {
          const parsed = JSON.parse(buffer.trim().slice(6));
          const converted = convertResponse(parsed);
          await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(converted)}\n\n`));
        } catch {
          await writer.write(new TextEncoder().encode(`${buffer.trim()}\n\n`));
        }
      }
    }
  } catch (e) {
    console.error('Stream read error:', e);
  } finally {
    await writer.close();
  }
}

// ─── Cloudflare Worker 入口 ───
export default {
  async fetch(request, env, ctx) {
    // CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    // 解析请求体
    let requestObj;
    try {
      requestObj = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid JSON' } }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const toolCount = requestObj.tools?.length ?? 0;
    console.log(`[${new Date().toISOString()}] → ${requestObj.model} | stream: ${requestObj.stream} | tools: ${toolCount}`);

    // DTO 转换请求
    const convertedReq = convertRequest(requestObj);

    // 构建转发到 CodeBuddy 的请求
    const forwardHeaders = new Headers({
      'Content-Type': 'application/json',
    });

    // 传递 Authorization 头
    const authHeader = request.headers.get('authorization') || request.headers.get('x-api-key');
    if (authHeader) {
      forwardHeaders.set('Authorization', authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`);
    }

    // 转发请求到 CodeBuddy
    let proxyRes;
    try {
      proxyRes = await fetch(CODEBUDDY_URL, {
        method: 'POST',
        headers: forwardHeaders,
        body: JSON.stringify(convertedReq),
      });
    } catch (e) {
      console.error('→ CodeBuddy fetch error:', e);
      return new Response(
        JSON.stringify({ error: { message: `Proxy error: ${e.message}` } }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 非 200 透传错误
    if (proxyRes.status !== 200) {
      const errorBody = await proxyRes.text();
      console.log(`  ← ${proxyRes.status} (error)`);
      return new Response(errorBody, {
        status: proxyRes.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 非流式：完整转换后返回
    if (!convertedReq.stream) {
      const fullBody = await proxyRes.text();
      try {
        const parsed = JSON.parse(fullBody);
        const converted = convertResponse(parsed);
        console.log(`  ← 200 (converted non-stream)`);
        return new Response(JSON.stringify(converted), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch {
        return new Response(fullBody, {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // 流式：创建 ReadableStream 做 DTO 转换
    console.log(`  ← 200 (stream converting)`);
    const { readable, writable } = new TransformStream();
    const ctx2 = new AbortController();

    // 后台处理流转换（ctx.waitUntil 保证 Worker 不会在流完成前退出）
    ctx.waitUntil(
      (async () => {
        const writer = writable.getWriter();
        await handleStreamResponse(proxyRes.body, writer);
      })()
    );

    return new Response(readable, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  },
};
