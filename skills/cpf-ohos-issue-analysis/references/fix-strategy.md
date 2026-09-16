# OHOS 跨平台框架修复策略

> 本文档定义 OHOS 跨平台框架（Flutter-OHOS / React Native-OHOS / KMP-CMP 等）问题的修复策略，
> 供 `diagnosis-fix-advisor`（修复方案设计）和 `diagnosis-fix-verifier-advisor`（修复验证）参考。

## 核心原则：OHOS 独有问题优先 Native 层修复

### 为什么优先 Native 层

OHOS 跨平台框架的问题分两类：

| 问题类型 | 定义 | 修复策略 |
|---|---|---|
| **三端共性问题** | Android/iOS/OHOS 都存在 | 跟随上游修复，cherry-pick 或升级 |
| **OHOS 独有问题** | Android/iOS 正常，仅鸿蒙出现 | **优先 Native 层修复** |

OHOS 独有问题的根因通常在：
- Native 层（C++ Engine/Embedder）的平台适配代码
- ArkTS 平台实现层（MethodChannel/Plugin 的鸿蒙端）

在 Dart 层打补丁的问题：
1. **治标不治本**——Dart 层 workaround 只是绕过症状，Native 层的根因仍在
2. **引入分支逻辑**——Dart 层需要 `if (Platform.isOHOS)` 判断，增加维护成本
3. **三端行为不一致**——Dart 层补丁只影响 OHOS，可能导致后续三端逻辑分叉
4. **性能损耗**——Dart 层的额外检查/转换有运行时开销

### 修复层级优先级

```
1. Native 层（C++ / ArkTS）     ← 优先
   ↓ 无法修复时
2. Framework 鸿蒙化层            ← 其次
   ↓ 无法修复时
3. Dart 层 workaround            ← 最后（仅短期止血）
```

#### 各层适用场景

| 层级 | 适用场景 | 示例 |
|---|---|---|
| **Native (C++)** | Engine/Embedder 的平台适配缺陷 | 渲染管线、线程调度、内存管理、GPU 调用 |
| **Native (ArkTS)** | 平台 Channel/Plugin 的鸿蒙端实现 | MethodChannel 通信、权限处理、系统能力调用 |
| **Framework** | Flutter framework 的 OHOS 适配代码 | 平台视图、手势识别、生命周期适配 |
| **Dart** | 仅作为短期止血，等待 Native 修复 | 临时参数调整、输入预处理、降级方案 |

### 降级到 Dart 层的判断依据

只有满足以下**至少一项**时，才允许选择 Dart 层修复：

1. **Native 层无法修改**——闭源 SDK / 无源码权限 / 依赖未开源
2. **Native 层修改成本过高**——需要改 Engine 编译链，超出 Issue 修复范围
3. **紧急止血**——线上故障需要立即恢复，Native 修复周期长
4. **Dart 层修复更通用**——问题本质是跨平台逻辑，三端都需要调整

选择 Dart 层修复时，必须在 `risk_assessment` 中说明：
- 为何无法在 Native 层修复（对应上述 1-4 中的哪项）
- Native 层修复的长期计划（如"已提 Issue，等待 Engine 升级"）

## 输出字段规范

修复方案 JSON 中必须包含以下字段：

| 字段 | 值 | 说明 |
|---|---|---|
| `fix_code_layer` | `native` / `framework` / `dart` | 修复代码所在的层 |
| `is_ohos_specific` | `true` / `false` | 根因是否为 OHOS 端独有 |
| `fix_layer` | `application` / `plugin` / `framework` / `engine` / `system` | 根因所在层面（与 fix_code_layer 不同，前者是问题层面，后者是修复层面） |

### 字段组合判断

| is_ohos_specific | fix_code_layer | 要求 |
|---|---|---|
| `true` | `native` | ✅ 最佳实践 |
| `true` | `framework` | ⚠️ 可接受，说明为何 Native 层不合适 |
| `true` | `dart` | ❌ 必须在 risk_assessment 中说明降级理由 |
| `false` | 任意 | 跟随上游策略，无强制要求 |

## 验证要点（供 verifier-advisor 使用）

修复验证 Agent 应检查：

1. **`is_ohos_specific=true` 时是否遵循了 Native 优先**
   - `fix_code_layer=native` → 通过
   - `fix_code_layer=dart` → 检查 `risk_assessment` 是否说明了降级理由，未说明则 `verdict=fail`

2. **`fix_code_layer` 与 `root_cause_fix.file` 的一致性**
   - `native` → file 应为 `.cpp` / `.h` / `.ts` / `.ets`
   - `framework` → file 应在 framework ohos 适配目录
   - `dart` → file 应为 `.dart`

3. **Dart 层修复的长期计划**
   - `fix_code_layer=dart` 时，`upstream_collaboration` 中应有 Native 层修复的跟踪计划

