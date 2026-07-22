---
name: cpf-ohos-issue-analysis
description: OHOS 跨平台框架（Flutter-OHOS / React Native-OHOS / KMP-CMP 等）鸿蒙化问题 AI 诊断技能（CPF 版）。提供问题分类识别表、根因模式库、日志解读方法、环境信息采集清单、修复建议和报告模板等专家经验，作为诊断 Agent 的知识源。
descriptionZH: CPF 鸿蒙跨平台框架问题 AI 诊断技能，提供分类识别、根因模式、日志解读、采集清单、修复建议和报告模板。
tags:
  - CPF
  - 鸿蒙
  - OHOS
  - Flutter
  - 跨平台框架
  - 问题诊断
  - 根因分析
  - 上游追踪
source: aceharness
---

# CPF 鸿蒙跨平台框架问题 AI 诊断技能

## 技能定位

本技能是「鸿蒙跨平台框架问题 AI 自动诊断工作流」的**知识源**，为诊断 Agent 提供领域专家经验。

> **三层职责划分**：Agent 的执行步骤由 Workflow（调度）+ Agent 自身（角色+工具）+ Skill（领域知识）三者共同确定。本 Skill 只提供领域知识，不定义执行步骤。

## 问题类型识别表

| 问题类型 | 关键特征 | 典型现象 | 优先级参考 |
|---------|---------|---------|-----------|
| **稳定性 (stability)** | 进程崩溃/退出、ANR 卡死 | 闪退、冻结、SIGABRT/SIGSEGV | P0-P1 |
| **内存泄漏 (memory-leak)** | 内存持续增长、OOM | 长时间运行后卡顿/崩溃 | P1-P2 |
| **功能 (functional)** | 功能不工作、行为异常 | MissingPluginException、API 不响应 | P1-P2 |
| **性能 (performance)** | 卡顿、掉帧、启动慢 | FPS<60、启动>3s | P2-P3 |
| **渲染 (rendering)** | UI 显示异常 | 黑屏、白屏、花屏、错位 | P0-P2 |

## 问题层面定界参考

| 层面 | 占比 | 检查重点 |
|------|------|---------|
| **应用层** | 60% | 用户代码逻辑、状态管理、生命周期处理 |
| **插件层** | 25% | 插件鸿蒙化实现、MethodChannel 通信、权限声明 |
| **框架层** | 10% | Flutter framework 鸿蒙化代码、平台差异处理 |
| **引擎层** | 4% | Engine/Embedder、完整堆栈、提 Issue |
| **系统层** | 1% | HarmonyOS 系统行为、版本差异对比 |

## 诊断流程总览

```mermaid
flowchart LR
    A[问题描述] --> B[分类定界]
    B --> C[信息采集]
    B -.并行.-> D[问题复现]
    B -.并行.-> E[上游追踪]
    C --> F[根因分析]
    D --> F
    E --> F
    F --> G{置信度足够?}
    G -- 否 --> H[兜底诊断]
    G -- 是 --> I[修复建议]
    I --> J[人工审查]
    J --> K[代码修改]
    K --> L[修复验证]
    L --> M[报告沉淀]
    H --> M
```

## 知识源文件索引

### 根因模式库（issue-types/）

| 文件 | 问题类型 | 根因模式数 |
|------|---------|-----------|
| [issue-types/stability.md](./issue-types/stability.md) | 稳定性 | 8+ |
| [issue-types/memory-leak.md](./issue-types/memory-leak.md) | 内存泄漏 | 6+ |
| [issue-types/functional.md](./issue-types/functional.md) | 功能 | 8+ |
| [issue-types/performance.md](./issue-types/performance.md) | 性能 | 6+ |
| [issue-types/rendering.md](./issue-types/rendering.md) | 渲染 | 7+ |

### 参考文档（references/）

| 文件 | 内容 |
|------|------|
| [references/environment-info.md](./references/environment-info.md) | 环境信息采集清单 |
| [references/log-collection.md](./references/log-collection.md) | 日志采集命令模板 |
| [references/log-interpretation.md](./references/log-interpretation.md) | 日志解读方法 |
| [references/report-template.md](./references/report-template.md) | 诊断报告模板 |
| [references/upstream-search.md](./references/upstream-search.md) | 上游社区搜索策略 |

## Agent 与 Skill 知识映射

