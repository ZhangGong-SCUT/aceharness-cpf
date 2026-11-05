# cpf-ohos-issue-diagnosis

**CPF OHOS Issue 智能诊断系统** —— 面向 OHOS 跨平台框架（Flutter-OHOS / React Native-OHOS / KMP-CMP 等）的 Issue 自动化诊断服务。

用户粘贴一个 GitCode / GitHub / Gitee 的 Issue URL，系统代理调用 [AceHarness](https://gitcode.com/huangyouhua/ACEHarness/tree/cpf-ohos-issue-diagnosis) 工作流引擎执行智能分析，产出包含**问题定位、根本原因、影响范围、修复建议、优先级评估**的完整诊断报告（六大章节）。

> 本系统采用**代理模式**：只负责任务受理、状态映射与前端展示，实际分析能力由 AceHarness 服务提供，本地仅存储任务元数据（taskId ↔ runId 映射）。

## 系统组成

| 服务 | 目录 | 端口 | 说明 |
|------|------|------|------|
| **后端 API 服务** | `Server/` | 3000 | Issue 分析任务受理、状态代理、报告渲染 |
| **前端 Web 服务** | `web/` | 8080 | 静态页面 + `/api/*` 反向代理（含 SSE 透传） |
| **数据库管理服务** | `dbController/` | 7788 | SQLite 可视化管理（schema 查看、数据浏览、SQL 查询） |
| OpenCode CLI | 外部 | 4096 | 健康检查依赖（`/api/alive`），需预先启动 `opencode serve` |
| AceHarness | 外部 | — | 工作流引擎，默认 `https://cpf-manager.xyz`，可配置 |

## 快速开始

```bash
# 0. 配置环境变量
cp .env.example .env   # 填入 AceHarness 账号、GitCode Token 等

# 1. 启动 OpenCode CLI 服务（后端健康检查依赖，端口 4096）
nohup ~/.opencode/bin/opencode serve --port 4096 > /tmp/opencode-serve.log 2>&1 &

# 2. 启动后端服务（端口 3000）
node Server/server.js

# 3. 启动前端服务（端口 8080，代理到 3000）
API_SERVER=http://localhost:3000 PORT=8080 node web/server.js

# 4. （可选）启动数据库管理服务（端口 7788）
node dbController/server.js
```

打开 `http://localhost:8080` 即可使用。

## 核心功能

### 1. Issue 智能分析（核心业务）

| API | 方法 | 说明 |
|-----|------|------|
| `/api/issue-analysis` | POST | 启动分析任务，入参 `issueUrl`（必填）、`accessToken`、`priority`、`issueType`、`configFile` |
| `/api/issue-analysis/validate` | POST | 校验 Issue URL 格式并解析 owner/repo/编号 |
| `/api/issue-analysis` | GET | 列出所有任务（含 AceHarness 工作台跳转链接） |
| `/api/issue-analysis/:taskId/status` | GET | 查询任务状态（实时代理 AceHarness） |
| `/api/issue-analysis/:taskId/final-review` | GET | 诊断报告：浏览器访问渲染 HTML，`curl` 下载 Markdown |

**支持平台**：GitCode、GitHub、Gitee（URL 形如 `/{owner}/{repo}/issues/{number}`）。

**任务状态机**（AceHarness 状态 → 本地 stage 映射）：

```
issueanalysis_pending → issueanalysis_fetching → issueanalysis_analyzing → issueanalysis_complete
                                                                                    ↘ failed / cancelled
```

**报告内容**：问题概述、环境信息、复现步骤、根因结论、修复建议、验证建议六大章节。

### 2. 内嵌子系统（挂载在前端 web 服务上）

**GitCode 打 TAG 系统**（`TAG/`，页面 `/tag`）

| API | 方法 | 说明 |
|-----|------|------|
| `/tag/list` | GET | 获取所有 TAG 记录 |
| `/tag/create` | POST | 创建 TAG 记录（仅入库） |
| `/tag/execute` | POST | 执行打 TAG 操作 |
| `/tag/delete/:id` | DELETE | 删除 TAG 记录 |

**PR 检视意见批量解决系统**（`PrCheck/`，页面 `/prcheck`）

| API | 方法 | 说明 |
|-----|------|------|
| `/prcheck/list` | GET | 获取所有 PR 检视记录 |
| `/prcheck/create` | POST | 创建记录（仅入库） |
| `/prcheck/preview` | POST | 预览 PR 检视意见 |
| `/prcheck/execute` | POST | 批量解决检视意见（含重试、approve review） |

> 两个子系统均不存储 Token，仅在请求中临时使用；数据库分别位于 `../db/GitCodeTag/` 和 `../db/PrCheck/`。

### 3. 系统与统计 API

| API | 方法 | 说明 |
|-----|------|------|
| `/api/alive` | GET | 轻量健康检查（OpenCode CLI 连通性） |
| `/api/alive/detail` | GET | 详细健康信息（内存、队列、SSE 统计） |
| `/api/alive/copilot` | GET | Copilot CLI 健康检查 |
| `/api/queue/status` | GET | 并发队列状态 |
| `/api/stats/visit` | GET | 访问量记录 |
| `/api/stats/visit/count` | GET | 访问计数 |
| `/api/stats/session/increment` | POST | 会话计数自增 |
| `/api/stats/session/count` | GET | 会话计数查询 |

## 核心架构

```
┌────────────────────────────────────────────────────────────┐
│              前端 web/ (Express + 反向代理, :8080)           │
│  静态页面 + /tag + /prcheck + 欧盟 IP 拦截 (euBlocker)       │
│  /api/* → http-proxy-middleware → 后端 :3000 (SSE 透传)     │
└──────────────────────────┬─────────────────────────────────┘
                           │ HTTP
┌──────────────────────────▼─────────────────────────────────┐
│                后端 Server/ (Express 5, ES Modules, :3000)  │
│  routes/ — system · issueanalysis · stats                   │
├────────────────────────────────────────────────────────────┤
│  issueAnalysis/service.js  — 业务层（任务受理 + 状态映射）     │
│  issueAnalysis/aceHarnessClient.js — AceHarness HTTP 客户端  │
│      （JWT 登录缓存、workflow start/status、outputs 读取）    │
├────────────────────────────────────────────────────────────┤
│  PortingOrchestrator — 编排器（队列/并发/健康检查）            │
│  library/HybridTaskStore — 内存+SQLite 双写（重启恢复）       │
│  library/persistence/IssueAnalysisPersistence — 持久化子类   │
│  core/ — TaskQueue · Semaphore · PollingScheduler · Cancel  │
│  send/ — SSEEmitter（按 taskId 分组、用户限流、心跳）          │
└──────────────────────────┬─────────────────────────────────┘
                           │ HTTPS (JWT)
                ┌──────────▼──────────┐
                │  AceHarness 工作流   │
                │  (实际分析能力提供方) │
                └─────────────────────┘
```

### 关键设计

- **代理模式**：本系统不存储任何分析产物，所有状态/报告数据实时从 AceHarness 获取；本地 SQLite 仅存任务元数据
- **run 丢失自愈**：AceHarness 重启后内存 run 丢失时，尝试读取磁盘报告判断是否已完成，自动修正本地状态（complete/failed）
- **JWT 缓存**：AceHarness 登录 token 缓存 23 小时，避免重复登录
- **数据库连接复用**：http/https Agent keepAlive，maxSockets 6
- **数据与代码分离**：所有数据库统一存放在项目外的 `../db/` 目录

## 目录结构

```
cfp-ohos-issue-diagnosis/
├── README.md
├── AGENTS.md                      # AI Agent 指南
├── .env.example                   # 环境变量模板
├── Server/                        # 后端服务（ES Modules, Express 5）
│   ├── server.js                  # HTTP 服务入口
│   ├── PortingOrchestrator.js     # 编排器（构造、close、取消、队列、健康检查）
│   ├── routes/                    # 路由模块
│   │   ├── index.js               # 路由组装
│   │   ├── system.js              # /alive, /queue/status
│   │   ├── issueanalysis.js       # /issue-analysis/*
│   │   └── stats.js               # /stats/*（JSON 文件存储）
│   ├── issueAnalysis/             # Issue 分析业务层
│   │   ├── service.js             # 任务受理、状态映射、run 丢失自愈
│   │   └── aceHarnessClient.js    # AceHarness API 客户端（JWT、工作流）
│   ├── library/                   # 基础库
│   │   ├── config.js              # 全局配置（.env 注入）
│   │   ├── HybridTaskStore.js     # 混合存储（内存 + SQLite）
│   │   ├── TaskPersistence.js     # SQLite 持久化基类
│   │   ├── StatsService.js        # 统计服务
│   │   ├── skillInfoManager.js    # Skill 信息管理器
│   │   ├── logger.js / utils.js   # 日志与工具
│   │   └── persistence/
│   │       └── IssueAnalysisPersistence.js  # issueanalysis_tasks 表
│   ├── orchestrator/stages.js     # STAGE 状态常量
│   ├── core/                      # TaskQueue、Semaphore、PollingScheduler、CancelSignal
│   ├── cli/                       # CLI 适配层（opencode / copilot）
│   └── send/index.js              # SSEEmitter
├── web/                           # 前端服务（CommonJS, Express 5）
│   ├── server.js                  # 静态托管 + 反向代理 + TAG/PrCheck 挂载
│   ├── middleware/euBlocker.js    # 欧盟 IP 访问拦截
│   └── public/
│       ├── index.html             # 单页应用（健康检查 + Issue 分析）
│       ├── css/main.css
│       └── js/                    # health · issueanalysis · navigation · stats · utils
├── TAG/                           # GitCode 打 TAG 子系统（router + database + gitcodeApi + public）
├── PrCheck/                       # PR 检视意见批量解决子系统（同上结构）
├── dbController/                  # 数据库管理服务（:7788，管理 13 个 SQLite 库）
├── Fix/                           # 备用"系统维护中"静态页服务
├── scripts/                       # （预留，当前为空）
└── ../db/                         # 数据存储根目录（与代码分离）
    ├── issueanalysis/             # issueanalysis.db（本系统主库）
    ├── GitCodeTag/  PrCheck/      # 子系统数据库
    └── web/                       # visit-stats.json 访问统计
```

## 环境变量

配置通过项目根目录 `.env` 文件注入（模板见 `.env.example`），完整定义见 `Server/library/config.js`。

### 核心配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ACEHARNESS_BASE_URL` | `https://cpf-manager.xyz` | AceHarness 服务地址 |
| `ACEHARNESS_EMAIL` | — | AceHarness 登录邮箱（**必填**） |
| `ACEHARNESS_PASSWORD` | — | AceHarness 登录密码（**必填**） |
| `ACEHARNESS_CONFIG_FILE` | `flutter-ohos-diagnosis.yaml` | 默认工作流配置文件 |
| `ACEHARNESS_TIMEOUT_MS` | `600000` | AceHarness HTTP 请求超时（10 分钟） |
| `ACEHARNESS_POLL_INTERVAL_MS` | `3000` | 前端轮询间隔 |
| `ACEHARNESS_POLL_MAX_DURATION_MS` | `3600000` | 轮询最大时长（60 分钟） |
| `GITCODE_TOKEN` | — | GitCode API 令牌 |
| `DB_CONTROLLER_TOKEN` | — | 数据库管理 API 令牌；需设置强随机值并注入 dbController 进程，否则 API 拒绝请求 |
| `TRUST_PROXY_HOPS` | `0` | Web 前置可信代理的跳数；仅按实际网络拓扑设置，直连部署保持 0 |

### 服务与存储

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 后端服务端口 |
| `ISSUEANALYSIS_ROOT` | `../../db/issueanalysis` | Issue 分析数据根目录 |
| `WEB_STATS_ROOT` | `../../db/web` | 访问统计存储目录 |
| `TASK_PERSISTENCE` | `true` | 启用 SQLite 持久化（`false` 禁用） |
| `RESTORE_COMPLETED` | `false` | 重启时是否恢复已完成任务到内存 |

### 并发与轮询

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_CONCURRENT_TASKS` | `12` | 任务最大并发 |
| `TASK_QUEUE_SIZE` | `20` | 任务队列容量 |
| `MAX_CONCURRENT_ISSUEANALYSIS_TASKS` | `3` | Issue 分析最大并发 |
| `ISSUEANALYSIS_QUEUE_SIZE` | `20` | Issue 分析队列容量 |
| `MAX_CONCURRENT_SESSIONS` | `50` | 全局最大并发 Session 数 |
| `SEMAPHORE_ACQUIRE_TIMEOUT_MS` | `3000000` | 槽位等待超时 |
| `POLLING_INITIAL_INTERVAL_MS` | `2000` | 自适应轮询初始间隔 |
| `POLLING_MAX_INTERVAL_MS` | `12000` | 自适应轮询最大间隔 |
| `POLLING_GROWTH_FACTOR` | `1.5` | 轮询间隔增长倍数 |
| `ISSUEANALYSIS_TIMEOUT_MS` | `1800000` | 单 Issue 分析超时（30 分钟） |
| `SSE_HEARTBEAT_MS` | `25000` | SSE 心跳间隔 |
| `SSE_MAX_SUBSCRIBERS_PER_TASK` | `15` | 每任务最大 SSE 连接 |
| `SSE_MAX_SUBSCRIBERS_PER_USER` | `10` | 每用户最大 SSE 连接 |
| `LOG_LEVEL` | `info` | 日志级别 |

### CLI 集成

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCODE_HOST` | `localhost` | OpenCode CLI 地址 |
| `OPENCODE_PORT` | `4096` | OpenCode CLI 端口 |
| `GH_COMMAND` | `gh` | GitHub Copilot CLI 命令路径 |

## 数据库

主库 `issueanalysis.db`（表 `issueanalysis_tasks`，19 个字段）：

数据库管理服务默认仅监听 `127.0.0.1:7788`。启动时需在服务进程环境中设置 `DB_CONTROLLER_TOKEN`（建议 `openssl rand -hex 32` 生成）；浏览器首次访问 API 时输入该令牌。远程访问应通过受控反向代理，并配置防火墙；不要将 7788 直接暴露到公网。

- **公共字段 (10)**：`taskId`, `cliType`, `stage`, `createdAt`, `updatedAt`, `startedAt`, `finishedAt`, `error`, `retries`, `metadata`
- **专有字段 (9)**：`issueUrl`, `issueType`, `dirName`, `analysisSessionId`（存 AceHarness runId）, `analysisReportUrl`, `resultUrl`, `priorityLevel`, `summary`, `accessToken`

> 注意：dbController 管理的其余数据库（porting、codecheck、各语言 librarycheck 等）属于同源其他系统（AIWeb），与本项目运行无直接依赖。

## 开发提示

- 后端为 **ES Modules**（`"type": "module"`），前端 web 与 TAG/PrCheck 为 **CommonJS**
- 修改后端代码后需重启 `Server/server.js`；前端为静态文件，刷新浏览器即可
- 端口冲突排查：`lsof -i :3000` / `lsof -i :8080`，若被 PM2 管理的进程占用需 `pm2 stop` 而非 `kill`
- 验证服务健康：`curl http://localhost:3000/api/alive`
