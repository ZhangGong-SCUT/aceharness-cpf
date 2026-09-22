---
name: gitcode-pr-review
description: >-
  只处理白名单作者在 GitCode 上仍开着的 PR：听 Webhook → 按 DCP 标签/评论分类 →
  修 DCO/静态检查/编译/AI 检视 → push 到 fork → 评论 start build → 再等。
descriptionZH: 监听自己的 GitCode PR。按门禁类型修，推回 fork 后评论 start build，不要自动合入。
tags:
  - GitCode
  - PR
  - DCP
  - Webhook
source: aceharness
---

# 自己的 GitCode PR 自修

准入规则（满足其一即"自己的 PR"）：
1. `ACE_GITCODE_PR_AUTHOR` 白名单作者——约束 Webhook 自动启动；
2. `manual-start-by: <GitCode用户名>` 标记（AIWeb 手动开启时注入 globalContext）——
   该情况下校验 **PR 作者 = manual-start-by 本人**，白名单不适用（任何登录用户都能监控自己的 PR）。
两条都不满足、或已关闭/已合入：直接停。

不要用 `/commits/{sha}/status`。这个仓的门禁在 **标签** 和 **`openharmony_ci` 评论** 里。
不要自动评论 `submit`，不要合入。测试失败默认停下来问人。

## 产物

| 文件 | 用途 |
|------|------|
| `outputs/gate-check.json` | phase、标签、CI 评论、fork 信息 |
| `outputs/ai-review.md` | PR 上已有的 AI 检视意见 |
| `outputs/ai-review-comments.json` | 检视意见结构化数据 |
| `outputs/fix.patch` | 本轮修复 diff |
| `outputs/pr-comment.json` | 已发的 `start build` |

`gate-check.json` 的 `phase`：

`running` | `need_start_build` | `static_failed` | `compile_failed` | `test_failed` | `dco_failed` | `ai_review_pending` | `green` | `blocked_no_issue` | `unknown`

优先级：**DCO → 静态检查 → 编译 → AI 检视 → 测试（人工）**。
静态检查失败且编译还 pending 时，phase 必须是 `static_failed`。

## 1. 识别

记下 `owner` / `repo` / `number`、`head_ref`、**`head_repo`（fork 全名）**、`base_ref`。

## 2. 等待门禁

```powershell
node "<SKILL_ROOT>/scripts/check-pr-gates.mjs" --pr-url "<PR_URL>" --author "<PR作者>" --out outputs
```

`phase=running` 就挂起等 Webhook，不要 sleep 空转。
欢迎评论没到之前不要 `start build`。不要等 `AI已检视`。
`check-pr-gates.mjs` 以 `pulls/{n}/comments` 为准。GitCode 的 Issue 号和 PR 号独立，不要把 `issues/{n}/comments` 里同号 Issue 的评论当成已经 `start build`。

**门禁失败重试**：DCP 门禁对同一份代码存在抖动（社区 PR 同代码重发 `start build` 后直接通过）。
静态/编译失败且当前代码版本的 `start_build_count < start_build_max`（默认 3，环境变量 `ACE_GITCODE_START_BUILD_MAX`）时，
phase 会返回 `need_start_build`：**不改代码、不 push，直接重发 `start build` 再试**。
**测试失败的抖动识别**：冒烟测试失败但最近一条门禁评论里的失败详情**全部是 `ecotest timeout`**（含 `failed(IGNORE)`，
#1927/#1978 同款平台抖动、无断言失败）时，同样走 `need_start_build` 重试，预算内不进人工确认；
混入任何真实断言失败、裸 `failed`（无原因）或预算用完，仍按 `test_failed` 人工确认。
但 `check-pr-gates.mjs` 检测到静态失败时会先拉 DCP codeCheck 明细（`fetch-dcp-report.mjs`），
`dcp_defect_count > 0`（真实缺陷，文件/行/规则可查）时跳过重试直接进静态修复；拉不到明细才走抖动重试。
限流判定只认「限流评论之后 CI 又开始过构建」之前的窗口——CI 重新接受过 start build 即视为已解除。
重试用完仍失败才进静态修复/编译修复。新 push 会重置重试预算。CI 已开始重跑时 phase=running，不要重复发。

分流：

```powershell
node "<SKILL_ROOT>/scripts/route-pr-phase.mjs" --from 分类处置 --in outputs/gate-check.json
```

`--from` 还可以是 `分流静态` / `分流编译` / `分流测试` / `分流检视` / `分流触发`。

