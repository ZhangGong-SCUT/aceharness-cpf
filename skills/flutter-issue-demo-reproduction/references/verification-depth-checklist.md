# 复现验证深度检查清单

> **MANDATORY - READ ENTIRE FILE** before 在设备上验证 scenario 复现效果时。
> 这是 §3.5 + §3.6 的补充，专门解决"验证深度不够"的问题。
> 跑起来 ≠ 复现成功 ≠ 验证完整。

---

## A. 为什么需要这个清单

实战中反复出现的偏差：

| 偏差类型 | 典型表现 | 后果 |
|---------|---------|------|
| **只看 crash 不看数据** | "app 没崩 → 复现成功" | PV-03 鼠标注入只看 `mouse=1`，没逐字段对比 local/window/display/screen |
| **只看计数不看黄金标志** | "两个 View 都收到 touch → 复现成功" | PV-04 按钮注入 LOWER=1 而非 2，没发现按钮注入失效 |
| **描述与行为不同步** | README 写"window/display 与 local 相同" | 实际触摸路径 display 是正确的，描述滞后 |
| **跨平台验证不完整** | iOS 端只有 PV-03 没有 PV-04 | 用户问"iOS 上怎么验证 PV-04"才发现 |
| **没按迭代循环修改** | 按钮注入在 API 21 上失效 | 当时没迭代，直接交付 |

---

## B. 字段级验证清单（每个 scenario 必填）

每个 scenario 在 README 中必须定义"字段级预期值"，不能只写"bug 行为出现"。

### B.1 模板

```markdown
### Scenario <ID> 字段级预期

| 字段 | OHOS 预期（bug 存在） | Android/iOS 预期（bug 不复现） | 验证方法 |
|------|---------------------|-------------------------------|---------|
| <字段1> | <具体值或关系> | <具体值或关系> | <截图/日志/计数> |
| <字段2> | <具体值或关系> | <具体值或关系> | <同上> |
| <黄金标志> | <关键判据> | <对照值> | <同上> |
```

### B.2 反例 vs 正例

**❌ 反例（太粗）**：
> PV-03 鼠标事件坐标错误

**✅ 正例（字段级）**：
> | 字段 | OHOS 预期 | iOS 预期 |
> |------|----------|---------|
> | `mouse local` | (406.0, 308.0) | (406.0, 308.0) |
> | `window` | (406.0, 308.0) ❌ = local | (796.3, 1549.8) ✅ 含偏移 |
> | `display` | (406.0, 308.0) ❌ = local | (796.3, 1549.8) ✅ 含偏移 |
> | `screen` | (796.3, 1549.8) ✅ 正确 | (796.3, 1549.8) ✅ 正确 |
> | **黄金标志** | `window == display == local` | `window != local` |

---

## C. 黄金标志（Golden Signal）检查

每个 scenario 必须定义一个"黄金标志"——即**唯一能确认 bug 复现的关键判据**，不能只看"有响应"。

### C.1 黄金标志的特征

- **唯一性**：只有 bug 存在时才会出现这个值/行为
- **可观测**：能通过截图/日志/计数直接看到
- **量化**：是具体值或明确关系，不是"有异常"

### C.2 反例 vs 正例

**❌ 反例（不是黄金标志）**：
> PV-04 黄金标志：两个 View 都收到 touch
> （正确实现也可能两个都收到，不能区分 bug）

**✅ 正例（黄金标志）**：
> PV-04 黄金标志：`LOWER touch = 2`（第二个触点本应只命中 UPPER，但因缺 break 被 LOWER 再次接收）
> （正确实现 LOWER touch = 1，能明确区分）

### C.3 验证流程

```
1. 定义黄金标志（README 中明确写出）
2. 在设备上执行 scenario 操作
3. 截图/dump 采集实际值
4. 对照黄金标志：
   - 匹配 → 复现成功 ✅
   - 不匹配 → 进入迭代循环（§3.5）
5. 如果迭代 3 次仍不匹配 → 标注"未复现 + 已尝试方法 + 可能原因"
```

