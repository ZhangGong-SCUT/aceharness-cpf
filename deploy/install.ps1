# ACEHarness CPF 诊断平台 一键部署（Windows PowerShell 7+）
# 用法: .\install.ps1 [-Tgz .\dist\cpf-ohos-aceharness-1.0.0-beta.90.tgz] [-SdkRoot "$HOME\flutter-sdks"]
param(
  [string]$Tgz = "",
  [string]$SdkRoot = "$HOME\flutter-sdks",
  [string]$NpmRegistry = ""
)
$ErrorActionPreference = "Stop"
$TgzName = "cpf-ohos-aceharness-1.0.0-beta.90.tgz"
if (-not $Tgz) { $Tgz = "$PSScriptRoot\dist\$TgzName" }
if (-not (Test-Path $Tgz) -and $env:ACE_DIST_URL) {
  # 远程分发模式：tgz 不在本地时从 ACE_DIST_URL 拉取（给同事装机的一句话场景）
  $Tgz = "$PWD\$TgzName"
  Write-Host "    从 $env:ACE_DIST_URL 下载 $TgzName ..."
  Invoke-WebRequest -UseBasicParsing "$env:ACE_DIST_URL/$TgzName" -OutFile $Tgz
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

Write-Host "==> 3/5 同步运行时目录 `$HOME\.aceharness\{configs,skills,scripts} ..."
$rt = "$HOME\.aceharness"
New-Item -ItemType Directory -Force $rt | Out-Null
foreach ($d in 'configs','skills','scripts') {
  if (-not (Test-Path "$rt\$d")) {
    Copy-Item -Recurse "$aceRoot\$d" "$rt\$d"
    Write-Host "    已同步 $d/"
  } else {
    Write-Host "    $rt\$d 已存在，跳过"
  }
}

Write-Host "==> 4/5 改写 SDK 清单路径 -> $SdkRoot ..."
$sdkConf = "$rt\configs\ohos-flutter-sdks.yaml"
if (Test-Path $sdkConf) {
  Copy-Item $sdkConf "$sdkConf.ace-deploy-bak"
  (Get-Content $sdkConf -Raw) -replace '/home/flutter/flutter-sdks', ($SdkRoot -replace '\\','/') | Set-Content $sdkConf -NoNewline
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

  注意：agent 执行终端请使用 PowerShell 7+ 或 Git Bash（工作流配置中的 ~/.aceharness
  路径依赖 shell 的 ~ 展开；cmd.exe 不展开 ~）。
"@
