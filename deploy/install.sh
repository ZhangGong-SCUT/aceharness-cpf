#!/usr/bin/env bash
# ACEHarness CPF 诊断平台 一键部署（Linux / macOS）
# 用法: ./install.sh [tgz路径] [SDK根目录]
#   ./install.sh                                   # 默认 dist/ 下的 tgz + ~/flutter-sdks
#   ./install.sh ./xxx.tgz /data/flutter-sdks      # 指定 tgz 与 SDK 目录
set -euo pipefail

TGZ_NAME="cpf-ohos-aceharness-1.0.0-beta.90.tgz"
TGZ="${1:-}"
if [ -z "$TGZ" ]; then
  TGZ="$(dirname "$0")/dist/$TGZ_NAME"
fi
if [ ! -f "$TGZ" ] && [ -n "${ACE_DIST_URL:-}" ]; then
  # 远程分发模式：tgz 不在本地时从 ACE_DIST_URL 拉取（给同事装机的一句话场景）
  TGZ="$(pwd)/$TGZ_NAME"
  echo "    从 $ACE_DIST_URL 下载 $TGZ_NAME ..."
  curl -fsSL "$ACE_DIST_URL/$TGZ_NAME" -o "$TGZ" || { echo "✗ 下载失败：检查 ACE_DIST_URL 或先手动放置 tgz"; exit 1; }
fi
SDK_ROOT="${2:-$HOME/flutter-sdks}"

echo "==> 1/5 检查 Node.js（需 >= 20，推荐 22 LTS）..."
command -v node >/dev/null || { echo "✗ 未找到 node，请先安装 Node.js 20+"; exit 1; }
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>=20?0:1)" \
  || { echo "✗ Node $(node -v) 版本过低，需要 >= 20"; exit 1; }
echo "    node $(node -v) ✓"

echo "==> 2/5 全局安装 $TGZ ..."
[ -f "$TGZ" ] || { echo "✗ 找不到 $TGZ"; exit 1; }
# 事实澄清：tgz 只 bundled 了 @cangjielang/napi-cj；其余 ~120 个生产依赖首次安装需访问
# npm registry（约 880 个包、4~12 分钟，视网络）。内网/弱网环境请配镜像：
#   NPM_REGISTRY=https://<内网镜像> ./install.sh   （或 npm config set registry <镜像>）
REG_OPT=()
[ -n "${NPM_REGISTRY:-}" ] && REG_OPT=(--registry "$NPM_REGISTRY")
# 失败恢复：清理 npm 中断残留的暂存目录（会导致 ENOTEMPTY）、必要时卸载后重装，避免"已卸载却没装上"
if ! npm install -g --prefer-offline "${REG_OPT[@]}" "$TGZ"; then
  echo "    首次安装失败，清理暂存目录并重试..."
  rm -rf "$(npm root -g)/@cpf-ohos/".aceharness-* 2>/dev/null || true
  if npm ls -g --depth 0 @cpf-ohos/aceharness >/dev/null 2>&1; then
    npm uninstall -g @cpf-ohos/aceharness
  fi
  npm install -g --prefer-offline "${REG_OPT[@]}" "$TGZ"
fi
ACE_ROOT="$(npm root -g)/@cpf-ohos/aceharness"
command -v ace >/dev/null || { echo "✗ ace 未进入 PATH，请检查 npm global bin 是否在你的 PATH 中"; exit 1; }
echo "    安装根: $ACE_ROOT"

echo "==> 3/5 同步运行时目录 ~/.aceharness/{configs,skills,scripts} ..."
mkdir -p "$HOME/.aceharness"
for d in configs skills scripts; do
  if [ ! -e "$HOME/.aceharness/$d" ]; then
    cp -r "$ACE_ROOT/$d" "$HOME/.aceharness/$d"
    echo "    已同步 $d/"
  else
    echo "    ~/.aceharness/$d 已存在，跳过（如需更新： rm -rf 后重跑本脚本，或手动 diff）"
  fi
done

echo "==> 4/5 改写 SDK 清单路径 -> $SDK_ROOT ..."
SDK_CONF="$HOME/.aceharness/configs/ohos-flutter-sdks.yaml"
if [ -f "$SDK_CONF" ]; then
  sed -i.ace-deploy-bak "s|/home/flutter/flutter-sdks|$SDK_ROOT|g" "$SDK_CONF"
  grep -q "sdkRoot: $SDK_ROOT" "$SDK_CONF" \
    && echo "    校验 ✓（原文件备份为 .ace-deploy-bak）" \
    || { echo "✗ SDK 路径改写失败"; exit 1; }
else
  echo "    未找到 $SDK_CONF，跳过（首次启动向导后请手动检查 SDK 路径）"
fi

echo "==> 5/5 环境自检（ace doctor）..."
# 经 bin/ace.js 直调（npm 全局 bin 的 PATH 在脚本内可能未刷新）；doctor 自身会自动补齐缺失运行时目录
node "$ACE_ROOT/bin/ace.js" doctor \
  || echo "    ⚠ doctor 有未通过项：按上方「修复」命令处理后，随时可重跑：ace doctor"

cat <<EOF

✅ 部署完成。接下来的 3 件事：

  1) 放入 Flutter SDK（约 1.2G/版本，按需）：
       rsync -avP <源机>:/home/flutter/flutter-sdks/ "$SDK_ROOT/"
     或新装单个版本（示例 3.44.9）：
       git clone --depth 1 -b dev https://gitcode.com/CPF-Flutter/flutter_flutter.git "$SDK_ROOT/3.44.9-ohos" \
         && "$SDK_ROOT/3.44.9-ohos/bin/flutter" precache --ohos
     装好后编辑 ~/.aceharness/configs/ohos-flutter-sdks.yaml 登记（只登记装好的版本）。

  2) 配置 AI 凭据（每机独立，勿拷贝他人 runtime-grants）：
       ace        # 启动向导，配置模型 provider key，写入 ~/.aceharness/data/runtime-grants/

  3) 启动平台：
       ace        # 或 ace start；浏览器打开 http://localhost:3000（端口用 PORT=xxxx 覆盖）

  可选：仅当需要跑「engine 源码修复」类 run 时，准备引擎共享源码树：
       mkdir -p ~/engine-src && cd ~/engine-src && <gclient sync 流程>
     见 ~/.aceharness/skills/cpf-ohos-issue-analysis/references/engine-build.md
     （不配置则 engine 编译类验证会报环境缺失，其余诊断流程不受影响）
EOF