---

## D. 跨平台验证完整性检查

§3.6 要求"至少在一个非 OHOS 平台上运行同样 scenario"，但**每个 scenario 都要在 Android/iOS 上有对应实现**，不能只验证部分 scenario。

### D.1 检查清单

```
对每个 scenario：
  ☐ OHOS 端有实现 + 能复现
  ☐ Android 端有实现 + 不复现（或三平台一致）
  ☐ iOS 端有实现 + 不复现（或三平台一致）
  ☐ README 中记录三平台预期差异表
```

### D.2 反例 vs 正例

**❌ 反例（跨平台验证不完整）**：
- OHOS 端有 PV-01/PV-03/PV-04 三个 scenario
- iOS 端只有 PV-03 的 `ReproNativeView`，**没有 PV-04 的 LOWER/UPPER 重叠场景**
- 用户问"iOS 上怎么验证 PV-04"时才发现

**✅ 正例（跨平台验证完整）**：
- 三平台都有 PV-01/PV-03/PV-04 三个 scenario 的完整实现
- 每个 scenario 在三平台上都能运行（即使按钮路径不同，也要有等价验证方式）
- README 中每个 scenario 都有三平台预期差异表

---

## E. API 级别差异检查（OHOS 特有）

OHOS 不同 API 级别可能走不同代码路径，**必须在 README 中标注 API 级别差异**。

### E.1 检查清单

```
对每个涉及 native 事件/坐标/命中测试的 scenario：
  ☐ 在 API 20-23 真机上验证（走 postTouchEvent 回退路径）
  ☐ 在 API 24+ 真机/模拟器上验证（走 postInputEventWithStrategy）
  ☐ README 中标注 API 级别差异表
  ☐ 如果只在一个 API 级别上验证 → 标注"未覆盖 + 原因"
```

### E.2 反例 vs 正例

**❌ 反例（忽略 API 差异）**：
- 只在 API 21 真机上验证 PV-03
- README 写"window/display 与 local 相同"
- 用户在 API 24+ 设备上验证发现 display 也错误（alignToLocalSpace 加剧）

**✅ 正例（标注 API 差异）**：
- README 中有 API 级别差异对照表
- 明确写出 API 20-23 vs API 24+ 的不同预期
- 即使只在一个 API 级别上验证，也标注"未覆盖其他 API 级别 + 原因"

---

## F. 描述与行为同步检查

§6.6 要求"scenario 描述必须与实际行为一致"，但**代码修改后描述容易滞后**。

### F.1 检查清单

```
每次修改 scenario 代码后：
  ☐ 更新 README 中的字段级预期表
  ☐ 更新 scenario 页面的文字描述
  ☐ 更新 uitest 脚本的断言（如有）
  ☐ 重新在设备上验证描述与行为一致
```

### F.2 反例 vs 正例

**❌ 反例（描述滞后）**：
- 代码修改后 PV-03 触摸路径 display 变成正确
- README 仍写"window/display 与 local 完全相同"
- 用户按 README 操作发现描述不准

**✅ 正例（同步更新）**：
- 代码修改后立即更新 README
- 描述明确区分触摸路径和鼠标路径的不同表现
- 重新验证描述与行为一致

---

## G. 迭代循环检查（§3.5 强化）

§3.5 要求"不符合则持续迭代直到符合"，但**迭代次数要有上限**，不能无限迭代。

### G.1 迭代决策树

