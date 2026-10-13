# 2026-10-13 训练审计修复复核（R01–R08）返修记录

时间：2026-10-13 13:30–15:10（北京时间）。背景：并行审核会话产出 `issue-training-review/2026-10-13-修复复核报告.md`，对 F01–F12 修复提出 8 项返修（R01–R08），并附 8 个独立验收探针（`review-20261013/review.test.ts`），初审 6 失败。本文件记录逐项返修内容与验证结果。

## 返修清单（问题 → 方案 → 验证）

| 编号 | 复核指认 | 本次修复 | 验证 |
|---|---|---|---|
| R01 | 引用/示例里的 pass JSON 会盖过真实 fail 裁决 | `result-channel.ts`：HTML 注释、markdown 引用块、"示例/例如/example"语境的 fenced JSON 全部划为不可信区，step-conclusion/result/fenced/inline/prose 各层统一在可信区提取；可信来源 verdict 冲突写入 `conflicts` 字段 | 独立探针 R1/R7 通过；result-channel 27 例全绿 |
| R02 | 正常路径丢失 conditional_pass 原因 | `workflow-manager.ts`：`parseVerdict` 同一次解析同步替换 verdict 与 reason（每轮覆盖，不继承旧原因）；恢复路径经 `readStepLogOutput` 优先读 outputRef 完整输出 | 探针通过 |
| R03 | 一致性检查读错产物（只读摘要 md）且误报诚实复用 | `diagnosis-script-step.ts`：报告文本取归档 md 与 step-logs(outputRef) 并集；矛盾检测改为句子级——绝对性否认（未执行/无证据）且无范围限定词（本轮/复现阶段已覆盖等）才告警；以 #1941 真实矛盾句为阳性、#1919 诚实复用句为阴性重写测试 | 探针×2 通过；consistency 8 例全绿 |
| R04 | 归档白名单漏掉报告引用的构建日志 | 引用驱动归档：扫描报告与修复验证输出中的 `outputs/<file>` 引用，存在即复制（role=referenced），缺失显式记 missing 并降级 overall=partial；fix.patch 按 problem_ownership 区分 missing/not_applicable | 探针通过（i1941_android_build.log 被归档） |
| R05 | 本地 origin 的 restore 仍抛 Invalid URL | `restore()`：URL 校验与镜像缓存改用 `canonical_url \|\| url`，`remote_kind=local` 走本地克隆路径，不再对本地路径 `new URL` | 探针通过 |
| R06 | 归档失败不进终态门禁；partial 在 verdict 枚举外；前端未消费 | finish 结果 verdict 回归三值枚举（complete/partial→pass、failed→fail），artifact_status 独立呈现；manager 钩子直读 artifact_status 字段；`shouldFinalizeDiagnosisAsCompleted` 对 artifact failed 一票否决并提示"可只重试归档"；CPF 列表/状态接口透传 artifactStatus/verificationStatus，前端渲染"归档失败/归档不完整/验证受限/证据不全"徽标 | 探针通过；CPF node:test 14/14 |
| R07 | 运行时配置（~/.aceharness/configs）与仓库模板漂移无机制 | 新增 `scripts/sync-runtime-config.mjs`：--check 报告逐文件 sha256 与活跃 run 引用（exit 1 表示漂移）；--apply 仅单文件、时间戳备份、活跃 run 未 --yes 拒绝、写 .sync-log 审计。实机确认 cpf-ohos-diagnosis.yaml 漂移（模板 3cab82b3 vs 运行时 c4864399）；apply 待 #1761/#2893 完成后执行 | 沙箱演练 check→apply→备份→幂等通过 |
| R08 | SDK 隔离与 HAR 安装门禁未形成执行闭环 | 新增 `src/lib/workflow/sdk-overlay.ts`：symlink 镜像 + bin/cache（含祖先目录）实体可写副本，写入不触碰共享 SDK；`persistOhosFlutterSdkPin` 命中共享 SDK 时自动建 overlay 并把 pin 的 flutterBin/sdkRoot 指向 overlay（失败降级共享 + 指纹检测兜底）；新增 `scripts/ohos-har-install.mjs` 安装门禁（BuildProfile 模式/target 比对 + HAR 来源路径校验 + sha256 记录，拒绝不装）；yaml 强制安装走门禁脚本 | tests/sdk-overlay 6 例全绿（合成 SDK 树 + 合成 HAR tar 夹具） |

## 全量验证

- ACEHarness vitest：1307 例，13 失败全部为修复前既有基线（chat-context/NewConfigModal/opencode-sdk-wrapper/workflow-creation*，stash 验证过）；`sidebar-plugins` 单测在全量下偶发时序失败、隔离复跑两次全绿（flake，与本改动无关）。
- 独立验收探针（复核方提供，未修改）：**8/8 通过**。
- CPF node:test：14/14 通过。
- `tsc --noEmit`：触及文件无错误。