4. **embedding / Native ArkTS 修复是否进了 Demo 实际消费的 HAR**（见下一节）
   - 黄金标志仍是修复前的值，先核对换的是哪个 HAR，再判断修复无效

## 修复验证的真机截图规范（截图不是乱截的）

修复验证阶段的真机复测必须留证，**截图与 hilog 同场景配对采集**，规则如下（Issue #2721 教训：13 张复现截图 vs 1 张白屏修复截图，证据链失衡）：

1. **全场景覆盖**：复现阶段建立的每个场景（S1-S4、Reset 等）修复后逐一复测，每场景 OHOS 一张；复现有 Android 对照的，修复后同样每场景一张。禁止只截一个场景交差。
2. **截图时机**：点击场景按钮 → `sleep 2~3`（等 WMS 生效、渲染稳定）→ `snapshot_display`。截图前确认 app 在前台（`hdc shell aa start` 拉起 / `uitest` 点击成功回显）；息屏或后台状态下截出白屏/壁纸无效。
3. **有效性自查**：白屏、锁屏、桌面壁纸、纯色空屏 = 无效截图，必须重拍（拉起 → 点击 → sleep → 重截），**不允许重拍失败就弃截图只交 hilog**，也不允许多场景共用一张截图。
4. **命名对齐**：`fix_{场景}_{平台}_after.jpeg`（如 `fix_s1_ohos_after.jpeg`、`fix_s1_android_after.png`），与复现阶段 `sN_{平台}_after` 命名对齐，便于前后对照。
5. **hilog 配对**：每场景的截图与 `ohos-hilog-fix-{场景}.txt` 同场景采集（先截屏后抓日志，或反之，保持同一次场景执行内），证据可互相对照时间。
6. **方向/旋转类 bug 的判据声明**：`hdc shell snapshot_display` 输出按逻辑屏归一化，180° 倒置在截图中不可见——此类 bug 的黄金判据是 hilog 数值（`ohosOrientation` 值 + WMS `rotation`），截图仅作场景标记；但场景标记本身仍须是有效画面（见第 3 条）。

## 把 embedding 改动送进 Demo（验证必做）

OHOS Flutter 工具链里同时有两套 HAR 文件名，**不能默认盖 `flutter.har`**：

| 名字 | 工具链出处 | 含义 |
|---|---|---|
| `flutter.har` | `artifacts.dart` 把 `Artifact.flutterEngineHar` 映射成这个名字；`ohos_builder.dart` 注释「复制 flutter.har」 | 引擎 HAR 工件名之一 |
| `flutter_embedding_${mode}.har` | `hvigor.dart` 从 SDK 缓存目录拷贝；`printHowToConsumeHar` 把 `@ohos/flutter_ohos` 写成这个文件 | 应用侧 embedding 常见消费名。debug 即 `flutter_embedding_debug.har` |

Issue #2500 修复验证曾把新 HAR 盖到 `flutter.har`，第一轮真机黄金标志仍在（LOWER DOWN=2）。Demo 的 `oh_modules/.ohpm/lock.json5` 显示 `@ohos/flutter_ohos` 实际指向 SDK 缓存里的 `flutter_embedding_debug.har`。改盖该文件并删 `ohos/oh_modules` 重装后，黄金标志才消失。

## SDK 与 repo 必须同套

`repo/` 只是本次诊断 clone 的源码树（改 ets、出 `fix.patch`），完成步骤会删掉。编 hap / 上真机用的是本机 **按分支对号入座的** OHOS Flutter SDK（`bin/flutter` + `bin/cache/artifacts/engine/`）。

本机清单在 `configs/ohos-flutter-sdks.yaml`。信息采集拿到 `repo/` 分支后，引擎写入 `outputs/ohos-flutter-sdk.json`，并注入步骤上下文「OHOS Flutter SDK」。

- 只 `git checkout` 源码、或把 `repo/` 编出来的 HAR 盖到另一版 SDK 的缓存上，**都不算对齐**（3.41 HAR + 3.27 `libflutter.so` 会 SIGSEGV）。
- 编 hap、换 HAR、装真机必须用 pin 里的 `flutterBin`，和 `repo/` **同一套引擎**（同一分支的 so + embedding HAR）。不要用 PATH 里的社区 flutter，也不要把 `repo/` 当 SDK。
- HAR 只盖进选用 SDK 的 `bin/cache`，或本次 run 目录。禁止盖日常 SDK（`dailySdk`，常见 `D:\a_flutter\flutter_flutter`）的 `flutter_embedding_*.har`。
- 本机没有匹配 SDK（`matched=false`）：补丁仍可出，运行验证写 `needs_runtime_validation` / `conditional_pass`，`issue_resolved=partial`，`engine_aligned=false`。禁止改用日常 SDK 凑真机。引擎见到清单未对上会把修复验证 `pass` 降为 `conditional_pass`。
- 黄金标志跟 **Issue 正文的预期结果**，不跟本机旧 SDK 上碰巧更重的症状。