```
scenario 在设备上验证：
  ├── 实际效果 = 预期 → ✅ 通过，继续下一个
  ├── 实际效果 ≠ 预期：
  │   ├── 迭代 1：分析原因 → 修改代码 → 重新编译→运行→验证
  │   ├── 迭代 2：换一种触发方式 → 重新验证
  │   ├── 迭代 3：检查前置状态/时机 → 重新验证
  │   └── 迭代 3 次仍不匹配：
  │       ├── 标注"未复现 + 已尝试方法 + 可能原因"
  │       └── 不能默默跳过
  └── 无法在设备上验证（无设备/无权限）：
      └── 标注"未验证 + 原因"
```

### G.2 反例 vs 正例

**❌ 反例（不迭代）**：
- PV-04 按钮注入在 API 21 上 LOWER=1（不是 2）
- 当时没迭代，直接交付
- 用户用真实双指验证后才发现按钮注入失效

**✅ 正例（按迭代循环）**：
- PV-04 按钮注入在 API 21 上 LOWER=1
- 迭代 1：检查 postTouchEvent 路径 → 发现 ArkUI 命中测试挡住 LOWER
- 迭代 2：改为直接调用 handleEngineTouchEvent → 重新验证 → LOWER=2 ✅
- README 中标注"按钮注入路径与真实双指路径结果一致"

---

## H. 交付前最终检查清单

在交付 demo 前，逐条确认：

```
对每个 scenario：
  ☐ 字段级预期表已定义（B）
  ☐ 黄金标志已定义且可观测（C）
  ☐ 三平台都有实现且验证过（D）
  ☐ API 级别差异已标注（E，如适用）
  ☐ 描述与行为同步（F）
  ☐ 迭代循环已完成（G）
  ☐ 证据已采集并归档（I）— 截图 + 日志 + dump 三件套

对整个 demo：
  ☐ README 中有场景覆盖矩阵
  ☐ 每个 scenario 有 uitest 脚本
  ☐ 三平台编译通过
  ☐ 三平台设备运行验证通过
  ☐ 跨平台对照验证完成
  ☐ 每个 scenario 的证据路径已写入 README
```

如果任何一条不满足，**不能交付**。

---

## I. 证据采集与归档（MANDATORY — 没有证据 = 没有验证）

> **核心原则**：验证结论必须有证据支撑。口头说"我验证过了"不算验证，必须提供截图 + 日志 + dump 三件套，让 reviewer 能独立复核。

### I.1 证据三件套

每个 scenario 的每次验证（OHOS 复现 + Android/iOS 对照）都必须采集以下三类证据：

| 证据类型 | 采集方法 | 文件命名规范 | 存放路径 | 证明什么 |
|---------|---------|-------------|---------|---------|
| **截图** | uitest `driver.screenCapture()` / `hdc shell snapshot` / `adb exec-out screencap` / `xcrun simctl io` | `pv<NN>_<platform>_<path>_<before|after>.png` | `/tmp/` 或 demo 的 `evidence/` 目录 | UI 状态、计数文本、坐标值、布局 |
| **日志** | `hdc hilog` / `adb logcat` / `NSLog` / `debugPrint` 输出 | `pv<NN>_<platform>_<path>.log` | 同上 | 异常堆栈、MethodChannel 调用、引擎内部状态 |
| **UI dump** | `hdc shell uitest dumpLayout` / `adb shell uiautomator dump` / `xcrun simctl` | `pv<NN>_<platform>_<path>_<before|after>.xml` | 同上 | 控件树、文本内容、坐标属性（可被 grep 验证） |

### I.2 证据命名规范

```
pv<NN>_<platform>_<path>_<phase>.<ext>

示例：
pv03_ohos_mouse_after.png          # OHOS PV-03 鼠标路径注入后截图
pv03_ohos_mouse_after.xml          # 同上的 UI dump
pv03_ohos_touch_after.png          # OHOS PV-03 触摸路径截图
pv03_android_touch_after.png       # Android PV-03 触摸路径截图
pv03_ios_touch_after.png           # iOS PV-03 触摸路径截图
pv04_ohos_inject_after.png         # OHOS PV-04 按钮注入后截图
pv04_ohos_multitouch.jpeg          # OHOS PV-04 真实双指截图
pv04_ios_physical_after.png        # iOS PV-04 真实双指截图
pv01_ohos_before.png               # OHOS PV-01 触发前截图
pv01_ohos_hilog.log                # OHOS PV-01 hilog 日志
```

