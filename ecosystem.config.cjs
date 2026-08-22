/**
 * ACEHarness PM2 进程管理配置
 *
 * 用途：
 *  - 把 Next.js 生产服务（server.js）和 Cloudflare Tunnel 交给 PM2 统一管理
 *  - 设置最大内存阈值，自动 OOM 重启（避免 dev 模式那种悄无声息的崩溃）
 *  - 配置完整 PATH，保证 opencode / hdc / adb 等子命令在 PM2 进程里可用
 *
 * 适用平台：
 *  - macOS（开发 / 临时验证）        ← interpreter 优先用环境变量 ACE_NODE_BIN，回退 ~/.nodebrew/current/bin/node 或 nvm current
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
  : (process.env.ACE_NODE_BIN
      || path.join(home, '.nodebrew', 'current', 'bin', 'node')
      || 'node');                            // macOS：DevEco 自带 Node 18 太老，强制用 22+；通过 ACE_NODE_BIN 注入

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
// 策略：优先从登录 shell 动态读取完整 PATH（包含 .zshrc/.zprofile 中配置的所有路径），
//       回退到硬编码的关键路径（确保即使 shell 读取失败也能找到核心工具）。
const { execSync } = require('child_process');

/**
 * 从登录 shell 动态读取完整 PATH（跨平台：macOS / Linux / Windows）
 *
 * 原理：pm2 从非交互式 shell 启动时，process.env.PATH 只有最小化系统路径，
 *       不包含用户 shell 配置文件（.zshrc / .bashrc / .profile 等）中配置的路径。
 *       本函数通过启动一个登录 shell 并执行 echo $PATH，获取用户配置的完整 PATH。
 *
 * 平台兼容：
 *   - macOS/Linux：通过 $SHELL 或 /etc/passwd 中的默认 shell（zsh/bash/sh），
 *                  使用 -l -i -c 'echo $PATH' 读取 .zshrc/.zprofile/.bashrc/.bash_profile
 *   - Windows：通过 cmd.exe 读取注册表中的用户 PATH（HKCU\Environment）和系统 PATH（HKLM\...\Session Manager\Environment），
 *              因为 Windows 没有 shell 配置文件，PATH 存储在注册表中
 */
function readShellPath() {
  // ── Windows：从注册表读取用户级 + 系统级 PATH ──
  if (isWin) {
    try {
      // 读取用户级 PATH（HKCU\Environment）
      const userPath = execSync(
        'reg query "HKCU\\Environment" /v PATH 2>nul',
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).split('\n').find(l => l.includes('PATH'))?.split('REG_EXPAND_SZ')[1]?.trim()
        || execSync(
          'reg query "HKCU\\Environment" /v PATH 2>nul',
          { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).split('\n').find(l => l.includes('PATH'))?.split('REG_SZ')[1]?.trim()
        || '';
      // 读取系统级 PATH（HKLM\...\Session Manager\Environment）
      const sysPath = execSync(
        'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v PATH 2>nul',
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).split('\n').find(l => l.includes('PATH'))?.split('REG_EXPAND_SZ')[1]?.trim()
        || '';
      // 合并用户级 + 系统级（用户级优先）
      return [userPath, sysPath].filter(Boolean).join(';');
    } catch {
      return '';
    }
  }

  // ── macOS / Linux：从登录 shell 读取 PATH ──
  try {
    // 优先用 $SHELL 环境变量，回退到 /etc/passwd 中的默认 shell，最终回退到 sh
    let shell = process.env.SHELL;
    if (!shell) {
      try {
        // 从 /etc/passwd 读取用户的默认 shell
        const passwd = execSync(`getent passwd ${process.env.USER || process.env.LOGNAME || ''}`, {
          encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        shell = passwd.split(':')[6];  // 第 7 字段是 shell
      } catch { /* ignore */ }
    }
    shell = shell || '/bin/sh';  // 最终回退

    // -l: 登录 shell（加载 .zprofile / .bash_profile / .profile）
    // -i: 交互式 shell（加载 .zshrc / .bashrc）
    // -c: 执行命令
    // 注意：sh 不支持 -i，需要判断
    const isInteractive = !shell.endsWith('/sh');
    const flags = isInteractive ? '-l -i -c' : '-l -c';
    const result = execSync(`"${shell}" ${flags} 'echo $PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,  // 5 秒超时，避免 shell 启动卡住
      stdio: ['pipe', 'pipe', 'pipe'],  // 静默 stderr（避免 .zshrc 的输出干扰）
    }).trim();
    return result;
  } catch {
    // shell 读取失败时返回空，回退到硬编码路径
    return '';
  }
}

// 动态读取的 shell PATH（包含用户 .zshrc/.zprofile 中配置的所有路径）
const shellPath = readShellPath();

// 硬编码的回退路径（当 shell PATH 读取失败时使用，确保核心工具可用）
const fallbackPathSegments = isWin
  ? [
      path.join(home, 'node22'),
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      'C:\\Program Files\\nodejs',
    ]
  : [
      // 通过环境变量注入用户级路径，避免硬编码 /Users/<user>/...
      process.env.ACE_NODE_BIN_DIR,
      path.join(home, '.opencode', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      // DevEco Studio 完整工具链（hdc / hvigor / ohpm / node）
      '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains',
      '/Applications/DevEco-Studio.app/Contents/tools/node/bin',
      '/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin',
      '/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin',
      // Flutter SDK
      path.join(home, 'Desktop', 'FlutterProject', 'FlutterConfig', 'flutter', 'bin'),
      // Java / Android SDK
      '/opt/homebrew/opt/openjdk@17/bin',
      path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'),
      // 系统级路径
      '/usr/local/bin',
      '/opt/homebrew/bin',
    ].filter(Boolean);

// 最终 PATH：优先用 shell 动态读取的 PATH，拼接回退路径和当前 process.env.PATH
// 跨平台：Windows 从注册表读取，macOS/Linux 从登录 shell 读取
const fullPath = (shellPath ? [shellPath] : fallbackPathSegments)
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
      node_args: '--max-old-space-size=8192',  // 与 package.json start 脚本一致，PM2 默认不传该参数会导致 V8 heap limit 仅 4GB
      exec_mode: 'fork',                  // 关键：server.js 不是 cluster 安全的
      instances: 1,

      // 关键环境变量
      env: {
        NODE_ENV: 'production',
        ACE_HOST: '0.0.0.0',
        ACE_PORT: '3031',
        ACE_MANAGED: '1',                 // 受管模式：内存看门狗触发时主动重启，避免 V8 OOM 硬杀
        PATH: fullPath,
      },

      // 资源 / 重启策略
      max_memory_restart: '6G',           // opencode SDK 流式响应 + 大仓 git 输出缓冲需要较高内存阈值，2G 会导致工作流被频繁打断
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
