import { describe, expect, test } from 'vitest';
import {
  buildThreadHeaders,
  buildWorkflowEmailSubject,
  extractPrIdentityFromContext,
  resolveEmailThreadKey,
} from '@/lib/notify/email-thread';

describe('extractPrIdentityFromContext / resolveEmailThreadKey', () => {
  test('从 globalContext 提取 PR 身份（merge_requests 形式）', () => {
    const ctx = 'owner: CPF-Flutter\nrepo: flutter_flutter\npr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1906';
    expect(extractPrIdentityFromContext(ctx)).toBe('cpf-flutter/flutter_flutter#1906');
  });

  test('PR 身份优先于 runId：同一 PR 的多波 run 归入同一线程', () => {
    const ctx = 'pr_url: https://gitcode.com/CPF-Flutter/flutter_flutter/pulls/1913';
    expect(resolveEmailThreadKey({ runId: 'run-a', globalContext: ctx }))
      .toBe(resolveEmailThreadKey({ runId: 'run-b', globalContext: ctx }));
    expect(resolveEmailThreadKey({ runId: 'run-a', globalContext: ctx })).toBe('pr-cpf-flutter/flutter_flutter#1913');
  });

  test('没有 PR 时按 runId 成线程；两者都没有则不加线程', () => {
    expect(resolveEmailThreadKey({ runId: 'run-x', globalContext: '' })).toBe('run-run-x');
    expect(resolveEmailThreadKey({ runId: '', globalContext: '' })).toBe('');
  });
});

describe('buildThreadHeaders', () => {
  test('首封是根（自带 References=根ID，抗中继 Message-ID 改写），后续邮件挂回根', () => {
    const first = buildThreadHeaders('pr-rootref-t1', 'smtp.example.com');
    expect(first.messageId).toBe(first.threadRootId);
    expect(first.inReplyTo).toBeUndefined();
    // 首封也带 References（自指）：QQ 等中继改写 Message-ID 后，全线程仍共享同一 References
    expect(first.references).toBe(first.threadRootId);

    const second = buildThreadHeaders('pr-rootref-t1', 'smtp.example.com');
    expect(second.messageId).not.toBe(first.messageId);
    expect(second.inReplyTo).toBe(first.threadRootId);
    expect(second.references).toBe(first.threadRootId);

    const third = buildThreadHeaders('pr-rootref-t1', 'smtp.example.com');
    expect(third.inReplyTo).toBe(first.threadRootId);
  });

  test('不同线程互不影响；空线程键退化为随机 Message-ID（独立邮件）', () => {
    const a = buildThreadHeaders('pr-a#1', 'smtp.example.com');
    const b = buildThreadHeaders('pr-b#2', 'smtp.example.com');
    expect(a.threadRootId).not.toBe(b.threadRootId);

    const lone = buildThreadHeaders('', 'smtp.example.com');
    expect(lone.threadRootId).toBe('');
    expect(lone.inReplyTo).toBeUndefined();
  });

  test('Message-ID 本地部分被清洗成合法字符', () => {
    const root = buildThreadHeaders('pr-CPF_Flutter/x#19', 'smtp.qq.com');
    expect(root.messageId).toMatch(/^<ace-[a-z0-9._-]+@smtp\.qq\.com>$/);
  });

  test('Thread-Index：根 22 字节、子 27 字节且共享前 22 字节（Outlook 归组依据）', () => {
    // 模块级 sentThreadRoots 有状态：用例间用独立键隔离
    const root = buildThreadHeaders('pr-threadidx-t1', 'smtp.example.com');
    const child = buildThreadHeaders('pr-threadidx-t1', 'smtp.example.com');

    const rootBytes = Buffer.from(root.threadIndex!, 'base64');
    const childBytes = Buffer.from(child.threadIndex!, 'base64');
    expect(rootBytes.length).toBe(22);
    expect(childBytes.length).toBe(27);
    // 子邮件的 Thread-Index 前 22 字节必须等于根 → Outlook 据此归入同一会话
    expect(childBytes.subarray(0, 22).equals(rootBytes)).toBe(true);
    // 子邮件的时间增量必须为正
    expect(childBytes.readUInt32BE(22) * 256 + childBytes.readUInt8(26)).toBeGreaterThan(0);
  });

  test('Thread-Index 根跨调用确定性（同键恒同根，重启不断链）', () => {
    const a = buildThreadHeaders('pr-threadidx-t2', 'smtp.example.com');
    const b = buildThreadHeaders('pr-threadidx-t2', 'smtp.example.com');
    expect(Buffer.from(b.threadIndex!, 'base64').subarray(0, 22)
      .equals(Buffer.from(a.threadIndex!, 'base64').subarray(0, 22))).toBe(true);

    const other = buildThreadHeaders('pr-threadidx-t3', 'smtp.example.com');
    expect(Buffer.from(other.threadIndex!, 'base64').subarray(0, 22)
      .equals(Buffer.from(a.threadIndex!, 'base64').subarray(0, 22))).toBe(false);
  });

  test('空线程键没有 Thread-Index', () => {
    const lone = buildThreadHeaders('', 'smtp.example.com');
    expect(lone.threadIndex).toBeUndefined();
  });
});

describe('buildWorkflowEmailSubject', () => {
  test('有 PR：仓库名#编号 · 配置名，主题稳定不含状态', () => {
    const subject = buildWorkflowEmailSubject('[ACE]', {
      configFile: 'gitcode-pr-review.yaml',
      prUrl: 'https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1906',
    });
    expect(subject).toBe('[ACE] 工作流 · flutter_flutter#1906 · gitcode-pr-review');
  });

  test('无 PR：配置名兜底；无前缀也可用', () => {
    expect(buildWorkflowEmailSubject('[ACE]', { configFile: 'demo.yaml', prUrl: '' })).toBe('[ACE] 工作流 · demo');
    expect(buildWorkflowEmailSubject(undefined, { configFile: '', prUrl: '' })).toBe('工作流 · 工作流');
  });
});
