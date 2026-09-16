# 2026-09-16 rerun-from-step 双缺陷修复 + #2646 从修复验证重跑至 completed

## 时间

2026-09-16 16:20 ~ 17:30(本地)

## 解决了什么问题

### 问题

用户要求 #2646 从出问题的步骤(修复验证)继续运行。调
`POST /api/workflow/rerun-from-step` 后连续三次失败,暴露 state-machine 版
`rerunFromStep` 的两个缺陷:

1. **不恢复工作目录**:加载 workflow config 后没有把
   `context.projectRoot` 指回 `runState.workingDirectory`,agent cwd 落在
   工作流模板目录 `_template` → 在错误目录里 ls 找 run 产物,输出混乱,
   引擎把 ace-process 片段误判为 step 错误 → run failed
2. **不清被重跑 agent 的旧 session**:恢复 agents 时原样带回旧 sessionId,
   旧 session(承载原始 run 全上下文)加载反复超时
   (ACP session/load timeout 30000ms)→ run failed
   (对照:workflow/manager.ts 版 rerunFromStep 有"Clear session IDs
   for agents involved in removed steps",state-machine 版漏了)

另确认参数语义:state-machine 版第二个参数是 **stateName**(如"修复验证"),
不是 stepName——传 stepName 会 throw "找不到状态" 且被 route 的
fire-and-forget `.catch(() => {})` 吞掉,API 仍返回 success。

### 方案(state-machine/workflow-manager.ts rerunFromStep +18 行)

1. config 加载后:`workflowConfig.context.projectRoot = runState.workingDirectory`
2. agents 恢复时:按 config.states 顺序收集 stateName 及后续 state 的全部
   agent,这些 agent **跳过 sessionId 恢复**(开新 session),其余 agent
   照常恢复

### 验证结果(端到端,#2646 重跑)

- 第三次重跑(修复后引擎):修复验证 agent 新 session 正常执行,
  真机复测通过,输出规范 JSON(`"verdict":"pass","engine_aligned":true,
  "issue_golden_flag_met":true`——上一提交的 0b 规范生效)
- 引擎终审放行:报告沉淀 → 完成 → **run.completed**
- CPF-AIWeb 本地任务同步为 `issueanalysis_complete`
- tsc 检查 workflow-manager.ts 无类型错误(报告的 TS 错误均为他人
  tests/ 预存问题);next build EXIT=0

## 涉及文件

- src/lib/state-machine/workflow-manager.ts(+18,rerunFromStep)
- 现场处置:手动清 2646 state.yaml 中 3 个 agent 的 sessionId
  (fix-verifier/reporter/completer)配合旧引擎解围,引擎修复后不再需要
