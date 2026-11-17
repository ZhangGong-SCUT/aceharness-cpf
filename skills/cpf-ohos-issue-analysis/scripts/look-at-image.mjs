/**
 * GLM 主模型看不了图时的眼睛：把本地图片 + 问题发给视觉模型（默认 Qwen3.7-Plus），
 * 把文字观察返回给调用方。同一张图可以反复调用、换问题追问。
 *
 * CLI:
 *   node look-at-image.mjs --image <path> --question "<具体问题>"
 *
 * MCP stdio:
 *   node look-at-image.mjs mcp
 */
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_VISION_MODEL = 'qwen3.7-plus';
export const DEFAULT_VISION_PROVIDER = '火山AI网关';
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export function guessMimeType(filePath) {
  return MIME_BY_EXT[path.extname(String(filePath || '')).toLowerCase()] || 'image/png';
}

/** 看图结果是锁屏时，这张图不能当证据。调用方看到非 0 退出码后必须重拍。 */
export function isLockScreenObservation(text) {
  return /系统锁屏|当前显示的是\*{0,2}锁屏|lock screen/i.test(String(text || ''));
}

function readJsonIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function opencodeConfigCandidates(env = process.env, home = homedir()) {
  return [
    env.OPENCODE_CONFIG,
    env.OPENCODE_CONFIG_DIR ? path.join(env.OPENCODE_CONFIG_DIR, 'opencode.json') : '',
    path.join(home, '.config', 'opencode', 'opencode.json'),
    env.APPDATA ? path.join(env.APPDATA, 'opencode', 'opencode.json') : '',
  ].filter(Boolean);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

export function resolveVisionEndpoint(env = process.env, home = homedir()) {
  const fromEnv = {
    baseURL: firstNonEmpty(env.VISION_BASE_URL, env.OPENAI_BASE_URL),
    apiKey: firstNonEmpty(env.VISION_API_KEY, env.OPENAI_API_KEY),
    model: firstNonEmpty(env.VISION_MODEL) || DEFAULT_VISION_MODEL,
  };
  if (fromEnv.baseURL && fromEnv.apiKey) return fromEnv;

  for (const configPath of opencodeConfigCandidates(env, home)) {
    const config = readJsonIfExists(configPath);
    const providers = config?.provider && typeof config.provider === 'object' ? config.provider : {};
    const provider = providers[DEFAULT_VISION_PROVIDER] || Object.values(providers)[0];
    const options = provider?.options || {};
    const baseURL = firstNonEmpty(fromEnv.baseURL, options.baseURL);
    const apiKey = firstNonEmpty(fromEnv.apiKey, options.apiKey);
    if (baseURL && apiKey) {
      return {
        baseURL,
        apiKey,
        model: fromEnv.model,
      };
    }
  }

  return fromEnv;
}

export function chatCompletionsUrl(baseURL) {
  const trimmed = String(baseURL || '').replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

export function parseCliArgs(argv) {
  const args = { image: '', question: '', mode: 'cli' };
  const tokens = [...argv];
  if (tokens[0] === 'mcp') {
    args.mode = 'mcp';
    return args;
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token === '--image' || token === '-i') {
      args.image = String(next || '').trim();
      i += 1;
    } else if (token === '--question' || token === '-q') {
      args.question = String(next || '').trim();
      i += 1;
    } else if (token === '--help' || token === '-h') {
      args.mode = 'help';
    } else if (!args.image) {
      args.image = token;
    } else if (!args.question) {
      args.question = token;
    }
  }
  return args;
}

export function encodeImageFile(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  if (!existsSync(resolved)) {
    throw new Error(`图片不存在: ${resolved}`);
  }
  const buffer = readFileSync(resolved);
  if (!buffer.length) {
    throw new Error(`图片为空: ${resolved}`);
  }
  return {
    path: resolved,
    mime: guessMimeType(resolved),
    dataUrl: `data:${guessMimeType(resolved)};base64,${buffer.toString('base64')}`,
  };
}

export function buildVisionMessages(question, dataUrl) {
  const asked = String(question || '').trim() || '请描述这张图里和问题相关的视觉现象。';
  return [
    {
      role: 'system',
      content: [
        '你是诊断流水线里的看图眼睛。调用你的主模型看不见像素，只能读你的文字。',
        '只根据图里实际看见的内容回答，不要根据文件名或 Issue 正文臆造。',
        '回答要具体：控件、文字、颜色、对齐、下划线位置/长短、是否错位。',
        '看不清就直说看不清，不要编。用中文。',
      ].join(''),
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: asked },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ];
}

export async function lookAtImage(options) {
  const question = String(options.question || '').trim();
  const encoded = encodeImageFile(options.image);
  const endpoint = resolveVisionEndpoint(options.env, options.home);
  if (!endpoint.baseURL || !endpoint.apiKey) {
    throw new Error('未配置视觉接口：请设置 VISION_BASE_URL + VISION_API_KEY，或配置 OpenCode 火山AI网关');
  }

  const response = await (options.fetchImpl || fetch)(chatCompletionsUrl(endpoint.baseURL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: endpoint.model || DEFAULT_VISION_MODEL,
      max_tokens: 800,
      messages: buildVisionMessages(question, encoded.dataUrl),
    }),
  });

  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error?.message || raw.slice(0, 400) || `HTTP ${response.status}`;
    throw new Error(`视觉模型请求失败 (${response.status}): ${message}`);
  }

  const text = String(payload?.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    throw new Error('视觉模型没有返回文字内容');
  }
  return {
    model: endpoint.model || DEFAULT_VISION_MODEL,
    image: encoded.path,
    question,
    text,
  };
}

