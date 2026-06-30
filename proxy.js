/**
 * CodeBuddy → VS Code Copilot 代理服务器（DTO 转换版）
 *
 * CodeBuddy API 返回的 DTO 与 OpenAI 标准格式有差异，本代理做格式转换。
 *
 * ═══════════════════════════════════════════════════════════════
 * 差异对照表（CodeBuddy vs OpenAI 标准 vs VS Code Copilot 需要）
 * ═══════════════════════════════════════════════════════════════
 *
 * finish_reason:
 *   OpenAI 标准: "stop" | "tool_calls" | "length" | null
 *   CodeBuddy:   "" (空字符串)
 *   转换:        "" → null (进行中), 末尾补 "stop" (结束时)
 *
 * delta.tool_calls:
 *   OpenAI 标准: 不调用工具时不出现该字段
 *   CodeBuddy:   始终返回 [] 空数组
 *   转换:        [] → 删除该字段
 *
 * delta.reasoning_content:
 *   OpenAI 标准: o1/o3 系列用，普通模型不返回
 *   CodeBuddy:   DeepSeek 扩展，返回推理过程
 *   转换:        VS Code Copilot 不支持 reasoning 渲染，
 *                无法直接展示 thinking 内容
 *
 * delta.extra_fields:
 *   OpenAI 标准: 不存在
 *   CodeBuddy:   null
 *   转换:        删除
 *
 * delta.function_call:
 *   OpenAI 标准: 已废弃（被 tool_calls 取代）
 *   CodeBuddy:   null
 *   转换:        删除
 *
 * delta.refusal:
 *   OpenAI 标准: 不存在
 *   CodeBuddy:   ""
 *   转换:        删除
 *
 * choice.logprobs:
 *   OpenAI 标准: 可选
 *   CodeBuddy:   null
 *   转换:        null 时删除
 *
 * usage:
 *   OpenAI 标准: 可选
 *   CodeBuddy:   null
 *   转换:        null 时删除
 *
 * ═══════════════════════════════════════════════════════════════
 * 注意：thinking / reasoning 内容的限制
 * ═══════════════════════════════════════════════════════════════
 *
 * VS Code Copilot 的 customendpoint 解析器只认：
 *   - delta.content (文本)
 *   - delta.tool_calls (工具调用)
 *
 * CodeBuddy 的 reasoning_content 是 DeepSeek 扩展字段，
 * VS Code Copilot 无法渲染 thinking/reasoning 内容。
 * 如果模型同时返回 reasoning + content，用户只能看到 content 部分。
 * 想看到 thinking 输出，需要在终端用 simple-chat.js 直接调用。
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const PORT = 8123;
const CODEBUDDY_URL = 'https://copilot.tencent.com/v2/chat/completions';

// ─── OpenAI 标准 finish_reason 值 ───
const VALID_FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter', null]);

/**
 * CodeBuddy Delta → OpenAI Delta
 *
 * OpenAI Delta 字段：
 *   content?: string      - 文本内容（可逐 chunk 递增）
 *   role?: string         - "assistant"（仅首条）
 *   tool_calls?: Array    - 工具调用（有实际内容时才出现）
 *   function_call?: ...   - 已废弃
 *
 * CodeBuddy 额外字段（需删除）：
 *   reasoning_content     - DeepSeek 扩展，VS Code 不渲染
 *   extra_fields           - CodeBuddy 自定义
 *   refusal                - CodeBuddy 自定义
 *   function_call          - 已废弃
 *   tool_calls: []         - 空数组 = 不应出现
 */
function convertDelta(cbDelta) {
  if (!cbDelta) return {};

  const result = {};

  // content：核心文本，直接保留
  if (cbDelta.content !== undefined && cbDelta.content !== null) {
    result.content = cbDelta.content;
  }

  // role：首条消息携带，保留
  if (cbDelta.role !== undefined) {
    result.role = cbDelta.role;
  }

  // tool_calls：流式模式下跨多个 chunk 累积
  // 流式格式示例：
  //   chunk 1: {"tool_calls": [{"index": 0, "id": "call_abc", "type": "function", "function": {"name": "read_file"}}]}
  //   chunk 2: {"tool_calls": [{"index": 0, "function": {"arguments": "{\"file"}}]}
  //   chunk 3: {"tool_calls": [{"index": 0, "function": {"arguments": "Pa"}}]}
  //
  // VS Code Copilot 自己做累积拼接，我们只管透传。
  // 空数组 [] 不添加，有内容时直接透传原始对象（不做 id/type 补全）
  if (Array.isArray(cbDelta.tool_calls) && cbDelta.tool_calls.length > 0) {
    result.tool_calls = cbDelta.tool_calls;
  }
  // 空数组 [] → 不添加（CodeBuddy 的默认空工具调用）

  // reasoning_content → 删除（VS Code Copilot 不支持渲染 reasoning）
  // function_call → 删除（OpenAI 已废弃）
  // refusal → 删除（非标准字段）
  // extra_fields → 删除（CodeBuddy 自定义字段）

  return result;
}

