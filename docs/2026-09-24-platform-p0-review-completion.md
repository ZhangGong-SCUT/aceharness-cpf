# P0 复核补完（门禁检查时间 / 队列尝试日志）

时间：2026-09-24 15:10（Asia/Shanghai）。

承 CPF-AIWeb 的 [P0 复核问题修复](../../CPF-AIWeb/docs/2026-09-24-platform-p0-review-fixes.md)，补齐 ACEHarness 侧未提交改动。

## 变更

- `src/lib/workflow/pr-script-step.ts`：`gates` 脚本执行后立即把结果写入 `outputs/gate-check.json`，即使本轮没有状态转移也保留**实际检查时间**，供 AIWeb 的监控健康显示（M1）。
- `src/lib/workflow/pr-event-queue.ts`：新增 `attempts` 尝试日志（每次派发的状态/原因/时间，24h 滚动、上限 10000 条，`sampleWindowCapped` 标注），失败率与"按 PR 最近错误"据此精确统计；409 计入容量等待而非失败。

## 验证

- `tsc -p tsconfig.build.json` 通过；相关 vitest 253 项通过。
- 改动来自并行 Codex 会话，本次归档保存，未纳入仓库原有 WIP。
