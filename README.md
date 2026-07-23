<div align="center">

<p>
  <img src="https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/logo.png" alt="ACEHarness" width="96">
</p>

# ACE Harness (Agent Centric Engineering Harness)

<p>
  <strong>重构你的 Agent 生产力 | Your team of AI</strong><br>
  仓颉团队出品
</p>

[English](./README.en.md) | 中文

<p>
  <strong>企业级 AI Multi-Agent 智能协作系统</strong><br>
  Spec Driven Development / 状态机工作流 / Supervisor 智能路由 / 对抗式迭代 / 多 Agent 议场 / 长期记忆
</p>

![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-Apache--2.0%20with%20Runtime%20Library%20Exception-blue.svg)
  
ACEHarness 是一个面向工程任务的本地 AI Multi-Agent 协作平台。它把 Spec Driven Development、状态机工作流、Supervisor 智能路由、对抗式迭代、多 Agent 议场、Git 基线断点、多层永久记忆、Notebook 知识沉淀、Skill 能力扩展和模型/引擎诊断组合在一起，让复杂研发任务可以被规划、执行、协作、审查、回退、恢复和复盘。

<p>
  <img src="https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/readme.png" alt="ACEHarness 产品总览" width="59%">
  <img src="https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/images/cover.png" alt="ACEHarness 封面" width="39%">
</p>

</div>

---

## 目录

