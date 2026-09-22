import { describe, expect, it } from 'vitest';

describe.skipIf(!process.env.ACE_EMAIL_E2E)('email toggle E2E（AIWeb 开关 → ACEHarness 读取）', () => {
  it('关闭后 ACEHarness 发信被跳过；重新开启后恢复', async () => {
    // 动态 import AIWeb 的开关函数（CommonJS→ESM 边界：用文件内联方式太绕，直接复刻其行为路径）
    const { readFileSync, writeFileSync, renameSync, mkdirSync } = await import('fs');
    const { homedir } = await import('os');
    const { join } = await import('path');
    const file = join(homedir(), '.aceharness', 'data', 'system-settings.yaml');
    const setEnabled = (want: boolean) => {
      const lines = readFileSync(file, 'utf8').split('\n');
      const hit = lines.findIndex((l) => /^\s*enabled:/.test(l));
      lines[hit] = lines[hit].replace(/^(\s*enabled:).*/, `$1 ${want}`);
      const tmp = file + '.toggle-test';
      writeFileSync(tmp, lines.join('\n'), 'utf8');
      renameSync(tmp, file);
    };

    const { sendWorkflowStateEmailNotification } = await import('@/lib/notify/workflow-event-email');
    const { mkdir, writeFile, rm } = await import('fs/promises');
    const { getWorkspaceRunsDir } = await import('@/lib/core/app-paths');
    const ZHANGGONG = 'f7798c97-4ddf-48bf-ab73-199c4618fe82';
    const runId = 'run-toggle-e2e-' + Date.now();
    const runDir = join(getWorkspaceRunsDir(), runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.yaml'), [
      `runId: ${runId}`, 'status: completed', `runOwnerId: ${ZHANGGONG}`,
      'configFile: gitcode-pr-review.yaml',
      'globalContext: |', '  pr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1906', '',
    ].join('\n'), 'utf8');
    const payload = { state: '完成', message: '开关 E2E 验证（AIWeb 按钮闭环测试）', runId, __configFile: 'gitcode-pr-review.yaml' };
    try {

    setEnabled(false);
    const off = await sendWorkflowStateEmailNotification(payload as any);
    expect(off).toMatchObject({ ok: false, reason: 'email-disabled' });

    setEnabled(true);
    const on = await sendWorkflowStateEmailNotification(payload as any);
    expect(on).toEqual({ ok: true });
    console.log('关闭 → reason=email-disabled（跳过）；开启 → ok:true（真实投递到 zhanggong22@huawei.com）');
    } finally { await rm(runDir, { recursive: true, force: true }).catch(() => {}); }
  });
});
