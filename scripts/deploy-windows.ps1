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
$NodeDir        = "$env:USERPROFILE\node22"           # Windows 端 Node 22 安装目录；Mac 端通过 ACE_NODE_BIN_DIR 环境变量指定
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

# 安全执行原生命令：在 $ErrorActionPreference = 'Stop' 下，
# 原生命令写 stderr 会被包装成 NativeCommandError 异常抛出。
# 本函数临时放宽策略，把 stdout+stderr 合并收集，返回对象：
#   { Output: [string], ExitCode: [int] }
# 调用方按需判断 $LASTEXITCODE / 输出内容，避免脚本意外终止。
#
# 实现说明：用 cmd /c 包装，而不是 PowerShell 的 & 调用 + splatting。
# 原因：npm 在 Windows 上安装的命令（pm2 / cloudflared 等）是 .ps1 shim，
# 用 & $cmd @args 调用 .ps1 shim 时，splatting 数组会被当成单个位置参数，
# 导致 shim 内部 $args 解析错位，pm2 报 [PM2][ERROR] Command not found。
# 走 cmd /c 能保证参数解析和命令行直接敲一致。
function Invoke-NativeSafe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string[]]$ArgumentList,
        [string]$WorkingDirectory
    )
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # 对每个参数做 cmd 安全的引号包装：含空格或特殊字符的用双引号包住，
        # 内部双引号转义为 ""。简单参数原样传递。
        $quoted = $ArgumentList | ForEach-Object {
            if ($_ -match '\s|["<>|&^()]') { '"' + ($_ -replace '"', '""') + '"' } else { $_ }
        }
        $cmdLine = $quoted -join ' '
        $out = if ($WorkingDirectory) {
            Push-Location $WorkingDirectory
            try { & cmd /c $cmdLine 2>&1 } finally { Pop-Location }
        } else {
            & cmd /c $cmdLine 2>&1
        }
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
    } catch {
        $out = $_.Exception.Message
        $code = 1
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    [pscustomobject]@{ Output = ($out -join "`n"); ExitCode = $code }
}

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

# 列出已有 tunnel（用 Invoke-NativeSafe 避免 stderr 触发 NativeCommandError）
$listResult = Invoke-NativeSafe @('cloudflared', 'tunnel', 'list')
if ($listResult.ExitCode -ne 0) {
    Fail "cloudflared tunnel list 失败：$($listResult.Output)"
}
$existing = $listResult.Output -split "`n"

# 匹配形如「<uuid> aceharness  ...」的行，注意要避免误匹配 aceharness-mac
# 用 \s 作为 NAME 列的右边界，确保精确匹配 tunnel 名
$matchLine = $existing | Where-Object { $_ -match "^\S+\s+$([regex]::Escape($WinTunnelName))\s" }

if ($matchLine) {
    $tunnelId = ($matchLine -split '\s+')[0]
    Ok "Tunnel '$WinTunnelName' 已存在，复用，ID: $tunnelId"
} else {
    $createResult = Invoke-NativeSafe @('cloudflared', 'tunnel', 'create', $WinTunnelName)
    if ($createResult.ExitCode -ne 0) {
        Fail "tunnel 创建失败：$($createResult.Output)"
    }
    # 重新 list 拿 id
    $relist = Invoke-NativeSafe @('cloudflared', 'tunnel', 'list')
    $relistLines = $relist.Output -split "`n"
    $tunnelId = ($relistLines | Where-Object { $_ -match "^\S+\s+$([regex]::Escape($WinTunnelName))\s" } | ForEach-Object { ($_ -split '\s+')[0] })
    if (-not $tunnelId) {
        Fail "tunnel 创建后未能从 list 中解析出 ID，请手动检查：cloudflared tunnel list"
    }
    Ok "Tunnel 创建成功: $tunnelId"
}

# 生成 config.yml
$configPath = "$CloudflaredDir\config.yml"
$configContent = @"
tunnel: $tunnelId
credentials-file: $CloudflaredDir\$tunnelId.json

# GFW 阻断 UDP/QUIC，强制走 HTTP/2 over TCP
protocol: http2

# 日志：warn 级别减少 IO 开销（info 日志量大，长期运行影响性能）
loglevel: warn
transport-loglevel: warn

# 连接重试与优雅关闭
retries: 5                    # 连接失败重试次数（默认 5，显式声明）
grace-period: 30s             # 重启时给 30s 完成现有请求，避免中断

# 全局 origin 请求优化
originRequest:
  connectTimeout: 10s
  tlsTimeout: 10s
  tcpKeepAlive: 30s
  keepAliveConnections: 100
  keepAliveTimeout: 90s
  http2Origin: true
  noTLSVerify: true           # origin 是本地 localhost，跳过 TLS 校验开销
  noHappyEyeballs: true       # 国内服务器 IPv6 路由常异常，禁用避免回源超时

ingress:
  - hostname: $Domain
    service: http://localhost:$Port
    originRequest:
      connectTimeout: 10s
      keepAliveConnections: 100
      keepAliveTimeout: 90s
      http2Origin: true
  - service: http_status:404
"@
Set-Content -Path $configPath -Value $configContent -Encoding UTF8
Ok "config.yml 已写入 $configPath"

# 绑定 DNS（如果之前没绑）
# cloudflared 在记录已存在时会写 stderr（code: 1003 ... already exists），
# 用 Invoke-NativeSafe 捕获，识别为良性情况。
$route = Invoke-NativeSafe @('cloudflared', 'tunnel', 'route', 'dns', $WinTunnelName, $Domain)
if ($route.ExitCode -eq 0) {
    Ok "DNS route 已创建"
} elseif ($route.Output -match 'already exists|code: 1003') {
    Warn "DNS 记录已存在，跳过（正常情况）：$Domain"
} else {
    Warn "DNS route 失败：$($route.Output)"
}

# ────────────────────────────────────────────────────────────
# Step 7: PM2 启动
# ────────────────────────────────────────────────────────────
Step "7/8 启动 PM2"
# 平台分流：ecosystem.config.cjs 已自动判断 Windows
# pm2 delete all 在无进程时会写 stderr 警告 [PM2][WARN] No process found，
# 用 Invoke-NativeSafe 吞掉，避免 NativeCommandError 中断脚本。
$del = Invoke-NativeSafe @('pm2', 'delete', 'all')
if ($del.ExitCode -ne 0 -and $del.Output -notmatch 'No process found') {
    Warn "pm2 delete all 输出：$($del.Output)"
}

$start = Invoke-NativeSafe @('pm2', 'start', "$ProjectDir\ecosystem.config.cjs")
if ($start.ExitCode -ne 0) {
    Fail "pm2 start 失败：$($start.Output)"
}
Ok "PM2 启动完成"

$save = Invoke-NativeSafe @('pm2', 'save')
if ($save.ExitCode -ne 0) {
    Warn "pm2 save 输出：$($save.Output)"
}

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
