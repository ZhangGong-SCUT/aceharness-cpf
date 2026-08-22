# 诊断报告模板

> 用于 diagnosis-reporter Agent 的报告生成参考。报告面向定位问题的开发者，严格按以下模板输出，不得增减章节。

## 报告模板

```markdown
# 诊断报告

## 问题概述

[一句话描述问题现象。例如：SharedPreferencesAsync.getStringList 在 OHOS 平台始终返回 null]

- **问题类型**: 稳定性 | 内存泄漏 | 功能 | 性能 | 渲染
- **问题层面**: 应用层 | 插件层 | 框架层 | 引擎层 | 系统层
- **优先级**: P0 | P1 | P2 | P3
- **问题归属**: Flutter框架/插件问题 | 上层应用开发者问题
- **修复方向**: 修改Flutter框架/插件代码 | 修改上层应用代码

（问题归属和修复方向根据根因分析的 problem_ownership 判定：framework_library → Flutter框架/插件问题，应修改框架/插件代码；business_code → 上层应用开发者问题，应修改应用代码；mixed → 混合问题，需两者协同修改）

## 环境信息

| 项 | 值 |
|---|---|
| 仓库 | [仓库路径] |
| 分支 | [分支名] |
| Commit | [commit hash] |
| 框架版本 | [Flutter/Flutter-OHOS 版本] |
| 设备型号 | [设备型号，缺失则写"未提供"] |
| 系统版本 | [HarmonyOS 版本，缺失则写"未提供"] |

## 复现步骤

1. [步骤1]
2. [步骤2]
3. [步骤3]

**预期结果**: [预期行为]

**实际结果**: [实际行为]

## 问题复现结论

- **是否已在Demo复现**: 是 | 否 | 未验证
- **复现状态**: verified | stable | intermittent | unstable | not_reproducible | theoretical
- **复现设备**: [OHOS真机序列号 / iOS模拟器 / Android模拟器 / 无设备]
- **黄金标志**: [复现阶段的黄金标志检查结果，如 Route match=false + defaultRouteName=/]
- **跨平台对照**: [OHOS bug / Android正常 / iOS正常 等对照结论]
- **复现说明**: [如果未复现，说明原因（缺设备/触发条件不对/Demo代码有误等）和理论复现路径]

（以上字段从问题复现和复现验证步骤的输出中获取）

## 根因结论

[用 2-3 段话描述根本原因。第一段说结论，第二段说触发条件，第三段说影响机制。]

**置信度**: [0.0-1.0]

**问题归属判定**: [framework_library / business_code / mixed，说明判定依据]

### 证据链

1. [证据1：代码位置 + 具体问题]
2. [证据2：Android/iOS 基线对比差异]
3. [证据3：日志/堆栈/Issue 描述中的直接证据]

## 修复建议

### 修复方向

**应修改**: Flutter框架/插件代码 | 上层应用代码
**修改位置**: [框架/插件仓库路径 或 应用代码路径]
**判定依据**: [为什么是框架/插件问题或应用问题]

### 短期修复（Workaround）

[快速止血方案，让开发者能立即绕过问题]

### 根因修复

**修改文件**: `[文件路径]`
**修改行号**: [行号]

修改前：
```dart
// 原代码
```

修改后：
```dart
// 新代码
```

**变更说明**: [为什么这样改]

### 长期改进

1. [改进建议1]
2. [改进建议2]

## 验证建议

1. [验证步骤1]
2. [验证步骤2]
3. [验证步骤3]
```

## 报告生成规则

1. **严格按模板输出**：只输出模板中定义的章节，不得增减章节、不得改变章节顺序
2. **面向开发者**：报告读者是定位问题的开发者，语言简洁直接，避免元数据和工作流内部术语
3. **证据分级**：已确认事实直接陈述；基于代码推断的写"推测"；未运行时验证的写"待验证"
4. **缺失证据**：如果 Issue 正文/评论/截图/日志缺失，在对应位置标注"未提供"，不得编造
5. **可执行性**：修复建议必须具体到文件路径和行号，验证建议必须可操作
6. **简洁性**：报告正文不超过 1500 字，避免冗长解释
7. **可解析结尾**：报告末尾必须附 JSON：
   ```json
   {"verdict":"pass|conditional_pass|fail","summary":"...","artifact_path":"outputs/...md","key_findings":[...],"report_path":"outputs/...md","reproduction_confirmed":"yes|no|unverified","problem_ownership":"framework_library|business_code|mixed","fix_target":"framework_plugin|application","verification_status":"verified|skipped|needs_runtime_validation","missing_evidence":[...]}
   ```
