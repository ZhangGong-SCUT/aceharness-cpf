# GitCode PR 自修工作流（状态机）优化指南

> 适用对象：维护 `configs/gitcode-pr-review.yaml` + `skills/gitcode-pr-review/` 的开发者。
> 目标：让优化工作流的人先找对层，再动手——改错层会导致无法测试的回归。

## 一、工作流的三层结构

PR 自修工作流是「**状态机（编排）+ Agent（智能决策）+ 脚本（确定性工具）」的混合体：

```
┌─────────────────────────────────────────────────────┐
│ 状态机层  configs/gitcode-pr-review.yaml             │
│   状态 / 转移条件 / 轮次预算 / agent 角色分工          │
│   （识别→等待门禁→分类处置→分流→修复→推送→就绪/终止）    │
└───────────────┬─────────────────────────────────────┘
                │ task 指令中声明调用
┌───────────────▼─────────────────────────────────────┐
│ 脚本层  skills/gitcode-pr-review/scripts/*.mjs       │
│   check-pr-gates（门禁判定/预算） route-pr-phase      │
│   fetch-ai-review fetch-dcp-report scan-same-rule    │
│   post-pr-comment （gitcode-token/ohos-pr-gates 被间接引用）│
└───────────────┬─────────────────────────────────────┘
                │ Agent 读取
┌───────────────▼─────────────────────────────────────┐
│ 指令层  SKILL.md + references/gitcode-api.md         │
│   行为约束（不要 submit、只改检视点到的文件…）           │
└─────────────────────────────────────────────────────┘
```

另有 **引擎层**（ACEHarness `src/`，webhook 唤醒 / 调度 / 崩溃恢复）在状态机之下，
一般只在事件丢失、run 卡死时才涉及。

## 二、四层优化对照表

| 层 | 优化它意味着 | 风险 | 验证方式 |
|---|---|---|---|
| ① 脚本层 | 提高判断精度与自动化程度（判得更准、能自动处理的更多） | 低 | `npx vitest run tests/ohos-pr-gates.test.ts`（有单测套件） |
| ② 状态机层 | 改变行为模式（流程走向、轮次预算、角色分工） | 中 | 需跑完整工作流实战验证 |
| ③ 指令层 | 改 agent 行为边界（改什么、何时保守） | 高（LLM 非确定性，无法单测） | 只能实战观察修复质量 |
| ④ 引擎层 | 修基础设施缺陷（唤醒丢失、重启丢 run） | 中（需 rebuild+重启，避开活跃 run） | webhook 模拟 + run 状态核对 |

**决策口诀**：
- 误判 / 漏判 / 该自动的没自动 → 改**脚本层**
- 流程绕路 / 卡顿 / 浪费轮次 → 改**状态机层**
- Agent 乱改 / 超范围 / 不听话 → 改**指令层**（SKILL.md 或状态里的 task 文本）
- 事件丢失 / run 卡死 / 状态不同步 → 改**引擎层**

## 三、脚本层（优化性价比最高）

### 现有脚本与调用关系

| 脚本 | 被状态机引用 | 职责 |
|---|---|---|
| `check-pr-gates.mjs` | 等待门禁 | 拉标签 + openharmony_ci 评论，产出 `gate-check.json`（phase / 预算） |
| `ohos-pr-gates.mjs` | （被 check-pr-gates import） | 门禁判定核心：phase 分类、start build 计数、抖动识别 |
| `gitcode-token.mjs` | （被多脚本 import） | 按作者取令牌，严格隔离（禁借他人令牌） |
| `route-pr-phase.mjs` | 分类处置、分流静态/编译/测试/触发 | 按 phase 决定下一状态 |
| `fetch-ai-review.mjs` | 分流检视、检视修复 | 拉检视意见（带 push 边界过滤，区分 stale/noise/actionable） |
| `fetch-dcp-report.mjs` | 静态修复 | 拉静态检查失败明细（文件/行/规则） |
| `fetch-gate-logs.mjs` | （被 check-pr-gates 调用） | 拉构建日志(tar) 与跑测报告（`download.ci`→`cidownload` 镜像改写）做根因核对，产出 `gate-log-analysis.json`（含 `harness_env_failure`/`test_assertion` 等） |
| `gate-log-analysis.mjs` | （被 fetch-gate-logs/ohos-pr-gates 调用） | 纯解析/归因：tar 读构建日志、zip 读 ecoTest 报告（`report_data.json` 等）→ 结论与证据行 |
| `scan-same-rule-defects.mjs` | 静态修复 | 扫同类缺陷，避免只修报到的这一处 |
| `post-pr-comment.mjs` | 推送并触发 | 发 start build（含 push ack 等待，防构建被中止） |
| `fetch-pr-diff.mjs` | **无引用（遗留死代码，可删）** | .diff 端点已 400，diff 由 check-pr-gates 覆盖 |

### 关键设计（改动前必读）

- **重试预算分账**（2026-09-10 方案 B）：真失败占 `start_build_count`（普通上限 3），
  平台抖动（全部 timeout/基础设施类、无断言失败）占 `jitter_fail_count`（独立上限 5，
  `ACE_GITCODE_JITTER_RETRY_MAX` 可调）。普通预算尽但本轮是抖动 → 抖动预算续命；
  两者皆尽 → 转人工并建议反馈 DCP。背景：PR#1978 三连 ecotest timeout。
- **预算只认 PR 作者本人的 start build**；push（代码更新）会重置版本窗口与预算。
- 修改脚本后：`node --check` → 跑 `tests/ohos-pr-gates.test.ts` → 用真实 PR 评论数据
  造 `gate-input.json` 快速核对（参考 jitter 方案落地时的验证方式）。
