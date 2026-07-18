<#
  ACEHarness Windows 部署脚本（PowerShell）

  用途：把 Mac 上验证过的整套配置一键复制到 Windows
  作者：自动从 ACEHarness 项目生成
  日期：2026-07-18

  必备前置（脚本会检查）：
   1. PowerShell 5.1+ （Win10/11 自带）
   2. Node.js 20.9+ （用 fnm / nvm-windows 管理）
   3. PM2：npm i -g pm2
   4. cloudflared：winget install Cloudflare.cloudflared  或手动下载
   5. 已有 Cloudflare 账号 + 域名 cpf-manager.xyz

  使用（在 Windows PowerShell 里）：
    PS> .\scripts\deploy-windows.ps1
#>

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

# ────────────────────────────────────────────────────────────
# 配置区（按需修改）
# ────────────────────────────────────────────────────────────
$RepoRoot       = (Resolve-Path "$PSScriptRoot\..").Path
$ProjectDir     = $RepoRoot
$NodeDir        = "$env:USERPROFILE\node22"           # 与 Mac 的 /Users/hyh/node22 对应
$Port           = 3031
$Domain         = 'cpf-manager.xyz'
$CloudflaredDir = "$env:USERPROFILE\.cloudflared"
$LogsDir        = Join-Path $ProjectDir 'logs'
$NodeMajor      = 22

# Windows 平台的 tunnel 名（避免和 Mac 的 aceharness-mac 冲突）
$WinTunnelName  = 'aceharness'

# ────────────────────────────────────────────────────────────
# 颜色
# ────────────────────────────────────────────────────────────
function Step($msg)  { Write-Host "`n==[ $($msg) ]==" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

# ────────────────────────────────────────────────────────────
# Step 1: 基础环境检查
# ────────────────────────────────────────────────────────────
Step "1/8 检查基础环境"

# Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "未找到 node，请先安装 Node.js $NodeMajor" }
$nodeVer = & node -v
if ([int]($nodeVer -replace 'v(\d+)\..*','$1') -lt 20) {
    Fail "Node 版本 $nodeVer 过低（Next.js 16 要求 >= 20.9），建议装 Node $NodeMajor"
}
Ok "Node: $nodeVer  ($node)"

# npm
$npmVer = & npm -v
Ok "npm: $npmVer"

# PM2
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
    Warn "未找到 pm2，正在安装..."
    npm install -g pm2 | Out-Null
    $pm2 = Get-Command pm2
}
Ok "PM2: $((& pm2 -v) 2>&1)"

# cloudflared
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
    Warn "未找到 cloudflared"
    Write-Host "    安装方式（任选其一）："
    Write-Host "    A) winget install Cloudflare.cloudflared"
    Write-Host "    B) scoop install cloudflared"
    Write-Host "    C) 从 https://github.com/cloudflare/cloudflared/releases 下载 cloudflared-windows-amd64.exe 放到 $CloudflaredDir\"
}
Ok "cloudflared: $((& cloudflared --version) 2>&1)"

# ────────────────────────────────────────────────────────────
# Step 2: 安装依赖
# ────────────────────────────────────────────────────────────
Step "2/8 安装项目依赖"
Set-Location $ProjectDir
if (Test-Path 'node_modules') {
    Ok "node_modules 已存在，跳过"
} else {
    npm ci
    Ok "依赖安装完成"
}

# ────────────────────────────────────────────────────────────
# Step 3: 生产构建
# ────────────────────────────────────────────────────────────
Step "3/8 生产构建"
if (Test-Path '.next\BUILD_ID') {
    $ts = (Get-Item '.next\BUILD_ID').LastWriteTime
    Ok ".next 已构建（$ts），跳过"
} else {
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "构建失败，请看上面的错误" }
    Ok "构建完成"
}

# ────────────────────────────────────────────────────────────
# Step 4: 日志目录
# ────────────────────────────────────────────────────────────
Step "4/8 准备日志目录"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
Ok "logs/ 已就绪"

