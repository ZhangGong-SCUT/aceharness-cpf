---
name: gitcode-issue-collector
description: 从 GitCode 仓库收集已关闭 Issue 并匹配已合并 PR，按质量评分筛选测试用例集。当用户需要从 GitCode 平台收集带 PR 关联的测试 Issue、构建评测数据集、或筛选高质量 Issue-PR 对时使用此技能。
descriptionZH: 从 GitCode 仓库收集已关闭 Issue 并匹配已合并 PR，按质量评分筛选测试用例集。支持按仓库、时间范围、质量评分、PR 合并状态等条件过滤，输出结构化测试 Issue 集。
tags:
  - GitCode
  - Issue Collection
  - PR Matching
  - Test Dataset
  - Quality Scoring
source: aceharness
---

# GitCode Issue 收集器

你负责帮助从 GitCode 平台收集已关闭的 Issue，匹配对应的已合并 PR，并按质量评分筛选出符合要求的测试用例集。

## 配置文件

所有收集参数从配置文件读取：`skills/gitcode-issue-collector/config.json`

**开始收集前，必须先读取配置文件**，从中获取 Token、仓库、时间范围、评分阈值等参数。如果配置文件不存在或 Token 为空，应提示用户填写配置文件。

**Token 过期处理**：如果 API 返回 401 Unauthorized，说明 Token 已过期，需提示用户更新配置文件中的 `access_token`。

## 核心流程

收集工作以 Issue 为中心，分为 3 个步骤，必须按顺序执行：

### 步骤 1：获取时间范围内的已关闭 Issue

通过 GitCode API v5 获取目标仓库的所有已关闭 Issue，按时间范围过滤。

```
GET /repos/{owner}/{repo}/issues?state=closed&page={page}&per_page=100&access_token={token}
```

- 分页获取，每页 100 条，直到返回不足 100 条为止
- 每次请求间隔 0.3 秒，避免触发限流
- 根据配置文件中的时间范围（如近半年），按 Issue 的 `created_at` 或 `updated_at` 过滤

### 步骤 2：质量评分筛选

对步骤 1 获取的每个 Issue 按以下维度评分（满分 15+）：

| 维度 | 分值 | 判断方式 |
|------|------|---------|
| Body 长度 > 500 字符 | +2 | `len(body) > 500` |
| Body 长度 > 1500 字符 | +2 | `len(body) > 1500` |
| Body 长度 > 3000 字符 | +1 | `len(body) > 3000` |
| 包含复现步骤 | +2 | 正则匹配 `复现\|步骤\|reproduc\|steps?` |
| 包含代码示例 | +2 | 包含 ` ``` ` 或匹配 `代码\|code sample` |
| 包含错误/堆栈信息 | +2 | 正则匹配 `error\|exception\|crash\|报错\|错误\|异常\|崩溃` |
| 包含环境信息 | +2 | 正则匹配 `flutter doctor\|ohos\|harmonyos\|鸿蒙\|设备\|系统版本\|api level` |
| 包含截图 | +1 | 正则匹配 `image\|screenshot\|png\|jpg\|截图\|图片` |
| 评论数 ≥ 3 | +1 | `comments >= 3` |
| 评论数 ≥ 5 | +1 | `comments >= 5` |

筛选出评分 ≥ 阈值（默认 5 分）的 Issue 进入下一步。

### 步骤 3：检查 Issue 的 PR 关联并验证 PR 已合入

对步骤 2 筛出的每个高质量 Issue，检查其是否关联了 PR，并验证该 PR 已合入。

**3a. 从 Issue 中提取 PR 关联**

通过 GitCode API v5 的 `/issues/{number}/pull_requests` 端点获取 Issue 关联的 PR：

```
GET /repos/{owner}/{repo}/issues/{issue_number}/pull_requests?access_token={token}
```

返回该 Issue 关联的 PR 列表，每个 PR 对象包含 `number`、`title`、`state`、`merged_at` 等字段。

**只使用这一种方式获取 PR 关联**，不使用评论匹配、正文正则、web-api discussions 等其他方式。

**3b. 验证 PR 已合入**

对每个提取到的 PR 编号，通过 API 获取 PR 详情，验证其已合入：

```
GET /repos/{owner}/{repo}/pulls/{pr_number}?access_token={token}
```

验证条件：`state == "merged"` 且 `merged_at` 字段非空。

**只有同时满足"质量评分达标"和"关联了已合入 PR"的 Issue 才纳入最终结果。**

## 问题分类

对每个匹配到的 Issue，按标题和正文内容分类。**分类按优先级从上到下匹配，命中第一个即归类，不再继续匹配。**

| 类型 | 关键词 | 匹配范围 | 说明 |
|------|--------|---------|------|
| stability（稳定性） | crash, 闪退, 崩溃, stack overflow, abort, segfault, sigabrt, sigsegv | 标题 + 正文（去除模板） | 标题或正文中明确出现 Crash 相关词时归为此类。ANR/Freeze/卡死等「挂起不响应」问题不归为此类 |
| memory-leak（内存泄漏） | memory leak, 内存泄漏, 内存溢出, oom, out of memory, nativeinit | 标题 + 正文 | |
| rendering（渲染） | render, 渲染, 绘制, gpu, opengl, impeller, skia, surface, texture, gradient, 黑屏, 白屏, 花屏, 闪烁 | 标题 + 正文 | |
| performance（性能） | performance, 性能, 卡顿, jank, fps, latency, 优化, ltpo, slow, 耗时 | 标题 + 正文 | |
| functional（功能） | 默认分类 | — | 功能异常、逻辑错误、编译报错、文档问题等均归为此类 |

**模板文本去除**：Issue 正文常包含 Flutter 默认模板文本（如 "Thank you for using Flutter! If you are looking for support..."），这些模板中可能包含 "crash" 等词但并非问题描述。匹配 stability 关键词前，需先移除以下模板内容：
- 以 `Thank you for using Flutter` 开头的整段文本
- `## Flutter Doctor` / `## Steps to reproduce` 等标准模板标题下的占位说明文本
- 仅保留用户实际填写的问题描述、复现步骤、错误日志等真实内容