**命名要素**：
- `pv<NN>`：场景编号（如 pv01, pv03, pv04）
- `<platform>`：ohos / android / ios
- `<path>`：事件路径（mouse / touch / inject / multitouch / physical）
- `<phase>`：before / after（操作前 / 操作后）

### I.3 证据采集命令速查

**OHOS**：
```bash
# 截图
hdc shell snapshot_display -f /data/local/tmp/pv03_ohos_mouse_after.png
hdc file recv /data/local/tmp/pv03_ohos_mouse_after.png /tmp/

# UI dump（uitest）
hdc shell uitest dumpLayout
hdc file recv /data/local/tmp/layout.json /tmp/pv03_ohos_mouse_after.xml

# hilog（过滤 Flutter 相关）
hdc shell hilog | grep -E "Flutter|PlatformView|TouchEvent" > /tmp/pv03_ohos_hilog.log
```

**Android**：
```bash
# 截图
adb exec-out screencap -p > /tmp/pv03_android_touch_after.png

# UI dump
adb shell uiautomator dump /sdcard/window_dump.xml
adb pull /sdcard/window_dump.xml /tmp/pv03_android_touch_after.xml

# logcat
adb logcat -v threadtime | grep -E "flutter|PlatformView" > /tmp/pv03_android_logcat.log
```

**iOS**：
```bash
# 截图（模拟器）
xcrun simctl io booted screenshot /tmp/pv03_ios_touch_after.png

# NSLog 已在 flutter run 输出中，重定向即可
flutter run -d "iPhone 17 Pro" 2>&1 | tee /tmp/pv03_ios_nslog.log
```

### I.4 证据归档到 README

每个 scenario 的验证记录中必须列出证据文件路径，让 reviewer 能按图索骥：

```markdown
#### PV-03 坐标 Bug — 已复现 ✅

**证据**：
- 截图：`/tmp/pv03_ohos_mouse_after.png`
- UI dump：`/tmp/pv03_ohos_mouse_after.xml`
- hilog：`/tmp/pv03_ohos_hilog.log`

**关键数据**（从证据中提取）：
\`\`\`
viewId=21 touch=0 mouse=1
mouse local=(406.0,308.0)
window=(406.0,308.0)
display=(406.0,308.0)
screen=(796.3,1549.8)
\`\`\`

**结论**：`window == display == local`（黄金标志匹配），bug 确认。
```

### I.5 反例 vs 正例

**❌ 反例（无证据）**：
> PV-03 已复现，鼠标注入后 window/display 与 local 相同。
> （没有截图、没有日志、没有 dump，reviewer 无法复核）

**❌ 反例（证据不完整）**：
> PV-04 已复现，截图见 /tmp/pv04.png。
> （只有一张截图，没有 before/after 对比，没有日志，无法确认是哪个路径的验证）

**✅ 正例（三件套齐全）**：
> PV-04 按钮注入路径已复现：
> - before 截图：`/tmp/pv04_ohos_inject_before.png`（LOWER=0, UPPER=0）
> - after 截图：`/tmp/pv04_ohos_inject_after.png`（LOWER=2, UPPER=1）
> - UI dump：`/tmp/pv04_ohos_inject_after.xml`（可 grep 验证 touch=2）
> - hilog：`/tmp/pv04_ohos_inject.log`（含 MethodChannel 调用记录）
> - 黄金标志：LOWER=2 ✅ 匹配

### I.6 证据与结论的对应关系

每个验证结论必须能追溯到至少一条证据：