| Agent | 使用的 Skill 知识 | 用途 |
|-------|-----------------|------|
| **diagnosis-classifier** | 问题类型识别表 + 层面定界参考 | 分类决策 |
| **diagnosis-collector** | environment-info.md + log-collection.md | 采集清单 |
| **diagnosis-root-cause-analyzer** | issue-types/*.md + log-interpretation.md | 根因匹配 + 置信度评估 |
| **diagnosis-fix-advisor** | issue-types/*.md 修复建议 | 修复方案 |
| **diagnosis-reporter** | report-template.md | 报告模板 |
| **diagnosis-fallback** | 通用经验 + NEVER 列表 | 排查思路 |

## 通用经验

1. **上游优先**：先查上游社区是否已有同类问题/修复，再深入自研代码
2. **渐进式深入**：从快速分类到深度分析，分层投入精力
3. **对比分析法（硬约束）**：鸿蒙特有问题，**必须先对比 Android 和 iOS 源码**，再下根因结论和修复建议。鸿蒙化问题绝大多数是"鸿蒙实现与 Android/iOS 基线不一致"导致的，不对比基线就无法定位根因。对比要求：
   - 在 repo/ 中搜索 Android 实现（`*.kt` / `*.java`）和 iOS 实现（`*.swift` / `*.m`）
   - 逐函数对比三端实现逻辑：Android vs iOS vs OHOS（ArkTS）

   - 在证据链/修复建议中必须引用 Android/iOS 基线（标注文件路径和行号）
   - 如果 repo/ 中找不到 Android/iOS 实现，在 missing_evidence 中明确记录
4. **最小复现法**：构造最小复现 Demo，便于上游提 Issue
5. **日志先行**：先采集完整日志，再分析代码
6. **GitCode 获取锁定降级链**：GitCode Issue/PR 页面常是 SPA，页面抓取可能只返回空壳；必须依次尝试 API v5、comments API、带 Cookie/登录态请求、用户人工导出。页面抓取失败不得等同于 Issue 内容为空。
7. **证据分级表达**：所有结论按 confirmed / inferred / unverified 分层。confirmed 只能来自 Issue/API、日志、源码、命令结果或上游记录；inferred 必须说明推理链；unverified 必须给出补充验证命令或样本需求。
8. **报告保守表述**：Issue 未明确说明的具体现象（如崩溃、白屏、方向错误、镜像异常）只能写为“可能/推测”，不得写成已验证事实；未编译/未运行验证时，修复状态必须是 skipped 或 needs_runtime_validation。
9. **步骤结论可传递**：每个阶段最终输出必须给下游一个结构化结论，至少包含 verdict、summary、artifact_path、key_findings、missing_evidence；不要只留下工具调用日志或零散 grep/ls 结果。
10. **缺失证据要写影响**：正文、评论、截图、日志、样本、运行环境缺失时，必须说明影响的是分类、根因置信度、修复验证还是上游追踪，避免缺口一路隐身到报告。

## NEVER 列表

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

## 问题归属判断（problem_ownership）

分类时必须明确判断问题归属，输出 `problem_ownership` 字段：

| 归属类型 | 含义 | 特征 | 排查方向 |
|---|---|---|---|
| **business_code**（上层业务代码） | 问题出在用户自己写的 Dart/ArkTS 业务代码中 | API 使用方式错误、状态管理逻辑错误、生命周期处理不当、参数传递错误 | 检查用户代码的 API 调用、参数、逻辑流程 |
| **framework_library**（底层框架/库） | 问题出在 Flutter-OHOS 框架、插件鸿蒙化实现、引擎 Embedder、Pigeon 生成代码等 | 用户代码调用方式正确，但框架/库内部处理有 bug | 审查框架/库源码、对比 Android/iOS 实现、检查鸿蒙化适配代码 |
| **mixed**（混合问题） | 上层业务代码触发了底层框架/库的 bug | 用户代码没问题，但框架内部处理有缺陷，两者协同才触发 | 先确认用户代码正确性，再深入框架/库源码定位 bug |

### 判断依据

1. Issue 中的代码片段是标准 API 用法 → 倾向 `framework_library`
2. Issue 中的代码片段有明显的逻辑错误 → 倾向 `business_code`
3. Issue 提到"Android/iOS 正常但鸿蒙异常" → 倾向 `framework_library`
4. Issue 提到"升级版本后出现问题" → 倾向 `framework_library`
5. Issue 只在特定业务场景下出现 → 需要进一步分析是 `business_code` 还是 `mixed`

---

## 多框架扩展

本技能当前聚焦 Flutter-OHOS（CPF 版），架构支持按框架扩展：

```
cpf-ohos-issue-analysis/           # 当前（CPF 鸿蒙跨平台框架）
├── issue-types/
└── references/

react-native-ohos-issue-analysis/  # 可扩展（RN-OHOS）
├── issue-types/
└── references/

kmp-cmp-issue-analysis/            # 可扩展（KMP-CMP）
├── issue-types/
└── references/
```

框架扩展流程：
1. 在 `skills/` 下新增框架目录
2. 编写该框架的 `issue-types/` 和 `references/`
3. Classifier Agent 自动识别框架类型并加载对应知识
4. 其他 Agent 无需修改，自动使用新框架知识
