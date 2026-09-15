# 诊断工作流优化归档（2026-09-15）：方案设计红蓝对抗 + 字段路由条件化

> 归档时间：2026-09-15 15:00 CST
> 分支：cpf-ohos-issue-diagnosis
> 涉及配置：`configs/cpf-ohos-diagnosis.yaml`、`configs/flutter-ohos-diagnosis.yaml`（两份已同步，仅保留原有 vision-look 差异）

## 背景

对 cpf-ohos-diagnosis 工作流做结构审查，发现两个问题：

1. **方案设计是修复链路中唯一"单 agent 独断"的关键环节**：根因分析有完整红蓝对抗（defender→attacker→judge），而方案设计只有 defender 一步。方案设计缺陷要到修复验证（真机跑完）才暴露，每次回环 = 改码+编译+装机的高昂成本；且 `configs/agents/` 里 `diagnosis-fix-challenger`、`diagnosis-fix-judge` 两个 agent 早已就绪但从未被引用。
2. **修复验证的回退路由"配置文件说了不算、引擎源码说了才算"**：YAML 里 8 条同 verdict 多目标边自述"仅作图示与兜底"，真实路由由引擎 `resolveFixVerificationNextState`（utils.ts）按 `feedback_to_target` 正则特判——改 YAML 不生效、引擎代码被单个工作流的状态名/字段名污染。

## 解决的问题

| # | 问题 | 解决方案 |
|---|------|---------|
| 1 | 方案设计无对抗制衡，坏方案带病进入代码修复 | 方案设计改为红蓝对抗 3 步（design-fix → challenge-fix-design[diagnosis-fix-challenger, attacker] → judge-fix-design[diagnosis-fix-judge, judge]）；judge cpass 回 defender 自迭代（maxSelfTransitions=2 熔断，超限走 fail 出口进报告沉淀）；judge 可指定 next_state=根因分析 返工根因；business_code/mixed 应用层分流 fail 语义原样保留 |
| 2 | 修复验证路由靠引擎硬编码，YAML 假边误导维护 | 引擎 `matchCondition` 新增 5 类字段条件（见下），YAML 用 21 条真实条件边完整表达原特判语义（含 fieldAbsent 保证"结构化字段优先于散文回退"的优先级不变），删除引擎 `resolveFixVerificationNextState` / `extractFixVerificationRollbackTarget` / `mapFixVerificationFeedbackTarget` 特判代码 |
| 3 | 字段路由条件对 agent 不可见 | 转移规则提示词（roadmap 与 step context 两处）附带条件摘要（`describeTransitionFieldCondition`），agent 能看到"feedback_to_target~/方案/ → 方案设计"这类真实路由 |

## 引擎配套改动

- `src/lib/core/schemas.ts`：`transitionConditionSchema` 新增可选键（全部向后兼容）：
  - `fieldEquals`：所有字段必须解析成功且相等（字符串化比较）
  - `fieldNotEquals`：所有字段均不得等于给定值（字段缺失视为不相等，条件通过）
  - `fieldMatch`：所有字段必须存在且匹配正则（不回退全文）
  - `fieldAbsent`：所有字段路径都必须未解析到（结构化字段缺失时才做全文散文匹配）
  - `outputMatch`：对状态完整原始输出做正则匹配
  - 字段键支持 `a.b` 点路径与 `a|b` 候选路径（取第一个存在的候选，跨多个非工具 JSON 取最后一次解析结果，与 verdict 提取口径一致）
- `src/lib/state-machine/utils.ts`：
  - 新增纯函数 `resolveOutputField` / `matchTransitionFieldConditions` / `hasTransitionFieldCondition` / `describeTransitionFieldCondition`（无效正则按条件失败处理，不拖垮工作流）
  - 删除 `resolveFixVerificationNextState` / `extractFixVerificationRollbackTarget` / `mapFixVerificationFeedbackTarget` / `FIX_VERIFY_ROLLBACK_STATES`
  - `enforceFixVerificationGoldenFlag`（pass 降级护栏）**保留不动**——它是 verdict 级安全机制，不属于路由
- `src/lib/state-machine/workflow-manager.ts`：
  - `evaluateTransitions` 移除修复验证特判入口，统一走 priority + matchCondition
  - `matchCondition` 接入 `matchTransitionFieldConditions`（stepOutputs 作为字段提取源）
  - `hasAdvancedTransitionCondition` 纳入字段条件（next_state 建议不触发高级条件边）
  - 两处转移规则提示词展示条件摘要

## 修复验证新路由（与旧特判语义逐条对齐）

| 优先级 | 条件 | 目标 |
|-------|------|------|
| 1 | pass | 报告沉淀 |
| 2-6 | fieldMatch `feedback_to_target\|next_state` ~ 问题复现 / 根因 / 方案 / 报告 / 代码修复 | 对应状态 |
| 7-9 | fieldAbsent + outputMatch（修订黄金标志/回退方案/分支B；回退根因；Demo 有误回问题复现） | 对应状态 |
| 10 | fieldNotEquals `run_verification.engine_aligned\|engine_aligned` = true | 报告沉淀 |
| 11 | 默认 | 代码修复 |
| 12-21 | fail 同构 | 同上 |

关键保真点：结构化 feedback_to_target 存在时散文回退不生效（fieldAbsent）；feedback=代码修复 时即使 engine_aligned 缺失也回代码修复（优先级 6 先于 10）；engine_aligned 缺失按"未对齐"处理回报告沉淀（与旧 `extractEngineAligned !== true` 口径一致）。

## 验证

- 新增 `tests/state-machine-field-routing.test.ts`（44 用例）：双 YAML schema 校验 + 引擎三路转移断言 + 修复验证 12 个路由场景（对齐旧特判测试用例）+ 方案设计对抗结构与 4 个路由场景 + 其他状态回归
- 更新 `tests/state-machine-verdict.test.ts`：删除已移除函数的用例，新增 resolveOutputField/matchTransitionFieldConditions 等 16 个纯函数用例
- vitest 全量对比：改动后 15 失败 vs 基线（stash 后）28 失败——所有失败均为预存（他人 WIP/环境相关），本次改动零新增失败；基线上新测试文件在无引擎改动时 4 个路由用例失败，证明测试真实覆盖新机制
- `npx tsc --noEmit`：src/ 零报错（tests/ 的报错为预存，与本改动无关）
- eslint：6 个改动文件零告警

## ⚠️ 部署注意（未部署）

本次只改了仓库源码与配置，**尚未部署到运行中的服务**（pid 340665，生产模式跑 dist/.next + ~/.aceharness/configs）：

1. 仓库 src/ 还有他人未提交的 WIP（extractBaseBranch/fallbackBranch 等），现在 `npm run build` 会把半成品编译进去——等 WIP 落地后再构建
2. **禁止只 `npm run sync:configs` 不同步引擎**：旧引擎的 matchCondition 会忽略新条件键，fieldMatch 边退化为裸 verdict 边（cpass 会错误路由到优先级 2 的问题复现）
3. 正确部署顺序：`npm run build` → 重启服务 → `npm run sync:configs`（三者一次完成）
