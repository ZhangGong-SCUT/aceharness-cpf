# Issue 内容采集参考

> 用于 diagnosis-issue-collector Agent 的 Issue 内容采集指导。本文件提供领域经验，不定义执行步骤。

## 0. 先判断输入：Issue 链接或纯文本

`globalContext` 可以是 Issue 链接，也可以是没有 Issue 号的问题正文。步骤上下文里的「诊断输入形态」为准。

### 0A. 没有 Issue 链接（freeform）

禁止 curl GitCode/GitHub 的 Issue/comments API，禁止编造 Issue 号，禁止改去诊断工作副本或模板里残留的旧 Issue（例如 `#2490` 截图）。

- 把 `globalContext` 全文当作本轮唯一问题：`issue_title` 取首行或第一句，`issue_body_summary` 概括全文
- `issue_comments_count=0`，`input_source=freeform_text`
- 没有 `created_at`：不要 `git log --before` 回退，`reset_status=skipped_no_issue_date`
- 仓地址：正文里的 gitcode/github 仓；否则 `https://gitcode.com/CPF-Flutter/flutter_flutter.git`

### 0B. 有 Issue 链接

GitCode / AtomGit 的 Issue 页是 SPA，抓 HTML 经常只有站点壳，没有标题和正文。**正文只认 API JSON，不认页面。**

从 `globalContext` 链接拆 `{owner}/{repo}/{number}`：

`https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2492` → `CPF-Flutter` / `flutter_flutter` / `2492`

| 取什么 | GitCode | GitHub |
|---|---|---|
| **正文**（先打这条） | `https://gitcode.com/api/v5/repos/{owner}/{repo}/issues/{number}` | `https://api.github.com/repos/{owner}/{repo}/issues/{number}` |
| 评论 | `…/issues/{number}/comments` | 同左结构 |

Windows 必须用 **`curl.exe`**，不要用 PowerShell 的 `curl`（那是 `Invoke-WebRequest`，中文常乱码）：

```bash
curl.exe -sS "https://gitcode.com/api/v5/repos/{owner}/{repo}/issues/{number}"
curl.exe -sS "https://gitcode.com/api/v5/repos/{owner}/{repo}/issues/{number}/comments"
```

从 JSON 取 `title`、`body`、`created_at`、`html_url`、`labels`。返回是 `è§¦æ` 这类乱码时，先当 **UTF-8 被错解**，用 UTF-8 重解或改 `curl.exe`；**禁止靠猜乱码编标题/正文**。页面抓取失败或空壳，不得写成 Issue 内容为空。

## 1. Issue 评论获取策略

### API 调用

先打第 0 节的正文 API，再打评论：

- GitCode: `https://gitcode.com/api/v5/repos/{owner}/{repo}/issues/{number}/comments`
- GitHub: `https://api.github.com/repos/{owner}/{repo}/issues/{number}/comments`

### 评论信息提取要点

从评论中重点提取以下信息：

| 信息类型 | 示例 | 用途 |
|---------|------|------|
| **补充复现步骤** | "需要先 xxx 再 yyy 才能复现" | 完善复现条件 |
| **环境补充** | "我的系统是 HarmonyOS 5.0.1" | 补充环境信息 |
| **日志/堆栈** | "hilog 报错：E Flutter: ..." | 提供运行时证据 |
| **维护者回复** | "已在后续版本修复" / "不是 bug，是 xxx" | 判断问题状态（**禁止写出 PR 号 / PR URL / 官方修复 commit**） |
| **用户反馈** | "升级到 xxx 版本后好了" | 辅助定位引入版本 |
| **关联 Issue** | "和当前仓库另一个 Issue 是同一个问题" | 关联问题识别（可保留当前 Issue 号，禁止写出官方修复 PR） |

### 评论处理原则

1. **按时间排序**：评论按时间顺序阅读，理解问题演进
2. **区分角色**：reporter（报告者）vs maintainer（维护者）vs 其他用户
3. **提取结论**：是否有解决方案、是否已修复、是否需要更多信息。维护者说「已合入 / 已在 PR 修复」时，只写「维护者称后续有修复」这类模糊状态，**禁止**写出 PR 号、PR URL、官方修复 commit，禁止写「对照该 PR」「套官方 commit」。当前 Issue 号和回退用的 reset merge commit 必须保留。
4. **记录缺失**：如果评论中有人提问但 reporter 未回答，记录为 missing_evidence
5. **禁止漏题**：不得把官方修复 PR 递给下游当答案。引擎会屏蔽采集输出里的 PR URL / `PR #` / `git apply` 官方修复。

## 2. 截图分析要点

### 截图下载

Issue body 中的图片 URL 格式：
- GitCode: `https://raw.gitcode.com/user-images/assets/{user_id}/{uuid}/filename.png`
- GitHub: `https://user-images.githubusercontent.com/{user_id}/{uuid}.png`

