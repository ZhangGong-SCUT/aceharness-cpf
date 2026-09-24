# P1 需求实现（R06/R08/R10）

时间：2026-09-24 15:20（Asia/Shanghai）。

依据 CPF-AIWeb 的 [平台功能与需求补强方案](../../CPF-AIWeb/docs/2026-09-24-platform-requirements-roadmap.md) 第二批 P1，ACEHarness 侧实现：

## R06 按任务类型调度

- 新增 `src/lib/workflow/pr-task-scheduler.ts`：`read/ai/build/write` 分类限流（`ACE_SCHED_*_MAX`）、同 PR 串行、反饥饿公平排队、超时抛错。
- `src/lib/workflow/pr-monitor.ts` 派发接入调度器；`/api/gitcode/monitor` 增加 `scheduler` 状态。

## R08 可配置自动化策略

- 新增 `src/lib/workflow/pr-review-policy.ts`：模板与预算模型、优先级解析、内容哈希版本、`withinPolicy` 校验、`buildPolicyInstructions`。
- 新增 `src/app/api/gitcode/policy/route.ts` 与 `configs/pr-review-policies.yaml`。

## R10 回放与质量基线

- 新增 `tests/pr-replay.test.ts`：重复/乱序 webhook、重启恢复、429 重试、硬失败、超长评论；产出 `docs/pr-replay-baseline.json`。

## 验证

`tsc -p tsconfig.build.json` 通过；相关 vitest 266 项通过（含 `pr-task-scheduler`、`pr-review-policy`、`pr-replay`）。

## 上线

隔离目录 `.pr-monitor-build` 重新构建并部署；`configs/pr-review-policies.yaml` 同步到运行配置目录。
