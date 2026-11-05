/**
 * middleware/euBlocker.js — 欧盟 IP 访问拦截中间件
 *
 * 职责：
 *  1. 获取客户端真实 IP
 *  2. 查询 IP 归属国家（ip-api.com 免费 API，无需 key）
 *  3. 若归属欧盟成员国，拦截并返回提示页面
 *
 * 设计要点：
 *  - 内存缓存 + 并发去重：同一 IP 只查询一次，避免 API 限流（ip-api 免费 45 次/分钟）
 *  - 本地/私有 IP 直接放行，不影响开发调试
 *  - API 异常时 fail-open（允许访问），避免误封合法用户
 *  - 响应内容纯 HTML，不依赖前端 JS
 */

const http = require('http');

// ── 欧盟 27 国 ISO-3166 alpha-2 代码 ──────────────────────────────────────
// 来源：https://european-union.europa.eu/principles-countries-history/countries-eu_en
const EU_COUNTRY_CODES = new Set([
    'AT', // 奥地利
    'BE', // 比利时
    'BG', // 保加利亚
    'HR', // 克罗地亚
    'CY', // 塞浦路斯
    'CZ', // 捷克
    'DK', // 丹麦
    'EE', // 爱沙尼亚
    'FI', // 芬兰
    'FR', // 法国
    'DE', // 德国
    'GR', // 希腊
    'HU', // 匈牙利
    'IE', // 爱尔兰
    'IT', // 意大利
    'LV', // 拉脱维亚
    'LT', // 立陶宛
    'LU', // 卢森堡
    'MT', // 马耳他
    'NL', // 荷兰
    'PL', // 波兰
    'PT', // 葡萄牙
    'RO', // 罗马尼亚
    'SK', // 斯洛伐克
    'SI', // 斯洛文尼亚
    'ES', // 西班牙
    'SE', // 瑞典
]);

// ── 拦截页面 HTML ────────────────────────────────────────────────────────
const BLOCKED_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>访问受限</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #f5f5f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .blocked-card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      padding: 48px 64px;
      text-align: center;
      max-width: 560px;
    }
    .blocked-icon {
      font-size: 64px;
      margin-bottom: 24px;
    }
    .blocked-title {
      font-size: 24px;
      font-weight: 600;
      color: #333;
      margin-bottom: 16px;
    }
    .blocked-message {
      font-size: 16px;
      color: #666;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="blocked-card">
    <div class="blocked-icon">🚫</div>
    <div class="blocked-title">访问受限</div>
    <div class="blocked-message">当前网页无法向欧盟 IP 提供服务</div>
  </div>
</body>
</html>`;

// ── IP 缓存：Map<ip, {country, ts}> ───────────────────────────────────────
// 缓存 TTL：24 小时（国家归属很少变化）
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ipCache = new Map();

// ── 并发去重：同一 IP 并发请求只发一次 API 查询 ──────────────────────────
const pendingQueries = new Map();

/**
 * 判断是否为本地/私有 IP，这类 IP 直接放行
 */
function isPrivateIP(ip) {
    if (!ip || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    // 去掉 ::ffff: 前缀
    const v4 = ip.replace(/^::ffff:/, '');
    if (v4 === '127.0.0.1' || v4 === 'localhost') return true;
    const parts = v4.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
}

/**
 * 查询 IP 归属国家代码
 * 使用 ip-api.com 免费 API（无需 key，45 次/分钟限制）
 * @returns {Promise<string|null>} ISO-3166 alpha-2 国家代码，查询失败返回 null
 */
function queryCountryCode(ip) {
    // 检查缓存
    const cached = ipCache.get(ip);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return Promise.resolve(cached.country);
    }

    // 并发去重
    if (pendingQueries.has(ip)) {
        return pendingQueries.get(ip);
    }

    const promise = new Promise((resolve) => {
        const url = `http://ip-api.com/json/${ip}?fields=status,countryCode`;
        const req = http.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status === 'success' && json.countryCode) {
                        ipCache.set(ip, { country: json.countryCode, ts: Date.now() });
                        resolve(json.countryCode);
                    } else {
                        // API 返回失败（如限流），fail-open
                        resolve(null);
                    }
                } catch (_) {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });

    pendingQueries.set(ip, promise);
    promise.finally(() => pendingQueries.delete(ip));
    return promise;
}

/**
 * 获取客户端真实 IP
 * 支持 X-Forwarded-For / X-Real-IP（反向代理场景）
 */
function getClientIP(req) {
    // 只信任 Express 根据配置的可信代理链解析出的 IP。直接读取请求头会让
    // 客户端自行伪造 X-Forwarded-For / X-Real-IP 绕过地区限制。
    return req.ip || req.socket?.remoteAddress || '';
}

/**
 * Express 中间件：欧盟 IP 拦截
 *
 * 用法：
 *   const euBlocker = require('./middleware/euBlocker');
 *   app.use(euBlocker);
 */
const euBlocker = async (req, res, next) => {
    try {
        const ip = getClientIP(req);

        // 本地/私有 IP 直接放行
        if (isPrivateIP(ip)) {
            return next();
        }

        const countryCode = await queryCountryCode(ip);

        // 查询失败 → fail-open（不拦截）
        if (!countryCode) {
            return next();
        }

        // 欧盟 IP → 拦截
        if (EU_COUNTRY_CODES.has(countryCode)) {
            console.log(`[EU Blocker] 拦截欧盟 IP: ${ip} (${countryCode})`);
            return res.status(403).type('html').send(BLOCKED_HTML);
        }

        next();
    } catch (err) {
        // 任何异常 → fail-open
        console.error('[EU Blocker] 中间件异常:', err.message);
        next();
    }
};

module.exports = euBlocker;
