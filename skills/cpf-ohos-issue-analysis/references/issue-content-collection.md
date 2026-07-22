# Issue 内容采集参考

> 用于 diagnosis-issue-collector Agent 的 Issue 内容采集指导。本文件提供领域经验，不定义执行步骤。

## 1. Issue 评论获取策略

### API 调用

- GitCode: `https://gitcode.com/api/v5/repos/{owner}/{repo}/issues/{number}/comments`
- GitHub: `https://api.github.com/repos/{owner}/{repo}/issues/{number}/comments`

### 评论信息提取要点

从评论中重点提取以下信息：

| 信息类型 | 示例 | 用途 |
|---------|------|------|
| **补充复现步骤** | "需要先 xxx 再 yyy 才能复现" | 完善复现条件 |
| **环境补充** | "我的系统是 HarmonyOS 5.0.1" | 补充环境信息 |
| **日志/堆栈** | "hilog 报错：E Flutter: ..." | 提供运行时证据 |
| **维护者回复** | "已在 PR #xxx 修复" / "不是 bug，是 xxx" | 判断问题状态 |
| **用户反馈** | "升级到 xxx 版本后好了" | 辅助定位引入版本 |
| **关联 PR/Issue** | "和 #123 是同一个问题" | 关联问题识别 |

### 评论处理原则

1. **按时间排序**：评论按时间顺序阅读，理解问题演进
2. **区分角色**：reporter（报告者）vs maintainer（维护者）vs 其他用户
3. **提取结论**：是否有解决方案、是否已修复、是否需要更多信息
4. **记录缺失**：如果评论中有人提问但 reporter 未回答，记录为 missing_evidence

## 2. 截图分析要点

### 截图下载

Issue body 中的图片 URL 格式：
- GitCode: `https://raw.gitcode.com/user-images/assets/{user_id}/{uuid}/filename.png`
- GitHub: `https://user-images.githubusercontent.com/{user_id}/{uuid}.png`

下载命令：
```bash
curl -sS -o screenshot_{n}.png "<image_url>"
```

### 截图内容解析策略（按模型能力降级）

| 级别 | 条件 | 方法 | 输出 |
|------|------|------|------|
| **优先** | 模型支持多模态（vision） | 直接用模型分析图片 | 截图类型 + 文字提取 + 视觉现象描述 |
| **降级 1** | 模型不支持多模态，但截图是日志/代码 | OCR 工具提取文字 | 提取的文字内容 |
| **降级 2** | 模型不支持多模态且 OCR 不可用 | 只记录 URL + Issue body 上下文 | URL + 上下文文字 |
| **降级 3** | 截图下载失败 | 记录原始 URL | URL + download_failed 标记 |

### 降级 1：OCR 提取文字

如果模型不支持多模态，但本机有 OCR 工具（tesseract）：

```bash
# 检查 tesseract 是否可用
which tesseract

# 提取文字（中文+英文）
tesseract screenshot_{n}.png stdout -l chi_sim+eng

# 如果 tesseract 不可用，检查其他 OCR 工具
which paddleocr || which easyocr
```

**OCR 适用场景**：
- 日志截图（hilog、console 输出）
- 代码截图（IDE 界面）
- 错误弹窗（含文字信息）

**OCR 不适用场景**：
- 纯视觉现象（黑屏、花屏、布局错位）
- 无文字的 UI 截图

### 降级 2：上下文提取

如果 OCR 也不可用，从 Issue body 中提取图片前后的文字作为上下文：

```python
# 从 Issue body 中提取图片 URL 及其上下文
import re
pattern = r'(.{0,200})!\[([^\]]*)\]\(([^)]+)\)(.{0,200})'
for match in re.finditer(pattern, issue_body):
    before_text = match.group(1).strip()
    alt_text = match.group(2)  # 图片 alt 描述
    image_url = match.group(3)
    after_text = match.group(4).strip()
    context = f"{before_text} [图片: {alt_text}] {after_text}"
```

