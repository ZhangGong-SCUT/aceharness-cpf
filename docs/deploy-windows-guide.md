# ACEHarness Windows 部署指南（最简版）

> **目标**：把 ACEHarness 从开发机（macOS）部署到正式生产机（Windows 11/Server），通过 Cloudflare Tunnel 用 `https://cpf-manager.xyz` 对外提供服务。
>
> **预计时间**：30 ~ 60 分钟（含下载依赖）
>
> **配套脚本**（仓库自带）：
> - `scripts/deploy-windows.ps1` — 一键部署（8 步全自动）
> - `scripts/switch-tunnel.ps1` — DNS 切到本机 tunnel
> - `scripts/switch-tunnel.sh`   — Mac/Linux 端的 DNS 切换
> - `ecosystem.config.cjs`       — PM2 跨平台配置

---

## 目录

- [Step 0 — Mac 端先让出 DNS](#step-0--mac-端先让出-dns)
- [Step 1 — Windows 装基础软件](#step-1--windows-装基础软件)
- [Step 2 — clone 代码](#step-2--clone-代码)
- [Step 3 — cloudflared 首次登录](#step-3--cloudflared-首次登录)
- [Step 4 — 跑一键部署脚本](#step-4--跑一键部署脚本)
- [Step 5 — DNS 切到 Windows 的 tunnel](#step-5--dns-切到-windows-的-tunnel)
- [Step 6 — 验证公网](#step-6--验证公网)
- [Step 7 — 开机自启（可选）](#step-7--开机自启可选)
- [日常命令速查](#日常命令速查)
- [常见踩坑](#常见踩坑)

---

## Step 0 — Mac 端先让出 DNS

在 Mac 上执行（**只停服务，不删 tunnel**，留作备用）：

```bash
pm2 delete aceharness cloudflared
```

> 如果你想彻底清掉 Mac 的 tunnel，再执行：`cloudflared tunnel delete aceharness-mac`

---

## Step 1 — Windows 装基础软件

**以管理员身份**打开 PowerShell，依次执行：

### 1.1 Node.js 22（用 fnm，干净且能多版本切换）

```powershell
winget install Schniz.fnm
fnm install 22
fnm use 22

# 验证
node -v
# 期望输出：v22.x.x
```

> ⚠️ **必须 >= 20.9.0**，Next.js 16 强制要求。如果之前装过老版本 Node，先卸载再装。

### 1.2 PM2

```powershell
npm install -g pm2
pm2 -v
```

### 1.3 cloudflared

```powershell
winget install Cloudflare.cloudflared
cloudflared --version
```

> 如果 `winget` 装不上，去 [GitHub Releases](https://github.com/cloudflare/cloudflared/releases) 下载 `cloudflared-windows-amd64.exe`，重命名为 `cloudflared.exe`，放到 `C:\Windows\System32\` 或任意在 PATH 里的目录。

---

## Step 2 — clone 代码

```powershell
cd C:\projects
git clone <你的 ACEHarness 仓库地址>
cd ACEHarness
```

> 仓库地址如：`https://gitcode.com/Cangjie-SIG/ACEHarness.git`
> 或你 fork 后的地址。

---

## Step 3 — cloudflared 首次登录

```powershell
cloudflared tunnel login
```

会弹出浏览器，选中 **cpf-manager.xyz** 域名，点 Authorize。

完成后会在以下位置生成证书：

```
C:\Users\<你的用户名>\.cloudflared\cert.pem
```

---

## Step 4 — 跑一键部署脚本

在仓库根目录执行：

```powershell
.\scripts\deploy-windows.ps1
```

脚本会自动完成 8 步：

| 步骤 | 内容 |
|------|------|
| 1/8 | 检查 Node / PM2 / cloudflared 版本 |
| 2/8 | `npm ci` 装依赖 |
| 3/8 | `npm run build` 生产构建 |
| 4/8 | 创建 `logs/` 目录 |
| 5/8 | 确认 `cert.pem` 存在 |
| 6/8 | 创建（或复用）名为 `aceharness` 的 tunnel，生成 `config.yml` |
| 7/8 | `pm2 start ecosystem.config.cjs && pm2 save` |
| 8/8 | 端到端验证本地 + 公网 |

**跑完会打印一个 tunnel id**，形如：

```
Tunnel 创建成功: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**复制这个 id，下一步要用。**

---

## Step 5 — DNS 切到 Windows 的 tunnel

两种方式任选：

### 方式 A：在 Windows 上切（推荐）

```powershell
.\scripts\switch-tunnel.ps1 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 方式 B：在 Mac 上切

```bash
cd /Users/hyh/Desktop/FlutterProject/ACEHarness
./scripts/switch-tunnel.sh xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> 把 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 换成 Step 4 拿到的 Windows tunnel id。

5 秒内全球生效。

---

## Step 6 — 验证公网

浏览器打开：**https://cpf-manager.xyz**

应该看到 ACEHarness 主界面。

也可以在 PowerShell 里：

```powershell
curl.exe -I https://cpf-manager.xyz/
# 期望：HTTP/2 200
```

---

## Step 7 — 开机自启（可选）

> **说明**：Windows 关机/重启后，PM2 默认不会自动拉起进程。要让它开机自启，需要把 PM2 注册成 Windows 服务。

### 推荐：NSSM

```powershell
# 装 nssm
choco install nssm

# 把 PM2 注册成 Windows 服务
nssm install ACEHarness-PM2 "C:\Program Files\nodejs\node.exe" `
  "C:\Users\<你的用户名>\.npm-global\node_modules\pm2\bin\pm2.cmd" "resurrect"
nssm set ACEHarness-PM2 AppDirectory "C:\projects\ACEHarness"
nssm set ACEHarness-PM2 DisplayName "ACEHarness PM2"
nssm start ACEHarness-PM2
```

> 上面命令里的 `C:\Program Files\nodejs\node.exe` 要换成 `where node` 的实际路径。

### 简易：pm2-windows-startup

```powershell
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

> 简单场景可以用，但稳定性不如 NSSM。

---

## 日常命令速查

| 操作 | 命令 |
|------|------|
| 查看 PM2 状态 | `pm2 list` |
| 看实时日志（全部） | `pm2 logs` |
| 只看 aceharness 日志 | `pm2 logs aceharness` |
| 只看 cloudflared 日志 | `pm2 logs cloudflared` |
| 重载（无停机） | `pm2 reload ecosystem.config.cjs` |
| 硬重启 | `pm2 restart ecosystem.config.cjs` |
| 停所有 | `pm2 stop all` |
| 删所有 | `pm2 delete all` |
| 端到端健康检查 | `curl http://127.0.0.1:3031/` + `curl https://cpf-manager.xyz/` |
| 看 tunnel 连接 | `cloudflared tunnel info <tunnel-id>` |
| 切 DNS | `.\scripts\switch-tunnel.ps1 <新 tunnel id>` |

---

## 常见踩坑

### 坑 1：Node 版本太低

**症状**：
```
Error: EBADENGINE Unsupported engine { node: 'v18.x.x' }
```
或
```
SyntaxError: Unexpected token ...
```

**解决**：重装 Node 22。`fnm install 22 && fnm use 22 && node -v` 验证。

### 坑 2：3031 端口被占

**症状**：
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3031
```

**定位**：
```powershell
netstat -ano | findstr :3031
# 最后一列是 PID，例如 12345
taskkill /F /PID 12345
```

**预防**：Windows 部署时如果 3031 已经被其他服务用了，要么杀掉占用进程，要么改端口（要同步改 2 处）：
- `ecosystem.config.cjs` 里的 `ACE_PORT`
- `C:\Users\<你>\.cloudflared\config.yml` 里的 `service: http://localhost:<新端口>`

### 坑 3：DNS 没切过来 / 公网 502

**症状**：浏览器或 `curl https://cpf-manager.xyz/` 报 502/530/连接超时。

**排查三步走**：

```powershell
# 1. 看 PM2 状态
pm2 list
# 确认 aceharness 和 cloudflared 都 online

# 2. 看 aceharness 监听端口
netstat -ano | findstr :3031
# 期望有 LISTENING 状态

# 3. 看 cloudflared 连接
cloudflared tunnel info <你的 tunnel id>
# 期望有 4 条 connection（connIndex=0~3）
```

**如果连接数 = 0**：本机网络出不去 Cloudflare 边缘，检查代理设置。

**如果连接数 = 4 但公网 502**：DNS 没指过来，跑到 [Step 5](#step-5--dns-切到-windows-的-tunnel) 重切。

### 坑 4：cloudflared 走 QUIC 不通

**症状**：cloudflared 日志反复重连，连接数始终 0。

**解决**：`config.yml` 已默认强制 `protocol: http2`，QUIC 不通也无所谓。如果还是不行，检查本机是否屏蔽了 7844/UDP 之外的 443/TCP。

### 坑 5：Windows 防火墙拦截

**症状**：本机 `curl http://127.0.0.1:3031/` 200，但 cloudflared 日志报 "connection refused"。

**解决**：通常 cloudflared 是本地连 localhost，不会被防火墙拦。但如果是 0.0.0.0 监听可能被拦，可以临时关防火墙测试：
```powershell
Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled False
# 验证完记得打开
Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True
```

### 坑 6：git clone 后没装依赖

**症状**：
```
Error: Cannot find module 'next'
```

**解决**：
```powershell
cd C:\projects\ACEHarness
npm ci
```

### 坑 7：tunnel 名 `aceharness` 已被占

**症状**：
```
Failed to create tunnel: tunnel with name already exists
```

**解决**：Cloudflare 同一账号下 tunnel 名唯一。如果你之前在 Mac 上也建过 `aceharness`，要么：
- A) Mac 端删掉：`cloudflared tunnel delete aceharness`
- B) Windows 端用别的名（编辑 `deploy-windows.ps1` 第 22 行的 `$WinTunnelName`）

---

## 部署完成后该做什么

1. **观察 24 小时**：看 `pm2 logs` 有没有异常 OOM / 重启
2. **备份 `ecosystem.config.cjs` 和 `config.yml`**：重装系统时要用
3. **写个简单的健康检查脚本**（可选）：每 5 分钟 `curl https://cpf-manager.xyz/`，失败就重启 PM2
4. **保留 Mac 的 tunnel 作为热备**：Mac 端不跑 PM2，但保留 tunnel id，万一 Windows 挂了，在 Mac 上 `pm2 start` + `switch-tunnel.sh <mac-tunnel-id>` 5 分钟恢复

---

## 排错命令一站式

```powershell
# === 一键看现状 ===
pm2 list
pm2 logs --lines 50 --nostream
cloudflared tunnel info <tunnel-id>
curl -I http://127.0.0.1:3031/
curl -I https://cpf-manager.xyz/

# === 一键重启 ===
pm2 reload ecosystem.config.cjs

# === 一键全部重置（杀进程 + 清 lock + 重建） ===
pm2 delete all
Remove-Item .next\dev\lock -ErrorAction SilentlyContinue
pm2 start ecosystem.config.cjs
pm2 save
```

---

## 参考资料

- [README.md - 部署到公网域名（Cloudflare Tunnel）](../README.md#部署到公网域名cloudflare-tunnel)
- [README.md - 跨平台部署（macOS ⇄ Windows 切换）](../README.md#跨平台部署macos--windows-切换)
- [Cloudflare Tunnel 官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [PM2 官方文档](https://pm2.keymetrics.io/docs/usage/quick-start/)
