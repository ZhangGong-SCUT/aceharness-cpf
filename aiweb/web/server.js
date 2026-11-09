/**
 * web/server.js — 前端开发服务器
 *
 * 职责：
 *  1. 托管 public/ 下的静态文件（index.html、CSS、JS）
 *  2. 将 /api/* 请求反向代理到后端 Server（默认 http://localhost:3000）
 *  3. SSE 事件流透传（不缓冲）
 *
 * 启动：
 *   node server.js
 *   API_SERVER=http://localhost:3000 PORT=8080 node server.js
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const http     = require('http');
const https    = require('https');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT       = parseInt(process.env.PORT || '8080', 10);
const API_TARGET = process.env.API_SERVER || 'http://localhost:3000';

async function requirePlatformUser(req, res, next) {
    const authorization = req.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: '请先登录' });
    }
    try {
        const response = await fetch(new URL('/api/pr-review/me', API_TARGET), {
            headers: { Authorization: authorization },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return res.status(response.status === 401 ? 401 : 503).json({ success: false, message: response.status === 401 ? '登录已过期' : '无法验证登录状态' });
        const result = await response.json();
        if (!result?.user) return res.status(401).json({ success: false, message: '登录已过期' });
        req.platformUser = result.user;
        next();
    } catch {
        res.status(503).json({ success: false, message: '无法验证登录状态' });
    }
}

const app = express();
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || '0', 10);
if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) app.set('trust proxy', trustProxyHops);

// ── 欧盟 IP 访问拦截（最前置，所有路由之前） ──────────────────────────────
// 欧盟 IP 访问时返回 403 + 提示页面，不进入后续路由
const euBlocker = require('./middleware/euBlocker');
app.use(euBlocker);

// ── JSON 请求体解析（TAG 等内嵌模块需要） ────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── GitCode 打 TAG 系统 ──────────────────────────────────────────────────
// A05：页面路由必须先于 app.use 中间件注册。
// app.use('/tag', requirePlatformUser, …) 也会匹配精确的 /tag 路径，
// 若页面路由在其后，匿名打开 /tag 会直接收到 401 JSON，而不是进入页面再引导登录。
// 页面路由只匹配精确的 /tag（或 /TAG），/tag/list 等 API 子路径仍由下方中间件鉴权。
app.get(/^\/[tT][aA][gG]$/, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'TAG', 'public', 'index.html'));
});

// API 路由：/tag/* → TAG/router.js（注入依赖，避免 TAG 内部 require 外部模块）
const { createTagRouter } = require('../TAG/router');
const Database = require('better-sqlite3');
app.use('/tag', requirePlatformUser, createTagRouter({ express, Database }));

// ── PR 检视意见批量解决系统 ────────────────────────────────────────────────
// A05：同 TAG，页面路由先注册（只匹配精确的 /prcheck 或 /PrCheck）
app.get(/^\/[pP][rR][cC]heck$/, (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'PrCheck', 'public', 'index.html'));
});

const { createPrCheckRouter } = require('../PrCheck/router');
app.use('/prcheck', requirePlatformUser, createPrCheckRouter({ express, Database }));

// ── 环境检测 API（C++ 移植按钮状态） ──────────────────────────────────────
// 必须挂在代理之前，否则会被代理到后端
app.get('/api/cpp/env-check', (_req, res) => {
    const platform = process.platform; // 'win32' | 'darwin' | 'linux'
    const isWindows = platform === 'win32';
    const dataPath = '/data/tpc_c_cplusplus';
    let dataDirExists = false;
    if (!isWindows) {
        try { dataDirExists = fs.existsSync(dataPath); } catch (_) { /* ignore */ }
    }
    const canStart = !isWindows && dataDirExists;
    res.json({
        success: true,
        platform,
        isWindows,
        dataDirExists,
        dataPath,
        canStart,
        reason: isWindows ? 'Windows 暂不支持' : (!dataDirExists ? '环境未搭建' : null),
    });
});

// 本地个人部署打开即工作台。公网部署仍从登录页进入。
const localDeployment = process.env.AIWEB_DEPLOYMENT === 'personal';

