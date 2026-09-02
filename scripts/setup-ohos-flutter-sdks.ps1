# 把本机已有的 OHOS Flutter 仓做成「能编 hap」的分版本 SDK。
# 不碰日常 D:\a_flutter\flutter_flutter。
# 3.35：D:\flutter_flutter（oh-3.35.7-dev，引擎与 release 相同）junction 到清单路径。
# 3.22 / 3.41 / 3.44：从同一仓 worktree 出对应 oh-*-dev。

$ErrorActionPreference = 'Stop'
$SdkRoot = 'D:\flutter-sdks'
$Source335 = 'D:\flutter_flutter'
$Path322 = Join-Path $SdkRoot '3.22.3-ohos'
$Path335 = Join-Path $SdkRoot '3.35.7-ohos'
$Path341 = Join-Path $SdkRoot '3.41.9-ohos'
$Path344 = Join-Path $SdkRoot '3.44.9-ohos'

function Assert-GitRepo($path) {
  if (-not (Test-Path (Join-Path $path '.git'))) {
    throw "不是 git 仓: $path"
  }
}

function Ensure-Junction($link, $target) {
  if (Test-Path $link) { return }
  New-Item -ItemType Directory -Path (Split-Path $link -Parent) -Force | Out-Null
  cmd /c "mklink /J `"$link`" `"$target`""
  if ($LASTEXITCODE -ne 0) { throw "创建 junction 失败: $link -> $target" }
}

function Ensure-Worktree($repo, $path, $branch, $startPoint) {
  if (Test-Path (Join-Path $path 'bin\flutter.bat')) { return }
  New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
  $local = git -C $repo branch --list $branch
  if ($local) {
    git -C $repo worktree add $path $branch
  } else {
    git -C $repo worktree add -b $branch $path $startPoint
  }
  if ($LASTEXITCODE -ne 0) { throw "worktree add 失败: $path ($branch)" }
}

function Invoke-FlutterPrecache($sdkPath) {
  $flutter = Join-Path $sdkPath 'bin\flutter.bat'
  if (-not (Test-Path $flutter)) { throw "没有 flutter.bat: $sdkPath" }
  Write-Host "=== flutter --version @ $sdkPath ==="
  & $flutter --version
  Write-Host "=== flutter precache --ohos @ $sdkPath ==="
  & $flutter precache --ohos
  $engine = Join-Path $sdkPath 'bin\cache\artifacts\engine\ohos-arm64'
  $har = Join-Path $engine 'flutter_embedding_debug.har'
  $flutterHar = Join-Path $engine 'flutter.har'
  if (-not ((Test-Path $har) -or (Test-Path $flutterHar))) {
    throw "precache 结束仍没有 OHOS HAR: $engine"
  }
  Write-Host "OK $engine"
}

Assert-GitRepo $Source335
New-Item -ItemType Directory -Path $SdkRoot -Force | Out-Null
Ensure-Junction $Path335 $Source335
Ensure-Worktree $Source335 $Path322 'oh-3.22.3-dev' 'origin/oh-3.22.3-dev'
Ensure-Worktree $Source335 $Path341 'oh-3.41.9-dev' 'origin/oh-3.41.9-dev'
Ensure-Worktree $Source335 $Path344 'oh-3.44.9-dev' 'origin/oh-3.44.9-dev'

Invoke-FlutterPrecache $Path322
Invoke-FlutterPrecache $Path335
Invoke-FlutterPrecache $Path341
Invoke-FlutterPrecache $Path344

Write-Host '全部就绪。'
