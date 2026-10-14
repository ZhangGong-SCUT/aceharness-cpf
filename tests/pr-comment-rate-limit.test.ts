import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);

test.each(['blocked', 'recovered', 'unreadable'])('start build side effect guard: %s', async kind => {
  let posts = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { posts++; res.end(JSON.stringify({ id: 42 })); return; }
    if (kind === 'unreadable') { res.statusCode = 403; res.end('{}'); return; }
    const comments = [{ user: { login: 'openharmony_ci' }, body: '触发门禁次数已达到上限', created_at: '2026-10-14T10:00:00Z' }];
    if (kind === 'recovered') comments.push({ user: { login: 'openharmony_ci' }, body: '门禁构建开始', created_at: '2026-10-14T11:00:00Z' });
    res.end(JSON.stringify(comments));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'pr-comment-guard-'));
  try {
    const port = (server.address() as { port: number }).port;
    let error: any;
    try {
      await exec(process.execPath, ['skills/gitcode-pr-review/scripts/post-pr-comment.mjs',
        '--owner', 'org', '--repo', 'repo', '--number', '42', '--token', 'fake-test-token', '--out', dir],
      { env: { ...process.env, GITCODE_API_ROOT: `http://127.0.0.1:${port}` }, timeout: 10000 });
    } catch (e) { error = e; }
    expect(posts).toBe(kind === 'recovered' ? 1 : 0);
    if (kind === 'recovered') expect(error).toBeUndefined();
    else expect(error?.code).not.toBe(0);
    if (kind === 'blocked') expect(JSON.parse(await readFile(join(dir, 'pr-comment.json'), 'utf8')))
      .toMatchObject({ ok: false, phase: 'blocked_rate_limit', posted_at: null });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
