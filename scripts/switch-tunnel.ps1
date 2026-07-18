<#
  switch-tunnel.ps1 — Windows 版的 DNS 切换脚本
  与 scripts/switch-tunnel.sh 等价，调用同一个 Cloudflare API

  用法：
    PS> .\scripts\switch-tunnel.ps1 <tunnel-id>

  示例：
    PS> .\scripts\switch-tunnel.ps1 24341696-3a8f-47dd-8737-933ff80f4801
#>
$ErrorActionPreference = 'Stop'

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$TunnelId
)

$ZoneId      = 'b9d212f1eda65aec73544576343147e7'
$RecordName  = 'cpf-manager.xyz'
$CertPath    = "$env:USERPROFILE\.cloudflared\cert.pem"

if (-not (Test-Path $CertPath)) {
    Write-Error "✗ 没找到 $CertPath，请先 cloudflared tunnel login"
    exit 1
}

# 解析 cert.pem 拿 API token（PowerShell 不能用 base64 -d 之前先拼接）
$certLines = Get-Content $CertPath | Where-Object { $_ -notmatch 'BEGIN|END' }
$certB64   = ($certLines -join '').Trim()
$certJson  = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($certB64))
$certObj   = $certJson | ConvertFrom-Json
$apiToken  = $certObj.apiToken

$target = "$TunnelId.cfargotunnel.com"

Write-Host "==[ switch-tunnel (Windows) ]==" -ForegroundColor Cyan
Write-Host "  Zone:       $ZoneId"
Write-Host "  Record:     $RecordName"
Write-Host "  New target: $target"
Write-Host ""

# 1) 列当前记录
Write-Host "--- 当前 DNS 记录 ---" -ForegroundColor Yellow
$listUrl = "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records?name=$RecordName"
$list = Invoke-RestMethod -Uri $listUrl -Headers @{ Authorization = "Bearer $apiToken" } -Method Get
$list.result | ForEach-Object {
    Write-Host "  [$($_.type)] $($_.name) → $($_.content)  (id=$($_.id))"
}

# 2) 找 CNAME 记录的 id
$rec = $list.result | Where-Object { $_.type -eq 'CNAME' } | Select-Object -First 1
if (-not $rec) {
    Write-Error "✗ 没找到 CNAME 记录，请先在 Cloudflare Dashboard 添加"
    exit 1
}

# 3) PATCH
Write-Host ""
Write-Host "--- 切换 CNAME ---" -ForegroundColor Yellow
$patchUrl = "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records/$($rec.id)"
$body = @{
    type    = 'CNAME'
    name    = $RecordName
    content = $target
    proxied = $true
    ttl     = 1
} | ConvertTo-Json -Compress

$res = Invoke-RestMethod -Uri $patchUrl -Headers @{ Authorization = "Bearer $apiToken" } -Method Patch -ContentType 'application/json' -Body $body
if ($res.success) {
    Write-Host "  ✓ $($res.result.type) $($res.result.name) → $($res.result.content)" -ForegroundColor Green
    Write-Host "    proxied=$($res.result.proxied), ttl=$($res.result.ttl)"
} else {
    Write-Error "✗ 失败: $($res.errors | ConvertTo-Json)"
    exit 1
}

# 4) 验证
Write-Host ""
Write-Host "--- 验证 tunnel 在线 ---" -ForegroundColor Yellow
& cloudflared tunnel info $TunnelId 2>&1 | Select-Object -First 8

Write-Host ""
Write-Host "✓ 切换完成。DNS 5 秒内全球生效。" -ForegroundColor Green