### 降级 3：下载失败处理

```bash
# 记录失败的 URL
echo "{\"url\": \"$image_url\", \"status\": \"download_failed\"}" >> outputs/screenshots/failed.json
```

### 截图内容解读要点（多模态可用时）

| 截图类型 | 关注重点 | 判断依据 |
|---------|---------|---------|
| **错误界面** | 错误信息文本、错误码 | 红色异常框、Toast、弹窗 |
| **黑屏/白屏** | 是否完全无内容、是否有状态栏 | 全黑/全白 vs 部分渲染 |
| **花屏/错位** | UI 元素位置、颜色、重叠 | 布局异常、像素错乱 |
| **性能问题** | FPS 数字、加载时间 | 卡顿表现、加载进度条 |
| **日志截图** | 日志级别、Tag、内容 | E/W/F 级别、Flutter/hilog Tag |
| **代码截图** | 文件名、行号、代码内容 | 定位问题代码 |

### 多模态分析注意事项

1. **不要凭截图臆断**：截图只能提供视觉线索，不能替代代码审查
2. **结合 Issue 文字描述**：截图 + body 文字一起理解
3. **记录不确定性**：如果截图模糊或无法判断，记录为 `screenshot_unclear`
4. **区分现象和根因**：截图展示的是"现象"，不是"根因"
5. **降级时诚实标注**：如果用了降级策略，在 `screenshot_analysis` 字段如实标注，不要假装做了多模态分析

## 3. 环境信息提取清单

### 从 Issue body 中提取的环境信息

Issue body 通常包含结构化字段，需要从中提取：

| 字段 | 常见标签 | 示例 | 提取正则参考 |
|------|---------|------|-------------|
| **设备型号** | "设备"/"Device"/"手机型号" | 华为 Mate 60 Pro | `设备[：:]\s*(.+)` |
| **系统版本** | "系统版本"/"OS"/"HarmonyOS" | HarmonyOS 5.0.1 | `系统版本[：:]\s*(.+)` |
| **API 版本** | "API"/"API Level" | API 12 | `API[版本]*[：:]\s*(.+)` |
| **框架版本** | "Flutter"/"Flutter-OHOS"/"框架版本" | Flutter 3.22.0-ohos | `[Ff]lutter[- ]*[Oo][Hh][Oo][Ss]*[：:\s]*(.+)` |
| **引擎版本** | "引擎"/"Engine" | engine 028be699 | `[Ee]ngine[：:]\s*(.+)` |
| **应用版本** | "应用版本"/"App Version" | v1.0.2 | `应用版本[：:]\s*(.+)` |
| **分支信息** | "分支"/"Branch" | br_pigeon-v26.1.5_ohos | `分支[：:]\s*(.+)` |
| **复现概率** | "复现概率"/"必现/偶现" | 必现/100% | `(必现|偶现|100%|偶发)` |

### 环境信息缺失处理

1. **标记缺失**：未提取到的字段标记为 `missing`
2. **评估影响**：缺失的环境信息对根因置信度的影响
3. **不要臆断**：不能从 Issue 中推断出没有明确写出的环境信息
4. **从评论补充**：如果 Issue body 中缺失，检查评论中是否有补充

### 环境信息完整性评估

| 完整性等级 | 标准 | 对根因分析的影响 |
|-----------|------|----------------|
| **complete** | 设备型号 + 系统版本 + 框架版本 + 复现步骤齐全 | 可精确复现 |
| **partial** | 部分字段缺失 | 可推断但置信度降低 |
| **minimal** | 只有问题描述，无环境信息 | 需要更多假设，置信度低 |

## 4. Issue 内容完整性检查清单

信息采集完成后，检查以下内容是否齐全：