- [产品全景](#产品全景)
- [一人公司模式](#一人公司模式)
- [快速开始](#快速开始)
- [部署到公网域名（Cloudflare Tunnel）](#部署到公网域名cloudflare-tunnel)
  - [Windows 部署指南（最简版）](./docs/deploy-windows-guide.md)
- [核心机制](#核心机制)
- [系统架构](#系统架构)
- [产品界面](#产品界面)
- [工作流案例](#工作流案例)
- [配置与引擎](#配置与引擎)
- [渠道接入](#渠道接入)
- [文档](#文档)
- [开发参考](#开发参考)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

---

## 产品全景

ACEHarness 按“规划、执行、协作、沉淀、扩展、接入”组织工程任务闭环；下图展开核心能力入口，便于从产品全景进入日常工作流。

<picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/images/features-overview.svg">
    <img src="https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/images/features-overview.svg" alt="ACEHarness 核心能力亮点">
</picture>

---

## 一人公司模式

一人公司模式把 `/office` 办公室变成个人 AI 团队桌面，用户用一句话组建或调整产品、设计、工程、增长、运营等 Agent 角色，并通过工位、组织图、私聊/群聊和长期记忆持续协作。

![一人公司模式角色蓝图](./public/images/opc-roles.png)

---

## 快速开始

### 前置条件

- Node.js `>= 20` / npm `>= 9`：运行 Next.js 服务与 npm CLI 包
- AI 执行引擎：`claude-code`、`kiro-cli`、`opencode`、`nga`、`codegenie`、`cursor`、`codex`、`trae-cli`、`magic-cli` 等至少一种

### 安装与运行

快速开始：

```bash
npm install -g @cangjielang/aceharness

ace --help
ace
# ✔ 请选择语言 › 中文
# [ACE] 欢迎使用。首次启动将初始化本地运行配置。
# ...
# [ACE] 正在启动服务：http://127.0.0.1:3000
# [ACEHarness] Server ready on http://0.0.0.0:3000
# [ACE] 请在浏览器中打开 http://127.0.0.1:3000
```

首次访问会进入初始化流程：创建管理员、选择语言、配置默认工作目录和可用 AI 引擎。后续团队成员可通过注册页申请账号，由管理员审核后使用。进入控制台后，可通过 Onboarding 查看完整使用路径和模块引导。

如果您是开发者：

```bash
git clone https://gitcode.com/Cangjie-SIG/ACEHarness.git && cd ACEHarness

# 安装依赖
npm install

# 本地调试：npm run dev 会先构建 CLI，再启动开发服务
ACE_HOST=0.0.0.0 ACE_PORT=3000 npm run dev

# Windows PowerShell:
# $env:ACE_HOST="0.0.0.0"
# $env:ACE_PORT="3000"
# npm run dev

# 生产模式：首次启动或代码更新后先构建
npm run build
ACE_HOST=0.0.0.0 ACE_PORT=3000 npm start
```

启动后访问 `http://127.0.0.1:3000`。如果使用 PowerShell 运行生产模式，同样先设置 `$env:ACE_HOST` 和 `$env:ACE_PORT`，再执行 `npm start`。

ACE Service 的全局 CLI 用法：

```bash
ace              # 启动 ACE Service
ace start        # 显式启动 ACE Service
ace service      # 查看并停止当前受管的 ACE 实例
ace update       # 更新到 npm latest 版本
ace update beta  # 更新到指定 npm tag 或版本号，例如 beta / release / 1.0.0-beta.66
```

启动向导支持直接开启后台运行；如同时启用守护进程，ACE 会以 daemon 模式托管后台服务，并在异常退出后自动拉起。执行 `ace update` 时会检查这些受管的 ACE 实例；交互模式下可选择停止后更新、继续更新但不停止，或取消更新。脚本中可用 `ace update --stop-running` 先停止运行中的实例，或用 `ace update --force` 在实例仍运行时继续安装，运行中的服务重启后才会使用新版本。

---

## 部署到公网域名（Cloudflare Tunnel）

通过 Cloudflare Tunnel（cloudflared）可以将本地运行的 ACEHarness 服务安全地暴露到公网域名，无需公网 IP、无需端口转发、无需修改防火墙。以下是完整步骤。

### 前置条件

- 一个域名（如 `cpf-manager.xyz`），DNS 已托管到 Cloudflare
- 本地已安装 `cloudflared` CLI
- ACEHarness 服务已在本地正常运行

### 步骤 1：安装 cloudflared

```bash
# macOS
brew install cloudflared

# 验证
cloudflared --version
```

### 步骤 2：登录 Cloudflare 并创建 Tunnel

```bash
# 登录（会打开浏览器授权）
cloudflared tunnel login

# 创建一个 tunnel
cloudflared tunnel create aceharness
# 输出示例：
# Created tunnel aceharness with id 769ef0ee-a101-4f38-b384-cb5642d47bf2
# Credentials written to /Users/<user>/.cloudflared/769ef0ee-xxxx.json
```

### 步骤 3：配置 DNS 路由

```bash
# 将域名 DNS CNAME 指向 tunnel ID
cloudflared tunnel route dns aceharness cpf-manager.xyz
```

这会自动在 Cloudflare DNS 添加一条 CNAME 记录：`cpf-manager.xyz → 769ef0ee-xxxx.cfargotunnel.com`。

### 步骤 4：编写 config.yml

创建 `~/.cloudflared/config.yml`：

```yaml
tunnel: <你的-tunnel-id>
credentials-file: /Users/<user>/.cloudflared/<tunnel-id>.json

# 中国网络环境推荐使用 http2 协议（QUIC/UDP 可能被 GFW 阻断）
protocol: http2

ingress:
  - hostname: cpf-manager.xyz
    service: http://localhost:3031
  - service: http_status:404
```

> **端口说明**：`service` 中的端口必须与 ACEHarness 实际监听端口一致。ACEHarness 默认监听 3000，可通过 `ACE_PORT` 环境变量修改（见步骤 5）。

### 步骤 5：启动 ACEHarness 服务

```bash
cd /path/to/ACEHarness

# 开发模式（dev）：热编译，适合调试，但长期运行会 OOM
nohup env ACE_PORT=3031 npm run dev > /tmp/aceharness.log 2>&1 &

# 生产模式（推荐长期运行）：先 build 再 start
npm run build
nohup env ACE_PORT=3031 npm start > /tmp/aceharness.log 2>&1 &

# 验证本地服务
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3031/
# → HTTP 200
```

> ⚠️ **端口冲突注意**：如果 3000 端口被其他服务占用，务必通过 `ACE_PORT=3031` 指定端口。不要使用 `env -C`（macOS 不支持）或 `PORT=`（可能被覆盖），统一用 `ACE_PORT`。

### 步骤 6：启动 cloudflared

```bash
nohup cloudflared tunnel run > ~/.cloudflared/cloudflared.log 2>&1 &

# 验证 tunnel 连接
cloudflared tunnel info <tunnel-id>
# 应显示 4 条 connection（connIndex=0~3），location 为最近的 edge 节点
```

### 步骤 7：验证公网访问

```bash
# 直接访问（如果本地网络可直连 Cloudflare）
curl -sI https://cpf-manager.xyz/

# 中国网络环境可能需要走代理
curl -sk -o /dev/null -w "HTTP %{http_code} | TTFB=%{time_starttransfer}s\n" \
  --proxy http://127.0.0.1:7890 https://cpf-manager.xyz/
# → HTTP 200 | TTFB=0.8s
```

浏览器打开 `https://cpf-manager.xyz` 即可访问 ACEHarness。

### 常见问题排查

#### 问题 1：公网返回 HTTP 530（Origin Error）

**原因**：cloudflared 连不上本地 origin 服务。

```bash
# 检查 ACEHarness 是否在运行
ps aux | grep "[n]ode.*server.js"
lsof -iTCP:3031 -sTCP:LISTEN

# 检查 cloudflared 日志
tail -20 ~/.cloudflared/cloudflared.log
# 如果看到 "dial tcp [::1]:3031: connect: connection refused"
# 说明 ACEHarness 进程挂了或端口不对
```

**修复**：重启 ACEHarness 服务（见步骤 5）。

#### 问题 2：Next.js dev lock 冲突

**原因**：多个 dev 实例同时启动，`.next/dev/lock` 被占用。

```bash
# 错误信息：
# ⨯ Unable to acquire lock at .next/dev/lock, is another instance of next dev running?

# 修复：杀掉所有残留进程 + 删除 lock
pkill -9 -f "node.*server.js"
rm -f .next/dev/lock

# 重新启动
nohup env ACE_PORT=3031 npm run dev > /tmp/aceharness.log 2>&1 &
```

#### 问题 3：dev 模式 OOM 崩溃

**原因**：dev 模式下 Next.js 热编译 + 多个 opencode-sdk session 并发，内存持续增长直到被系统 OOM killer 杀掉。

```bash
# 日志中的警告：
# ⚠ 正在以 DEV（开发）模式运行 —— 长期运行内存会持续增长直至 OOM，请勿用于部署。

# 修复：长期运行改用 production 模式
npm run build
nohup env ACE_PORT=3031 npm start > /tmp/aceharness.log 2>&1 &
```

#### 问题 4：QUIC 协议被 GFW 阻断

**原因**：cloudflared 默认使用 QUIC（UDP 7844），在中国网络环境可能被阻断。

**修复**：在 `config.yml` 中强制使用 `http2` 协议：

```yaml
protocol: http2  # 走 TCP，不依赖 QUIC/UDP
```

#### 问题 5：DNS 未生效

**原因**：域名 NS 未指向 Cloudflare，或 DNS 记录未传播。

```bash
# 检查 NS 是否指向 Cloudflare
dig +short cpf-manager.xyz NS
# 应返回 *.ns.cloudflare.com

# 检查 A 记录
dig +short cpf-manager.xyz A
# 应返回 Cloudflare 的 anycast IP（104.x.x.x 或 172.67.x.x）

# 多 DNS 服务器检查传播情况
for d in 8.8.8.8 1.1.1.1 114.114.114.114 223.5.5.5; do
  echo "--- $d ---"
  dig +short cpf-manager.xyz NS @$d
done
```

如果 NS 未指向 Cloudflare，需要到域名注册商（如腾讯云）修改 NS 为 Cloudflare 分配的 NS 服务器。

### 一键重启脚本

将以下脚本保存为 `scripts/restart-service.sh`，方便快速重启：

```bash
#!/bin/bash
# ACEHarness + Cloudflare Tunnel 一键重启脚本

export PATH="/Applications/DevEco-Studio.app/Contents/tools/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$(dirname "$0")/.."  # 假设脚本在 scripts/ 目录，自动定位仓库根

PORT=3031
TUNNEL_ID="769ef0ee-a101-4f38-b384-cb5642d47bf2"

echo "=== 1. 停止旧进程 ==="
pkill -9 -f "node.*server.js" 2>/dev/null
pkill -f "cloudflared" 2>/dev/null
sleep 2

echo "=== 2. 清理 lock ==="
rm -f .next/dev/lock

echo "=== 3. 启动 ACEHarness (port $PORT) ==="
nohup env "PATH=$PATH" ACE_PORT=$PORT npm run dev > /tmp/aceharness.log 2>&1 &
echo "  ACEHarness PID: $!"
sleep 15

echo "=== 4. 启动 cloudflared ==="
nohup cloudflared tunnel run > ~/.cloudflared/cloudflared.log 2>&1 &
echo "  cloudflared PID: $!"
sleep 5

echo "=== 5. 验证 ==="
curl -s -o /dev/null -w "  本地: HTTP %{http_code}\n" http://127.0.0.1:$PORT/
curl -sk -o /dev/null -w "  公网: HTTP %{http_code}\n" --proxy http://127.0.0.1:7890 https://cpf-manager.xyz/

echo "=== 完成 ==="
echo "  访问地址: https://cpf-manager.xyz"
```

### Cloudflare 免费额度说明

- **Cloudflare Tunnel**：完全免费，无流量限制、无请求数限制
- **DNS / SSL / CDN / DDoS 防护**：免费
- **Zero Trust 用户**：免费 50 个用户
- **Tunnel 连接数**：每个 tunnel 最多 4 条并发连接（足够个人/小团队使用）
- **请求 body 限制**：100 MB

> 中国跨境访问 Cloudflare 的固有延迟约 500-1000ms（TTFB），这是网络物理距离决定的，非配置问题。如需加速可考虑 Cloudflare Argo Smart Routing（$5/月）或部署到国内服务器。

---

## 跨平台部署（macOS ⇄ Windows 切换）

> **本节配套 3 个文件**（仓库已自带）：
> - `ecosystem.config.cjs` — PM2 配置，平台自动分流
> - `scripts/deploy-windows.ps1` — Windows 一键部署脚本
> - `scripts/switch-tunnel.sh` — Mac/Linux 一键切换 DNS 指向的 tunnel

### 场景

开发机在 Mac、生产机在 Windows（或反过来）。两台机器都装了 cloudflared、都创建了 tunnel，但**同一时间只能让一台对外提供服务**——否则请求会被随机分配到不同机器，体验分裂。

### 架构原理

```
用户浏览器
   ↓ https://cpf-manager.xyz
Cloudflare 边缘节点（自动选最近）
   ↓ CNAME 解析
Tunnel A（Mac 临时）  ←  当前 DNS 指向这台
Tunnel B（Windows 生产）
   ↓ http://localhost:3031
ACEHarness (Next.js + server.js)
```

**核心原则**：DNS CNAME 一次只指向一个 tunnel。要切换时，执行 `switch-tunnel.sh` 即可。

### 仓库内置部署工具

#### 1. `ecosystem.config.cjs`（PM2 配置，跨平台）

| 平台 | Node 解释器 | cloudflared 路径 | 备注 |
|------|------------|------------------|------|
| macOS | `~/.nodebrew/current/bin/node`（可通过 `ACE_NODE_BIN` 环境变量覆盖） | `/opt/homebrew/bin/cloudflared` | 强制 Node 22（DevEco 自带 18 太老）|
| Windows | `node`（系统 PATH） | `%USERPROFILE%\cloudflared.exe` | 用 `winget install Cloudflare.cloudflared` |

**关键设计**：
- `exec_mode: 'fork'`：server.js 不是 cluster 安全的
- `max_memory_restart: '2G'`：超过 2G 自动重启（防 OOM 静默死亡）
- 完整 `PATH` 注入 opencode / hdc / adb 等子命令
- 日志统一输出到 `logs/aceharness-*.log` 和 `logs/cloudflared-*.log`

#### 2. `scripts/deploy-windows.ps1`（Windows 一键部署）

在 Windows PowerShell 里执行 `.\scripts\deploy-windows.ps1`，会自动：
1. ✅ 检查 Node 20.9+ / PM2 / cloudflared
2. ✅ `npm ci` + `npm run build`
3. ✅ 创建日志目录
4. ✅ `cloudflared tunnel login`（首次需要浏览器授权）
5. ✅ 创建或复用名为 `aceharness` 的 tunnel
6. ✅ 生成 `~/.cloudflared/config.yml`
7. ✅ `pm2 start ecosystem.config.cjs && pm2 save`
8. ✅ 端到端验证本地 + 公网

#### 3. `scripts/switch-tunnel.sh`（DNS 切换，Mac/Linux）

```bash
# 列出所有 tunnel
./scripts/switch-tunnel.sh

# 把 cpf-manager.xyz 切到指定 tunnel
./scripts/switch-tunnel.sh 24341696-3a8f-47dd-8737-933ff80f4801
```

内部调用 Cloudflare API 的 PATCH `/dns_records/{id}`，5 秒内全球生效。

### 完整工作流：Mac 验证 → Windows 生产

#### Phase 1：Mac 临时验证（当前）

```bash
# Mac 端
cd /Users/<user>/Desktop/FlutterProject/ACEHarness
npm run build
pm2 start ecosystem.config.cjs
pm2 save
./scripts/switch-tunnel.sh $(cloudflared tunnel list | grep aceharness-mac | awk '{print $1}')
```

公网验证：`https://cpf-manager.xyz` 返回 200。

#### Phase 2：切到 Windows 机器

```powershell
# Windows 端（PowerShell）
cd C:\path\to\ACEHarness
.\scripts\deploy-windows.ps1
```

部署完成后在 Windows 上看到本机 tunnel id（`xxxx-yyyy-...`）。

#### Phase 3：DNS 切到 Windows tunnel

**二选一**：

```bash
# 在 Mac 上（推荐：Mac 仍是开发主控机）
./scripts/switch-tunnel.sh <windows-tunnel-id>

# 或在 Windows 上
.\scripts\switch-tunnel.ps1 <windows-tunnel-id>
```

#### Phase 4：清理 Mac 端（可选）

```bash
# Mac 端
pm2 delete all
cloudflared tunnel delete aceharness-mac
```

### 多 tunnel 共存时的注意事项

| 现象 | 原因 | 解决 |
|------|------|------|
| 公网访问随机失败 | DNS 指向的 tunnel 在那台机器没运行 | `switch-tunnel.sh` 切到正在运行的 tunnel |
| `cpf-manager.xyz` 解析到 `104.21.x.x` | Proxied CNAME 被 Cloudflare 隐藏链 | 正常现象，看不到中间 cfargotunnel 链 |
| Dashboard 看不到 A 记录 | CF 把 Proxied CNAME 当 A 记录存 | 用 API 列：`curl -H "Authorization: Bearer $TOKEN" .../dns_records` |
| 多台机器 tunnel 名冲突 | Cloudflare 同一账号下 tunnel 名唯一 | 用机器后缀：`aceharness-mac` / `aceharness-win` |

### 开机自启

#### macOS

```bash
pm2 startup
# 会输出类似：sudo env PATH=... pm2 startup launchd -u <user> --hp /Users/<user>
# 把那行命令复制执行一次即可
pm2 save
```

#### Windows（推荐 NSSM）

```powershell
# 安装 nssm
choco install nssm

# 把 pm2 注册成 Windows 服务
nssm install ACEHarness-PM2 "C:\Program Files\nodejs\node.exe" "C:\Users\<user>\.npm-global\node_modules\pm2\bin\pm2" " resurrect"
nssm set ACEHarness-PM2 AppDirectory "C:\path\to\ACEHarness"
nssm start ACEHarness-PM2
```

> ⚠️ 简单场景也可以用 `pm2-startup`（`npm i -g pm2-windows-startup && pm2-startup install`），但稳定性不如 NSSM。

### 跨平台同步 checklist

- [ ] Mac 和 Windows 都装了 Node 20.9+
- [ ] 两边都 `npm ci && npm run build`
- [ ] 两边 `cloudflared tunnel list` 能看到自己的 tunnel
- [ ] 同一时间只让一台机器的 PM2 跑 `aceharness + cloudflared`
- [ ] DNS 切到正在跑的那台的 tunnel id
- [ ] 不跑的那台可以保留 tunnel（备用），但 PM2 进程关掉
- [ ] 代码改动通过 git push/pull 同步，不要直接拷贝 `.next` 目录

---

## 核心机制

![核心机制总览](https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/images/core-mechanisms-overview.svg)

ACEHarness 的核心机制已整合在上方工作台图中：从 Spec 计划与状态机执行，到 Supervisor 路由、对抗评审、议场协作、记忆沉淀、能力扩展、模型诊断和外部渠道接入，形成可治理的工程闭环。

---

## 系统架构

![系统架构 SVG 配图](https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/images/system-architecture.svg)

注：
- 浏览器前端承接首页对话、工作流工作台、议场、笔记本、工作区和设置诊断等主要页面。
- 服务入口统一处理启动、页面路由、接口路由、鉴权、协作长连接和流式事件。
- 业务服务负责任务、对话、状态机、规范开发、议场、笔记本、工作区、渠道、能力市场和模型诊断。
- 运行与执行层通过调度器、进程管理器、引擎工厂、上下文恢复和结果归一化连接多种执行后端。
- 本地数据根目录沉淀配置、数据、缓存、日志、工作区、运行记录、笔记本和能力包，外部渠道消息进入同一上下文。

## 产品界面

![前端页面功能云图](https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/images/product-interface-overview.svg)

ACEHarness 的界面围绕日常工程工作流组织：

- **首页对话**：承接普通 AI 对话、工作流创建、议场入口和微信 ClawBot 会话绑定。
- **议场**：以话题或工作流为中心组织多 Agent 群聊，适合方案讨论、分歧收敛和执行复盘。
- **工作流工作台**：展示状态机运行、步骤流式输出、人工检查点、Preflight 结果、Git 步骤变更和运行恢复；状态机步骤支持嵌入另一个状态机作为子工作流执行。
- **Workspace 与变更**：内嵌文件编辑、目录浏览、Git diff、步骤级变更和 baseline 对比。
- **Cangjie Notebook**：沉淀文档、笔记、运行产物和复盘材料，支持个人/团队空间、协作编辑、快照和分享。
- **模型/引擎诊断台**：用标准 probe 评估模型与执行后端，定位 SDK、ACP、HTTP driver 和流式事件问题。
- **治理与接入**：账号、用户、系统设置、渠道接入和 API 文档作为治理入口串联所有页面。

## 工作流案例

![工作流案例总览](https://raw.gitcode.com/Cangjie-SIG/ACEHarness/files/main/public/images/workflow-cases-overview.svg)

查看四个案例的根因路径、执行数据与交付结果：[工作流案例文档](https://gitcode.com/Cangjie-SIG/ACEHarness/blob/main/docs/workflow-cases.md)。

## 配置与引擎

ACEHarness 的配置主要由启动向导、引擎管理页和环境变量共同决定。当前仓库支持 `claude-code`、`kiro-cli`、`opencode`、`nga`、`codegenie`、`cursor`、`codex`、`trae-cli`、`magic-cli` 等本地执行后端；模型/引擎诊断台可验证连接、流式事件、结构化输出、代码、数学和推理能力。

### ACE Service

`server.js` 会在启动时加载 `.env`、`.env.local` 以及当前模式对应的 `.env.development*` / `.env.production*`；shell、进程管理器或启动脚本里已存在的环境变量优先级更高，不会被文件覆盖。

核心启动与运行目录变量：

| 变量 | 说明 | 默认值 / 优先级 |
|------|------|-----------------|
| `ACE_HOST` | 服务监听地址 | `127.0.0.1` |
| `ACE_PORT` | ACEHarness 服务端口 | `3000` |
| `PORT` | 通用服务端口 | 优先级高于 `ACE_PORT` |
| `BASEURL` / `BASE_URL` | 反向代理子路径或站点前缀，用于生成 Next.js `basePath` / `assetPrefix`，避免 `_next` CSS/JS 资源以根路径访问 | 未设置时为空；示例：`/ace` 或 `https://example.com/ace` |
| `ACE_HOME` | ACE 运行根目录，决定 `config/`、`data/`、`cache/`、`logs/`、`workspace/` 等运行时数据位置 | 未设置时按平台回退 |
| `APPDATA` | Windows 下 `ACE_HOME` 的回退根目录 | `<APPDATA>/ACEHarness` |
| `XDG_DATA_HOME` | Linux / macOS 下 `ACE_HOME` 的回退根目录 | `<XDG_DATA_HOME>/aceharness` |

反向代理到子路径时，需要在构建和启动时使用同一个 `BASEURL`。例如将外部 `/ace/` 代理到本地 `http://127.0.0.1:3000/`：

```bash
BASEURL=/ace ACE_HOST=127.0.0.1 ACE_PORT=3000 npm run build
BASEURL=/ace ACE_HOST=127.0.0.1 ACE_PORT=3000 npm start
```

开发模式也可以直接：

```bash
BASEURL=/ace ACE_HOST=127.0.0.1 ACE_PORT=3000 npm run dev
```

Windows PowerShell:

```powershell
$env:BASEURL="/ace"
$env:ACE_HOST="127.0.0.1"
$env:ACE_PORT="3000"
npm run dev
```
| `ACE_INSTALL_ROOT` | 安装根目录；用于定位 `server.js`、`configs/`、`dist/` 等安装内容 | 未设置时由启动器自动设为当前安装目录 |
| `ACE_LOCALE` | ACE CLI 与服务默认语言 | 优先级高于 `LANG` / `LC_ALL` |
| `LANG` | 语言回退变量 | 在 `ACE_LOCALE` 未设置时参与解析 |
| `LC_ALL` | 语言回退变量 | 在 `ACE_LOCALE`、`LANG` 未设置时参与解析 |
| `NODE_ENV` | 运行模式；同时影响 `.env*` 加载和部分调试默认值 | `production`（受管服务子进程默认如此） |
| `ACE_MAX_OLD_SPACE_MB` | 服务进程 V8 老生代堆上限（MB），覆盖自动计算值 | 默认按物理内存 60% 取值，夹在 `4096`–`8192` |
| `ACE_MEM_WATCHDOG` | 内存看门狗开关；超阈值时在 OOM 前优雅重启 | 默认开启；设为 `0` 关闭 |
| `ACE_MEM_SOFT_PCT` | 软阈值（占堆上限比例）；仅在空闲时触发优雅重启 | `0.80` |
| `ACE_MEM_HARD_PCT` | 硬阈值（占堆上限比例）；无条件强制重启以避免 OOM | `0.92` |
| `ACE_MANAGED` | 内部标记：标识服务进程受 daemon 监管，允许看门狗自重启 | 由 CLI 自动设置，无需手动配置 |

对外地址与渠道恢复变量：

| 变量 | 说明 | 默认值 / 优先级 |
|------|------|-----------------|
| `ACE_PUBLIC_ORIGIN` | 对外访问的绝对地址；用于 webhook、回调 URL、官方微信桥接等场景 | 优先级最高 |
| `NEXT_PUBLIC_ACE_ORIGIN` | 对外地址回退值 | 次于 `ACE_PUBLIC_ORIGIN` |
| `NEXT_PUBLIC_APP_ORIGIN` | 对外地址回退值 | 次于 `NEXT_PUBLIC_ACE_ORIGIN` |
| `ACE_WECHAT_AUTO_RESTORE` | 是否在服务启动后自动恢复官方微信 bridge | 默认开启；设为 `0` / `false` 可关闭 |
| `ACE_WECHAT_RESTORE_DELAY_MS` | 官方微信 bridge 自动恢复延迟（毫秒） | `3000` |

诊断与 ACP / 流式运行变量：

| 变量 | 说明 | 默认值 / 优先级 |
|------|------|-----------------|
| `ACE_TIMING_DEBUG` | 打印服务与 ACP 阶段耗时日志 | 本地开发默认开，生产 / 测试默认关 |
| `ACE_ACP_TIMING_DEBUG` | 同上，专门控制 ACP 耗时日志 | 可与 `ACE_TIMING_DEBUG` 叠加使用 |
| `ACE_ACP_STREAM_DEBUG` | 打印 ACP stream 事件级调试信息 | 未设置时跟随引擎诊断开关 |
| `ACE_ACP_INIT_TIMEOUT_MS` | ACP `connection.initialize` 超时（毫秒） | `30000` |
| `ACE_ACP_NEW_SESSION_TIMEOUT_MS` | ACP `newSession` 超时（毫秒） | `60000` |
| `ACE_ACP_LOAD_SESSION_TIMEOUT_MS` | ACP `session/load` 超时（毫秒） | `30000` |
| `ACE_ACP_MODEL_DISCOVERY_TIMEOUT_MS` | 模型发现接口总超时（毫秒） | `init + newSession + 15000` |
| `ACE_CHAT_STREAM_DEBUG` | Claude Code SDK 流式输出调试 | 默认关闭 |
| `ACE_CLAUDE_CODE_EXECUTABLE` | 指定 Claude Code 可执行文件路径 | 未设置时回退到 `CLAUDE_CODE_EXECUTABLE` 或自动探测 |
| `ACE_CLAUDE_API_RETRY_ATTEMPTS` | Claude Code SDK API 重试次数上限 | `12` |
| `ACE_CLAUDE_API_RETRY_MIN_DELAY_MS` | Claude Code SDK API 最小重试间隔（毫秒） | `10000` |

按引擎生效的 ACE 变量：

| 变量 | 说明 | 默认值 / 优先级 |
|------|------|-----------------|
| `ACE_CODEGENIE_BIN` | CodeGenie 可执行文件路径 | 未设置时按 PATH / SDK 配置探测 |
| `ACE_CODEGENIE_SDK_BASE_URL` | CodeGenie SDK 服务地址 | 未设置时使用内置默认 |
| `ACE_CODEGENIE_SDK_COMMAND` | CodeGenie SDK 启动命令 | 未设置时按 PATH / SDK 配置探测 |
| `ACE_CODEGENIE_SDK_TIMEOUT_MS` | CodeGenie SDK 请求超时（毫秒） | 未设置时使用内置默认 |
| `ACE_NGA_BIN` | NGA 可执行文件路径 | 未设置时按 PATH / SDK 配置探测 |
| `ACE_NGA_SDK_BASE_URL` | NGA SDK 服务地址 | 未设置时使用内置默认 |
| `ACE_NGA_SDK_COMMAND` | NGA SDK 启动命令 | 未设置时按 PATH / SDK 配置探测 |
| `ACE_NGA_SDK_TIMEOUT_MS` | NGA SDK 请求超时（毫秒） | 未设置时使用内置默认 |

## 渠道接入

ACEHarness 现已支持把工作流运行时对话、人工检查点和多 Agent 议场桥接到外部聊天平台。当前内置了 `Feishu`、`DingTalk`、`WeChat Bridge`、`Generic Webhook` 四类 provider 模板，可通过 `POST /api/channels/setup` 一键生成 webhook 和共享密钥，再由外部平台或桥接器把消息投递到 `/api/channels/inbound/:integrationId`。

详细说明见：[渠道接入文档](./docs/channel-integrations.md)。

## 文档

- [工作流案例](https://gitcode.com/Cangjie-SIG/ACEHarness/blob/main/docs/workflow-cases.md)：四个真实/复盘案例的完整细节
- [ACP Code Agent 集成检查清单](https://gitcode.com/Cangjie-SIG/ACEHarness/blob/main/docs/acp-code-agent-integration-checklist.md)：ACP Code Agent 接入与验证参考
- [一人公司模式功能介绍](./docs/one-person-company-mode.md)：基于 `/office` 的个人 AI 团队、组织草案、工位协作和记忆模式说明

---

## 开发参考

### 项目结构

| 路径 | 说明 |
|------|------|
| `bin/` | npm CLI 入口，`ace` 命令会加载构建后的 `dist/cli.js` |
| `server.js` | 自定义 Next.js 启动器，负责加载 `.env*`、启动 HTTP 服务和 Notebook 协作 WebSocket |
| `src/app/` | Next.js App Router 页面与 API 路由 |
| `src/components/` | 工作台、对话、Notebook、工作区等前端组件 |
| `src/lib/` | 工作流引擎、Spec Coding、认证、运行记录、调度、模型和工作区等核心逻辑 |
| `configs/` | 工作流配置与内置 Agent/角色配置 |
| `skills/` | 随包分发的 Skills |
| `messages/` | 中英文界面文案 |
| `public/` | README 和前端使用的图片资源 |
| `tests/` | Vitest 测试用例 |

### 常用命令

命令来源：`package.json`。

```bash
npm run dev              # 本地开发，先构建 CLI，再以 dev 模式启动服务
npm run build            # 构建 CLI 和 Next.js 应用
npm start                # 启动生产构建
npm test                 # 运行 Vitest 测试
npm run test:components  # 使用 jsdom 环境运行组件测试
npm run lint             # 运行 Next.js lint
npm run check:engines    # 检测本机可用 AI 执行引擎
npm run clean            # 清理 dist、.next、dist-build
npm run publish:beta     # 构建并以 beta tag 发布 npm 包
```

CLI 命令来源：`src/cli.ts`。

```bash
ace                # 启动 ACEHarness
ace start          # 启动 ACEHarness
ace service        # 查看并停止 ACE 服务
ace update         # 更新到 npm latest 版本
ace update beta    # 更新到指定 npm tag 或版本号
ace reset --force  # 重置本地 ACE 配置
ace --help         # 查看帮助
```

### 测试与质量

测试框架为 Vitest，配置位于 `vitest.config.ts`，默认匹配 `tests/**/*.test.ts` 和 `tests/**/*.test.tsx`。

```bash
npm test
npm run test:components
npm run lint
```

### 技术栈

| 类别 | 技术 |
|------|------|
| 应用框架 | Next.js 16.1、React 18.2、TypeScript 5 |
| UI 与交互 | Tailwind CSS 3.4、Shadcn/ui、Radix UI、Base UI、Framer Motion、Vaul |
| 编辑与协作 | Tiptap 3、Yjs、y-websocket、Monaco Editor |
| 工作流与配置 | Zod 4、YAML、node-cron、tar-stream、unzipper、yazl |
| 可视化 | ReactFlow 11、Recharts 3、Mermaid 11 |
| 表单与拖拽 | React Hook Form 7、@dnd-kit |
| Markdown 与文档 | react-markdown、remark-gfm、rehype-raw、KaTeX |
| AI SDK 与执行后端 | Anthropic Claude Agent SDK、OpenAI Codex SDK、`claude-code` / `kiro-cli` / `opencode` / `nga` / `codegenie` / `cursor` / `codex` / `trae-cli` / `magic-cli` |
| 测试 | Vitest 4、Testing Library、jsdom |
| 主题 | next-themes |

### 文档维护

当以下内容变化时，请同步更新本 README：

- `package.json` scripts、`bin`、`files` 或发布流程变化
- 文档中列出的环境变量变化
- `src/app/` 页面入口、API 分类或主要用户流程变化
- `src/lib/` 中工作流、Spec Coding、引擎、认证、Notebook 等核心机制变化
- `configs/`、`skills/` 或内置 Agent 能力变化
- 发布版本、许可证或仓库地址变化

---

## 贡献指南

当前仓库在 README 中保留简化贡献流程；如果后续新增独立 `CONTRIBUTING.md`，这里应改为链接正式贡献指南。

```bash
# Fork → 创建分支 → 提交 → PR
git checkout -b feature/your-feature
git commit -m "feat: add new feature"
git push origin feature/your-feature
```

Commit 规范遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat` / `fix` / `docs` / `perf` / `refactor` / `test` / `chore`

---

## 许可证

ACEHarness 使用 Apache-2.0 with Runtime Library Exception，详见 [LICENSE](https://gitcode.com/Cangjie-SIG/ACEHarness/blob/main/LICENSE)。
