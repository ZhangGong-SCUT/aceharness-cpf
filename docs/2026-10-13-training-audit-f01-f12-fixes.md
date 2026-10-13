# 2026-10-13 训练审计 F01–F12 平台修复归档

## 背景

训练评审（`issue-training-review/2026-10-13-训练流程问题与改进方案.md`）在 4 个真实 Issue、共 8 次运行回放（#1919×5、#1941、#2856、#1772）中发现 12 个平台问题（F01–F12）。本次提交落地其中 9 项完整修复、3 项部分修复（F09/F10/F11 剩余项见台账）。

## 问题 → 方案 → 验证

| 编号 | 问题 | 方案（本仓库改动） | 验证 |
|---|---|---|---|
| F01 | 收尾脚本失败被 run=completed 掩盖（本地路径 origin 使 `new URL` 抛 "Invalid URL"） | `sanitizeGitRemote` 分类不抛异常；逐仓 try/catch；save 逐目标容错；`classifyDiagnosisScriptError` 错误码；workflow-manager 将 finish 结论持久化为 `diagnosisArtifactStatus`（state.yaml→summary.json→status API） | tests/diagnosis-finish-artifacts.test.ts：崩溃场景不再崩，归档不可写→fail+错误码 |
| F02 | 结构化结果格式不统一，散文字段丢失被当 false | `result-channel.ts` `extractLooseStructuredResult` 分层提取（step-conclusion JSON > result 标签 > fenced json > 白名单散文 key=value > 否定防护散文），逐字段 provenance，unknown 不伪造 | tests/diagnosis-loose-extraction.test.ts 14 例（用 R7 真实输出） |
| F03 | 盲测输入在线采集暴露答案 | `readIssueSnapshot`（路径限定 `~/.aceharness/eval-inputs/` + sha256 校验 + 256KB 上限）；collectIssue 快照分支（input_source=provided_snapshot，issue-url 仅作仓库身份） | tests/diagnosis-snapshot-input/chain 共 5 例；6 个脱敏输入逐字节一致 |
| F04 | conditional_pass 原因笼统 | 门禁携带 conditionalReason（`extractConditionalReason` 兼容结构化与散文"唯一原因"）；`diagnosisVerificationStatus` 持久化并透出 | tests/state-machine-verdict.test.ts +2 例 |
| F05 | 归档不完整无法机器发现 | 证据复制 + `diagnosis-archive-manifest.json`（sha256/bytes/status），fix.patch 强制归档 | finish 集成测试验证 manifest |
| F06 | 报告与证据矛盾 | `checkReportConsistency` 交叉告警（Android 证据/验证状态两类）+ yaml 证据一致性条款 | tests/diagnosis-report-consistency.test.ts 7 例（用 R6 真实句式） |
| F07 | 引擎失败消息空 `{}` 无法分类 | `describeSdkError` 展开 code/status/exitCode/stderr 尾并脱敏；session/spawn 两处接入 | tests/describe-sdk-error.test.ts 6 例 |
| F10(部分) | token 全零与"零消耗"不可区分 | summary.json 增加 `tokenUsageSource`/`tokenUsageCoverage`；引擎侧采集留后续 | tsc + 全量回归 |
| F11(部分) | 共享 SDK 无按 run 隔离 | preflight 建 `<runDir>/sdk-overlay/`（路径含 runId）+ 共享 HAR 指纹基线；finish 复核 diff，改动即告警 | tests/diagnosis-sdk-isolation.test.ts 4 例 |
| F12 | HAR release/debug 错配致验证返工 | `inspectHarBuildProfile` 读 HAR 内 BuildProfile.ets 写入 manifest；yaml 安装前模式预检 | 用真实 release HAR 验证读出 release |

配套改动：`live-status.ts` 透出诊断状态；`ohos-flutter-sdk.ts` 提示语指向 sdk_overlay（该文件含他人未提交 hunk，已用 `git apply --cached` 仅暂存本行）；`configs/cpf-ohos-diagnosis.yaml` 报告沉淀/修复验证条款。

## 验证总览

- `npx vitest run`：1300 测试，13 个失败全部为基线既有（stash 对照同一集合，与本次无关），新增 40+ 全绿。
- `npx tsc --noEmit`：改动文件零错误。
- CPF-AIWeb 侧（F03/F08/F09）在 CPF 仓库独立提交归档。

## 遗留

F02 写入侧统一 schema、F10 引擎侧采集、F11 双 run 并行在线验收——见 `issue-training-review/run-20261012/fix-ledger.md`。
