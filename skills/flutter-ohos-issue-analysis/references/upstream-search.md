# 上游社区搜索策略

> 用于 diagnosis-upstream-tracker Agent 的上游搜索参考

## 搜索范围

### 上游仓库

| 仓库 | 类型 | 采集内容 | URL |
|------|------|---------|-----|
| `flutter/flutter` | 上游框架 | Issue + PR + Commit | https://github.com/flutter/flutter |
| `flutter/engine` | 上游引擎 | Issue + PR + Commit | https://github.com/flutter/engine |
| `flutter/flutter_ohos` | 鸿蒙化框架 | Issue + PR | https://gitcode.com/.../flutter_ohos |
| 鸿蒙化插件仓库 | 插件 | Issue + PR | 各插件仓库 |
| `openharmony/docs` | 系统文档 | Issue | https://gitee.com/openharmony/docs |

### 搜索源

| 搜索源 | API | 适用场景 |
|--------|-----|---------|
| GitHub | REST API / Search API | Flutter 上游 Issue/PR |
| GitCode | API v5 | 鸿蒙化仓库 Issue/PR |
| Gitee | API | OpenHarmony 文档 Issue |

## 搜索策略

### 策略1: 堆栈匹配（权重 0.35）

**方法**：提取问题堆栈中的关键函数名，在社区 Issue/PR 的 body 和 comments 中搜索

**步骤**：
1. 从 faultlog 中提取堆栈函数名
2. 在 GitHub/GitCode 搜索 Issue/PR body
3. 匹配到相同函数名 → 高置信度

**示例**：
```
堆栈函数: FlutterEngineNotifyDisplayChange
搜索: GitHub Issues "FlutterEngineNotifyDisplayChange" in:body
```

### 策略2: 错误信息匹配（权重 0.25）

**方法**：提取错误信息文本，全文搜索社区内容

**步骤**：
1. 从日志中提取错误信息（如 `MissingPluginException`）
2. 在 GitHub/GitCode 全文搜索
3. 匹配到相同错误信息 → 中高置信度

**示例**：
```
错误信息: MissingPluginException: No implementation found for method xxx
搜索: GitHub Issues "MissingPluginException" in:body
```

### 策略3: 语义匹配（权重 0.20）

**方法**：将问题现象描述转为向量，在社区内容的向量索引中做相似度搜索

**步骤**：
1. 将问题描述向量化（embedding）
2. 在向量数据库中搜索相似内容
3. 语义相似度高 → 中置信度

**示例**：
```
问题描述: "应用切后台切前台后黑屏"
向量搜索: 找到语义相似的 Issue "Black screen after background/foreground switch"
```

### 策略4: 代码位置匹配（权重 0.20）

**方法**：定位问题代码的文件路径，搜索变更过该文件的 PR

**步骤**：
1. 从堆栈定位问题代码文件路径
2. `git blame` 定位最后修改 Commit
3. 查找包含该 Commit 的 PR
4. 关联原始 Issue 和修复 PR

**示例**：
```
问题文件: engine/src/flutter/shell/platform/ohos/flutter_ohos.cc
git blame: commit abc123
查找 PR: PR #123456 contains commit abc123
关联 Issue: Issue #123789 linked to PR #123456
查找修复 PR: PR #124000 fixes Issue #123789
```

## 置信度计算

```
总置信度 = 0.35 × 堆栈匹配分 + 0.25 × 错误信息匹配分
         + 0.20 × 语义匹配分 + 0.20 × 代码位置匹配分
```

### 置信度分级

| 置信度 | 含义 | 动作 |
|--------|------|------|
| >0.8 | 高度匹配 | 直接复用社区分析 |
| 0.5-0.8 | 可能匹配 | 人工确认后复用 |
| 0.3-0.5 | 弱匹配 | 作为参考线索 |
| <0.3 | 无匹配 | 标记为潜在新问题 |

## PR 追溯算法

### 追溯流程

```python
def trace_introducing_pr(file_path, line_number, repo_path):
    # 1. git blame 定位最后修改 Commit
    commit_hash = git_blame(repo_path, file_path, line_number)

    # 2. 查找包含该 Commit 的 PR
    pr = find_pr_by_commit(repo_path, commit_hash)

    # 3. 关联原始 Issue
    linked_issues = find_linked_issues(pr)

    # 4. 检查是否有后续修复 PR
    fix_prs = find_fix_prs(linked_issues)

    # 5. 评估影响
    impact = assess_pr_impact(pr, current_version)

    return {
        "introducing_pr": pr,
        "linked_issues": linked_issues,
        "fix_prs": fix_prs,
        "impact": impact
    }
```

### PR 影响评估

```python
def assess_pr_impact(pr, current_version):
    return {
        "is_in_current_version": check_version_contains(pr, current_version),
        "affected_versions": get_affected_versions(pr),
        "rollback_risk": assess_rollback_risk(pr),
        "downstream_dependencies": find_dependent_prs(pr)
    }
```

## 搜索关键词策略

### 按问题类型

| 问题类型 | 搜索源 | 关键词策略 |
|---------|--------|-----------|
| Crash + 堆栈 | Flutter Engine Issues | 堆栈中的函数名 |
| 功能不工作 | Flutter Issues + 插件仓库 | 错误信息 + 组件名 |
| 渲染异常 | Flutter Engine Issues | 现象描述 + Skia/Impeller |
| 性能问题 | Flutter Issues | 现象 + performance |
| 鸿蒙特有 | Flutter-OHOS Issues | ohos + 现象 |

### 按场景

| 场景 | 搜索源 | 搜索关键词策略 |
|------|--------|--------------|
| Crash + 堆栈 | Flutter Engine Issues | 堆栈中的函数名 |
| 功能不工作 | Flutter Issues + 插件仓库 | 错误信息 + 组件名 |
| 渲染异常 | Flutter Engine Issues | 现象描述 + Skia/Impeller |
| 性能问题 | Flutter Issues | 现象 + performance |
| 鸿蒙特有 | Flutter-OHOS Issues | ohos + 现象 |

## 输出分类与后续动作

| 检测结果 | 含义 | 后续动作 |
|---------|------|---------|
| **已修复** | 上游有 Issue 且已合并修复 PR | 通知根因分析直接复用，检查版本是否含修复 |
| **已知未修复** | 上游有 Issue 但未修复 | 通知根因分析参考，评估临时修复 |
| **PR 引入** | 追溯到引入问题的 PR | 通知根因分析评估回退 |
| **潜在新问题** | 上游未找到同类 | 通知报告 Agent 建议提交上游 Issue |

## API 调用示例

### GitHub Issue 搜索

```bash
# 搜索 GitHub Issues
curl -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/search/issues?q=repo:flutter/flutter+MissingPluginException+in:body&sort=updated&order=desc"
```

### GitCode Issue 搜索

```bash
# 搜索 GitCode Issues
curl "https://gitcode.com/api/v5/repos/{owner}/{repo}/issues?access_token=$GITCODE_TOKEN&state=open&q=MissingPluginException"
```

### GitHub PR 搜索

```bash
# 搜索 GitHub PRs
curl -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/search/issues?q=repo:flutter/flutter+type:pr+XComponent+in:body"
```

## 注意事项

1. **API 限流**：GitHub API 有速率限制（5000次/小时），GitCode 也有限制
2. **Token 管理**：API Token 需要安全存储，不暴露在日志中
3. **结果去重**：多策略搜索可能有重复结果，需要去重
4. **时效性**：优先搜索最近更新的 Issue/PR
5. **状态确认**：确认 Issue/PR 的当前状态（Open/Closed/Merged）
