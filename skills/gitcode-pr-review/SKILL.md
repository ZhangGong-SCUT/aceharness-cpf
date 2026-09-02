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

只处理 `ACE_GITCODE_PR_AUTHOR` 白名单作者的 PR。他人 PR、已关闭/已合入直接停。

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
node "<SKILL_ROOT>/scripts/check-pr-gates.mjs" --pr-url "<PR_URL>" --out outputs
```

`phase=running` 就挂起等 Webhook，不要 sleep 空转。
欢迎评论没到之前不要 `start build`。不要等 `AI已检视`。

分流：

```powershell
node "<SKILL_ROOT>/scripts/route-pr-phase.mjs" --from 分类处置 --in outputs/gate-check.json
```

`--from` 还可以是 `分流静态` / `分流编译` / `分流测试` / `分流检视` / `分流触发`。

## 3. 修复

checkout **fork** 的 `head_ref` 到 `repo/`；已有则 fetch。本阶段不要 commit、不要 push。
不要在步骤里编 Flutter/OH 全量工程。

- **DCO**：只补 `Signed-off-by`
- **静态**：对着 codeCheck / 静态检查报告改
- **编译**：对着 DCP 编译日志改
- **检视**：跑 `fetch-ai-review.mjs`；`actionable_count=0` 不要空改

## 4. 推送并触发

有改动才 commit。提交必须带 DCO（`git commit -s`）。push 到 **`head_repo` 的 `head_ref`**，禁止 `--force`。

第一次欢迎之后、或刚推完代码，评论恰好一行：

```powershell
node "<SKILL_ROOT>/scripts/post-pr-comment.mjs" --pr-url "<PR_URL>" --body "start build" --out outputs
```

无改动且不是 `need_start_build`：不要空 commit，也不要空评论。
禁止 `--body submit`。

## 过滤

- `ACE_GITCODE_PR_AUTHOR`：作者白名单，逗号分隔
- `ACE_GITCODE_WATCH_REPOS`：正式环境用 `CPF-Flutter/flutter_flutter`
- Token：`GITCODE_TOKEN` / `ACE_GITCODE_TOKEN`

Webhook 勾 **Merge Request** 和 **Note**。同一条 PR 已有 run 时只唤醒，不新开。
