# 通用经验与约束

本文件汇总跨 Agent 的通用经验和硬约束。各 Agent 的 systemPrompt 不必重复声明这些内容，只需在需要时引用本文件。

## 通用经验（10 条）

1. **上游优先**：先查上游社区是否已有同类问题/修复，再深入自研代码
2. **渐进式深入**：从快速分类到深度分析，分层投入精力
3. **对比分析法**：鸿蒙特有问题，对比 Android/iOS 实现
4. **最小复现法**：构造最小复现 Demo，便于上游提 Issue
5. **日志先行**：先采集完整日志，再分析代码
6. **GitCode 获取锁定降级链**：GitCode Issue/PR 页面常是 SPA，页面抓取可能只返回空壳；必须依次尝试 API v5、comments API、带 Cookie/登录态请求、用户人工导出。页面抓取失败不得等同于 Issue 内容为空。
7. **证据分级表达**：所有结论按 confirmed / inferred / unverified 分层。confirmed 只能来自 Issue/API、日志、源码、命令结果或上游记录；inferred 必须说明推理链；unverified 必须给出补充验证命令或样本需求。
8. **报告保守表述**：Issue 未明确说明的具体现象（如崩溃、白屏、方向错误、镜像异常）只能写为"可能/推测"，不得写成已验证事实；未编译/未运行验证时，修复状态必须是 skipped 或 needs_runtime_validation。
9. **步骤结论可传递**：每个阶段最终输出必须给下游一个结构化结论，至少包含 verdict、summary、artifact_path、key_findings、missing_evidence；不要只留下工具调用日志或零散 grep/ls 结果。
10. **缺失证据要写影响**：正文、评论、截图、日志、样本、运行环境缺失时，必须说明影响的是分类、根因置信度、修复验证还是上游追踪，避免缺口一路隐身到报告。

## NEVER 列表（11 条硬禁止）

- **NEVER** 在没有完整日志的情况下下根因结论
- **NEVER** 忽略上游社区的已有分析
- **NEVER** 只修复表面症状而不修复根因
- **NEVER** 在未验证修复的情况下声称问题已解决
- **NEVER** 把静态推断的症状表现写成已验证事实
- **NEVER** 把 GitCode SPA 空页面当作 Issue 正文为空
- **NEVER** 在 Issue 正文/评论缺失时输出高置信结论而不列 missing_evidence
- **NEVER** 只输出 ls、grep、read 等过程日志而不输出阶段结论和 artifact_path
- **NEVER** 跳过人工审查直接执行代码修改
- **NEVER** 对偶现问题标记为"已修复"而不提供 trigger_pattern
- **NEVER** 在兜底诊断中只说"不知道"而不提供排查思路

## 通用工具约束

以下约束适用于所有诊断 Agent，各 Agent systemPrompt 不必重复声明：

- **不要调用 write/edit 工具写文件**：直接在回复中输出全部内容，工作流引擎会自动保存到 outputs/ 目录
- **不要读取 ACEHarness 内部状态文件**：state.yaml、events.jsonl、summary.json 等
- **不要读取 ~/.aceharness/ 目录下的任何文件**
- **不要搜索或查询上游仓库的 PR/Issue**：如 Issue 在 openharmony-tpc/flutter_flutter，不得查 flutter/flutter 主仓库
- **不要调用 GitCode/GitHub API 搜索上游 PR/Issue**（即使本机有 token）
- **必须输出 <step-conclusion> 标签**：内含 verdict JSON，这是工作流引擎判断步骤完成的唯一依据
- **upstream_status 一律记为 "unknown"**：不确定的上游信息用 upstream_search_keywords 列表形式输出，供用户手动搜索