## 性能优化

- 步骤 2 质量评分可快速过滤掉大量低质量 Issue，减少步骤 3 需要检查 PR 关联的 Issue 数量
- 步骤 3 中获取 Issue 评论和验证 PR 状态是主要 API 调用开销，应控制每次请求间隔 0.15-0.3 秒
- 可缓存已验证的 PR 状态，避免对同一 PR 重复验证

## 去重

同一问题常跨多个版本/分支提交多个 Issue（如 [3.22]、[3.27]、[3.32]、[3.35]、[3.41]），这些 Issue 内容高度相似，仅版本号不同。为避免测试集冗余，需对这类 Issue 去重。

**去重规则**：
1. 对每个 Issue 标题进行归一化：移除版本号标记（如 `[3.22]`、`[3.27]`、`[3.32]`、`[3.35]`、`[3.41]`、`【3.35】`、`[OHOS]`、`[ohos]`、`[CP]` 等方括号/圆括号标记）、移除分支名（如 `br_3.27.4-ohos-1.0.4`）、移除前后缀空格
2. 按归一化后的标题分组，同一组内的 Issue 视为重复
3. 每组按以下优先级排序，保留第一个：
   - 评分降序（评分高的优先）
   - 标题完整性：不含 `<title>` 占位符的优先（Cherry-Pick 模板未填写的标题质量差，如 `[CP] <title>从flutter3.32同步...`）
   - Issue 编号降序（最新的优先）
4. 在输出文件中标注被去重的 Issue 编号列表

**归一化示例**：
- `[3.35][LTPO]LTPO Performance Optimization` → `LTPO Performance Optimization`
- `[3.41][LTPO]LTPO Performance Optimization` → `LTPO Performance Optimization`（同一组，去重）
- `【3.35】DFX能力路由跳转和标签页切换的检测` → `DFX能力路由跳转和标签页切换的检测`
- `【3.32】DFX能力路由跳转和标签页切换的检测` → `DFX能力路由跳转和标签页切换的检测`（同一组，去重）

## 输出格式

最终输出为 Markdown 文件，包含：

1. **筛选标准**：来源仓库、PR 合并时间范围、质量评分阈值
2. **总览表格**：Issue 编号（带链接）、标题、PR 编号（带链接）、PR 创建人、合并日期、类型、评分、Body 长度、评论数
   - Issue 编号列使用 Markdown 链接格式：`[#1064](https://gitcode.com/{owner}/{repo}/issues/1064)`
   - PR 编号列使用 Markdown 链接格式：`[#940](https://gitcode.com/{owner}/{repo}/merge_requests/940)`
   - PR 创建人列显示 PR 详情中 `user.login` 字段值（即 PR 创建者的 GitCode 用户名）
   - 标题列显示完整标题，不截断；标题中的 `|` 需转义为 `\|` 以避免破坏表格结构
