# 通用经验与约束

本文件汇总跨 Agent 的通用经验和硬约束。各 Agent 的 systemPrompt 不必重复声明这些内容，只需在需要时引用本文件。

## 通用经验（10 条）

1. **上游优先**：先查上游社区是否已有同类问题/修复，再深入自研代码
2. **渐进式深入**：从快速分类到深度分析，分层投入精力
3. **对比分析法**：鸿蒙特有问题，对比 Android/iOS 实现
4. **最小复现法**：构造最小复现 Demo，便于上游提 Issue
5. **日志先行**：先采集完整日志，再分析代码
6. **GitCode 获取锁定降级链**：先打 Issue 正文 API（`/api/v5/repos/{owner}/{repo}/issues/{number}`）再打 comments API。Windows 用 `curl.exe`，不要用 PowerShell 的 `curl`。页面常是 SPA 空壳，抓 HTML 失败不得当成 Issue 为空；乱码先按 UTF-8 重解，禁止猜乱码编标题。再不行才 Cookie/登录态或请用户导出。
7. **证据分级表达**：所有结论按 confirmed / inferred / unverified 分层。confirmed 只能来自 Issue/API、日志、源码、命令结果或上游记录；inferred 必须说明推理链；unverified 必须给出补充验证命令或样本需求。
8. **报告保守表述**：Issue 未明确说明的具体现象（如崩溃、白屏、方向错误、镜像异常）只能写为"可能/推测"，不得写成已验证事实；未编译/未运行验证时，修复状态必须是 skipped 或 needs_runtime_validation。
9. **步骤结论可传递**：每个阶段最终输出必须给下游一个结构化结论，至少包含 verdict、summary、artifact_path、key_findings、missing_evidence；不要只留下工具调用日志或零散 grep/ls 结果。
10. **缺失证据要写影响**：正文、评论、截图、日志、样本、运行环境缺失时，必须说明影响的是分类、根因置信度、修复验证还是上游追踪，避免缺口一路隐身到报告。

## NEVER 列表（17 条硬禁止）

- **NEVER** 在没有完整日志的情况下下根因结论
- **NEVER** 忽略上游社区的已有分析
- **NEVER** 只修复表面症状而不修复根因
- **NEVER** 在未验证修复的情况下声称问题已解决
- **NEVER** 把静态推断的症状表现写成已验证事实
- **NEVER** 把 GitCode SPA 空页面当作 Issue 正文为空
- **NEVER** 先抓 GitCode Issue HTML 当正文，或把 API 乱码猜成标题 — 正文只认 `/api/v5/.../issues/{number}` 的 JSON；Windows 用 `curl.exe`。详见 `references/issue-content-collection.md` 第 0 节
- **NEVER** 在 Issue 正文/评论缺失时输出高置信结论而不列 missing_evidence
- **NEVER** 只输出 ls、grep、read 等过程日志而不输出阶段结论和 artifact_path
- **NEVER** 跳过人工审查直接执行代码修改
- **NEVER** 对偶现问题标记为"已修复"而不提供 trigger_pattern
- **NEVER** 在兜底诊断中只说"不知道"而不提供排查思路
- **NEVER** 修 embedding 后不读 Demo 的 `oh-package.json5` / `oh_modules/.ohpm/lock.json5` 就盖 `flutter.har` — 应用侧 `@ohos/flutter_ohos` 常指向 `flutter_embedding_${mode}.har`。盖错文件时黄金标志仍在，看起来像修复无效。**Use**：先对 lock 指向的文件；`flutter build hap` 默认吃 **release** 的 `flutter_embedding_release.har`，只盖 debug 无效；换完删 `ohos/oh_modules` **并清 `~/.ohpm/cache`** 再编。详见 `references/fix-strategy.md`「把 embedding 改动送进 Demo」
- **NEVER** 用本机另一套 Flutter SDK 的 HAR / `libflutter.so` 给 `repo/` 补丁背书，或改用户日常 SDK 缓存来凑真机 — `repo/` 是分析/出 patch 的源码树，不是可运行 SDK。**Use**：信息采集后读 `outputs/ohos-flutter-sdk.json`（或步骤上下文里的「OHOS Flutter SDK」）。`matched=true` 时必须用里面的 `flutterBin` 编 hap / 换 HAR / 装真机，HAR 只盖进该 SDK 的 `bin/cache` 或本次 run 目录。`matched=false`：可以出 patch，禁止退回日常 SDK 凑验，`engine_aligned=false`，`verdict` 最高 `conditional_pass`。只 checkout 源码不算对齐。详见 `fix-strategy.md`「SDK 与 repo 必须同套」
- **NEVER** 把本机碰巧复现到的更重症状当成 Issue 验收（例如 Issue 要自定义 `code`/`details`，却用「Future 不挂死」判 pass）— **Use**：黄金标志必须是 Issue 正文的预期/实际结果；旁证可以记，不能替代验收
- **NEVER** 在修复验证阶段修订、改写、放宽黄金标志后再写 `pass`（例如第 1 轮 `window ≠ local` 已 fail，第 2 轮改成「display 带偏移」）— 复现阶段锁定的 Issue 验收不能改。修不了：`issue_golden_flag_met=false`，`verdict` 最高 `conditional_pass`。引擎见到「修订黄金标志」或缺少 `issue_golden_flag_met=true` 会把 `pass` 降为 `conditional_pass`。
- **NEVER** 把评论里的「已合入 / 已在 PR #xxx 修复 / 对照该 PR」或官方修复 commit 当成修法，也禁止 `git apply` / cherry-pick 官方修复。采集阶段不得写出 PR 号、PR URL、官方修复 commit；当前 Issue 号和 reset merge commit 必须保留。下游只根据回退后的源码和复现证据改。

## 通用工具约束

以下约束适用于所有诊断 Agent，各 Agent systemPrompt 不必重复声明：

- **不要调用 write/edit 工具写文件**：直接在回复中输出全部内容，工作流引擎会自动保存到 outputs/ 目录
- **不要读取 ACEHarness 内部状态文件**：state.yaml、events.jsonl、summary.json 等
- **不要读取 ~/.aceharness/ 目录下的任何文件**
- **不要搜索或查询上游仓库的 PR/Issue**：如 Issue 在 openharmony-tpc/flutter_flutter，不得查 flutter/flutter 主仓库
- **不要调用 GitCode/GitHub API 搜索上游 PR/Issue**（即使本机有 token）
- **必须输出 step-conclusion 标签**：内含 verdict JSON，这是工作流引擎判断步骤完成的唯一依据
- **upstream_status 一律记为 "unknown"**：不确定的上游信息用 upstream_search_keywords 列表形式输出，供用户手动搜索
