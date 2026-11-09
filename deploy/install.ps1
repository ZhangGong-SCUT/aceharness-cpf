# ACEHarness CPF 诊断平台 一键部署（Windows PowerShell 5.1+）
# 用法: .\install.ps1 [-Tgz .\dist\cpf-ohos-aceharness-<版本>.tgz] [-SdkRoot "$HOME\flutter-sdks"]
param(
  [string]$Tgz = "",
  [string]$SdkRoot = "$HOME\flutter-sdks",
  [string]$NpmRegistry = ""
)
$ErrorActionPreference = "Stop"
function Select-AceTgz([string]$Explicit, [string]$DistDir) {
  if ($Explicit) { return $Explicit }
  $found = Get-ChildItem -Path $DistDir -Filter 'cpf-ohos-aceharness-*.tgz' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($found) { return $found.FullName }
  $plain = Join-Path $DistDir 'cpf-ohos-aceharness.tgz'
  if (Test-Path $plain) { return $plain }
  return ""
}
if ($env:ACE_INSTALL_LIBRARY -eq '1') { return }
if (-not $Tgz) { $Tgz = Select-AceTgz "" "$PSScriptRoot\dist" }
if (-not $Tgz -and $env:ACE_DIST_URL) {
  if (-not $env:ACE_DIST_NAME) { Write-Host "✗ 远程安装需要 ACE_DIST_NAME=cpf-ohos-aceharness-<版本>.tgz"; exit 1 }
  $Tgz = Join-Path $PWD $env:ACE_DIST_NAME
  Write-Host "    从 $env:ACE_DIST_URL 下载 $env:ACE_DIST_NAME ..."
  Invoke-WebRequest -UseBasicParsing "$env:ACE_DIST_URL/$env:ACE_DIST_NAME" -OutFile $Tgz
}

Write-Host "==> 1/5 检查 Node.js（需 >= 20，推荐 22 LTS）..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host "✗ 未找到 node，请先安装 Node.js 20+（https://nodejs.org）"; exit 1 }
$ver = (node -v).TrimStart('v').Split('.')[0]
if ([int]$ver -lt 20) { Write-Host "✗ $(node -v) 版本过低，需要 >= 20"; exit 1 }
Write-Host "    $(node -v) ✓"

Write-Host "==> 2/5 全局安装 $Tgz ..."
if (-not (Test-Path $Tgz)) { Write-Host "✗ 找不到 $Tgz"; exit 1 }
# 事实澄清：tgz 只 bundled 了 @cangjielang/napi-cj；其余 ~120 个生产依赖首次安装需访问
# npm registry（约 880 个包、4~12 分钟，视网络）。内网/弱网环境请配镜像：
#   .\install.ps1 -NpmRegistry https://<内网镜像>   （或 npm config set registry <镜像>）
$regArgs = @()
if ($NpmRegistry) { $regArgs = @('--registry', $NpmRegistry) }
# 失败恢复：清理 npm 中断残留的暂存目录（会导致 ENOTEMPTY）、必要时卸载后重装
& npm install -g --prefer-offline @regArgs $Tgz
if ($LASTEXITCODE -ne 0) {
  Write-Host "    首次安装失败，清理暂存目录并重试..."
  $gm = "$(npm root -g)\@cpf-ohos"
  Get-ChildItem -Path $gm -Filter '.aceharness-*' -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  npm ls -g --depth 0 '@cpf-ohos/aceharness' 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { npm uninstall -g '@cpf-ohos/aceharness' }
  & npm install -g --prefer-offline @regArgs $Tgz
  if ($LASTEXITCODE -ne 0) { Write-Host "✗ 安装失败，请检查网络或配置内网镜像源"; exit 1 }
}
$aceRoot = "$(npm root -g)\@cpf-ohos\aceharness"
$ace = Get-Command ace -ErrorAction SilentlyContinue
if (-not $ace) { Write-Host "✗ ace 未进入 PATH，请重新打开终端或检查 npm global bin"; exit 1 }
Write-Host "    安装根: $aceRoot"

Write-Host "==> 3/5 同步运行时目录 ..."
$rt = (& node "$aceRoot\scripts\runtime-root.mjs").Trim()
New-Item -ItemType Directory -Force $rt | Out-Null
$homeLink = Join-Path $HOME '.aceharness'
if ($rt -ne $homeLink -and -not (Test-Path $homeLink)) {
  New-Item -ItemType Junction -Path $homeLink -Target $rt | Out-Null
  Write-Host "    已把 ~/.aceharness 链接到 $rt"
}
& node "$aceRoot\scripts\sync-missing-runtime-files.mjs" $aceRoot $rt
if ($LASTEXITCODE -ne 0) { Write-Host "✗ 运行时文件补齐失败"; exit 1 }

Write-Host "==> 4/5 改写 SDK 清单路径 -> $SdkRoot ..."
$sdkConf = Join-Path $rt 'configs\ohos-flutter-sdks.yaml'
if (Test-Path $sdkConf) {
  Copy-Item $sdkConf "$sdkConf.ace-deploy-bak"
  $sdkText = ($SdkRoot -replace '\\','/')
  & node "$aceRoot\scripts\rewrite-sdk-root.mjs" $sdkConf '/home/flutter/flutter-sdks' $sdkText
  if ($LASTEXITCODE -ne 0) { Write-Host "✗ SDK 路径改写失败"; exit 1 }
  Write-Host "    校验: $((Select-String -Path $sdkConf -Pattern 'sdkRoot').Line.Trim())（原文件备份 .ace-deploy-bak）"
} else {
  Write-Host "    未找到 $sdkConf，跳过"
}

Write-Host "==> 5/5 环境自检（ace doctor）..."
# 经 bin/ace.js 直调（npm 全局 bin 的 PATH 在脚本内可能未刷新）；doctor 自身会自动补齐缺失运行时目录
& node "$aceRoot\bin\ace.js" doctor
if ($LASTEXITCODE -ne 0) { Write-Host "    ⚠ doctor 有未通过项：按上方「修复」命令处理后，随时可重跑：ace doctor" }

Write-Host @"

✅ 部署完成。接下来的 3 件事：

  1) 放入 Flutter SDK：
       从源机拷贝（在源机执行）:
         scp -r /home/flutter/flutter-sdks <本机用户>@<本机IP>:$SdkRoot
       或新装单个版本（PowerShell，示例 3.44.9）:
         git clone --depth 1 -b dev https://gitcode.com/CPF-Flutter/flutter_flutter.git "$SdkRoot\3.44.9-ohos"
         & "$SdkRoot\3.44.9-ohos\bin\flutter.bat" precache --ohos
     装好后编辑 $HOME\.aceharness\configs\ohos-flutter-sdks.yaml 登记。

  2) 配置 AI 凭据：ace（启动向导，key 写入 ~/.aceharness/data/runtime-grants/，勿拷他人）

  3) 启动平台：ace start → http://localhost:3000

  注意：运行时目录在 %APPDATA%\ACEHarness。若它和 $HOME\.aceharness 不同，安装脚本会建目录联接，
  PowerShell 里的 ~/.aceharness 因此能用。cmd.exe 不展开 ~，不要用它跑工作流命令。
"@