3. **详细信息**：每个 Issue 的链接、PR 链接、PR 标题、PR 创建人、合并时间、质量评分明细、问题描述
4. **统计**：按类型统计数量和评分范围
5. **质量保证**：列出每个 Issue 满足的条件清单
6. **数据收集方法**：记录收集步骤和 API 调用方式

## GitCode Token 获取

Token 从配置文件 `skills/gitcode-issue-collector/config.json` 的 `gitcode.access_token` 字段读取。

**如果配置文件中 Token 为空或已过期**（API 返回 401），可通过以下方式获取新 Token：

1. 从 CPF-Manager 数据库解密获取（备用方案）：
   - 数据库路径：通过环境变量 `CPF_MANAGER_DB_PATH` 指定（默认 `<你的工程>/backend/data/cpf-manager.db`）
   - 加密 Token 存储在 `settings` 表，key 为 `gitcode_access_token`
   - 加密方式：AES-256-ECB，密钥为 CPF-Manager 启动密钥（**必须**通过环境变量 `CPF_MANAGER_SECRET_KEY` 传入，禁止硬编码到仓库）
   - 解密命令：
   ```bash
   DB_PATH="${CPF_MANAGER_DB_PATH:-$(pwd)/cpf-manager.db}"
   : "${CPF_MANAGER_SECRET_KEY:?必须设置环境变量 CPF_MANAGER_SECRET_KEY}"
   SECRET="$CPF_MANAGER_SECRET_KEY"
   ENCRYPTED=$(sqlite3 "$DB_PATH" "SELECT value FROM settings WHERE key='gitcode_access_token'")
   KEY_HEX=$(printf '%s' "$SECRET" | xxd -p -c 64)
   echo "$ENCRYPTED" | openssl enc -aes-256-ecb -d -nosalt -K "$KEY_HEX" -base64
   ```
2. 获取到新 Token 后，更新配置文件中的 `access_token` 字段。

**不要在脚本中硬编码 Token**，始终从配置文件读取。

## 常见陷阱

1. **PR 合并状态验证**：验证 PR 是否已合入时，必须用 `GET /pulls/{pr_number}` 获取详情并检查 `state == "merged"`。不能用 `state=closed` 的 PR 列表（其中包含未合并的 PR，且 `merged_at` 字段为空）。
2. **`close_related_issue` 字段**：PR 中的此字段是布尔值（`True`/`False`），表示 PR 是否关联了 Issue，不是 Issue 编号。不能用于获取关联的 Issue 编号。
3. **正向 vs 反向查询**：用 `/issues/{number}/pull_requests`（正向，Issue→PR）可以正确获取关联 PR；但 `/pulls/{pr_number}/issues`（反向，PR→Issue）返回的是 PR 自动创建的"镜像 Issue"，内容少、质量低，不要混用。
4. **镜像仓库去重**：`openharmony-sig` 和 `openharmony-tpc` 仓库是 `CPF-Flutter` 的镜像，Issue/PR 编号一致，需按 Issue 编号去重。
5. **API 限流**：GitCode API 有请求频率限制，每次请求间隔至少 0.15-0.3 秒。
6. **Token 过期**：Token 可能过期（返回 401 Unauthorized），需更新配置文件 `config.json` 中的 `access_token` 字段。
7. **CP Issue 信息不全**：Cherry-Pick Issue 使用 CP 模板创建，若模板未正确填写，标题会包含 `<title>` 占位符（如 `[CP] <title>从flutter3.32同步...`），正文也是 CP 模板内容（Issue Link、Target、PR Link 等字段）而非标准 Bug 报告。这类 Issue 信息不全，不适合作为测试用例，应在质量评分前过滤掉。
8. **仓库管理类 Issue**：部分 Issue 是仓库管理类操作（如 OAT 门禁配置、流水线门禁新增/修改、测试用例补充等），标题通常含 `OAT.xml`、`OAT文件`、`门禁`（包括"流水线门禁"、"门禁缺失"、"新增门禁"、"配置门禁"等各种组合）、`测试用例`、`测试案例` 等关键词。这类 Issue 不是真正的功能/缺陷问题，不适合作为诊断测试用例，应在质量评分前过滤掉。

## 可配置参数

所有参数在配置文件 `skills/gitcode-issue-collector/config.json` 中设置，包含 `gitcode`（Token、API 地址、请求参数）、`collection`（仓库、时间范围、评分阈值、分类）、`output`（输出格式选项）三部分。具体字段及说明请直接查看配置文件。
