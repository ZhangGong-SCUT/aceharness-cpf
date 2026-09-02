# 设备/模拟器启动参考

> **MANDATORY - READ ENTIRE FILE** when §3.4 设备运行验证或 §3.6 跨平台对照验证发现某平台无可用设备时。
>
> **Android 硬规则**：没有安卓真机时，必须启动 Android 模拟器（AVD）做对照，**禁止**因为 `adb devices` 为空就跳过 Android。只有 SDK/AVD 都不存在、启动失败才允许记 `missing_evidence`，且必须写清失败原因。

---

## 0. 选择顺序（Android）

1. `adb devices` 里有**真机**（序列号不是 `emulator-xxxx`，`adb devices -l` 含 `usb:`）→ 用真机。
2. 没有真机，但已有模拟器在线（`emulator-5554` 等）→ 直接用已有模拟器。
3. 真机、模拟器都没有 → **必须启动 AVD**，等 `sys.boot_completed=1` 后再 `flutter run` / 装 apk。
4. 没有 Android SDK，或 `emulator -list-avds` 为空，或启动后一直 boot 不完 → 记 `android_baseline=not_run`，`missing_evidence` 写明原因。不能把「没真机」写成「已对照」。

OHOS / iOS 仍是：有真机用真机；没有再起模拟器。OHOS 模拟器无法命令行启动（见文末）。

本机诊断跑在 **Windows + PowerShell**。下面 Android 命令以 Windows 为准；Linux/macOS 用文内 bash 备选。

---

## Android：先查设备，没有真机再起模拟器

```powershell
# 1. 有没有设备
adb devices -l
```

判定：

| `adb devices -l` | 怎么做 |
|---|---|
| 有 `usb:` / 非 `emulator-` 序列号 | 用真机，不要再起模拟器 |
| 只有 `emulator-5554` 这类 | 用这个模拟器 |
| 空，或只有 `unauthorized` / `offline` | 进入下面「启动 AVD」 |

### Windows（必须用 Start-Process，不要 nohup）

```powershell
# 2. 定位 SDK 与模拟器
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$emu = Join-Path $sdk 'emulator\emulator.exe'
if (-not (Test-Path $emu)) { throw "emulator.exe 不存在: $emu" }

# 3. 列出 AVD；优先选已有的（Pixel / API 30+ 均可）
& $emu -list-avds
$avd = (& $emu -list-avds | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
if (-not $avd) { throw '本机没有 AVD。请用 Android Studio Device Manager 先创建一个。' }

# 4. 后台启动（窗口可最小化）。不要用 Start-Job / 不要只写 emulator.exe &
Start-Process -FilePath $emu -ArgumentList @(
  '-avd', $avd,
  '-no-snapshot-load', '-no-audio', '-no-boot-anim'
) -WindowStyle Minimized

# 5. 等到开机完成，再跑 flutter
adb wait-for-device
$deadline = (Get-Date).AddMinutes(3)
do {
  Start-Sleep -Seconds 5
  $booted = (adb shell getprop sys.boot_completed 2>$null | Out-String).Trim()
  if ((Get-Date) -gt $deadline) { throw '模拟器 3 分钟仍未 boot_completed=1' }
} while ($booted -ne '1')
adb devices -l
```

装包与截图（模拟器和真机命令相同）：

```powershell
flutter build apk --debug
adb install -r build\app\outputs\flutter-apk\app-debug.apk
adb shell monkey -p com.example.flutter_app -c android.intent.category.LAUNCHER 1
adb exec-out screencap -p > outputs\android_baseline.png
```

包名按 Demo 实际 `applicationId` 替换。截图路径写入 README / 复现 JSON。

### Linux / macOS 备选

```bash
adb devices -l
EMU="${ANDROID_HOME:-$ANDROID_SDK_ROOT}/emulator/emulator"
"$EMU" -list-avds
nohup "$EMU" -avd <avd_name> -no-snapshot-load -no-audio -no-boot-anim >/tmp/android_emu.log 2>&1 &
disown
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 5; done
adb devices -l
```

**启动失败**：

- `emulator.exe` 不存在 → 未装 Android SDK，或 `ANDROID_HOME` 指错。
- `-list-avds` 为空 → 必须先有 AVD，Agent 不能凭空创建系统镜像；记 missing_evidence。
- 一直不是 `boot_completed=1` → 冷启动可到 60–90 秒；超时再记失败，不要假装设备在线。
- Windows 上用 `nohup` / `& disown` → 模拟器常被一起杀掉。本机必须用 `Start-Process`。

---

## iOS 模拟器启动（仅 macOS）

```bash
xcrun simctl list devices booted
xcrun simctl list devices available | grep -i "iphone"
xcrun simctl boot <simulator_udid>
open -a Simulator
sleep 5
xcrun simctl list devices booted
```

Windows 上没有 iOS 模拟器：Android 对照仍必须做；iOS 记 `ios_baseline=not_run（非 macOS）`。

---

## OHOS 模拟器

OHOS 模拟器目前**只能通过 DevEco Studio 启动**，无法命令行直接启动。

- 有鸿蒙真机 → 用真机做 OHOS 复现（与 Android 对照是两件事）。
- 无 OHOS 真机且无法启动模拟器 → 标注「OHOS 模拟器需 DevEco Studio Device Manager 启动，本次未执行 OHOS 设备运行验证」。这**不能**作为跳过 Android 对照的理由。

---

## 设备检查命令速查

| 平台 | 检查命令 | 真机+模拟器 |
|------|---------|-------------|
| OHOS | `hdc list targets` | 真机/模拟器均列出 |
| Android | `adb devices -l` | 真机带 `usb:`；模拟器名含 `emulator-` |
| iOS | `xcrun simctl list devices booted` | 仅模拟器（真机需 `xcrun devicectl list devices`） |
