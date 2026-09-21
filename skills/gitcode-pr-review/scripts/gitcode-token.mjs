import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function envAuthorKey(author) {
  return String(author || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/* 服务端令牌库回退：管理员代他人启动监控时，引擎进程 env 只有启动者的令牌，
 * PR 作者的令牌绑在 env-vars.users/<userId>.yaml（平台「🔑 令牌」页绑定）。
 * 扫描全部用户的绑定文件找 GITCODE_TOKEN_<author>——与 AIWeb findAuthorGitcodeToken 同逻辑。
 * 目录不存在（桌面客户端等场景）时返回空，行为不变。 */
function serverTokenForAuthor(author) {
  const key = envAuthorKey(author);
  if (!key) return '';
  try {
    const dir = join(homedir(), '.aceharness', 'data', 'env-vars.users');
    const keyRe = new RegExp(`key:\\s*GITCODE_TOKEN_${key}\\b`);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      try {
        const content = readFileSync(join(dir, file), 'utf8');
        if (!keyRe.test(content)) continue;
        const m = content.match(/key:\s*GITCODE_TOKEN_\S+[\s\S]{0,200}?value:\s*["']?([A-Za-z0-9_\-]+)["']?/);
        if (m && m[1]) return m[1];
      } catch { /* 单文件失败跳过 */ }
    }
  } catch { /* 目录不存在或非 Node 环境（脚本用 ESM）→ 静默 */ }
  return '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const token = String(value || '').trim();
    if (token) return token;
  }
  return '';
}

function perUserTokenNames(authorKey) {
  if (!authorKey) return [];
  return [
    `GITCODE_TOKEN_${authorKey}`,
    `ACE_GITCODE_TOKEN_${authorKey}`,
    `GITCODE_ACCESS_TOKEN_${authorKey}`,
  ];
}

export function hasPerUserGitcodeTokens(env = process.env) {
  return Object.keys(env || {}).some((name) => (
    /^(GITCODE_TOKEN|ACE_GITCODE_TOKEN|GITCODE_ACCESS_TOKEN)_[A-Za-z0-9_]+$/.test(name)
    && String(env[name] || '').trim()
  ));
}

export function resolveGitcodeToken(env = process.env, author = '') {
  const authorKey = envAuthorKey(author);
  if (authorKey) {
    const named = firstNonEmpty(...perUserTokenNames(authorKey).map((name) => env?.[name]));
    if (named) return named;
    // 进程 env 无该作者令牌 → 服务端令牌库回退（管理员代监控场景）
    const serverToken = serverTokenForAuthor(author);
    if (serverToken) return serverToken;
    if (hasPerUserGitcodeTokens(env)) return '';
  }
  return firstNonEmpty(
    env?.GITCODE_TOKEN,
    env?.ACE_GITCODE_TOKEN,
    env?.GITCODE_ACCESS_TOKEN,
  );
}

/* CLI：node gitcode-token.mjs --check-author <login>
 * 退出码 0 = 该作者本人的命名令牌（GITCODE_TOKEN_<login> 系）在环境中可用；
 * 退出码 1 = 不可用。注意：不走 generic（GITCODE_TOKEN）回退——start build 必须由
 * PR 作者本人凭据发出，DCP 会拒绝非 PR 提交人的触发；用别人的 generic 令牌代发必被拒。
 * 供工作流步骤（如编译修复的 env-jitter-retry 通道）做凭据探测。 */
if (process.argv.includes('--print-token')) {
  const idx = process.argv.indexOf('--print-token');
  const author = String(process.argv[idx + 1] || '');
  const token = resolveGitcodeToken(process.env, author);
  if (token) {
    process.stdout.write(token + '\n');
    process.exitCode = 0;
  } else {
    process.stderr.write(JSON.stringify({ author: author || null, error: 'no-token' }) + '\n');
    process.exitCode = 1;
  }
} else if (process.argv.includes('--check-author')) {
  const idx = process.argv.indexOf('--check-author');
  const author = String(process.argv[idx + 1] || '');
  const authorKey = envAuthorKey(author);
  const named = (Boolean(authorKey) && perUserTokenNames(authorKey)
    .some((name) => String(process.env[name] || '').trim()))
    || Boolean(serverTokenForAuthor(author)); // 服务端令牌库绑定也算可用（管理员代监控可推送）
  // 注意用 exitCode 而非 process.exit()：后者会截断尚未 flush 的 stdout
  process.stdout.write(`${JSON.stringify({ author: author || null, named_token_available: named })}\n`);
  process.exitCode = named ? 0 : 1;
}

export function firstAvailableGitcodeToken(env = process.env) {
  const generic = firstNonEmpty(
    env?.GITCODE_TOKEN,
    env?.ACE_GITCODE_TOKEN,
    env?.GITCODE_ACCESS_TOKEN,
  );
  if (generic) return generic;
  for (const [name, value] of Object.entries(env || {})) {
    if (!/^(GITCODE_TOKEN|ACE_GITCODE_TOKEN|GITCODE_ACCESS_TOKEN)_[A-Za-z0-9_]+$/.test(name)) continue;
    const token = String(value || '').trim();
    if (token) return token;
  }
  return '';
}