/**
 * CodeBuddy Choice → OpenAI Choice
 *
 * OpenAI Choice 字段：
 *   index: number
 *   delta?: Delta        - 流式
 *   message?: Message    - 非流式
 *   finish_reason: "stop" | "tool_calls" | "length" | null
 *   logprobs?: object | null
 *
 * CodeBuddy 问题：
 *   finish_reason: "" → 非标准空字符串
 *   logprobs: null → OpenAI 规范中 null 不应序列化
 */
function convertChoice(cbChoice) {
  const result = { index: cbChoice.index ?? 0 };

  // delta（流式响应）
  if (cbChoice.delta) {
    result.delta = convertDelta(cbChoice.delta);
  }

  // message（非流式响应）
  if (cbChoice.message) {
    result.message = {
      role: cbChoice.message.role ?? 'assistant',
      content: cbChoice.message.content ?? null,
    };
  }

  // finish_reason 转换：
  // CodeBuddy 返回 "" (空字符串) 用于中间 chunk
  // OpenAI 标准：中间 chunk 用 null，最后一条用 "stop"
  // 如果 CodeBuddy 最后一条也是 ""，转为 "stop"
  if (VALID_FINISH_REASONS.has(cbChoice.finish_reason)) {
    result.finish_reason = cbChoice.finish_reason;
  } else if (cbChoice.finish_reason === '' || cbChoice.finish_reason === undefined) {
    result.finish_reason = null; // 进行中
  } else {
    result.finish_reason = null; // 未知值也转 null
  }

  // logprobs：null 不应出现在 OpenAI 响应中
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

  // 顶层字段
  if (cbData.id !== undefined) result.id = cbData.id;
  if (cbData.model !== undefined) result.model = cbData.model;
  if (cbData.object !== undefined) result.object = cbData.object;
  if (cbData.created !== undefined) result.created = cbData.created;

  // choices 转换
  if (Array.isArray(cbData.choices)) {
    result.choices = cbData.choices.map(convertChoice);
  }

  // usage：非 null 时才保留
  if (cbData.usage != null) {
    result.usage = cbData.usage;
  }

  return result;
}

/**
 * 请求转换：
 * 保留 tools 和 tool_choice，VS Code Copilot 靠模型返回 tool_calls 来本地执行工具。
 * 不依赖 GitHub Copilot 自带模型——其他本地模型（如 Ollama）也能正常调用工具。
 */
function convertRequest(reqBody) {
  return { ...reqBody };
}

// ─── HTTP 服务器 ───
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  // 收集请求体
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }

  let requestObj;
  try {
    requestObj = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
    return;
  }

  const toolCount = requestObj.tools?.length ?? 0;
  console.log(`[${new Date().toISOString()}] → ${requestObj.model} | stream: ${requestObj.stream} | tools: ${toolCount}`);

  // DTO 转换请求
  const convertedReq = convertRequest(requestObj);

  // 构建转发请求
  const url = new URL(CODEBUDDY_URL);
  const headers = { 'Content-Type': 'application/json' };

  const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
  if (authHeader) {
    headers['Authorization'] = authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`;
  }

  const postData = JSON.stringify(convertedReq);

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    headers: { ...headers, 'Content-Length': Buffer.byteLength(postData) },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      let errorBody = '';
      proxyRes.on('data', (chunk) => { errorBody += chunk; });
      proxyRes.on('end', () => {
        console.log(`  ← ${proxyRes.statusCode} (error)`);
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(errorBody);
      });
      return;
    }

    const isStream = convertedReq.stream;

    if (!isStream) {
      // 非流式：完整接收后转换再返回
      let fullBody = '';
      proxyRes.on('data', (chunk) => { fullBody += chunk; });
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(fullBody);
          const converted = convertResponse(parsed);
          console.log(`  ← 200 (converted non-stream)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(converted));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(fullBody);
        }
      });
      return;
    }

    // 流式：逐行做 DTO 转换
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let buffer = '';

    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      let lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '') {
          res.write('\n');
          continue;
        }

        if (trimmed === 'data: [DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          try {
            const parsed = JSON.parse(jsonStr);
            const converted = convertResponse(parsed);
            res.write(`data: ${JSON.stringify(converted)}\n\n`);
          } catch {
            // JSON 解析失败，透传原始
            res.write(`${trimmed}\n\n`);
          }
        } else {
          res.write(`${trimmed}\n`);
        }
      }
    });

    proxyRes.on('end', () => {
      if (buffer.trim()) {
        if (buffer.trim() === 'data: [DONE]') {
          res.write('data: [DONE]\n\n');
        } else if (buffer.trim().startsWith('data: ')) {
          try {
            const parsed = JSON.parse(buffer.trim().slice(6));
            const converted = convertResponse(parsed);
            res.write(`data: ${JSON.stringify(converted)}\n\n`);
          } catch {
            res.write(`${buffer.trim()}\n\n`);
          }
        }
      }
      res.end();
      console.log(`  ← 200 (stream converted)`);
    });

    proxyRes.on('error', (err) => {
      console.error(`  ← stream error: ${err.message}`);
      res.end();
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`  → request error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
  });

  proxyReq.write(postData);
  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔗 CodeBuddy Proxy (DTO Converter) on http://0.0.0.0:${PORT}`);
  console.log(`   Target: ${CODEBUDDY_URL}\n`);
});
