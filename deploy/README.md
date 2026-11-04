# ACEHarness CPF 诊断平台 — 单机部署包

把 CPF-Flutter issue 自动诊断/修复/验证平台部署到任意一台电脑本地运行的完整套件。

## 包里有什么

| 文件 | 说明 |
|---|---|
| `dist/cangjielang-aceharness-1.0.0-beta.90.tgz` | 平台本体（100MB，含 CLI、Web UI、CPF 定制工作流与 skills、HAR/HAP 门禁脚本） |
| `install.sh` | Linux/macOS 一键部署脚本 |
| `install.ps1` | Windows（PowerShell 7+）一键部署脚本 |
| `README.md` | 本说明 |

## 为什么不用 `npm install -g @cangjielang/aceharness`（公网最新版）

公开 npm 最新版为 `1.0.0-rc.14`（通用上游版），其 `configs/` **不含** CPF 定制工作流
（`cpf-ohos-diagnosis.yaml`、`ohos-flutter-sdks.yaml`、`gitcode-pr-review.yaml` 等）。
本 tgz 从 fork 分支 `cpf-ohos-issue-diagnosis`（源机仓库 /home/flutter/ACEHarness，含未提交的配置改进）
打包，开箱即带完整诊断工作流。注意 fork 基于 beta.90，落后于上游 rc.14，后续可自行 rebase 上游。

## 快速开始（目标机，两条命令）

```bash
# Linux / macOS
chmod +x install.sh && ./install.sh

# Windows（PowerShell 7+，管理员无需；若策略限制先执行 Set-ExecutionPolicy -Scope CurrentUser RemoteSigned）
.\install.ps1
```

脚本自动完成：Node 版本检查（≥20）→ 全局安装 tgz → 同步 `~/.aceharness/{configs,skills,scripts}`
→ 改写 SDK 清单路径 → **环境自检 `ace doctor`**（11 项检查：Node/安装完整性/**构建来源**/运行时
目录/关键资产/scripts 一致性/SDK 清单/hdc/engine-src/~ 展开/端口/凭据；缺失目录自动补齐，每项
不通过时打印精确修复命令，退出码 0/1，支持 `--json`、`--no-fix`）。日常排障直接跑 `ace doctor` 即可。

**安装依赖网络（重要）**：tgz 只 bundled 了 `@cangjielang/napi-cj`，其余约 120 个生产依赖（next、
react、better-sqlite3 等）首次安装需从 npm registry 解析约 880 个包，耗时 4~12 分钟视网络而定。
内网/弱网环境请先配镜像源：`NPM_REGISTRY=https://<内网镜像> ./install.sh`（或
`npm config set registry <镜像>`）。脚本使用 `--prefer-offline`（缓存优先、缺项回退网络），
失败时自动清理 npm 暂存目录后重试一次。若安装被中途强杀，npm 全局目录可能残留 `.aceharness-*`
暂存目录导致后续 ENOTEMPTY——手动删除 `$(npm root -g)/@cangjielang/.aceharness-*` 即可。

**fork 构建的 `ace update` 锁定**：本包为 fork 构建（package.json 标记 `config.aceLineage`），
`ace update` 会被阻止并提示（它默认拉取上游 `@cangjielang/aceharness@latest`，会抹掉 CPF 定制工作流）。
确需升上游可设 `ACE_ALLOW_UPSTREAM_UPDATE=1` 绕过；正常升级 = 源机重新 `npm pack` + 目标机重装 tgz。

## 前置条件（脚本不代装，需自行准备）

| 依赖 | 用途 | 获取 |
|---|---|---|
| Node.js ≥ 20（推荐 22 LTS） | 平台运行时 | nodejs.org |
| Git | 仓库存取 | 系统包管理器 |
| DevEco Studio（含 Command Line Tools） | hdc / hvigorw / 签名 | 华为开发者官网 |
| OHOS 真机 + USB 调试 | 修复验证必需 | — |
| Flutter OHOS SDK（1.2G/版本） | 诊断按分支对号入座 | 从源机 rsync 或新装（见下） |
| `~/engine-src`（仅 engine 修复 run） | 引擎源码共享树（gclient sync） | 见 skills 内 engine-build.md |

## 装好后必做的三件事

1. **放 SDK**：`rsync -avP <源机>:/home/flutter/flutter-sdks/ ~/flutter-sdks/`（按需，可只拷目标
   issue 分支对应的版本），然后在 `~/.aceharness/configs/ohos-flutter-sdks.yaml` 里只登记装好的版本。
   新装单个版本：`git clone --depth 1 -b dev <flutter_flutter 仓> <目录> && <目录>/bin/flutter precache --ohos`。