# ────────────────────────────────────────────────────────────
# Step 5: Cloudflare Tunnel 登录
# ────────────────────────────────────────────────────────────
Step "5/8 Cloudflare Tunnel 认证"
if (-not (Test-Path "$CloudflaredDir\cert.pem")) {
    Warn "首次部署，需要登录 Cloudflare（会弹出浏览器）"
    cloudflared tunnel login
    Ok "登录完成"
} else {
    Ok "cert.pem 已存在，跳过"
}

# ────────────────────────────────────────────────────────────
# Step 6: 创建 / 复用 Tunnel
# ────────────────────────────────────────────────────────────
Step "6/8 Tunnel 准备（名称: $WinTunnelName）"

# 列出已有 tunnel
$existing = & cloudflared tunnel list 2>&1
$hasIt = $existing | Select-String -Pattern "^\S+\s+$WinTunnelName\s"

if ($hasIt) {
    Ok "Tunnel '$WinTunnelName' 已存在，复用"
    $tunnelId = ($existing | Select-String -Pattern "^\S+\s+$WinTunnelName\s" | ForEach-Object { ($_ -split '\s+')[0] })
} else {
    cloudflared tunnel create $WinTunnelName
    if ($LASTEXITCODE -ne 0) { Fail "tunnel 创建失败" }
    $tunnelId = (& cloudflared tunnel list | Select-String -Pattern "^\S+\s+$WinTunnelName\s" | ForEach-Object { ($_ -split '\s+')[0] })
    Ok "Tunnel 创建成功: $tunnelId"
}

# 生成 config.yml
$configPath = "$CloudflaredDir\config.yml"
$configContent = @"
tunnel: $tunnelId
credentials-file: $CloudflaredDir\$tunnelId.json

# GFW 阻断 UDP/QUIC，强制走 HTTP/2 over TCP
protocol: http2

# 优化：边缘连接复用
originRequest:
  connectTimeout: 10s
  tlsTimeout: 10s
  tcpKeepAlive: 30s
  keepAliveConnections: 100
  keepAliveTimeout: 90s
  http2Origin: true

ingress:
  - hostname: $Domain
    service: http://localhost:$Port
  - service: http_status:404
"@
Set-Content -Path $configPath -Value $configContent -Encoding UTF8
Ok "config.yml 已写入 $configPath"

# 绑定 DNS（如果之前没绑）
$routeExists = & cloudflared tunnel route dns $WinTunnelName $Domain 2>&1
if ($LASTEXITCODE -eq 0) {
    Ok "DNS route 已创建"
} else {
    Warn "DNS route 失败（可能已存在）：$routeExists"
}

# ────────────────────────────────────────────────────────────
# Step 7: PM2 启动
# ────────────────────────────────────────────────────────────
Step "7/8 启动 PM2"
# 平台分流：ecosystem.config.cjs 已自动判断 Windows
pm2 delete all 2>&1 | Out-Null
pm2 start "$ProjectDir\ecosystem.config.cjs" 2>&1 | Out-Null
pm2 save
Ok "PM2 启动完成"
pm2 list

# ────────────────────────────────────────────────────────────
# Step 8: 验证
# ────────────────────────────────────────────────────────────
Step "8/8 端到端验证"

Start-Sleep -Seconds 5

# 本地
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 10
    Ok "本地 127.0.0.1:$Port → HTTP $($r.StatusCode)"
} catch {
    Fail "本地访问失败: $_"
}

# 公网
try {
    $r = Invoke-WebRequest -Uri "https://$Domain/" -UseBasicParsing -TimeoutSec 20
    Ok "公网 https://$Domain/ → HTTP $($r.StatusCode)"
} catch {
    Warn "公网首次访问慢，DNS 可能还在传播，稍后手动验证：https://$Domain/"
}

Write-Host "`n==[ 🎉 部署完成 ]==" -ForegroundColor Green
Write-Host ""
Write-Host "接下来："
Write-Host "  • 查看实时日志： pm2 logs"
Write-Host "  • 开机自启：      pm2-startup install  （需管理员）"
Write-Host "  • 重启服务：      pm2 reload ecosystem.config.cjs"
Write-Host "  • 删除 Mac tunnel（让 DNS 唯一指向本机）："
Write-Host "      在 Mac 上: cloudflared tunnel delete aceharness-mac"
Write-Host ""
Write-Host "如公网访问异常，请按 README 「Cloudflare Tunnel 故障排查」一节排查。"