下载命令：
```bash
curl.exe -sS -o screenshot_{n}.png "<image_url>"
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

### 优先级 3：使用默认分支 dev

以上都无法推断时，使用 `dev` 分支（团队日常开发分支；不要留在镜像默认 HEAD）。

### 输出字段

- `branch`：最终使用的分支名
- `branch_source`：`inferred_from_issue`（从版本号推断）/ `explicit_in_issue`（从 Issue 内容直接提取）/ `default_branch`（使用默认分支 dev）/ `fallback_branch`（engine 仓无同名分支回退 dev 时标注）

## 5.5 多仓准备规则（framework + engine）

Flutter 3.35 以下版本的部分功能代码在 engine 仓实现，只拉 framework 仓会漏掉引擎层源码。按以下规则确定仓库清单：

| 条件 | 准备的仓 |
|---|---|
| Issue 正文/评论给了仓地址 | 正文地址（可能是 engine fork，如 wxflutter_engine335） |
| 版本低于 3.35（oh-3.27.x / oh-3.22.x 等） | framework 仓 **和** engine 仓 |
| problem_type_preliminary ∈ 渲染/稳定性/性能（引擎层高发） | 建议一并准备 engine 仓 |
| 其余（3.35+ 且功能类问题） | framework 仓 |

- framework 仓：`https://gitcode.com/CPF-Flutter/flutter_flutter.git`（默认分支 `dev`）
- engine 仓：`https://gitcode.com/CPF-Flutter/flutter_engine.git`（**分支与 framework 同名**，如 `oh-3.27.4-dev`；无同名分支回退 `dev`）
- 目录约定：framework/正文主仓 → `repo/`；engine 仓 → `repo-engine/`

### 统一用共享镜像缓存脚本（禁止手写 git clone 全量拉取）

每个 run 的工作区是全新的，直接 clone 上游要分钟级；共享镜像缓存（`~/.aceharness/repo-cache/` 裸仓 + 本地 hardlink clone）把它降到秒级：

```bash
# framework / 正文主仓（--branch 用第 5 节推断的分支）
node skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs clone \
  --repo https://gitcode.com/CPF-Flutter/flutter_flutter.git \
  --dest repo/ --branch oh-3.27.4-dev --fallback-branch dev

# engine 仓（需要时；分支同名，无同名分支自动回退 dev）
node skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs clone \
  --repo https://gitcode.com/CPF-Flutter/flutter_engine.git \
  --dest repo-engine/ --branch oh-3.27.4-dev --fallback-branch dev
```

脚本行为：目录已存在自动 fetch 复用；镜像异常自动降级直连上游（与旧流程一致的保底）；完整历史（支持回退 merge commit），不要 `--depth=1`。输出单行 JSON：`result`（success|degraded|failed）、`from_cache`、`branch`、`branch_source`、`commit`、`duration_ms`、`degraded_reason`。

## 6. 输出 JSON 模板

信息采集完成后，在 step-conclusion 标签内输出以下结构化 JSON（供下游 Agent 直接提取关键字段）：

```json
{
  "clone_result": "success|skipped|failed",
  "repo_url": "CPF-Flutter/flutter_packages",
  "engine_repo_url": "CPF-Flutter/flutter_engine 或 null（未准备 engine 仓时）",
  "engine_repo_path": "repo-engine/ 或 null",
  "branch": "br_pigeon-v25.3.2_ohos",
  "branch_source": "inferred_from_issue|explicit_in_issue|default_branch|fallback_branch",
  "local_path": "repo/",
  "key_files": ["packages/pigeon/lib/src/arkts/arkts_generator.dart", "..."],
  "commit": "d2530f60c0554637971e62e516a27cf06ca06b43",
  "issue_created_at": "2026-07-08T19:46:17+08:00",
  "reset_target_merge_commit": "d2530f60c... 或 null",
  "reset_status": "success|skipped|skipped_no_issue_date|failed",
  "input_source": "issue_url|freeform_text",
  "issue_content_complete": true,
  "issue_title": "【pigeon】需要兼容1.0浮点数的传递",
  "issue_body_summary": "ArkTS 端 1.0 经 Number.isInteger 误判为 INT32...",
  "issue_comments_count": 1,
  "issue_comments_summary": "维护者已认领，正在分析（若称已修复：只写「维护者称后续有修复」，禁止写 PR 号）",
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

> **重要**：`repo_url`、`branch`、`commit` 是下游报告 Agent 必须读取的字段，务必填写实际值，不要写"待核实"。`branch` 还会被引擎用来写入 `outputs/ohos-flutter-sdk.json`，按本机 `configs/ohos-flutter-sdks.yaml` 对号入座。
