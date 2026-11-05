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
  runningManagers: [] as { configFile: string; manager: any; isStateMachine: boolean }[],
}));

vi.mock('@/lib/workflow/registry', () => ({
  isStateMachineManagerLike: () => true,
  workflowRegistry: {
    getRunningManager: () => registryMock.manager,
    getRunningManagers: () => registryMock.runningManagers,
    getManagerByRunId: async () => registryMock.manager,
  },
}));

import { startPrReviewFromWebhook } from '@/lib/workflow/gitcode-webhook';

describe('Webhook 唤醒与人工确认（缺陷）', () => {
  const ENV_KEYS = ['ACE_GITCODE_WEBHOOK_SECRET', 'ACE_GITCODE_PR_AUTHOR', 'ACE_GITCODE_WATCH_REPOS', 'ACE_GITCODE_AUTO_MONITOR'] as const;
  let savedEnv: Record<string, string | undefined>;

  function makeManager(input: { previousState: string; configFile?: string }) {
    const manager = {
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
    registryMock.runningManagers = [
      { configFile: input.configFile || 'gitcode-pr-review.yaml', manager, isStateMachine: true },
    ];
    registryMock.manager = manager;
    return manager;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.ACE_GITCODE_WEBHOOK_SECRET = 's3cret';
    process.env.ACE_GITCODE_PR_AUTHOR = 'me';
    process.env.ACE_GITCODE_WATCH_REPOS = 'acme/app';
    // 本套件测的是自动模式下的唤醒/并行语义（人工模式拦截新启动的行为另行单测）
    process.env.ACE_GITCODE_AUTO_MONITOR = 'true';
    vi.clearAllMocks();
    registryMock.runningManagers = [];
    registryMock.manager = null;
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

  test('多 PR 并行：其他 PR 的 run 挂起不再阻塞新 PR 启动', async () => {
    makeManager({ previousState: '挂起' });
    const otherPrPayload = {
      ...notePayload,
      pull_request: {
        ...notePayload.pull_request,
        number: 19,
        html_url: 'https://gitcode.com/acme/app/pull/19',
      },
    };
    const origFetch = global.fetch;
    const fetchCalls: any[] = [];
    global.fetch = vi.fn(async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), body: init?.body });
      return new Response(JSON.stringify({ runId: 'run-new-parallel' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await startPrReviewFromWebhook({ payload: otherPrPayload });
      // 不再 409 一把锁：另一条 PR（#18）挂着时，#19 的事件走 start 路径新起 run
      expect(result.status).not.toBe(409);
      expect(result.started).toBe(true);
      expect(result.runId).toBe('run-new-parallel');
      // 挂起中的 #18 run 未被触碰（只按 runId 精确唤醒，不误伤并行 run）
      expect(registryMock.setContext).not.toHaveBeenCalled();
      expect(registryMock.answerHumanQuestion).not.toHaveBeenCalled();
      // 新起 run 的 runId 请求带 PR 编号，运行列表里可直观定位
      const startCall = fetchCalls.find((c) => c.url.includes('/api/workflow/start'));
      expect(startCall).toBeTruthy();
      const startBody = JSON.parse(startCall.body);
      expect(startBody.runId).toMatch(/^run-\d+-pr19-[a-f0-9]+$/);
    } finally {
      global.fetch = origFetch;
    }
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
  let pullCommentPages: Record<string, any[]>;
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
        requestedPages.push(`issues:${page}`);
        return send(commentPages[page] || []);
      }
      if (url.pathname === '/repos/acme/app/pulls/18/comments') {
        const page = url.searchParams.get('page') || '1';
        requestedPages.push(`pulls:${page}`);
        return send(pullCommentPages[page] || []);
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
        env: { ...process.env, GITCODE_API_ROOT: baseUrl, ACE_GITCODE_PR_AUTHOR: 'me', ACE_GITCODE_DCP_REPORT: '0' },
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
        { user: { login: 'openharmony_ci' }, body: '门禁构建开始,预计在60分钟内完成' },
        {
          user: { login: 'openharmony_ci' },
          body: '静态检查 noPass http://dcp.openharmony.cn/workbench/cicd/detail/1/runlist',
        },
      ],
    };
    pullCommentPages = {};
    requestedPages.length = 0;
    const dir = await mkdtemp(resolve(tmpdir(), 'gate-check-'));
    try {
      const result = await runScript(dir);
      // 门禁接受过 start build 后静态失败（首败，预算内）：按抖动重试设计走 need_start_build
      expect(result.phase).toBe('need_start_build');
      expect(result.start_build_count).toBe(1);
      expect(result.report_url).toContain('dcp.openharmony.cn');
      expect(result.start_build_posted).toBe(true);
      expect(result.head_repo).toBe('me/app_fork');
      const saved = JSON.parse(await readFile(resolve(dir, 'gate-check.json'), 'utf-8'));
      expect(saved.phase).toBe('need_start_build');
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
    pullCommentPages = {};
    requestedPages.length = 0;
    const dir = await mkdtemp(resolve(tmpdir(), 'gate-check-'));
    try {
      const result = await runScript(dir);
      // 第 4 页从未被请求
      expect(requestedPages.filter((item) => item.startsWith('issues:'))).toEqual(['issues:1', 'issues:2', 'issues:3', 'issues:4']);
      // 最新 CI 评论丢了：report_url 为空
      expect(result.report_url).toContain('/999/runlist');
      expect(result.latest_ci_comment).toContain('静态检查 noPass');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('讨论区为空时仍能从 PR 评论读到欢迎语并判定 need_start_build', async () => {
    pull = {
      state: 'open',
      user: { login: 'me' },
      head: { ref: 'plugin_restore_3.35', repo: { full_name: 'me/app_fork' }, sha: 'abc123' },
      base: { ref: 'oh-3.35.7-dev' },
      body: 'Fixes #2573',
    };
    labels = [{ name: 'dco检查成功' }, { name: 'AI已检视' }];
    commentPages = {};
    pullCommentPages = {
      '1': [
        {
          user: { login: 'openharmony_ci' },
          body: '<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>',
        },
      ],
    };
    requestedPages.length = 0;
    const dir = await mkdtemp(resolve(tmpdir(), 'gate-check-'));
    try {
      const result = await runScript(dir);
      expect(requestedPages).toContain('pulls:1');
      expect(result.welcome).toBe(true);
      expect(result.phase).toBe('need_start_build');
      expect(result.start_build_posted).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('静态检查失败但重试预算未用完时 phase=need_start_build 走重发', async () => {
    pull = {
      state: 'open',
      user: { login: 'me' },
      head: { ref: 'plugin_restore_3.35', repo: { full_name: 'me/app_fork' }, sha: 'abc123' },
      base: { ref: 'oh-3.35.7-dev' },
      body: 'Fixes #2573',
    };
    labels = [{ name: 'dco检查成功' }, { name: '静态检查失败' }];
    commentPages = {};
    pullCommentPages = {
      '1': [
        {
          user: { login: 'openharmony_ci' },
          body: '<p>感谢提交 Pull Requests！</p>',
          created_at: '2026-09-03T13:00:00Z',
        },
        {
          user: { login: 'me' },
          body: 'start build',
          created_at: '2026-09-03T21:59:00Z',
        },
        {
          user: { login: 'openharmony_ci' },
          body: '首次触发 门禁构建开始,预计在60分钟内完成',
          created_at: '2026-09-03T21:59:40Z',
        },
        {
          user: { login: 'openharmony_ci' },
          body: '代码门禁未通过 静态检查: codeCheck noPass',
          created_at: '2026-09-03T22:07:54Z',
        },
      ],
    };
    requestedPages.length = 0;
    const dir = await mkdtemp(resolve(tmpdir(), 'gate-check-'));
    try {
      const result = await runScript(dir);
      expect(result.phase).toBe('need_start_build');
      expect(result.start_build_count).toBe(1);
      expect(result.start_build_max).toBe(3);
      expect(result.verdict).toBe('pass');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('同号 Issue 上的 start build 不能当成 PR 已触发', async () => {
    pull = {
      state: 'open',
      user: { login: 'me' },
      head: { ref: 'plugin_restore_3.35', repo: { full_name: 'me/app_fork' }, sha: 'abc123' },
      base: { ref: 'oh-3.35.7-dev' },
      body: 'Fixes #2573',
    };
    labels = [{ name: 'dco检查成功' }];
    commentPages = {
      '1': [
        {
          comment_type: 'DiscussionNote',
          user: { login: 'me' },
          body: 'start build',
          target: { issue: { id: 4044338, number: '18', title: 'chore pipeline' } },
        },
      ],
    };
    pullCommentPages = {
      '1': [
        {
          comment_type: 'pr_comment',
          user: { login: 'openharmony_ci' },
          body: '<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>',
        },
      ],
    };
    requestedPages.length = 0;
    const dir = await mkdtemp(resolve(tmpdir(), 'gate-check-'));
    try {
      const result = await runScript(dir);
      expect(result.welcome).toBe(true);
      expect(result.start_build_posted).toBe(false);
      expect(result.phase).toBe('need_start_build');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('post-pr-comment.mjs', () => {
  let server: http.Server;
  let baseUrl: string;
  let posted: { path: string; method: string; body: any; token: string } | null;
  let pullUser = 'me';
  let pullComments: any[];
  let commentPolls = 0;

  beforeAll(async () => {
    posted = null;
    pullComments = [];
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const send = (data: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && url.pathname === '/repos/acme/app/pulls/18') {
        return send({ user: { login: pullUser }, state: 'open' });
      }
      if (req.method === 'GET' && url.pathname === '/repos/acme/app/pulls/18/comments') {
        commentPolls += 1;
        // 第 1 轮只有旧欢迎评论（push 未确认）；第 2 轮冒出「监测到PR 代码有更新」push 确认
        if (commentPolls >= 2) {
          pullComments = [
            ...pullComments,
            {
              id: 4242,
              user: { login: 'openharmony_ci' },
              body: '监测到PR: https://gitcode.com/acme/app/merge_requests/18 代码有更新,当前正在执行的门禁任务已自动中止',
              created_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ];
        }
        return send(pullComments);
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        posted = {
          path: url.pathname,
          method: req.method || '',
          body: raw ? JSON.parse(raw) : null,
          token: url.searchParams.get('access_token') || '',
          atPoll: commentPolls,
        };
        send({ id: 99, comment_type: 'pr_comment', body: posted.body?.body }, 201);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  test('start build 发到 pulls/comments 而不是 issues/comments', async () => {
    const script = resolve(__dirname, '../skills/gitcode-pr-review/scripts/post-pr-comment.mjs');
    const dir = await mkdtemp(resolve(tmpdir(), 'pr-comment-'));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          script,
          '--pr-url',
          'https://gitcode.com/acme/app/merge_requests/18',
          '--body',
          'start build',
          '--out',
          dir,
        ],
        {
          cwd: resolve(__dirname, '..'),
          env: { ...process.env, GITCODE_API_ROOT: baseUrl, GITCODE_TOKEN: 'test-token' },
        },
      );
      const result = JSON.parse(stdout);
      expect(posted?.method).toBe('POST');
      expect(posted?.path).toBe('/repos/acme/app/pulls/18/comments');
      expect(posted?.path).not.toContain('/issues/');
      expect(posted?.body).toEqual({ body: 'start build' });
      expect(result.ok).toBe(true);
      expect(result.endpoint).toBe('pulls');
      expect(result.comment_id).toBe(99);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('start build 使用 PR 作者自己的密钥，不用其他人的', async () => {
    const script = resolve(__dirname, '../skills/gitcode-pr-review/scripts/post-pr-comment.mjs');
    const dir = await mkdtemp(resolve(tmpdir(), 'pr-comment-'));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          script,
          '--pr-url',
          'https://gitcode.com/acme/app/merge_requests/18',
          '--author',
          'huhaodong',
          '--body',
          'start build',
          '--out',
          dir,
        ],
        {
          cwd: resolve(__dirname, '..'),
          env: {
            ...process.env,
            GITCODE_API_ROOT: baseUrl,
            GITCODE_TOKEN: 'token-z',
            GITCODE_TOKEN_z2036709353: 'token-z',
            GITCODE_TOKEN_huhaodong: 'token-h',
          },
        },
      );
      const result = JSON.parse(stdout);
      expect(posted?.token).toBe('token-h');
      expect(result.author).toBe('huhaodong');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('不传 --author 时按 PR 作者自动选用对应密钥', async () => {
    pullUser = 'huhaodong';
    const script = resolve(__dirname, '../skills/gitcode-pr-review/scripts/post-pr-comment.mjs');
    const dir = await mkdtemp(resolve(tmpdir(), 'pr-comment-'));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          script,
          '--pr-url',
          'https://gitcode.com/acme/app/merge_requests/18',
          '--body',
          'start build',
          '--out',
          dir,
        ],
        {
          cwd: resolve(__dirname, '..'),
          env: {
            ...process.env,
            GITCODE_API_ROOT: baseUrl,
            GITCODE_TOKEN: 'token-z',
            GITCODE_TOKEN_z2036709353: 'token-z',
            GITCODE_TOKEN_huhaodong: 'token-h',
          },
        },
      );
      const result = JSON.parse(stdout);
      expect(posted?.token).toBe('token-h');
      expect(result.author).toBe('huhaodong');
    } finally {
      pullUser = 'me';
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('--wait-push-ack 等 push 确认评论出现后才发 start build', async () => {
    commentPolls = 0;
    pullComments = [
      {
        id: 1,
        user: { login: 'openharmony_ci' },
        body: '感谢提交 Pull Requests！',
        created_at: '2026-09-04T01:00:00Z',
      },
      {
        id: 2,
        user: { login: 'huhaodong' },
        body: 'start build',
        created_at: '2026-09-04T01:30:00Z',
      },
      {
        id: 3,
        user: { login: 'openharmony_ci' },
        body: '代码门禁未通过',
        created_at: '2026-09-04T01:40:00Z',
      },
    ];
    posted = null;
    const script = resolve(__dirname, '../skills/gitcode-pr-review/scripts/post-pr-comment.mjs');
    const dir = await mkdtemp(resolve(tmpdir(), 'pr-comment-'));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          script,
          '--pr-url',
          'https://gitcode.com/acme/app/merge_requests/18',
          '--author',
          'huhaodong',
          '--body',
          'start build',
          '--wait-push-ack',
          '--wait-timeout',
          '15',
          '--out',
          dir,
        ],
        {
          cwd: resolve(__dirname, '..'),
          env: {
            ...process.env,
            GITCODE_API_ROOT: baseUrl,
            GITCODE_TOKEN_huhaodong: 'token-h',
          },
        },
      );
      const result = JSON.parse(stdout);
      expect(commentPolls).toBeGreaterThanOrEqual(2);
      expect((posted as any)?.atPoll).toBeGreaterThanOrEqual(2);
      expect(result.wait_ack).toBe('acked');
      expect(result.push_ack_at).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
