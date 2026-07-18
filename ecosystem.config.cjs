/**
 * ACEHarness PM2 进程管理配置
 *
 * 用途：
 *  - 把 Next.js 生产服务（server.js）和 Cloudflare Tunnel 交给 PM2 统一管理
 *  - 设置最大内存阈值，自动 OOM 重启（避免 dev 模式那种悄无声息的崩溃）
 *  - 配置完整 PATH，保证 opencode / hdc / adb 等子命令在 PM2 进程里可用
 *
 * 适用平台：
 *  - macOS（开发 / 临时验证）        ← interpreter 用 /Users/hyh/node22/bin/node
 *  - Windows（最终生产 / 正式部署）  ← interpreter 用 node（系统 PATH 里的 node）
 *    Windows 部署时请参考 README「Windows 部署」一节切换 interpreter 与 cwd 路径
 *
 * 使用：
 *  1. 首次启动： pm2 start ecosystem.config.cjs
 *  2. 保存进程列表： pm2 save
 *  3. 开机自启：
 *     - macOS： pm2 startup    （跟着提示执行 sudo 命令）
 *     - Windows：pm2-startup   （推荐用 nssm 或 pm2-windows-startup）
 *  4. 查看：     pm2 list / pm2 logs
 *  5. 重载配置： pm2 reload ecosystem.config.cjs
 */

const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';
const repoRoot = __dirname;
const home = os.homedir();

// ────────────────────────────────────────────────────────────
// 关键路径（按平台分流）
// ────────────────────────────────────────────────────────────
const nodeInterpreter = isWin
  ? 'node'                                  // Windows：用 PATH 里的 node（>= 20.9）
  : '/Users/hyh/node22/bin/node';           // macOS：DevEco 自带 Node 18 太老，强制用 22

const cloudflaredBin = isWin
  ? (process.env.PATH.split(';')
        .map(p => path.join(p, 'cloudflared.exe'))
        .find(p => {
          try { return require('fs').existsSync(p); } catch { return false; }
        })
     || path.join(home, 'cloudflared.exe')        // 回退：手动下载放用户目录
     || 'cloudflared')                             // 最终回退：交给 PATH 解析
  : '/opt/homebrew/bin/cloudflared';        // macOS brew 安装位置

// opencode SDK 路径（ACE 引擎依赖，PM2 进程里必须能找到）
const extraPathSegments = isWin
  ? [
      path.join(home, 'node22'),
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      'C:\\Program Files\\nodejs',
    ]
  : [
      '/Users/hyh/node22/bin',
      '/Users/hyh/.opencode/bin',
      '/Users/hyh/.npm-global/bin',
      '/Applications/DevEco-Studio.app/Contents/tools/node/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ];

const fullPath = extraPathSegments
  .concat([process.env.PATH || ''])
  .filter(Boolean)
  .join(isWin ? ';' : ':');

// ────────────────────────────────────────────────────────────
// 进程列表
// ────────────────────────────────────────────────────────────
module.exports = {
  apps: [
    {
      name: 'aceharness',
      script: 'server.js',
      args: 'start',
      cwd: repoRoot,
      interpreter: nodeInterpreter,
      exec_mode: 'fork',                  // 关键：server.js 不是 cluster 安全的
      instances: 1,

      // 关键环境变量
      env: {
        NODE_ENV: 'production',
        ACE_HOST: '0.0.0.0',
        ACE_PORT: '3031',
        PATH: fullPath,
      },

      // 资源 / 重启策略
      max_memory_restart: '2G',           // 超过 2G 自动重启，避免 OOM 静默死亡
      autorestart: true,
      restart_delay: 3000,                // 崩溃后等 3 秒再起，避免连环炸
      max_restarts: 20,
      min_uptime: '10s',                  // 启动 10 秒内反复重启就放弃（标记错误）
      kill_timeout: 5000,

      // 日志
      out_file: path.join(repoRoot, 'logs', 'aceharness-out.log'),
      error_file: path.join(repoRoot, 'logs', 'aceharness-error.log'),
      merge_logs: true,
      time: true,
    },

    {
      name: 'cloudflared',
      script: cloudflaredBin,
      args: 'tunnel --config ' + path.join(home, '.cloudflared', 'config.yml') + ' run',
      interpreter: 'none',                // cloudflared 是二进制，不走 node 解释器
      exec_mode: 'fork',
      instances: 1,

      env: {
        PATH: fullPath,
      },

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 30,
      min_uptime: '15s',

      out_file: path.join(repoRoot, 'logs', 'cloudflared-out.log'),
      error_file: path.join(repoRoot, 'logs', 'cloudflared-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