- **单测隔离**：webhook 磁盘快照在测试中默认关闭（`tests/setup/disk-snapshot-off.ts`），
  新增会读真实 `~/.aceharness/runs` 的逻辑必须提供同样隔离开关。

### 候选优化点

1. **编译失败摘要脚本**：目前编译失败靠 agent 读 build.log 全文定位首错，
   可新增 `parse-build-error.mjs` 提取首个 error 及上下文，减少 token 消耗与定位轮次。
   （2026-10-16 落地：`gate-log-analysis.mjs` 已能从 build.log 的 tar 成员里
   提取 `compile_errors`/`infra_failures`/`script_failures` 证据行；并已打通跑测报告——
   评论里的 `download.ci.openharmony.cn` 是内网别名，改写为可达镜像 `cidownload.openharmony.cn` 后可下载
   `report.zip`，读 `report_data.json` 得结构化结论：`harness_env_failure`（用例未跑到断言、测试环境准备失败 → 平台侧）
   或 `test_assertion`（`run/pass/failure` 计数，真断言失败 → 代码侧）。实测样本 PR2084/PR2109。）
2. `fetch-pr-diff.mjs` 死代码清理。

## 四、状态机层

### 现有状态一览

识别（3 步）→ 等待门禁（3 步）→ 挂起（等 Webhook）→ 分类处置 → 分流静态/编译/测试/检视/触发
→ DCO/静态/编译/检视修复（各 3 步 + maxSelfTransitions:3）→ 推送并触发 → 人工确认 → 就绪/终止。

### 关键设计

- **对抗性三步**：每个修复状态 = developer 改 → code-hunter（attacker）质疑 → fix-reviewer（judge）裁决。
  fail 转人工确认，conditional_pass 回环（上限 3 次）。
- **挂起省电**：CI 在跑时不 sleep 空转，等 Webhook 唤醒（人工监控模式下唤醒照常放行，
  只拦"启动全新监控"——2026-09-09 pr1978 教训，误拦唤醒会导致 run 永久卡死）。
- **安全底线**：推送到 fork、禁 force push、禁 submit/合入、DCO 邮箱必须复用 PR 原作者
  （1913 事故教训已写进 task 指令）。

### 候选优化点

- CI 单轮 60~90 分钟 × 最多 5 轮抖动 = 最坏约 7 小时。可在推送并触发后引入
  抖动重试退避（首败立即重试、连败逐步拉长间隔），减少无效等待。
- 增加新状态（如"合入后验证"）前，先用真实 PR 走一遍现有全链路评估必要性。

### 修改流程

改 yaml → `npx tsc --noEmit`（配置有 schema 校验）→ 找一个白名单作者的测试 PR 实战跑通
→ 观察 step-logs 三步结论是否符合预期。**禁止只改配置不实战**。

## 五、指令层（SKILL.md / task 文本）

- 约束写在两处：`SKILL.md`（整体规则）与各状态 task 中的自然语言指令。
- 这层**无法回归测试**：修改后只能靠实战 run 的 `outputs/step-logs/` 观察行为是否收紧/跑偏。
- 原则：**没有实战暴露的问题不碰这层**。收紧一条约束（如"只改检视点到的文件"）可能
  让 agent 在合法场景下变得过度保守。
- 每次修改必须在 SKILL.md 变更记录里注明动机（对应哪个 PR 的什么问题）。

## 六、引擎层（ACEHarness src/）

涉及 webhook 唤醒、run 调度、崩溃恢复时才改。注意事项：

- 改后需 `npx next build` + 重启 **3031 服务**——重启会打断活跃 run（挂起中的也会被判
  crashed，2026-09-09 事故：一次重启报废 6 个 run）。**重启前必须核对无活跃 run**，
  有则等终态窗口。
- webhook 人工监控模式只拦 `start`（新启动），不拦 `wake`（唤醒既有 run）；
  磁盘快照让重启后的挂起 run 仍可被唤醒（`ACE_WEBHOOK_DISK_SNAPSHOT=0` 可关，
  单测用）。
- 测试：`tests/pr-review-self-heal-audit.test.ts`（唤醒/并行语义）+
  webhook 模拟请求核对 `woken:true` / `started:false`。

## 七、优化落地的标准动作（Checklist）

1. 定位层：按第二节决策口诀。
2. 脚本层：改 → `node --check` → vitest 相关套件 → 真实 PR 数据核对 → 直接生效（无需重启）。
3. 状态机层：改 yaml → schema 校验 → 测试 PR 实战 → 无回归再合入。
4. 引擎层：改 → tsc/eslint → next build → **确认无活跃 run** → 重启 → webhook 模拟验证。
5. 每次改动同步更新本文档相应小节（脚本表/状态说明/约束动机）。

## 附：历史优化记录

| 日期 | 层 | 内容 | 触发问题 |
|---|---|---|---|
| 2026-09-09 | 引擎 | 人工模式误拦 wake（唤醒）导致 run 永久挂起 | PR#1978 CI 失败后工作流未唤醒 |
| 2026-09-09 | 引擎 | 磁盘快照：重启后挂起 run 仍可被 webhook 唤醒 | 同上（重启丢内存 manager） |
| 2026-09-10 | 脚本 | 抖动分账预算：普通 3 次 + 抖动独立 5 次 | PR#1978 三连 ecotest timeout，预算尽被迫转人工 |
| 2026-09-10 | 脚本 | 挂起等 CI 与真需人工确认在 UI/通知中区分显示 | 用户被"等待人工确认"误导 |
