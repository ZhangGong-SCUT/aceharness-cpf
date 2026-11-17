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
| `outputs/gate-check.json` | phase、标签、CI 评论、fork 信息；`log_verdict`/`root_cause_verified`/`log_reasons`/`log_evidence`（日志核对），`retry_budget_exhausted`/`needs_maintainer`/`maintainer_hint`（重试用尽 → 前端提示联系门禁维护人员） |
| `outputs/gate-log-analysis.json` | 门禁日志根因核对（构建日志证据 / 跑测报告是否可读） |
| `outputs/ai-review.md` | PR 上已有的 AI 检视意见 |
| `outputs/ai-review-comments.json` | 检视意见结构化数据 |
| `outputs/fix.patch` | 本轮修复 diff |
| `outputs/pr-comment.json` | 已发的 `start build` |

`gate-check.json` 的 `phase`：

`running` | `need_start_build` | `static_failed` | `compile_failed` | `test_failed` | `dco_failed` | `ai_review_pending` | `green` | `blocked_no_issue` | `unknown`

优先级：**DCO → 静态检查 → 编译 → AI 检视 → 测试（人工）**。
静态检查失败且编译还 pending 时，phase 必须是 `static_failed`。

## 1. 识别

引擎用环境变量 `ACE_NODE`（当前 Node 的绝对路径）执行 `skills/gitcode-pr-review/scripts/validate-pr-identity.mjs --out outputs`，并读取 `outputs/pr-identity.json`。
记下 `owner` / `repo` / `number`、`head_ref`、**`head_repo`（fork 全名）**、`base_ref`。
作者白名单 `ACE_GITCODE_PR_AUTHOR` 和令牌 `GITCODE_TOKEN_<作者>` 由脚本读取。不要用 `where node`、注册表或手写 curl 重新识别。空的 `GITCODE_TOKEN` 不是失败。

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
这层是**评论字符串**判定；一旦拉到跑测报告（见下"门禁日志根因核对"）就以报告为准：
`harness_env_failure`（平台/环境侧）继续重试，`test_assertion`（真断言失败）立即停手。
但 `check-pr-gates.mjs` 检测到静态失败时会先拉 DCP codeCheck 明细（`fetch-dcp-report.mjs`），
`dcp_defect_count > 0`（真实缺陷，文件/行/规则可查）时跳过重试直接进静态修复；拉不到明细才走抖动重试。
限流判定只认「限流评论之后 CI 又开始过构建」之前的窗口——CI 重新接受过 start build 即视为已解除。
重试用完仍失败才进静态修复/编译修复。新 push 会重置重试预算。CI 已开始重跑时 phase=running，不要重复发。

**门禁日志根因核对（防"抖动"臆断）**：有失败标签时 `check-pr-gates.mjs` 自动拉门禁日志，写 `outputs/gate-log-analysis.json`：

- **构建日志可下载**（CI 评论里的 `.../log/build.log` 是指针文件，正文指向 `build.log.zip`，实为未压缩 tar），可证实三类结论：
  `compile_error`（有明确编译错误 → 确定性问题，不重试）；`infra_failure`（拉镜像/分配执行节点等基础设施错误 → 平台问题）；
  `build_script_failure`（脚本/tbuild 失败但无编译错误证据 → 根因未确认）。
- **跑测报告可读**：评论里的 `download.ci.openharmony.cn` 是内网别名（本机不可解析），但同一路径在
  `cidownload.openharmony.cn` 可达 → 脚本自动改写镜像域名下载 `report.zip`，读 `report_data.json` / `summary.ini` /
  `result/*.xml` / `log/*/module_run.log` 归因，得到两类结论：
  - `harness_env_failure`（用例**未执行到断言**：测试框架/环境准备失败，如切换 Flutter 版本时 `flutter_flutter PR worktree sync failed`）
    → **平台/环境侧，不是 PR 代码问题**（已验证），可按抖动预算重发 `start build`；
  - `test_assertion`（用例真跑了并失败，`run=N pass=M failure=K`，K>0）→ 确定性问题，不重试。
  取不到报告时才降级为 `test_stage_unverified`。