## 3. 修复

checkout **fork** 的 `head_ref` 到 `repo/`；已有则 fetch。本阶段不要 commit、不要 push。
不要在步骤里编 Flutter/OH 全量工程。

- **DCO**：只补 `Signed-off-by`
- **静态**：先跑 `fetch-dcp-report.mjs` 拉 codeCheck 失败明细（文件/行号/规则/代码片段），对着明细改；
  再跑 `scan-same-rule-defects.mjs` 对 PR 新增行做同规则扫雷，同类问题一并修（DCP 一次只报一处，逐轮修浪费 CI）
- **编译**：对着 DCP 编译日志改
- **检视**：跑 `fetch-ai-review.mjs`；`actionable_count=0` 不要空改。`comments[]` 是当前代码的待处理意见（AI 检视 + 人工行内评论）；`stale_comments` 是已被后续 push 覆盖的旧意见，不要据此修改（兜底可用 `--include-stale` / `--include-conversation`）

```powershell
node "<SKILL_ROOT>/scripts/fetch-dcp-report.mjs" --report-url "<gate-check.json 的 report_url>" --out outputs
node "<SKILL_ROOT>/scripts/scan-same-rule-defects.mjs" --pr-url "<PR_URL>" --author "<PR作者>" --defects outputs/dcp-codecheck-defects.json --out outputs
```

同规则扫雷只扫 PR 自己改动的行（`same-rule-candidates.json` 的 `candidates`），不改 PR 未触碰的存量代码；
`needs_escape: true` 的行（字符串内含单引号）改写时注意转义。

DCP 被 WAF 保护（华为云 jsagent JS 挑战），纯 HTTP 会拿到 404 壳页；脚本用 playwright 无头浏览器过 WAF 后调 `codecheckAccess` 匿名 API。
报告 URL 里自带 eventId 和 taskId，无需登录态。输出 `outputs/dcp-codecheck-defects.json`。

## 4. 推送并触发

有改动才 commit。提交必须带 DCO（`git commit -s`）。**提交身份必须复用 fork 历史提交的作者**（`git log -1 --format='%an <%ae>'`），禁止编造邮箱——DCO 校验 Signed-off-by 邮箱须与 GitCode 账号一致。
push 到 **`head_repo` 的 `head_ref`**，禁止 `--force`。
远程 URL 带上作者用户名，才能用对那个人的 git 凭据：`https://{author}@gitcode.com/{head_repo}.git`。

第一次欢迎之后、或刚推完代码，评论恰好一行（脚本 POST 到 **pulls/comments**，不要发到 issues）。必须传 `--author`，用该作者自己的 `GITCODE_TOKEN_{用户名}`：

```powershell
node "<SKILL_ROOT>/scripts/post-pr-comment.mjs" --pr-url "<PR_URL>" --author "<PR作者>" --body "start build" --out outputs
```

无改动且不是 `need_start_build`：不要空 commit，也不要空评论。
`need_start_build` 的 CI 抖动重试（无改动）：不 commit、不 push，只重发 `start build`。
**刚 push 过的必须等确认再评论**：GitCode 的 MR 更新事件异步滞后（实测 ~70s），抢先评论会让 DCP 把刚启动的构建按「代码有更新」中止。加 `--wait-push-ack --since <push完成时间ISO>`，脚本会轮询等「监测到PR/代码有更新/感谢提交」确认评论出现再发（默认超时 120s，超时仍发出并标记 `wait_ack=timeout`）：

```powershell
node "<SKILL_ROOT>/scripts/post-pr-comment.mjs" --pr-url "<PR_URL>" --author "<PR作者>" --body "start build" --wait-push-ack --since "<push完成时间>" --out outputs
```

禁止 `--body submit`。

## 过滤

- `ACE_GITCODE_PR_AUTHOR`：作者白名单，逗号分隔
- `ACE_GITCODE_WATCH_REPOS`：正式环境用 `CPF-Flutter/flutter_flutter`
- `ACE_GITCODE_START_BUILD_MAX`：同一代码版本 `start build` 重试上限，默认 3；新 push 重置
- Token：每人一条 `GITCODE_TOKEN_{用户名}`。评论 `start build` 和 HTTPS push 必须用该 PR 作者自己的密钥，不要拿别人的覆盖。未匹配到具体人时才回退 `GITCODE_TOKEN` / `ACE_GITCODE_TOKEN`。

Webhook 勾 **Merge Request** 和 **Note**。同一条 PR 已有 run 时只唤醒，不新开。
