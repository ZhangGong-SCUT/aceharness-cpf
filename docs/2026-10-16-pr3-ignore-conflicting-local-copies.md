# PR #3：忽略与上游删除冲突的本地副本

时间：2026-10-16 16:50（Asia/Shanghai）。

PR：https://gitcode.com/huangyouhua/ACEHarness/pull/3。

源分支：`z2036709353/ACEHarness:cpf-ohos-issue-diagnosis`，修改前提交 `c22619948f473ca75056829b68e0e1886dbcf98e`。

目标分支：`huangyouhua/ACEHarness:cpf-ohos-issue-diagnosis`，核对时提交 `6d6cae0ca6a70b46b5bf5a2aaa0914ff1d8696da`。

## 问题

上游提交 `95df027` 删除了旧工作流与两组外置维护的 Skill 副本，后由 `9256701` 收敛为只删除副本。源分支基于共同祖先 `ed2922c` 继续修改其中 6 个文件，产生修改/删除冲突。原始 `git merge-tree --write-tree` 返回退出码 1，并明确列出这 6 个冲突。

仅增加 `.gitignore` 不能忽略已被 Git 跟踪的文件。用户明确要求忽略这些文件后重新提交。

## 方案

对以下 6 个文件执行 `git rm --cached`，同时加入根目录 `.gitignore` 的精确路径规则：

- `configs/flutter-ohos-diagnosis.yaml`
- `skills/cpf-ohos-issue-analysis/references/common-experience.md`
- `skills/cpf-ohos-issue-analysis/references/fix-strategy.md`
- `skills/cpf-ohos-issue-analysis/references/issue-content-collection.md`
- `skills/cpf-ohos-issue-analysis/scripts/look-at-image.mjs`
- `skills/flutter-issue-demo-reproduction/SKILL.md`

提交记录中的删除与上游的删除一致；本机文件继续存在并被忽略。操作范围只涉及这 6 个路径、忽略规则及本归档。

## 验证结果

- 获取当前目标分支并核对源分支远端提交，确认本次基线。
- 将暂存的 `.gitignore` 和 6 项取消跟踪写成临时 Git 提交对象（不移动分支），与目标提交 `6d6cae0` 运行 `git merge-tree --write-tree --name-only --messages`：退出码 **0**，无冲突路径；模拟合并树为 `4ecf999f087fb572a2d10dee31bcd828d52a6cf3`。
- `git check-ignore -v`：6 个路径均命中各自的精确忽略规则。
- 对照操作前 SHA-256：6 个本地文件均仍存在，内容完全一致。
- `git diff --cached --check` 未发现空白错误。本次没有更改运行中的文件内容，验证重点为 Git 合并、跟踪及本地副本保留行为。

## 范围说明

本次解决上述 6 项 Git 合并冲突。没有将其他未提交修改纳入提交。新增的 `build-engine.mjs`、`device-lock.mjs`、`repo-cache.mjs` 等仍按原分支保留；本次不代表外置 Skill 的依赖迁移或新环境部署已经完成验收。

最终提交推送后，还需以 GitCode 对更新后 PR 的冲突检查为准；本地模拟结论对应上述固定目标提交。
