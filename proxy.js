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
 *   OpenAI 标准: o1/o3/o4 等推理模型的标准字段
 *   CodeBuddy:   DeepSeek 扩展，返回推理过程
 *   转换:        保留（VS Code 可渲染），但注意其产生的大量 thinking
 *                tokens 会全额计入 CodeBuddy 的 completion 计费
 *
 * delta.extra_fields / function_call / refusal:
 *   CodeBuddy 自定义噪音字段 → 删除
 *
 * ═══════════════════════════════════════════════════════════════
 * 注意（2026-08 实测）
 * ═══════════════════════════════════════════════════════════════
 *
 * reasoning_effort / max_tokens / stream 等请求参数一律原样透传，
 * 由客户端（VS Code chatLanguageModels.json）完全决定，代理不干预。
 *
 * 实测结论（供客户端配置参考，不在代理层处理）：
 * - CodeBuddy 将 thinking tokens 全额计入 completion 计费；
 *   reasoning_effort 越高，thinking 越多，积分消耗越大
 * - CodeBuddy 拒绝非流式请求（code 11101），客户端应始终使用 stream: true
 * - 回传 assistant.reasoning_content 不增加 prompt_tokens、不破坏前缀缓存
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// ═══════════════════════════════════════════════════════════════
// .env 文件加载（轻量实现，不引入 dotenv 依赖）
// ═══════════════════════════════════════════════════════════════
// 在 proxy.js 同目录下创建 .env 文件，格式：
//   DEBUG=true
//   CB_PORT=8123
//   LOG_DIR=./logs
//   LOG_REQ_FILE=request.log
//   LOG_RESP_FILE=response.log
// 已存在的系统环境变量优先于 .env（不覆盖）。
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env');
if (existsSync(ENV_PATH)) {
  const envContent = readFileSync(ENV_PATH, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    // 不覆盖已有的系统环境变量
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const PORT = Number(process.env.CB_PORT) || 8123;
const CODEBUDDY_URL = 'https://copilot.tencent.com/v2/chat/completions';

// ─── 日志配置 ───
// DEBUG=true：将请求 body 与 SSE chunk 记录到本地 JSONL 文件；否则不写入任何文件。
// 参照 docker-opencode-proxy 的磁盘日志结构：请求与响应分文件、按天滚动、JSONL 格式。
const DEBUG = process.env.DEBUG === 'true';

// 日志目录（可用 .env 配置）
const LOG_DIR = process.env.LOG_DIR || './logs';
const LOG_DIR_PATH = resolve(__dirname, LOG_DIR);

// 确保日志目录存在
try {
  mkdirSync(LOG_DIR_PATH, { recursive: true });
} catch {
  // 目录创建失败时退化为仅控制台输出
}

/** 获取当天日期字符串 YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 获取当前 ISO 时间戳 */
function nowTs() {
  return new Date().toISOString();
}

/** 异步追加一行 JSON 到指定文件（写失败仅 console.error，不阻塞主流程） */
function appendLineAsync(filePath, data) {
  try {
    appendFileSync(filePath, JSON.stringify(data) + '\n', 'utf8');
  } catch (err) {
    console.error(`[logger] 写入失败: ${filePath}`, err);
  }
}

/**
 * 生成唯一请求 ID（与 docker-opencode-proxy 一致，使用 randomUUID）。
 * @returns {string}
 */
function newRequestId() {
  return randomUUID();
}

/**
 * 在记录原始请求体前脱敏 authorization / x-api-key 字段，避免密钥落盘。
 * @param {string} rawBody 原始请求 JSON 字符串
 * @returns {object} 脱敏后的对象
 */
function redactAuth(rawBody) {
  let obj;
  try {
    obj = JSON.parse(rawBody);
  } catch {
    return {};
  }
  if (obj && typeof obj === 'object') {
    if (obj.authorization) obj.authorization = '<REDACTED>';
    if (obj['x-api-key']) obj['x-api-key'] = '<REDACTED>';
  }
  return obj;
}

/**
 * 将请求元数据 + body 写入 requests-YYYY-MM-DD.jsonl（仅 DEBUG=true 时执行）。
 * 字段与 docker-opencode-proxy 的 logRequestToDisk 完全一致。
 */
function logRequestToDisk(requestId, meta, body) {
  if (!DEBUG) return;
  const filePath = join(LOG_DIR_PATH, `requests-${today()}.jsonl`);
  appendLineAsync(filePath, {
    ts: nowTs(),
    requestId,
    method: meta.method,
    path: meta.path,
    model: meta.model,
    provider: meta.provider,
    stream: meta.stream,
    clientRequestId: meta.clientRequestId,
    body,
  });
}

/**
 * 将单个原始 SSE chunk（data: 后的 JSON 对象）写入 streams-YYYY-MM-DD.jsonl。
 * 字段与 docker-opencode-proxy 的 logStreamChunkToDisk 完全一致。
 */
function logStreamChunkToDisk(requestId, model, chunk) {
  if (!DEBUG) return;
  const filePath = join(LOG_DIR_PATH, `streams-${today()}.jsonl`);
  appendLineAsync(filePath, {
    ts: nowTs(),
    requestId,
    model,
    chunk,
  });
}

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
 *   extra_fields           - CodeBuddy 自定义
 *   refusal                - CodeBuddy 自定义
 *   function_call          - 已废弃
 *   tool_calls: []         - 空数组 = 不应出现
 *
 * reasoning_content 透传保留（VS Code 可渲染；实测不增加计费）。
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

  // reasoning_content → 保留（OpenAI 标准字段，VS Code Copilot 可渲染）
  if (cbDelta.reasoning_content !== undefined && cbDelta.reasoning_content !== null) {
    result.reasoning_content = cbDelta.reasoning_content;
  }
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
 * 请求转换：原样透传客户端请求，不修改任何参数。
 *
 * 保留 tools 和 tool_choice，VS Code Copilot 靠模型返回 tool_calls 来本地执行工具。
 * reasoning_effort、max_tokens、stream 等全部由客户端决定——本代理不做任何
 * 干预，确保客户端的功能完整（例如用户显式选择高思考档位时必须生效）。
 */
function convertRequest(reqBody) {
  return { ...reqBody };
}

/**
 * 检测 CodeBuddy 错误信封（{ code, msg }，code !== 0 表示失败）。
 * 这些错误可能出现在 HTTP 200 的流中，需要识别并转发为 OpenAI 风格错误。
 */
function detectCodeBuddyError(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  if (typeof payload.code === 'number' && payload.code !== 0) {
    return { code: payload.code, msg: typeof payload.msg === 'string' ? payload.msg : String(payload.msg ?? '') };
  }
  return null;
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

  // 生成唯一请求 ID，用于对齐 request.log 与 response.log
  const requestId = newRequestId();
  const rid = `[${requestId}]`;

  const toolCount = requestObj.tools?.length ?? 0;
  // 控制台摘要（始终输出，便于实时监控）
  console.log(`[${rid}] → ${requestObj.model} | stream: ${requestObj.stream} | tools: ${toolCount} | effort: ${requestObj.reasoning_effort ?? '(未设置)'} | max_tokens: ${requestObj.max_tokens ?? '(未设置)'}`);

  // 落盘：原始请求对象（脱敏 authorization 后原样记录），写入 requests-*.jsonl
  logRequestToDisk(requestId, {
    method: req.method,
    path: req.url,
    model: requestObj.model,
    provider: 'codebuddy',
    stream: requestObj.stream === true,
    clientRequestId: req.headers['x-request-id'] || req.headers['client-request-id'] || undefined,
  }, redactAuth(body));

  // 请求原样透传（不修改客户端参数）
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
        console.log(`[${rid}] ← ${proxyRes.statusCode} (error)`);
        // 落盘：原始错误响应写入 streams-*.jsonl
        logStreamChunkToDisk(requestId, requestObj.model, { type: 'error', status: proxyRes.statusCode, body: errorBody });
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(errorBody);
      });
      return;
    }

    // 强制流式后 convertedReq.stream 恒为 true；保留 isStream 判断作为防御
    const isStream = convertedReq.stream === true || convertedReq.stream === undefined;

    if (!isStream) {
      // 非流式：完整接收后转换再返回（正常情况下不会走到这里，
      // 因为 convertRequest 强制 stream: true；保留兜底）
      let fullBody = '';
      proxyRes.on('data', (chunk) => { fullBody += chunk; });
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(fullBody);
          const cbError = detectCodeBuddyError(parsed);
          if (cbError) {
            console.log(`[${rid}] ← ${cbError.code} (CodeBuddy error)`);
            logStreamChunkToDisk(requestId, requestObj.model, { type: 'codebuddy-error', code: cbError.code, msg: cbError.msg });
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `CodeBuddy error ${cbError.code}: ${cbError.msg}` } }));
            return;
          }
          const converted = convertResponse(parsed);
          logStreamChunkToDisk(requestId, requestObj.model, parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(converted));
        } catch {
          logStreamChunkToDisk(requestId, requestObj.model, { type: 'non-streaming-raw', body: fullBody });
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
            // 落盘：原始上游 SSE chunk（data: 后的 JSON 对象），不记录转换后结果
            logStreamChunkToDisk(requestId, requestObj.model, parsed);
            // CodeBuddy 错误信封可能出现在 HTTP 200 的流中
            const cbError = detectCodeBuddyError(parsed);
            if (cbError) {
              console.log(`[${rid}] ← ${cbError.code} (CodeBuddy error in stream)`);
              res.write(`data: ${JSON.stringify({ error: { message: `CodeBuddy error ${cbError.code}: ${cbError.msg}` } })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
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
        const leftover = buffer.trim();
        if (leftover === 'data: [DONE]') {
          res.write('data: [DONE]\n\n');
        } else if (leftover.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(leftover.slice(6));
            const cbError = detectCodeBuddyError(parsed);
            if (cbError) {
              console.log(`[${rid}] ← ${cbError.code} (CodeBuddy error in stream)`);
              res.write(`data: ${JSON.stringify({ error: { message: `CodeBuddy error ${cbError.code}: ${cbError.msg}` } })}\n\n`);
            } else {
              const converted = convertResponse(parsed);
              res.write(`data: ${JSON.stringify(converted)}\n\n`);
            }
          } catch {
            res.write(`${leftover}\n\n`);
          }
        }
      }
      res.end();
      console.log(`[${rid}] ← 200 (stream end)`);
    });

    proxyRes.on('error', (err) => {
      console.log(`[${rid}] ← stream error: ${err.message}`);
      res.end();
    });
  });

  proxyReq.on('error', (err) => {
    console.log(`[${rid}] → request error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
  });

  proxyReq.write(postData);
  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔗 CodeBuddy Proxy (DTO Converter) on http://0.0.0.0:${PORT}`);
  console.log(`   Target: ${CODEBUDDY_URL}`);
  console.log(`   DEBUG: ${DEBUG ? 'ON (请求/响应写入 JSONL 日志)' : 'OFF (不写磁盘日志，设置 DEBUG=true 开启)'}`);
  console.log(`   LOG: ${join(LOG_DIR_PATH, 'requests-YYYY-MM-DD.jsonl')}`);
  console.log(`        ${join(LOG_DIR_PATH, 'streams-YYYY-MM-DD.jsonl')}`);
  console.log('');
});