function printHelp() {
  process.stdout.write(`用法:
  node look-at-image.mjs --image <path> --question "<具体问题>"
  node look-at-image.mjs mcp

同一张图可以换问题反复调用。当前模型如果已经能看见图片，请直接 Read 原图，不要调用本工具。
`);
}

export function mcpToolList() {
  return [
    {
      name: 'look_at_image',
      description: '仅在当前模型看不清或看不到图片时，才用 Qwen 看一张本地图片。能看图的模型请直接 Read 原图，不要调用本工具。同一张图可以换问题追问。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地图片路径，png/jpg/jpeg/webp' },
          image: { type: 'string', description: 'path 的别名' },
          question: { type: 'string', description: '要问这张图的具体问题，例如「《》下面的下划线是否对齐」' },
        },
        required: ['question'],
      },
    },
  ];
}

export async function handleMcpToolCall(args = {}) {
  const image = String(args.path || args.image || '').trim();
  const question = String(args.question || '').trim();
  if (!image) throw new Error('缺少 path/image');
  if (!question) throw new Error('缺少 question');
  const result = await lookAtImage({ image, question });
  return [
    `model: ${result.model}`,
    `image: ${result.image}`,
    `question: ${result.question}`,
    '',
    result.text,
  ].join('\n');
}

function writeMcpMessage(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

async function handleMcpRequest(message) {
  const id = message.id;
  const method = String(message.method || '');
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vision-look', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: mcpToolList() } };
  }
  if (method === 'tools/call') {
    try {
      const name = String(message.params?.name || '');
      if (name !== 'look_at_image') throw new Error(`未知工具: ${name}`);
      const text = await handleMcpToolCall(message.params?.arguments || {});
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }] },
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `look_at_image 失败: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        },
      };
    }
  }
  if (id === undefined) return null;
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

async function runMcpServer() {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline).toString('utf8').trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const reply = await handleMcpRequest(message);
        if (reply) writeMcpMessage(reply);
        continue;
      }
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);
      const message = JSON.parse(body);
      const reply = await handleMcpRequest(message);
      if (reply) writeMcpMessage(reply);
    }
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.mode === 'help') {
    printHelp();
    return 0;
  }
  if (args.mode === 'mcp') {
    await runMcpServer();
    return 0;
  }
  if (!args.image || !args.question) {
    printHelp();
    return 1;
  }
  const result = await lookAtImage({ image: args.image, question: args.question });
  process.stdout.write(`${result.text}\n`);
  if (isLockScreenObservation(result.text)) {
    process.stdout.write('evidence=invalid reason=lock_screen\n');
    return 2;
  }
  return 0;
}

const isMain = (() => {
  // R6：realpath 解析符号链接，避免经 .aceharness 链接调用时 main 不执行却 exit 0
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  runCli().then((code) => {
    if (code) process.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