2. **配 AI 凭据**：运行 `ace` 走启动向导。凭据写入 `~/.aceharness/data/runtime-grants/`，
   **每台机器各自配置，禁止拷贝**（含密钥，且与机器绑定）。
3. **启动**：`ace` 或 `ace start`，浏览器开 `http://localhost:3000`（`PORT=xxxx` 可改端口，
   后台运行/daemon 在启动向导里开启）。

## 机器相关配置清单（换机器时逐项核对）

| 配置 | 位置 | 本包处理 |
|---|---|---|
| SDK 根目录 | `~/.aceharness/configs/ohos-flutter-sdks.yaml` 的 `sdkRoot` + 各 `path` | 安装脚本自动改写 |
| HAR/HAP 门禁脚本 | 工作流引用 `~/.aceharness/scripts/*.mjs` | 安装脚本自动同步 |
| 引擎源码树 | 工作流引用 `~/engine-src` | 需手工准备（仅 engine 修复 run 需要） |
| AI 凭据 | `~/.aceharness/data/runtime-grants/` | 启动向导每机独立配置 |
| 端口 | `PORT` / `ACE_PORT` 环境变量，默认 3000 | 默认即可 |

## 升级流程

```bash
# 在源机（有 ACEHarness 仓库的机器）：
cd /home/flutter/ACEHarness
npm pack --ignore-scripts --pack-destination /home/flutter/ace-deploy/dist   # 更新 tgz
# 把新 tgz 拷到目标机后：
npm install -g ./cangjielang-aceharness-<新版本>.tgz
# 注意：npm i -g 只更新程序本体；~/.aceharness 下的 configs/skills/scripts 如有更新需对比后手动同步
```

## 常见问题

- **`engine_aligned=false` 导致无法 pass**：`ohos-flutter-sdks.yaml` 登记的分支别名与实际 SDK 对不上，
  按文件头注释只登记装好的版本。
- **真机步骤报 hdc 相关错误**：DevEco Command Line Tools 未进 PATH；`hdc list targets` 自检。
- **Windows 下 `~/.aceharness/...` 路径不展开**：cmd.exe 不展开 `~`，agent 终端改用 PowerShell 7+ 或 Git Bash。
- **端口 3000 被占**：`PORT=3100 ace start`。
- **诊断 run 归档膨胀**：`~/.aceharness/runs/` 随 run 线性增长（源机已 25G），定期清理或回传后清理。

## 来源与校验

- 打包源：`/home/flutter/ACEHarness` @ 分支 `cpf-ohos-issue-diagnosis`（commit cf0ffa4 + 工作区配置改进，
  含机器相关路径参数化：`/home/flutter/ACEHarness/scripts` → `~/.aceharness/scripts`、
  `/home/flutter/engine-src` → `~/engine-src`）。
- 打包命令：`npm pack --ignore-scripts`（跳过 prepack 构建，直接打包已构建产物 dist/ 与 .next/）。
- tgz 自检：5764 个文件，含 `configs/cpf-ohos-diagnosis.yaml`、`skills/cpf-ohos-issue-analysis/`（完整）、
  `scripts/ohos-hap-build.mjs`、`scripts/ohos-har-install.mjs`、`bin/ace.js`、`dist/cli.js`、`server.js`。
- 已在源机（Linux, node v22.20.0）用 install.sh 完成冒烟部署验证：干净 HOME 下 5 步全部通过，
  全局安装副本可正常启动 Web UI（2s 内响应）。
- 顺带修复了部署阻断问题：`scripts/` 原本不在 npm `files` 清单导致 tgz 缺门禁脚本
  （已加入）；两个诊断工作流 yaml 中 `/home/flutter/ACEHarness/scripts`、`/home/flutter/engine-src`
  机器绝对路径已分别参数化为 `~/.aceharness/scripts`、`~/engine-src`（源机 home 恰为
  /home/flutter，本机行为零变化）。
- `ace doctor` 子命令：`bin/ace.js` 前置分发 + `src/cli.ts` 正式命令（含 --help 条目），
  实现见 `scripts/ace-doctor.mjs`；自动修复只补缺失、不覆盖本地修改。
- fork 构建锁定：`bin/ace.js` 与 `dist/cli.js`（src/cli.ts 编译）双重拦截 `ace update`。