## 部署窗口说明（如实记录）

- 本轮回合 ACEHarness 代码（R01–R06、R08）**未构建、未重启**：#1761（run-1791868283873）与 #2893（run-1791873236351）正在线上运行，重启会杀死工作流。待两 run 终态后 `npm run build && systemctl --user restart aceharness`。
- 运行时配置同步（R07 --apply）同样推迟到该窗口，避免改变在途 run 的验收规则（其恢复快照已隔离，但遵守复核约束）。
- CPF 侧（R06 接口透传、F03/F08/F09）为普通 node 服务，提交后重启 aiweb-backend 即生效，不影响引擎内运行的 run。

## 追加：#1761 终态复盘发现的压缩缺陷（commit 29f29ae，已修复）

- 现象：#1761（2026-10-13 16:18 终态 failed）修复验证步骤输出 36KB，`outputRef` 落盘文件仅 8.5KB 且无 step-conclusion；终态门禁报"conditional_pass 且未记录具体原因"。
- 根因：`compactRuntimeOutputPreview` 用贪婪正则配对的 `<step-conclusion>` 匹配，被 grep 工具输出里**引用的、未闭合的同名开标签**带偏——伪匹配从引文开标签一路吞到真实结论的闭合标签（~15.7KB），起点位于 ace-process 工具区被过滤、且超过 8192 保留上限，输出退化为纯头部截断，真实裁决（conditional_pass，原因"无 OHOS 设备"）整体丢失。
- 修复：`findStepConclusionSpans` 就近配对（闭合标签与最近未配对开标签配对，引文未闭合开标签被后续开标签覆盖丢弃）；`result-channel.getStepConclusionJson` 同样改造。回归测试含 #1761 真实 36KB 流端到端用例（压缩后可提取 verdict=conditional_pass）。
- #1761 结论恢复后评估：verdict=conditional_pass 属实（无 OHOS 设备，运行时黄金标志待真机），门禁判 failed 是**正确的不粉饰行为**；修复补丁与官方 !1101 的对比已补入训练台账 fix-vs-official-comparison.md（机制等价、互有超出、盲测有效性受限因仓内 3.35.7 线已含官方修复）。

## 追加二：#1712 事后验证发现的原因提取缺口（commit a500ecc，已修复并上线）

- 现象：#1712（2026-10-13 22:12 终态 failed）已携带全部返修成果运行，outputRef 完整保留 7.9KB 真实 `<step-conclusion>`（29f29ae 压缩修复生效），终态 verdict=conditional_pass 正确，但 statusReason 仍报"验证步骤未记录具体原因"。
- 根因（两处，均非 R02 存取逻辑）：
  1. `extractConditionalReason` 语法只覆盖 `conditional_reason` 键与"…的原因：…"散文，未覆盖真实输出变体「运行验证未执行：无 OHOS 设备（hdc [Empty]）+ 引擎不对齐（决定性）」与「verdict=**conditional_pass**（括注）」；
  2. inline 层 `coerceInlineValue` 对 `verdict=**conditional_pass**（engine_aligned=false 路由报告沉淀）` 原样保留加粗残余与括注，loose fields 的 verdict 带噪声（下游 parseWorkflowVerdict 走 step-conclusion 正则路径未受影响，故门禁 verdict 仍正确）。
- 修复：原因提取按 structured > 的原因 > 未执行 > 括注 优先级新增两变体；`coerceInlineValue` 全局剥离 `**`，枚举型字段（verdict/problem_ownership/fix_target/verification_status/evaluation_mode/input_source 及布尔键）只取首词元，自由文本字段不截断。
- 验证：#1712 真实 7.9KB 结论端到端回归（verdict=conditional_pass 净值、reason=无 OHOS 设备（hdc [Empty]）+ 引擎不对齐（决定性）、issue_golden_flag_met=false）；result-channel 14/14、复核探针 8/8、全量 1309 例维持 13 失败既有基线。已构建重启（HTTP 200）。
- #1712 其余在线验证结论：R07 配置快照 hash=def8eb44 ✓；R08 overlay+pin 替换+共享 SDK 完整性 clean ✓；R04 归档 22 条 complete（fix.patch 按 business_code 豁免 not_applicable）✓；R06 三处（state.yaml/live-status/CPF metadata）状态一致 ✓；F12 未实战（无设备），Agent 依提示词主动拒绝降级 HAR 投递。

## 备注

- 归档文档首页"6 个真实 Issue 回放"已更正为"4 个真实 Issue、共 8 次运行（#1919×5、#1941、#2856、#1772）"（按 run 目录 diagnosis-input.json 逐一核对）。
- R07 工具发现的运行中用户任务 #2893（issue_url 通道，2026-10-13 13:53 提交）非本训练提交，串行提交约束仅覆盖训练回放（#1761→#1712）。
