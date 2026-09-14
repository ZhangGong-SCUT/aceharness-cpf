# 诊断工作流流程优化归档（2026-09-14）

> 归档时间：2026-09-14 13:01 CST
> 分支：cpf-ohos-issue-diagnosis
> 涉及配置：`configs/cpf-ohos-diagnosis.yaml`、`configs/flutter-ohos-diagnosis.yaml`（两份已同步，仅保留原有 vision-look 差异）

## 背景

对 cpf-ohos-diagnosis 工作流做流程审查，结合引擎源码（`src/lib/state-machine/`）与最近真实 run（run-1789028966116，2026-09-10，Issue 404 空跑 5 状态 23 分钟、8 个 agent session，最终被误标 failed）发现 4 个流程缺口 + 2 项声明与实际不符。

## 解决的问题

| # | 问题 | 解决方案 |
|---|------|---------|
| 1 | Issue 404/不可访问时全流程空跑（实跑证据：23 分钟产出零事实兜底报告） | 信息采集 task 增加【快速终止】规则：正文 API 404 且对照确认 API 可用 → verdict=fail 走终止 |
| 2 | 应用层问题（problem_ownership=business_code/mixed）仍强制走 方案设计→代码修复→修复验证，对框架仓产出无意义 patch | 根因定位 JSON 补 `problem_ownership` 字段；方案设计增加【问题归属分流】：business_code/mixed 只输出应用侧修改建议，verdict=fail 走「输出建议供人工执行」进报告沉淀 |
| 3 | 根因分析/修复验证都无法回退问题复现——Demo 没踩到相关代码路径时流程在 修复↔方案↔根因 里打转直到 maxTransitions 耗尽 | ① 根因分析新增 cpass→问题复现 转移边（judge 显式写 next_state=问题复现 时生效，默认 cpass 仍自迭代）；② 修复验证 feedback_to_target 白名单放行问题复现（引擎 mapFixVerificationFeedbackTarget/extractFixVerificationRollbackTarget 同步扩展） |
| 4 | 设计内兜底出口（根因 fail→报告沉淀→完成）正常完成却被引擎标 failed | shouldFinalizeDiagnosisAsCompleted 新增 fixVerificationReached 参数：修复验证从未执行的设计内出口按 completed 收尾；进过修复验证但未达标的仍标 failed |
| 5 | 描述声称"复现环≤2 / 修复环≤3"但无引擎机制保障（只有全局 maxTransitions=30 和自环熔断） | schema 新增 `maxVisits`（状态在 run 内最大进入次数，含自环重入），引擎逐状态计数（含 resume 从 stateHistory 重建）；YAML：问题复现/复现验证 maxVisits=3、修复验证 maxVisits=4、根因分析显式 maxSelfTransitions=3 |
| 6 | 黄金标志无结构化落点：修复验证要求"沿用复现阶段锁定的判据"但问题复现 JSON 没有该字段 | 问题复现 JSON 新增 `issue_golden_flag`（从 Issue 正文锁定唯一可观测判据），修复验证直接引用 |
| 7 | 问题分类定界后置：构造复现 Demo 时拿不到问题类型知识（内存泄漏需插桩、性能需埋点） | 信息采集输出 `problem_type_preliminary` 初判；问题复现按类型配置观测手段 |
| 8 | curl.exe 措辞在 Linux 执行环境会 ENOENT | 改为"用 curl（Windows 用 curl.exe）" |

## 引擎配套改动

- `src/lib/core/schemas.ts`：stateMachineStateSchema 增加 `maxVisits` 可选字段（向后兼容）
- `src/lib/state-machine/utils.ts`：
  - FIX_VERIFY_ROLLBACK_STATES / mapFixVerificationFeedbackTarget / extractFixVerificationRollbackTarget 放行「问题复现」
  - pickCircuitBreakerEscape 调整顺序：自环耗尽优先走 fail 出口，不会被新增的 cpass→问题复现 边劫持
  - shouldFinalizeDiagnosisAsCompleted 增加 fixVerificationReached（见问题 4）
- `src/lib/state-machine/workflow-manager.ts`：stateVisitCounts 字段/重置/resume 重建；executeStateMachine 入口处 maxVisits 熔断；finalizeWorkflowByDiagnosisGate 计算 fixVerificationReached
- `tests/state-machine-verdict.test.ts`：新增 5 个用例（问题复现路由×2、兜底完成、熔断不误入 cpass 边、Demo 缺陷路由）

## 验证

- vitest：state-machine 相关 5 个测试文件 153 用例全部通过（含新增）
- 两份 YAML + ~/.aceharness/configs 运行时副本均通过 stateMachineWorkflowSchema 校验及关键配置断言
- eslint / tsc 对改动文件零报错
- 已执行 `npm run sync:configs` 同步运行时配置

## 部署注意

- 引擎改动（src/lib/）需重新构建并重启 ACEHarness 服务后生效；本归档未重启任何运行中进程
- 工作区中另有他人未提交的 gitcode-pr-review 相关改动，本提交仅包含上述 6 个文件（workflow-manager.ts 已做分块暂存，剔除他人 hunk）