```
结论："PV-04 bug 已复现"
  └── 证据：after 截图显示 LOWER touch=2
      └── 证据：UI dump 中 grep "touch=" 返回 "touch=2"
          └── 证据：hilog 含 "injectOverlappingTouchDirect" 调用记录
```

如果结论无法追溯到证据，**结论无效**，必须重新采集。

### I.7 跨平台证据对照

跨平台对照验证时，三平台的证据必须**同路径、同命名、同格式**，方便并排对比：

```
/tmp/pv04_ohos_inject_after.png      # OHOS: LOWER=2 ❌
/tmp/pv04_android_touch_after.png    # Android: LOWER=0 ✅
/tmp/pv04_ios_physical_after.png     # iOS: LOWER=0 ✅
```

README 中的三平台对照表必须引用这些证据路径：

```markdown
| 平台 | LOWER | UPPER | 证据 |
|------|-------|-------|------|
| OHOS | 2 ❌ | 1 | `/tmp/pv04_ohos_inject_after.png` |
| Android | 0 ✅ | 1 | `/tmp/pv04_android_touch_after.png` |
| iOS | 0 ✅ | 1 | `/tmp/pv04_ios_physical_after.png` |
```

---

## J. 修复验证：embedding HAR 必须按 lock 替换

> 复现 Demo 跑通 ≠ 修复后的 embedding 进了这个 Demo。
> Issue #2500 第一轮真机仍是 LOWER DOWN=2，原因是新 HAR 盖到了 `flutter.har`，Demo 实际吃 `flutter_embedding_debug.har`。

OHOS Flutter 工具链同时存在：

- `flutter.har`：`artifacts.dart` 中 `Artifact.flutterEngineHar` 的文件名；`ohos_builder.dart` 注释「复制 flutter.har」
- `flutter_embedding_${mode}.har`：`hvigor.dart` 从 SDK 缓存拷贝；`printHowToConsumeHar` 把 `@ohos/flutter_ohos` 写成这个文件

**先对齐引擎，再换 HAR。** 读 `outputs/ohos-flutter-sdk.json`：`matched=true` 必须用 `flutterBin`，HAR 只盖进该 SDK `bin/cache` 或本次 run。`repo/` 里改的源码 / `assembleHar` 产物，必须配 **同一套** OHOS Flutter SDK 的 `libflutter.so` + embedding HAR。只 checkout 源码不算。对不上（例如 3.41 HAR + 3.27 so）或 `matched=false`：不要改用户日常 SDK 缓存凑数；运行验证最高 `conditional_pass`，禁止 `issue_resolved=yes`。黄金标志必须是 Issue 正文预期，不能用本机旧包上的替代症状。

**修复验证（改了 `flutter_embedding` / embedding ArkTS）必做：**

1. 记录 `repo/` 的 branch/commit，以及编 hap 用的 `<ohos_flutter>/bin/flutter --version`。两者引擎对不上则停在「patch 已出、Issue 版本未跑」。
2. 读 Demo `oh-package.json5` 和 `ohos/oh_modules/.ohpm/lock.json5`，记下 `@ohos/flutter_ohos` 的实际路径。
3. 把新编 HAR 盖到 **lock 指向的那个文件**。禁止因为搜到「复制 flutter.har」就盖 `flutter.har`。
4. `flutter build hap` 默认 release：常吃 `flutter_embedding_release.har`。只盖 debug 无效；按本次构建实际消费的 `${mode}` 盖。
5. 删除 Demo `ohos/oh_modules`，并清 `~/.ohpm/cache`，再 `flutter build hap`、安装。
6. 核对 `oh_modules` 内源码已含本次修改。用复现阶段锁定的 **Issue 原文** 黄金标志复测，禁止修订/改写后再判 pass。仍是修复前的值时，先核对 1–5，再写 `issue_golden_flag_met=false`。

debug 缓存常见路径（仍以 lock 为准）：`bin/cache/artifacts/engine/ohos-arm64/flutter_embedding_debug.har`。
