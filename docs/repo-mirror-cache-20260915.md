# 共享裸仓镜像缓存归档（2026-09-15）

> 归档时间：2026-09-15 19:20 CST
> 分支：cpf-ohos-issue-diagnosis
> 涉及：`skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs`（新增）、两份诊断 YAML、`skills/cpf-ohos-issue-analysis/references/issue-content-collection.md`

## 问题

1. **每次 run 全量 clone**：isolated-copy 模式下每个 run 工作区全新，`repo/` 永不存在，"已存在则 fetch"优化从未生效 → 每次 run 都从 GitCode 全量拉仓（engine 仓实测 3m24s；framework 仓更大）。并发 3 个 issue 分析任务 = 3 次重复全量下载；26 个 run 目录有 8 个残留完整 repo，磁盘重复占用。
2. **3.35 以下版本缺 engine 仓**（用户补充的领域知识）：低版本部分功能代码在 flutter_engine 实现，而信息采集只准备"Issue 正文仓或默认 flutter_flutter"一个仓 → 引擎层根因只能推断（inferred）无法实锤（confirmed），也没法对 engine 出 patch。

## 方案：共享裸仓镜像 + 多仓准备

```
GitCode 上游 ──(一次全量/增量 fetch, flock 串行)──▶ ~/.aceharness/repo-cache/<host>/<owner>/<repo>.git
                                                        │ hardlink 本地 clone（秒级，对象零复制）
              每次 run ─────────────────────────────────▶ <personalDir>/<runId>/repo{,-engine}/
                                          + remote set-url 指回真实上游 + 增量 fetch 补齐
```

### 1. 缓存脚本 `repo-cache.mjs`（agent 一条命令，禁止手写 git clone）

- 子命令：`ensure`（更新镜像）/ `clone`（ensure + hardlink clone + set-url + delta fetch + checkout）/ `status`（缓存概览）
- URL 规范化（去 userinfo/.git）；镜像路径 `<cache>/<host>/<owner>/<repo>.git`；锁 `flock -w 900`（并发安全）
- dest 已存在且有效 → 自动 fetch 复用（run 内重入）；镜像任何失败 → 自动降级直连（保底与旧流程一致）
- 分支：`--branch` 不存在时试 `--fallback-branch`，都没有则留默认分支并在 JSON 标注 `branch_source`
- 输出单行 JSON：`result(success|degraded|failed)`、`from_cache`、`branch`、`commit`、`duration_ms`、`degraded_reason`

**为什么 hardlink 本地 clone 而非 `git clone --reference`（alternates）**：alternates 让 run 仓依赖镜像文件，镜像 gc/强推清对象会损坏在跑的 run；hardlink 是独立副本（镜像 repack 不影响 run 侧 inode），同样秒级、同样省空间（已验证同一 inode）。

### 2. 多仓准备（framework + engine）

| 条件 | 准备的仓 |
|---|---|
| Issue 正文给了仓地址 | 正文地址（可能是 engine fork，如 wxflutter_engine335） |
| 版本 < 3.35 | framework 仓 **和** engine 仓 |
| problem_type_preliminary ∈ 渲染/稳定性/性能 | 建议一并准备 engine 仓 |
| 其余 | framework 仓 |

- framework：`https://gitcode.com/CPF-Flutter/flutter_flutter.git`（默认分支 **dev**，用户确认日常开发用 dev）
- engine：`https://gitcode.com/CPF-Flutter/flutter_engine.git`（**分支与 framework 同名**，如 oh-3.27.4-dev；无同名分支回退 dev——已 ls-remote 验证 engine 存在 dev + oh-3.22.0-dev/oh-3.27.4-dev 等同名分支）
- 目录约定：主仓 → `repo/`，engine 仓 → `repo-engine/`；下游配套：
  - 根因分析：硬约束放行 repo-engine/；engine 层根因必须引用 engine 源码 文件:行号 作为 confirmed 证据
  - 代码修复：引擎层修复改 repo-engine/，patch 追加 `outputs/fix-engine.patch` 并标注来源仓
  - 信息采集 JSON：新增 `engine_repo_url`/`engine_repo_path`，`repo_preparation` 枚举扩为 `cached|fetched|cloned|degraded|skipped`

## 验证

| 项 | 结果 |
|---|---|
| engine 全量 ensure（首次） | 3m24s（一次性成本） |
| 镜像 hardlink clone + checkout oh-3.27.4-dev | **2.7s**（约 75 倍提速） |
| dest 重入复用 | 1.3s |
| origin 指回真实上游 | ✓（后续 git fetch/checkout 行为与旧流程一致） |
| 分支 fallback（oh-3.41.9-dev 不存在于 engine → dev） | ✓ |
| 并发（两进程同时 clone 同镜像） | 双成功，镜像 fsck 完好 |
| hardlink（镜像与 clone 的 pack 同一 inode） | ✓ 物理磁盘不翻倍 |
| vitest：field-routing 44 用例 + verdict 全过；diagnosis-harness-regression 2 个失败为基线预存（stash 对照确认） | ✓ |

### 端到端验证（真实 Issue 诊断任务，2026-09-15 19:30）

首次提交时发现并修复一处**路径 bug**：YAML/skill 文档最初写的 `skills/cpf-ohos-issue-analysis/scripts/...`，而 agent 工作区实际挂载在 `.agents/skills/`（`getEngineSkillsSubdir` 返回 `.agents/skills`，`~/.aceharness/skills` → 仓库 skills 双层符号链接）。已改为 `.agents/skills/...`（cwd 相对）+ 绝对路径兜底，并在真实 run 工作区 cwd 下实测可达。

- Issue #2712：正文 API 404（Issue 不存在/私有），agent 按对照验证规则快速终止，未空跑——设计内快速终止逻辑工作正常
- Issue #2492（3.41 渲染类）：**agent 真实执行缓存脚本**（流中捕获两条命令：framework `--dest repo/ --branch oh-3.41.9-dev` + engine `--dest repo-engine/`），脚本输出 `from_cache:true`；**双仓 30 秒内就绪**（旧流程 framework 7m34s + engine 3m24s 全量 ≈ 11 分钟）；engine 无同名分支正确回退 `dev`；信息采集 JSON 输出 `repo_preparation:"cached"`、`engine_repo_path` 就位；任务正常推进至根因分析（issueanalysis_analyzing）

## 部署

- skill 目录（脚本 + 文档）经 `~/.aceharness/skills/` 符号链接挂载，仓库改动即时生效，无需重启
- 两份 YAML cp 到 `~/.aceharness/configs/`（workflow 每次 run 启动时读盘，无需重启）
- 已预热 engine 镜像；framework 镜像预热进行中（2G+，完成后所有后续 run 秒级取用）

## 运维备忘

- 缓存目录：`~/.aceharness/repo-cache/`（环境变量 `ACEHARNESS_REPO_CACHE_DIR` 可覆盖）
- 查看：`node skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs status`
- 镜像损坏恢复：删对应镜像目录，下次 run 自动重建（期间自动降级直连）
- 二期可做：gitcode-pr-review（PR 自修）工作流接入同一缓存；systemd timer 定时预热 top 仓；镜像 LRU 清理