`gate-check.json` 的 `root_cause_verified` = 根因是否有**日志证据**。为 `false` 时 summary 会写明"根因未验证"，
**禁止**对外断言"平台抖动"（此时仍可按抖动预算重试，但人工确认/评论里必须说明根因未验证）。`ACE_GITCODE_GATE_LOGS=0` 可关闭核对。
日志证据升级为确定性（编译错误/真实断言失败）时，脚本不再烧抖动重试预算，直接进对应修复；
`harness_env_failure` 为已验证的**平台侧**结论，重试文案会直说"不是 PR 代码问题"，不再用"疑似抖动"含糊措辞。
**重试预算用尽**（普通 + 抖动都用完）且非代码问题时，`gate-check.json` 置 `needs_maintainer=true`、`maintainer_hint` 写明原因并
提示"请携带门禁报告链接联系门禁维护人员"；`log_platform_verified=true` 表示日志已核实属门禁/平台侧（此时才可说"不是 PR 代码问题"），
否则为"根因未核实，需维护人员协助排查"。CPF-AIWeb 前端在 PR **普通详情**（`/status` 的 `gateDiagnosis`）与"检视修复"面板
（`gateSummary`）都渲染"门禁根因（日志核对）"与"联系门禁维护人员"提醒块。

**只读补查**（产物由旧版分类脚本写出、缺日志核对字段时）：`check-pr-gates.mjs --from-source <gate-source.json>` 会从已保存的
快照重放分类（不访问 GitCode、不评论、不触发构建），生成带新字段的 `gate-check.json`，并保留原 `checked_at`、附 `rechecked_at` /
`recheck_source` / `recheck: true` 以示这是补查而非新一次 CI 执行；覆盖已有产物时（非 `--from-source`）也会把旧 `checked_at` 记入
`previous_checked_at`。

```powershell
node "<SKILL_ROOT>/scripts/check-pr-gates.mjs" --owner CPF-Flutter --repo flutter_flutter --number 2084 `
  --from-source outputs/gate-source.json --out outputs
```

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
**刚 push 过的必须等确认再评论**：GitCode 的 MR 更新事件异步滞后（实测 ~70s），抢先评论会让 DCP 把刚启动的构建按「代码有更新」中止。必须传有效的 `--wait-push-ack --since <push完成时间ISO>`，脚本会轮询等「监测到PR/代码有更新/感谢提交」确认评论出现再发（默认超时 120s）。缺少或传入非法起点、确认超时都会停止发表评论，由上层显式失败后重试：

```powershell
node "<SKILL_ROOT>/scripts/post-pr-comment.mjs" --pr-url "<PR_URL>" --author "<PR作者>" --body "start build" --wait-push-ack --since "<push完成时间>" --out outputs
```

禁止 `--body submit`。

## 过滤

- `ACE_GITCODE_PR_AUTHOR`：作者白名单，逗号分隔
- `ACE_GITCODE_WATCH_REPOS`：正式环境用 `CPF-Flutter/*`；也可用逗号分隔的具体 `owner/repo` 限制范围。未配置时默认只接受 CPF-Flutter 代码仓。
- `ACE_GITCODE_START_BUILD_MAX`：同一代码版本 `start build` 重试上限，默认 3；新 push 重置
- `ACE_GITCODE_GATE_LOGS`：设为 `0` 关闭门禁失败时的日志根因核对（默认开启）
- Token：每人一条 `GITCODE_TOKEN_{用户名}`。评论 `start build` 和 HTTPS push 必须用该 PR 作者自己的密钥，不要拿别人的覆盖。未匹配到具体人时才回退 `GITCODE_TOKEN` / `ACE_GITCODE_TOKEN`。

Webhook 勾 **Merge Request** 和 **Note**。同一条 PR 已有 run 时只唤醒，不新开。