// ── 静态文件：public/ 目录 ──────────────────────────────────────────────────
// CSS/图片缓存 1 天；JS 使用协商缓存，避免继续运行旧的状态与决策逻辑。
// HTML 文档保持协商缓存（etag/last-modified），保证功能更新即时生效
app.use('/css', express.static(path.join(__dirname, 'public', 'css'), { maxAge: '1d' }));
app.use('/js', express.static(path.join(__dirname, 'public', 'js'), { maxAge: 0, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/img', express.static(path.join(__dirname, 'public', 'img'), { maxAge: '1d' }));

// ── HTML 自动版本化：按文件 mtime 重写 ?v= 参数 ────────────────────────────
// 防止"改了 JS/CSS 忘了 bump 版本号"导致浏览器/Cloudflare 拿旧缓存（2026-09-10 事故）：
// HTML 每次请求动态把 js/xxx.js?v=… 替换为 js/xxx.js?v=<该文件当前 mtime>，文件一变 URL 自动变。
app.use((req, res, next) => {
  if (!/\.html$/.test(req.path) && req.path !== '/') return next();
  let file = req.path === '/' ? (localDeployment ? 'index.html' : 'login.html') : req.path.slice(1);
  if (localDeployment && file === 'login.html') file = 'index.html';
  const full = path.join(__dirname, 'public', file);
  fs.readFile(full, 'utf8', (err, html) => {
    if (err) return next();
    const rewritten = html.replace(/((?:js|css)\/[\w.-]+\.(?:js|css))(?:\?v=\w*)?/g, (m, p) => {
      try { return `${p}?v=${fs.statSync(path.join(__dirname, 'public', p)).mtimeMs.toString(36)}`; }
      catch { return m; }
    });
    res.type('html').send(rewritten);
  });
});
app.use(express.static(path.join(__dirname, 'public')));

// ── 反向代理：/api/* → 后端 Server ─────────────────────────────────────────
// 注意：用 pathFilter 挂在根路径，避免 Express 剥掉 /api 前缀导致后端 404
app.use(createProxyMiddleware({
    pathFilter:   '/api',
    target:       API_TARGET,
    changeOrigin: true,
    // ─── 超时保护：防止后端阻塞时代理层无限等待 ──────────────────────────────
    // proxyTimeout：等待后端响应的最长时间（60s）
    // timeout：整个代理连接的最长空闲时间（120s，留足 SSE 心跳间隔余量）
    //   SSE 连接不受此限制 —— http-proxy 对 text/event-stream 不会触发 socket 超时
    proxyTimeout: 60000,
    timeout:      120000,
    // SSE 必须关闭缓冲
    on: {
        proxyReq: (proxyReq, req) => {
            proxyReq.setHeader('Accept-Encoding', 'identity');

            // ─── 修复：express.json() 已消费请求流，需手动重建请求体 ──────────
            // express.json() 在代理中间件之前执行，已将请求流读入 req.body，
            // 导致 http-proxy 转发时原始流为空，后端无限等待 → POST 请求超时。
            // 解决方案：如果 req.body 存在，将其序列化后重新写入代理请求。
            // 空对象 {} 也要写回去。只判断「有字段」时，继续分析这类空请求体会被吃掉，
            // 后端按 Content-Length 一直等正文，直到浏览器 30 秒断开。
            if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
                const bodyData = JSON.stringify(req.body);
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
        },
        proxyRes: (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
                proxyRes.headers['cache-control']     = 'no-cache';
                proxyRes.headers['x-accel-buffering'] = 'no';
            }
        },
        error: (err, _req, res) => {
            console.error('[Proxy Error]', err.message);
            if (!res.headersSent) {
                res.status(502).json({ success: false, message: `无法连接后端服务 ${API_TARGET}：${err.message}` });
            }
        },
    },
}));

// ── SPA 兜底：非 /api 路由统一返回 index.html ──────────────────────────────
// Express 5 / path-to-regexp v8 不再支持裸 *，改用正则
app.get(/^(?!\/api\/|\/tag\/|\/prcheck\/).*$/, (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// HOST 环境变量支持（默认 0.0.0.0 与历史行为一致；桌面客户端传 127.0.0.1 仅本机可达）
app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`[Web Server] 已启动：http://localhost:${PORT}`);
    console.log(`[Web Server] 后端代理：${API_TARGET}`);
});
