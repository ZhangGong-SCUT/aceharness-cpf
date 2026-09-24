/**
 * PR 自修工作流专项审查测试。
 *
 * 这些测试故意【钉住当前实现的真实行为】，其中多数行为是缺陷：
 * 每个用例名都标了「缺陷」或「按设计」，修复对应缺陷后应翻转断言。
 */
import { describe, expect, test, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { parse } from 'yaml';
import {
  classifyOhosPrGates,
  hasAssociatedIssue,
} from '../skills/gitcode-pr-review/scripts/ohos-pr-gates.mjs';
import { decideGitcodeWebhookRun } from '@/lib/workflow/pr-monitor-policy';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* 1. 历史评论钉死分类：DCO / 关联 Issue                                */
/* ------------------------------------------------------------------ */

describe('classifyOhosPrGates 历史评论污染（缺陷）', () => {
  test('修复：当前 DCO 成功标签覆盖历史失败评论', () => {
    // 场景：PR 曾 DCO 失败（openharmony_ci 发过失败评论），
    // 作者补 Signed-off-by 后重新 push，DCP 重跑并把标签换成 dco检查成功。
    // 旧的失败评论永远留在评论历史里。
    const result = classifyOhosPrGates({
      labels: ['dco检查成功', '静态检查成功', '编译成功', '冒烟测试成功'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'openharmony_ci', body: '此PR未通过DCO校验，请在 commit message 中添加 Signed-off-by' },
        { author: 'me', body: 'start build' },
        { author: 'openharmony_ci', body: '构建任务已结束' },
      ],
      pull: { body: 'fix #1' },
      state: 'open',
      own_pr: true,
    });
    // 期望（正确行为）: phase=green。实际（缺陷）: dco_failed
    expect(result.phase).toBe('green');
    expect(result.dco_ok).toBe(true); // dcoOk = 标签绿 && !dcoFail，被旧评论连带压成 false
  });

  test('修复：旧 DCO 失败评论不再触发重复修复', () => {
    const routed = classifyOhosPrGates({
      labels: ['dco检查成功'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'openharmony_ci', body: '此PR未通过DCO校验' },
        { author: 'me', body: 'start build' },
      ],
      pull: { body: 'fix #1' },
      state: 'open',
      own_pr: true,
    });
    expect(routed.phase).toBe('running');
    expect(routed.verdict).toBe('conditional_pass');
    // 分类处置 fail → DCO修复；修复状态「本状态不要 commit/push」，补不了就直接 pass
    // → 推送并触发（无改动且 phase≠need_start_build → pass 不评论）→ 等待门禁
    // → 仍 dco_failed → 循环。此循环下没有任何状态自环，self 熔断永不触发，
    // 唯一出口是 maxTransitions=60 熔断（见下方转移预算测试）。
  });

  test('修复：PR 描述补充 Issue 后解除历史阻塞', () => {
    // hasAssociatedIssue 只要历史评论里出现过「必须关联 Issue」就直接 return false，
    // 根本不看 PR body 里现在有没有 #1234。
    expect(hasAssociatedIssue({ body: 'Fixes #1234' }, [
      { author: 'openharmony_ci', body: '此PR必须关联 Issue 后才能 start build' },
    ])).toBe(true);

    const result = classifyOhosPrGates({
      labels: ['dco检查成功'],
      comments: [
        { author: 'openharmony_ci', body: '感谢提交 Pull Requests！' },
        { author: 'openharmony_ci', body: '此PR必须关联 Issue 后才能 start build' },
      ],
      pull: { body: 'Fixes #1234' },
      state: 'open',
      own_pr: true,
    });
    // 期望（正确行为）: 不再阻塞（或至少识别到已关联）。实际（缺陷）: blocked_no_issue
    expect(result.phase).toBe('need_start_build');
    expect(result.issue_associated).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Webhook 唤醒会劫持「人工确认」审批                                */
/* ------------------------------------------------------------------ */

const registryMock = vi.hoisted(() => ({
  answerHumanQuestion: vi.fn(async () => ({})) as ReturnType<typeof vi.fn>,
  forceTransition: vi.fn() as ReturnType<typeof vi.fn>,
  setContext: vi.fn() as ReturnType<typeof vi.fn>,
  manager: null as any,
}));

vi.mock('@/lib/workflow/registry', () => ({
  isStateMachineManagerLike: () => true,
  workflowRegistry: {
    getRunningManager: () => registryMock.manager,
    getRunningManagers: () => registryMock.manager ? [{ configFile: 'gitcode-pr-review.yaml', manager: registryMock.manager }] : [],
    getManagerByRunId: async () => registryMock.manager,
  },
}));

import { startPrReviewFromWebhook } from '@/lib/workflow/gitcode-webhook';

describe('Webhook 唤醒与人工确认（缺陷）', () => {
  const ENV_KEYS = ['ACE_GITCODE_WEBHOOK_SECRET', 'ACE_GITCODE_PR_AUTHOR', 'ACE_GITCODE_WATCH_REPOS', 'ACE_WEBHOOK_DISK_SNAPSHOT'] as const;
  let savedEnv: Record<string, string | undefined>;

  function makeManager(input: { previousState: string }) {
    return {
      getStatus: () => ({
        runId: 'run-9',
        status: 'running',
        currentState: '__human_approval__',
        globalContext: 'owner: acme\nrepo: app\nnumber: 18',
        pendingHumanQuestion: { id: 'q1', answerSchema: { type: 'approval-transition' } },
      }),
      getPendingHumanQuestion: () => ({
        id: 'q1',
        answerSchema: { type: 'approval-transition' },
        previousState: input.previousState,
        suggestedNextState: '终止',
      }),
      setContext: registryMock.setContext,
      answerHumanQuestion: registryMock.answerHumanQuestion,
      forceTransition: registryMock.forceTransition,
      setQueuedApprovalAction: vi.fn(),
    };
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.ACE_WEBHOOK_DISK_SNAPSHOT = '0';
    process.env.ACE_GITCODE_WEBHOOK_SECRET = 's3cret';
    process.env.ACE_GITCODE_PR_AUTHOR = 'me';
    process.env.ACE_GITCODE_WATCH_REPOS = 'acme/app';
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const notePayload = {
    hook_name: 'note_hooks',
    action: 'comment',
    pull_request: {
      number: 18,
      html_url: 'https://gitcode.com/acme/app/pull/18',
      state: 'open',
      user: { login: 'me' },
      head: { ref: 'feature', sha: 'abc' },
    },
    repository: { full_name: 'acme/app' },
  };

  test('修复：普通评论不会代替用户回答人工确认', async () => {
    registryMock.manager = makeManager({ previousState: '人工确认' });
    const result = await startPrReviewFromWebhook({ payload: notePayload });
    expect(result.woken).not.toBe(true);
    expect(registryMock.answerHumanQuestion).not.toHaveBeenCalled();
    expect(registryMock.forceTransition).not.toHaveBeenCalled();
  });

  test('按设计：run 停在「挂起」时，Webhook 唤醒到等待门禁（对照组）', async () => {
    registryMock.manager = makeManager({ previousState: '挂起' });
    const result = await startPrReviewFromWebhook({ payload: notePayload });
    expect(result.woken).toBe(true);
    expect(registryMock.answerHumanQuestion.mock.calls[0][1]).toMatchObject({
      selectedState: '等待门禁',
    });
  });

  test('修复：事件上下文使用可替换的固定区块', async () => {
    registryMock.manager = makeManager({ previousState: '挂起' });
    await startPrReviewFromWebhook({ payload: notePayload });
    const merged = registryMock.setContext.mock.calls[0][1] as string;
    expect(merged).toContain('<!-- pr-event:start -->');
    expect(merged).toMatch(/^owner: acme/); // 首段是旧上下文，之后每次唤醒都再拼一段
  });

  test('修复：来源不明的人工审批禁止自动唤醒', () => {
    const decision = decideGitcodeWebhookRun({
      incoming: { owner: 'acme', repo: 'app', number: '18' },
      running: {
        runId: 'run-9',
        status: 'running',
        currentState: '__human_approval__',
        globalContext: 'owner: acme\nrepo: app\nnumber: 18',
        pendingHumanQuestion: { id: 'q1', answerSchema: { type: 'approval-transition' } },
      },
    });
    expect(decision).toMatchObject({ action: 'ignore' });
  });
});

/* ------------------------------------------------------------------ */
/* 3. 转移预算：挂起/唤醒与循环的代价                                   */
/* ------------------------------------------------------------------ */

describe('maxTransitions 转移预算（缺陷）', () => {
  const cfg = parse(readFileSync(resolve(__dirname, '../configs/gitcode-pr-review.yaml'), 'utf-8'));
  const maxTransitions: number = cfg.workflow.maxTransitions;
  const states = new Map<string, any>(
    cfg.workflow.states.map((s: any) => [s.name, s]),
  );

  // 按 workflow-manager.executeStateMachine 语义：
  // 普通转移 transitionCount+1；离开 requireHumanApproval 状态 = 状态→__human_approval__(+1)
  // → 审批后 __human_approval__→目标(+1)，共 +2。
  function step(state: string, verdict: string): { target: string; cost: number } {
    const t = (states.get(state).transitions || [])
      .filter((x: any) => x.condition?.verdict === verdict)
      .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))[0];
    if (!t) throw new Error(`no transition ${state} --${verdict}-->`);
    return { target: t.to, cost: states.get(state).requireHumanApproval ? 2 : 1 };
  }

  test('挂起/唤醒空转一轮要烧 3 次转移：60 次预算只够 20 轮唤醒', () => {
    expect(maxTransitions).toBe(60);
    let count = 0;
    let wakes = 0;
    while (true) {
      if (count >= maxTransitions) break;
      // 等待门禁: CI 还在跑 → conditional_pass → 挂起（无审批，+1）
      const a = step('等待门禁', 'conditional_pass');
      count += a.cost;
      if (count >= maxTransitions) break;
      // 挂起: park 步骤 pass → 审批 → 唤醒回等待门禁（+2）
      const b = step('挂起', 'pass');
      count += b.cost;
      wakes += 1;
    }
    // 活跃 PR（每条评论/推送/标签都触发一次 Note/MR Webhook）评论 20 条
    // 就会把 run 以「达到最大状态转移次数，可能存在死循环」崩掉，
    // 而 run 其实只是在正常等门禁。
    expect(wakes).toBe(20);
  });

  test('测试失败直达人工确认，普通事件不能回答审批', () => {
    const classify = states.get('分类处置');
    expect(classify.transitions).toContainEqual(expect.objectContaining({
      to: '人工确认', condition: { verdict: 'fail', fieldEquals: { next_state: '人工确认' } },
    }));
    const decision = decideGitcodeWebhookRun({
      incoming: { owner: 'org', repo: 'repo', number: '1' } as any,
      running: { runId: 'run-1', status: 'running', currentState: '__human_approval__',
        globalContext: 'owner: org\nrepo: repo\nnumber: 1',
        pendingHumanQuestion: { previousState: '人工确认' } },
    });
    expect(decision.action).toBe('ignore');
  });

  test('旧 DCO 评论钉死的循环：一轮 4 次转移、无任何状态自环，self 熔断永不触发', () => {
    let count = 0;
    let cycles = 0;
    while (true) {
      const plan = [
        ['等待门禁', 'pass'],   // → 分类处置
        ['分类处置', 'fail'],   // phase=dco_failed（旧评论）
        ['DCO修复', 'pass'],    // 补无可补 → pass
        ['推送并触发', 'pass'], // 无改动且 phase≠need_start_build → 不 push 不评论
      ] as const;
      let cost = 0;
      for (const [state, verdict] of plan) cost += step(state, verdict).cost;
      if (count + cost > maxTransitions) break;
      count += cost;
      cycles += 1;
    }
    // 结论：不是走「人工确认」优雅停下，而是第 15 轮撞 maxTransitions
    // 抛「可能存在死循环」直接把 run 打成失败。
    expect(cycles).toBe(15);
  });
});

/* ------------------------------------------------------------------ */
/* 4. check-pr-gates.mjs 集成：分页上限与产物                            */
/* ------------------------------------------------------------------ */

describe('check-pr-gates.mjs 集成', () => {
  let server: http.Server;
  let baseUrl: string;
  let commentPages: Record<string, any[]>;
  let pull: any;
  let labels: any[];
  const requestedPages: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const send = (data: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === '/repos/acme/app/pulls/18') return send(pull);
      if (url.pathname === '/repos/acme/app/issues/18') return send({});
      if (url.pathname === '/repos/acme/app/issues/18/labels') return send(labels);
      if (url.pathname === '/repos/acme/app/issues/18/comments') {
        const page = url.searchParams.get('page') || '1';
        requestedPages.push(page);
        return send(commentPages[page] || []);
      }
      send({ message: 'not found' }, 404);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  async function runScript(outDir: string) {
    const script = resolve(__dirname, '../skills/gitcode-pr-review/scripts/check-pr-gates.mjs');
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, '--pr-url', 'https://gitcode.com/acme/app/pull/18', '--out', outDir],
      {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, GITCODE_API_ROOT: baseUrl, ACE_GITCODE_PR_AUTHOR: 'me' },
      },
    );
    return JSON.parse(stdout);
  }

  test('按设计：正常门禁分类写出 gate-check.json（静态失败 + 报告链接）', async () => {
    pull = {
      state: 'open',
      user: { login: 'me' },
      head: { ref: 'fix-branch', repo: { full_name: 'me/app_fork' } },
      base: { ref: 'master' },
    };
    labels = [{ name: 'dco检查成功' }, { name: '静态检查失败' }];
    commentPages = {
      '1': [
        { user: { login: 'openharmony_ci' }, body: '感谢提交 Pull Requests！' },
        { user: { login: 'me' }, body: 'start build' },
        {
          user: { login: 'openharmony_ci' },
          body: '静态检查 noPass http://dcp.openharmony.cn/workbench/cicd/detail/1/runlist',
        },
      ],
    };
    requestedPages.length = 0;
    const dir = await mkdtemp(resolve(tmpdir(), 'gate-check-'));
    try {
      const result = await runScript(dir);
      expect(result.phase).toBe('static_failed');
      expect(result.report_url).toContain('dcp.openharmony.cn');
      expect(result.start_build_posted).toBe(false); // CI 尚未确认构建开始
      expect(result.head_repo).toBe('me/app_fork');
      const saved = JSON.parse(await readFile(resolve(dir, 'gate-check.json'), 'utf-8'));
      expect(saved.phase).toBe('static_failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('修复：超过 300 条仍读取最新 CI 评论', async () => {
    pull = {
      state: 'open',
      user: { login: 'me' },
      head: { ref: 'fix-branch', repo: { full_name: 'me/app_fork' } },
      base: { ref: 'master' },
    };
    labels = [{ name: 'dco检查成功' }, { name: '静态检查失败' }];
    // 3 页 × 100 条普通评论，第 4 页才是最新的 CI 评论（升序分页假设下第 4 页最新）
    const filler = Array.from({ length: 100 }, (_, i) => ({
      user: { login: 'someone' },
      body: `review comment ${i}`,
    }));
    commentPages = {
      '1': filler,
      '2': filler,
      '3': filler,
      '4': [
        {
          user: { login: 'openharmony_ci' },
          body: '静态检查 noPass http://dcp.openharmony.cn/workbench/cicd/detail/999/runlist',
        },
      ],
    };
    requestedPages.length = 0;
    const dir = await mkdtemp(resolve(tmpdir(), 'gate-check-'));
    try {
      const result = await runScript(dir);
      // 第 4 页从未被请求
      expect(requestedPages).toEqual(['1', '2', '3', '4']);
      // 最新 CI 评论丢了：report_url 为空
      expect(result.report_url).toContain('/999/runlist');
      expect(result.latest_ci_comment).toContain('静态检查 noPass');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