- [ ] Issue 标题
- [ ] Issue body 全文
- [ ] Issue 创建时间（用于代码回退）
- [ ] Issue 评论（如有）
- [ ] 截图（如有，已下载）
- [ ] 环境信息（设备型号、系统版本、API 版本、框架版本）
- [ ] 复现步骤
- [ ] 期望行为
- [ ] 实际行为
- [ ] 关联 PR/Issue（如有）

如果以上任一项缺失，在输出中标记 `issue_content_complete=false`，并在 `missing_evidence` 中写明影响。

## 5. 分支推断规则

从 Issue 内容推断代码仓分支，按以下优先级：

### 优先级 1：从版本号推断

Issue 标题或内容中明确提到版本号时，按映射表推断对应分支：

| Issue 中的版本号 | 对应分支 |
|---|---|
| [3.41] / 3.41.x / 3.41.10-ohos | `oh-3.41.9-dev` |
| [3.35] / 3.35.x / 3.35.7-ohos | `oh-3.35.7-dev` |
| [3.27] / 3.27.x / 3.27.4-ohos | `oh-3.27.4-dev` |

> 注：版本号→分支映射会随版本迭代更新，维护者请保持此表与实际仓库分支同步。

### 优先级 2：从 Issue 内容直接提取分支名

Issue body 或评论中明确提到分支名（如 `br_pigeon-v26.1.5_ohos`），直接使用该分支。

### 优先级 3：使用仓库默认分支

以上都无法推断时，使用仓库默认分支（clone 后不切换分支）。

### 输出字段

- `branch`：最终使用的分支名
- `branch_source`：`inferred_from_issue`（从版本号推断）/ `explicit_in_issue`（Issue 中明确提到）/ `default_branch`（使用默认分支）

## 6. 输出 JSON 模板

信息采集完成后，在 `<step-conclusion>` 标签内输出以下结构化 JSON（供下游 Agent 直接提取关键字段）：

```json
{
  "clone_result": "success|skipped|failed",
  "repo_url": "CPF-Flutter/flutter_packages",
  "branch": "br_pigeon-v25.3.2_ohos",
  "branch_source": "inferred_from_issue|explicit_in_issue|default_branch",
  "local_path": "repo/",
  "key_files": ["packages/pigeon/lib/src/arkts/arkts_generator.dart", "..."],
  "commit": "d2530f60c0554637971e62e516a27cf06ca06b43",
  "issue_created_at": "2026-07-08T19:46:17+08:00",
  "reset_target_merge_commit": "d2530f60c... 或 null",
  "reset_status": "success|skipped|failed",
  "issue_content_complete": true,
  "issue_title": "【pigeon】需要兼容1.0浮点数的传递",
  "issue_body_summary": "ArkTS 端 1.0 经 Number.isInteger 误判为 INT32...",
  "issue_comments_count": 1,
  "issue_comments_summary": "维护者已认领，正在分析",
  "screenshots": [{"url": "https://raw.gitcode.com/...", "path": "outputs/screenshots/screenshot_1.png", "download_status": "success|failed"}],
  "screenshot_analysis": "vision|ocr|skipped_no_vision|failed",
  "screenshot_descriptions": ["错误界面：显示 Number.isInteger 启发式", "..."],
  "screenshot_contexts": ["图片前后的 Issue body 文字描述", "..."],
  "environment_info": {
    "device_model": "华为 Mate 60 Pro 或 missing",
    "os_version": "HarmonyOS 5.0.1 或 missing",
    "api_version": "API 12 或 missing",
    "framework_version": "Flutter 3.22.0-ohos 或 missing",
    "engine_version": "engine 028be699 或 missing",
    "app_version": "v1.0.2 或 missing",
    "branch": "br_pigeon-v25.3.2_ohos 或 missing",
    "reproducibility": "必现|偶现|missing"
  },
  "environment_completeness": "complete|partial|minimal",
  "missing_evidence": ["设备型号缺失", "系统版本缺失", "..."]
}
```

> **重要**：`repo_url`、`branch`、`commit` 是下游报告 Agent 必须读取的字段，务必填写实际值，不要写"待核实"。