### 引擎 HAR 工程的 API 版本对齐（禁止打桩绕过）

repo-engine 的 flutter_embedding 工程自带 `build-profile.json5`，`compatibleSdkVersion` 常是旧值（如 `"5.1.0(18)"`）。dev/新分支源码可能用到更高版本 API（如 `window.getGlobalWindowMode` @since 20），按旧 API 语境编译会报 `Property 'xxx' does not exist`。此时禁止删源码/伪造类型打桩，按以下流程对齐：

1. 查真机实际 API（`hdc shell param get const.ohos.apiversion`）与本机编译 SDK（`harmony-tools/ohos-sdk/` 下目录名，如 `26`）。
2. **真机 API ≥ 源码所需 API** 时：把 HAR 工程 build-profile 的 `compatibleSdkVersion`/`compileSdkVersion` 改成与本机 SDK 一致的 API 再重编。格式：`runtimeOS: "OpenHarmony"` 工程用整数（如 `26`）；`runtimeOS: "HarmonyOS"` 工程用 `"x.y.z(api)"` 字符串。demo 工程同步对齐。
3. 用本机完整 SDK 编出的 HAR **可以上真机做行为验证**（`engine_aligned=true`，前提是 SDK 分支对号入座），黄金标志照常实测。
4. 打桩产物只可用于纯编译检查，文件必须带 `_compile_check_only` 标记，**不得上真机**。
5. 只有真机 API < 源码所需 API（如真机 API 18 而代码用 @since 20 接口）时，才写 `needs_runtime_validation` / `conditional_pass`。

**本机（Linux）构建/真机操作前 MANDATORY 读 [`../../flutter-issue-demo-reproduction/references/linux-build-env.md`](../../flutter-issue-demo-reproduction/references/linux-build-env.md)**：demo 工程模板必须完成 build-profile 五项改造（`runtimeOS: OpenHarmony` + 整数 26 + `sdk.dir` + 签名密文块 + bundleName `com.example.flutterabilitydemo`）才能编 hap / 装真机；含 ArkTS handler 写法约束与报错对照表。

Issue #2492：仓是 `oh-3.41.9-dev`，真机用本机 3.27.5 SDK；验证把同样补丁打进 3.27 HAR 后写了 `bug_fixed=true`，Issue 要的自定义 `code`/`details` 并未过。

## embedding 换装操作步骤（验证必做）

验证 embedding / `flutter_embedding` 目录下的 ArkTS 修复时：

1. 读 Demo 的 `oh-package.json5` 和 `ohos/oh_modules/.ohpm/lock.json5`，看 `@ohos/flutter_ohos` **实际指向哪个文件**。
2. 把新编出来的 embedding HAR **盖到 lock 指向的那个文件**。不要先搜到「复制 flutter.har」就盖 `flutter.har`。
3. **`flutter build hap` 默认走 release**：lock / 实际消费经常是 `ohos-arm64-release/flutter_embedding_release.har`。只盖 debug 会白跑一轮。debug、release 以 lock 和本次 `flutter build hap` 的 product 为准，该盖哪份盖哪份。
4. 删 Demo 的 `ohos/oh_modules`，并清 `~/.ohpm/cache`（ohpm 按路径键复用旧包，只删 `oh_modules` 不够），再 `flutter build hap` / 重装。
5. 以安装后 `oh_modules` 里实际源码是否含本次修改为准（例如新出现的 `instanceof Error`），不要只看文件复制成功。
6. 用 **Issue 原文** 的黄金标志复测。若仍是修复前的值，先核对第 1–5 步，再写 `bug_fixed=false`。

debug 缓存常见路径（仍以 lock 为准）：`bin/cache/artifacts/engine/ohos-arm64/flutter_embedding_debug.har`。

## 典型案例

### 案例 1：Native 层修复（推荐）

**问题**：OHOS 端 JSON StringList 解码错误，Android/iOS 正常

**根因**：ArkTS 端 `Number.isInteger` 对 1.0 误判为 INT32

**修复**：
```json
{
  "is_ohos_specific": true,
  "fix_code_layer": "native",
  "root_cause_fix": {
    "file": "packages/pigeon/arkts/arkts_generator.ts",
    "change": "同步 Android 三态识别逻辑，1.0 不强制转 INT32"
  }
}
```

### 案例 2：Dart 层降级（需说明理由）

**问题**：OHOS 端某个 Engine API 返回值异常

**根因**：Engine C++ 层 bug，但 Engine 闭源无法修改

**修复**：
```json
{
  "is_ohos_specific": true,
  "fix_code_layer": "dart",
  "root_cause_fix": {
    "file": "lib/src/platform/ohos_codec.dart",
    "change": "对 OHOS 端返回值做二次校验"
  },
  "risk_assessment": {
    "regression_risk": "中",
    "dart_layer_reason": "Engine 闭源无法修改，已提 Issue 跟踪，Dart 层为临时止血"
  }
}
```
