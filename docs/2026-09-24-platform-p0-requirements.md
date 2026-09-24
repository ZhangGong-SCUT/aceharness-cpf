# PR 监控：队列时延与按 PR 健康（平台 P0 R04）

时间：2026-09-24 14:35（Asia/Shanghai）。

依据：CPF-AIWeb 的 [平台功能与需求补强方案](../../CPF-AIWeb/docs/2026-09-24-platform-requirements-roadmap.md) 第一批 P0 的 R04。

## 问题 → 方案 → 验证

- **问题**：`/api/gitcode/monitor` 只返回排队数、重试数、最久等待和最近 20 条派发耗时；用户/管理端无法看到 24h 时延分位、失败率，也看不到"某个 PR 是否还在排队、下次何时重试、最近一次结果/错误"。
- **方案**：扩展 `src/lib/workflow/pr-event-queue.ts` 的 `status()`：
  - 24h 内 receipt 聚合出 `samples24h`、`p50ms`、`p95ms`、`failureRate24h`；
  - 新增 `prs`：按队列键（`configFile:identity`，即按 PR）聚合 `pending/retrying/attempts/oldestReceivedAt/nextDueAt`，并从最近 500 条 receipt 回填 `lastStatus/lastDelayMs/lastFinishedAt/lastSuccessAt/lastError`。
  - 纯内存/落盘读取，不新增外部依赖；`/api/gitcode/monitor` 因直接展开 `getPrMonitorQueueStatus()` 而自动暴露新字段。
- **验证**：新增 `tests/pr-event-queue-status.test.ts`——成功/重试/硬失败三种派发下断言 `samples24h=2`、`failureRate24h=0.5`、`p95>=p50`、成功键 `lastStatus=200`、重试键 `pending=1/retrying=1/nextDueAt>now`。`tsc -p tsconfig.build.json` 与相关 vitest 回归 253 项通过。

## 上线

隔离目录 `.pr-monitor-build` 重新构建并部署；构建 ID `-97mTAWqLtYsEfpnYXVS_`；备份 `/home/flutter/.pr-stability-backups/20260924-143303-monitor`。线上只读实测 `/api/gitcode/monitor` 返回 `p50ms=1665 / p95ms=2021 / samples24h=116 / failureRate24h=0`，并带按 PR 的 `prs` 键。

## 复核修复（M2：失败统计）

时间：2026-09-24 15:00。

- **问题**（见 CPF-AIWeb 的 `2026-09-24-platform-p0-review.md` M2）：409/429/5xx 的重试不产生 receipt，失败率恒为 0、`lastError` 恒为空；容量上限也会截断 24h 样本。
- **方案**：`drain` 重试时在 job 上记录 `lastStatus/lastError/lastAttemptAt`；`status()` 的 `failureRate24h` 计入重试尝试并新增 `retryAttempts24h`、`sampleWindowCapped`；`prHealth` 用当前重试错误覆盖、成功回执清除历史错误。
- **验证**：`tests/pr-event-queue-status.test.ts` 断言重试被计入失败率与 `lastError`；`tsc` 与相关 vitest 253 项通过。
