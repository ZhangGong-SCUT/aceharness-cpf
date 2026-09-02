---
name: flutter-issue-demo-reproduction
description: "Write Flutter OHOS regression demos that REPRODUCE bugs on device. Complete ohos/android/ios native projects + MANDATORY uitest scripts per scenario. Every demo MUST run on real device/emulator to verify reproduction effect. Cross-platform verification on Android/iOS is MANDATORY for OHOS-specific bugs. Use when user says 写个 Flutter Demo, OHOS Flutter Demo, framework bug 复现 Demo, 给 flutter issue 写最小复现. NOT for pure ArkTS/C++ demos or production apps."
---

# Flutter Issue demo 复现（OHOS 设备验证场景）

> **Pattern**: Tool — 精确代码 + 决策树 + 反模式
> **加载策略**：先读本文件 (§1-§8 + §6 NEVER)；写第一个 scenario 前 **MANDATORY** 读 [`references/scenario-template.md`](references/scenario-template.md)；如需写 testWidgets，写前 **MANDATORY** 读 [`references/test-helpers.md`](references/test-helpers.md)；写第一个 uitest 脚本前 **MANDATORY** 读 [`references/uitest-snippets.md`](references/uitest-snippets.md)；设备运行验证或跨平台对照验证发现某平台无设备时 **MANDATORY** 读 [`references/device-emulator-setup.md`](references/device-emulator-setup.md)；写跨平台 integration test 前 **MANDATORY** 读 [`references/cross-platform-integration-test.md`](references/cross-platform-integration-test.md)；**设备上验证 scenario 复现效果前 MANDATORY 读 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md)**（解决"只看 crash 不看数据、只看计数不看黄金标志、描述与行为不同步、**验证结论无证据支撑**"等验证深度不够问题；含证据三件套采集命令、命名规范、归档模板）。**修 embedding / `flutter_embedding` 后再装 Demo 验证前，必须读该文件 §J**（先对齐引擎，再对 lock 换 HAR；禁止默认盖 `flutter.har`；默认 release + 清 ohpm 缓存）。
> **Do NOT load** references/ 当用户只是要"问 Demo 是什么"或"评估该不该写 demo" — 直接基于 §1 触发清单回答。

一个 Flutter OHOS Demo 工程承担七件事：

1. **问题复现**：demo 必须能稳定复现所描述的问题场景（bug 行为 / 修复前差异 / 平台行为差异），这是 demo 的首要职责——不能复现的 demo 没有价值
2. **真机演示**：跑在 OHOS/Android/iOS 设备，让 reviewer 直观看到 framework 级行为的正确表现 / 修复前/后差异
3. **自动化操作脚本**：每个 scenario 必须有对应的 uitest 自动化脚本，能一键复现场景并截图/dump 证据，reviewer 无需手动操作
4. **三平台可编译**：包含完整的 ohos/android/ios 原生工程，`flutter build hap/apk/ios` 能编译通过，`flutter run` 能在设备上启动
5. **真机/模拟器运行验证（MANDATORY）**：编译出包后必须在真机或模拟器上实际运行，确认 app 能正常启动、首页能渲染、scenario 可操作。**有真机连接时优先在真机上运行**；无真机时使用模拟器。不能仅编译通过就交付——编译通过 ≠ 能跑起来。
6. **复现效果验证与持续迭代（MANDATORY）**：app 运行起来后，必须逐个 scenario 验证**实际效果是否符合复现预期**（bug 行为是否出现 / 计数是否正确 / 异常是否触发）。如果不符合预期，必须分析原因并迭代修改代码，重新编译→运行→验证，直到每个 scenario 的实际效果都与预期一致才能交付。**跑起来 ≠ 复现成功**。
7. **跨平台对照验证（MANDATORY）**：OHOS 独有 bug 必须在 Android 和/或 iOS 上运行同样 scenario，验证 bug **不复现**，形成"OHOS 有 bug / Android·iOS 正常"的对照证据。**能复现 ≠ 一定是 OHOS 独有问题**——如果 demo 代码自身有错误，三平台都会出现异常行为。

这个 SKILL 总结的是**实战血泪经验**——不是为了教你写 demo，而是帮你避免下面 §6 列出的每个浪费 1 小时+的坑。

---

## 0. 快速启动决策树

```
OHOS Flutter 回归 demo → 本 Skill
├── 场景数 < 5 → 单 main.dart 多场景
├── 场景数 ≥ 5 → HomePage + Navigator.push（读 references/scenario-template.md）
├── 需 testWidgets（可选）→ 读 references/test-helpers.md
└── uitest 脚本（MANDATORY）→ 读 references/uitest-snippets.md
```

---

## 1. 何时使用 / 不使用

### ✅ 触发
- 用户要"写个 Flutter Demo 验证 XXX"（特别是 OHOS 行为、framework 级问题、MethodChannel、平台手势等）
- 用户要"给某个 flutter issue 写一个最小复现 / 修复后回归 Demo"
- 用户要"用 Flutter test 集成测试覆盖 XX 场景"
- 用户同时提到 **uitest + flutter test** 双覆盖
- 现有 demo 文件超过 ~500 行、需要按场景拆分页面

---

## 2. Before doing anything, ask yourself

这五个问题决定整个 demo 的形态。先问，再写代码：

1. **这是 framework bug 还是 demo-only 行为？**
   - **Framework bug**（如 Issue #2322 状态栏点击）：测试必须写到 `packages/flutter/test/<category>/<widget>_test.dart`，demo 只是为了 reviewer 在设备上肉眼验证
   - **Demo-only 行为**（如自定义组件、新交互 demo）：测试写到 `test/scenario_<id>_test.dart` 即可，不必动 framework 源码

2. **场景数 < 5 还是 ≥ 5？**
   - **< 5**：直接一个 `main.dart` 多场景，不需要 HomePage
   - **≥ 5**：必须 HomePage + Navigator.push 模式（见 `references/scenario-template.md` §A）

3. **demo 会被 reviewer 在设备上跑吗？**
   - **是**（常见）：每个 scenario 必须有**操作按钮**或显式 `_simulate<X>()` 函数触发 reviewer 不需要找系统手势
   - **否**（纯 CI）：可以依赖 system gesture / scroll-to-top 等自动行为

4. **这个 scenario 能稳定复现所描述的问题吗？**
   - **能复现**：写完后必须在设备上跑一遍 uitest 脚本验证“问题行为确实出现”，否则 scenario 无价值
   - **不能复现**：先调查根因（可能是触发条件不对 / 时机不对 / 缺少前置状态），调整代码直到能复现，再交付

5. **如果是给 Issue 写 demo，是否覆盖了 Issue 中提到的所有场景？**
   - **给定 Issue 时**：必须先通读 Issue 全文（标题 + 描述 + 评论 + 附图），提取出所有场景/现象/复现步骤，每个场景对应一个 scenario，不能遗漏
   - **覆盖检查**：写完后逐条对照 Issue 场景清单，确认每个场景都有对应的 scenario 页面 + uitest 脚本 + 复现验证
   - **部分覆盖**：如果某个场景暂时无法复现，必须在 README 中明确标注“未覆盖场景 + 原因 + 后续计划”，不能默默省略

6. **这个 bug 是 OHOS 独有的吗？是否需要跨平台对照验证？**
   - **OHOS 独有 bug**（根因在 `if (defaultTargetPlatform == TargetPlatform.ohos)` 分支内，或涉及 OHOS 独有的 MethodChannel / 平台组件）：**必须**在 Android 和/或 iOS 上运行同样 scenario，验证 bug **不复现**（详见 §3.6）
   - **跨平台 bug**（三平台都有相同行为）：不需要跨平台对照验证，但需在 README 中说明
   - **不确定**：先按 OHOS 独有 bug 处理，做跨平台对照验证，如果 Android/iOS 上也复现则说明是 demo 代码错误或跨平台 bug

**If 1 = framework bug AND 3 = reviewer runs on device AND 4 = 能复现 AND 5 = Issue 场景全覆盖 AND 6 = OHOS 独有 bug** → 这是最常见的场景，本 SKILL 主要为此设计。

---

## 3. 工程结构（三平台完整版）

每个 Demo **必须**包含 ohos/android/ios 三个原生工程，且都能编译运行：

```
flutter_demos/<topic>_demo/
├── lib/main.dart                  # 单文件入口，含所有 scenario
├── pubspec.yaml                   # 标准 flutter pubspec，无三方依赖
├── ohos/                          # OHOS 原生工程（HarmonyOS）
│   ├── AppScope/app.json5         # bundleName、版本
│   ├── build-profile.json5        # 签名配置、SDK 版本
│   ├── entry/                     # ArkTS 入口、module.json5
│   └── hvigorfile.ts
├── android/                       # Android 原生工程
│   ├── app/build.gradle.kts       # compileSdk、minSdk
│   ├── build.gradle.kts
│   └── settings.gradle.kts
├── ios/                           # iOS 原生工程
│   ├── Runner.xcodeproj
│   ├── Runner/Info.plist
│   └── Podfile
├── test/widget_test.dart          # demo 结构测试
├── assets/images/                 # 测试图片资源（如需要）
└── README.md                      # 场景列表 + 启动命令 + 签名说明
```

详细模板（HomePage 路由、pubspec 字段、scenario Dart 模板、MethodChannel 三种用法、占位符替换清单）→ [`references/scenario-template.md`](references/scenario-template.md)

### 3.1 三平台工程生成（MANDATORY）

**必须使用 OHOS 版本 flutter SDK**（Community flutter 不支持 ohos 平台，详见 §6.11）：

```bash
# 生成三平台工程（在已有 lib/ 的目录中补充平台工程）
<ohos_flutter>/bin/flutter create --platforms=ohos,android,ios \
  --project-name <topic>_demo .

# 验证三平台目录都已生成（MANDATORY，flutter create 有时静默跳过失败平台）
ls ohos/ android/ ios/  # 三个目录都必须存在
```

### 3.2 OHOS 签名配置（MANDATORY，否则 hap 无法构建）

OHOS 应用必须签名才能构建 hap 包。调试签名绑定 bundleName，配置不当会导致构建或安装失败。

**核心思维框架**（配置签名前 ask yourself）：
- **签名从哪来？** 直接从 [`references/signing.conf.example`](references/signing.conf.example) 复制，无需手动查找或生成。
- **bundleName 对得上吗？** 调试签名的 p7b 中绑定了 bundle-name，必须与应用的 bundleName 完全一致，否则构建报错。
- **证书过期了吗？** 调试证书有效期通常 1 年，过期证书会导致 `The certificate has expired` 错误。`signing.conf.example` 中的签名有效期至 2027-07-23。

**签名配置三步完成**（详细命令与决策树见 [`references/scenario-template.md`](references/scenario-template.md) §E.2）：
1. 复制 `references/signing.conf.example` 到 `ohos/signing.conf`
2. 用 python3 脚本将签名写入 `ohos/build-profile.json5`
3. 将应用 bundleName 改为与签名一致（`com.example.flutterproject`）

**关键约束**：签名材料的 bundleName 必须与 `AppScope/app.json5` 的 `bundleName` 一致。`signing.conf.example` 对应 `com.example.flutterproject`；自定义 bundleName 需在 DevEco Studio 重新生成签名。

### 3.3 编译验证（MANDATORY，写完代码必须验证）

| 步骤 | 命令 | 成功标志 |
|------|------|----------|
| 1. Dart 代码验证 | `<ohos_flutter>/bin/flutter analyze --no-fatal-infos` | 0 error |
| 2. 格式化 | `<ohos_flutter>/bin/dart format lib/main.dart` | 无变更 |
| 3. widget 测试 | `<ohos_flutter>/bin/flutter test test/widget_test.dart --timeout 120s` | All tests passed |
| 4. OHOS hap | `<ohos_flutter>/bin/flutter build hap` | `build/ohos/hap/entry-default-signed.hap` |
| 5. Android apk | `timeout 600 <ohos_flutter>/bin/flutter build apk --debug` | `build/app/outputs/flutter-apk/app-debug.apk` |
| 6. iOS（仅 macOS） | `<ohos_flutter>/bin/flutter build ios --debug --no-codesign` | `build/ios/iphoneos/Runner.app` |

> 步骤 4-6 需在 §3.2 签名配置完成后进行；步骤 5 首次 Gradle 编译可能 10+ 分钟，**必须设 timeout**。

**Don't over-engineer**：
- **NEVER** 引入 Bloc / Provider / Riverpod / GetX 等状态管理 — demo 越简单越好，reviewer 看到一堆框架会怀疑 bug 是 demo 自身引入的
- **NEVER** 拆多个文件 + 复杂 import — 单文件 3000 行是 OK 的
- **NEVER** 加第三方依赖 — `flutter create` 默认就够

### 3.4 设备运行验证（MANDATORY — 编译通过后必须在设备上跑起来）

§3.3 的编译验证只确认"能出包"，但 **编译通过 ≠ 能跑起来**。编译后必须在真机或模拟器上实际运行，确认 app 能正常启动、首页能渲染、scenario 可操作。

**设备选择优先级**：真机 > 模拟器 > 仅编译（最后手段）

**Android 对照**：没有安卓真机时必须启动 AVD 模拟器跑同样 scenario，不能因为 `adb devices` 为空就跳过。命令见 [`references/device-emulator-setup.md`](references/device-emulator-setup.md)。

**核心约束**（详细命令和检查清单 → [`references/device-emulator-setup.md`](references/device-emulator-setup.md)）：
- 三平台都要检查设备：`hdc list targets`（OHOS）/ `adb devices -l`（Android）/ `xcrun simctl list devices`（iOS）
- 有真机时优先真机（暴露真实性能/触摸/传感器问题），无真机时用模拟器
- 运行验证检查清单：app 启动无 crash → 首页渲染 → scenario 可操作 → 控制台无未捕获异常

**运行验证失败时的处理**：
- app crash → 检查 `main()` 初始化错误
- 页面空白 → 检查 `MaterialApp` 配置
- scenario 操作无响应 → 检查按钮 `onPressed` 绑定

#### 3.4.1 设备/模拟器自动启动（MANDATORY — 无设备时不能直接跳过）

检查到三平台任意一个**没有可用设备**时，**必须先尝试启动对应模拟器**，不能直接跳过该平台。这是 §3.4 设备运行验证和 §3.6 跨平台对照验证的前置条件。

**启动流程与详细命令** → **MANDATORY 读 [`references/device-emulator-setup.md`](references/device-emulator-setup.md)**

**关键约束**（即使不读 references 也必须遵守）：
- **没有安卓真机 = 必须起 Android 模拟器**，禁止把「无安卓真机」写成已跳过对照
- Windows 上用 `Start-Process emulator.exe ...` 后台启动；不要用 `nohup` / `& disown`（本机是 PowerShell，子进程会被一起杀掉）
- Linux/macOS 才用 `nohup emulator ... & disown`
- 启动后**必须验证 `sys.boot_completed=1`**（Android）或设备出现在 `booted` 列表（iOS），不能假设启动已完成
- 首次冷启动可能需要 60–90 秒，增量启动约 15-20 秒，等待时间不够会导致 `flutter run` 找不到设备
- OHOS 模拟器只能通过 DevEco Studio 启动，无法命令行直接启动 → 无 OHOS 真机时在 README 标注原因；这不能当作跳过 Android 对照的理由

### 3.5 复现效果验证与持续迭代（MANDATORY — 跑起来 ≠ 复现成功）

§3.4 确认了"app 能跑起来"，但 **跑起来 ≠ 复现成功**。必须在设备上逐个 scenario 验证实际效果是否符合复现预期，不符合则持续迭代直到符合。

> **验证前 MANDATORY 读 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md)** — 解决"只看 crash 不看数据、只看计数不看黄金标志、描述与行为不同步、跨平台验证不完整、API 级别差异忽略"等验证深度不够问题。该 checklist 包含字段级预期表、黄金标志定义、迭代决策树、交付前最终检查清单。

**验证流程**：每个 scenario → 执行操作 → 观察效果 → 对照预期 → 通过则继续 / 不通过则迭代

**迭代循环（不通过时）**：分析原因 → 修改代码 → 重新编译→运行→验证 → 重复直到一致

**不符合预期的常见原因**（按优先级排查）：
1. **触发时机不对**：delay 太短 / 动画未完成就点击
2. **前置状态不对**：缺少 rebuild / 缺少 setState
3. **模拟方式不对**：MethodChannel 消息格式错误 / 事件参数不匹配
4. **观测点不对**：找错了 controller / 计数逻辑有误
5. **framework 已修复**：需确认 SDK 版本是否包含修复

**每个 scenario 的预期效果检查清单**（需在代码注释 / README 中明确定义）：

| Scenario | 预期效果（bug 存在时） | 验证方法 | 证据要求 |
|----------|----------------------|----------|---------|
| <场景名> | <bug 行为描述：如计数异常 / 异常触发 / UI 状态错误> | <截图 / 日志 / 计数文本> | before+after 截图 + hilog/logcat + UI dump |
| <基线场景> | 正常行为（无 bug） | <同上> | <同上> |

> 每个 scenario 必须在 README 中定义自己的预期效果，不能套用其他 demo 的表格。

**证据采集要求（MANDATORY）**：每次验证必须采集**截图 + 日志 + UI dump 三件套**，并将证据文件路径写入 README 验证记录。没有证据 = 没有验证——口头说"我验证过了"不算数，reviewer 必须能独立复核。详细命令、命名规范、归档模板见 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §I。

**迭代终止条件**：所有 scenario 的实际效果都与预期一致（bug 场景能看到 bug 行为，基线场景能看到正常行为），且每个 scenario 都有完整的证据三件套归档。如果某个 scenario 始终无法复现，必须在 README 中明确标注"未复现 + 已尝试的方法 + 可能原因 + 采集到的证据"，不能默默跳过。

### 3.6 跨平台对照验证（MANDATORY — OHOS 独有 bug 必须在 Android/iOS 上验证"不复现"）

§3.5 确认了"OHOS 上 bug 能复现"，但 **能复现 ≠ 一定是 OHOS 独有 bug**。如果 demo 代码本身有逻辑错误，Android/iOS 上也会出现同样的异常行为，reviewer 会怀疑 bug 是 demo 自身引入的而非 framework 问题。因此必须在 Android 和/或 iOS 上运行同样的 scenario，验证 bug **不复现**，形成跨平台对照证据。

**为什么要跨平台对照验证**：

| 场景 | OHOS 上 | Android/iOS 上 | 结论 |
|------|---------|----------------|------|
| OHOS 独有 bug | bug 行为出现 | 正常行为（bug 不复现） | ✅ 确认是 OHOS 平台独有问题 |
| demo 代码错误 | bug 行为出现 | bug 行为也出现 | ❌ 是 demo 自身 bug，不是 framework 问题 |
| 跨平台 bug | bug 行为出现 | bug 行为也出现 | ⚠️ 需重新评估 issue 范围 |

**验证要求**：

1. **识别 OHOS 独有 bug**：如果 bug 根因在 `if (defaultTargetPlatform == TargetPlatform.ohos)` 分支内，或涉及 OHOS 独有的 MethodChannel / 平台组件，则属于 OHOS 独有 bug，**必须**进行跨平台对照验证
2. **至少在一个非 OHOS 平台上运行**：优先 Android。有安卓真机用真机；没有真机必须启动 Android 模拟器后再跑同样 scenario。Windows 上没有 iOS 模拟器时，Android 对照仍必须做。
3. **验证 bug 不复现**：在 Android/iOS 上，bug 场景应显示正常行为（如计数 = 1、无异常、后台不响应），基线场景也正常
4. **README 中记录跨平台预期差异**：在场景覆盖矩阵中明确标注每个 scenario 在三平台上的预期行为差异

**验证方法**：

跨平台对照验证有两种方法，**优先使用方法 B（integration test）**，因为能自动断言而非靠肉眼观察：

| 方法 | 适用场景 | 命令 | 优点 |
|------|----------|------|------|
| **A：手动运行** | 需肉眼观察颜色/布局等视觉差异 | `flutter run -d <device_id>` | 简单，无需额外代码 |
| **B：integration test**（推荐） | 能用 `expect()` 断言结果的场景 | `flutter drive --driver=... --target=... -d <device_id>` | 自动断言，可重复执行 |

> 方法 B 的完整工程结构、条件导入模式、测试模板 → **MANDATORY 读 [`references/cross-platform-integration-test.md`](references/cross-platform-integration-test.md)**

**条件导入模式（跨平台编译必备）**：

Demo 代码中如果用了 `Platform.isOhos` 或 `OhosView`（OHOS Flutter SDK 扩展），在标准 Flutter SDK（Android/iOS）中编译会报 `No static getter 'isOhos'` 或 `Undefined name 'OhosView'`。**必须**用条件导入模式（三文件：`ohos_view_builder.dart` 入口 + `ohos_view_builder_ohos.dart` OHOS 实现 + `ohos_view_builder_stub.dart` 占位实现）解决。

完整代码模板和原理 → **MANDATORY 读 [`references/cross-platform-integration-test.md`](references/cross-platform-integration-test.md) §B**

**跨平台预期差异表**（需在 README 中明确记录）：

| Scenario | OHOS 预期 (bug 存在) | Android/iOS 预期 (bug 不复现) | 对照结论 |
|----------|---------------------|-------------------------------|----------|
| <场景名> | <bug 行为> | <正常行为> | OHOS 独有 bug ✅ |
| <基线场景> | 正常行为 | 正常行为 | 三平台一致（基线） |

> 每个 scenario 必须在 README 中定义自己的跨平台预期差异，不能套用其他 demo 的表格。

**验证失败时的处理**：
- 如果 Android/iOS 上 bug 也复现 → 说明可能是 demo 代码自身的问题（而非 framework OHOS 独有 bug），需要排查 demo 逻辑
- 如果 Android/iOS 上 app 无法启动 → 检查平台特定配置（如 Android 权限、iOS Info.plist），修复后重新运行
- 如果没有安卓真机 → **先按 [`references/device-emulator-setup.md`](references/device-emulator-setup.md) 启动 AVD**，启动成功则必须完成对照；只有 SDK/AVD 不存在或启动失败，才允许在 README 标注「跨平台对照验证未执行 + 原因」，不能因为没真机就直接跳过

---

## 4. uitest 自动化脚本（MANDATORY — 每个 scenario 必须有）

每个 scenario **必须**配套一个 uitest 脚本，用于一键复现场景并采集证据（截图 + dump）。这是 demo 的核心交付物之一，不是可选项。

**uitest 脚本职责**：
- 自动进入目标 scenario 页面
- 模拟用户操作（点击按钮 / 滑动 / 触发平台手势）
- 等待动画/路由完成（`delay(2000)` 起步）
- 截图 + dump widget tree 作为证据

**脚本命名与位置**：
```
ohos/<module>/src/ohosTest/ets/test/
├── scenario_<id>_test.ets       # 每个 scenario 一个脚本
└── run_all.ets                  # 批量跑所有 scenario
```

最小脚本、常用 driver API、uitest 三个高频坑 → [`references/uitest-snippets.md`](references/uitest-snippets.md)

**Don't use uitest only when**：
- 测 framework 行为精确断言 → 用 `testWidgets` 更准（但 uitest 仍需写，用于设备证据采集）

---

## 5. Flutter testWidgets（可选 — 仅 framework bug 场景）

### 5.1 测试文件位置

| 测什么 | 写到哪 | 为什么 |
|--------|--------|--------|
| **Framework bug**（改了 `packages/flutter/lib/`） | `packages/flutter/test/<category>/<widget>_test.dart` | 必须能跑在 framework 测试套件里 |
| **Demo-only 行为**（没改 framework） | `test/scenario_<id>_test.dart` | 跑在 demo 项目自己的测试套件 |

### 5.2 必读 references（仅当需要写 testWidgets 时）

写第一个 `testWidgets` 前 **MANDATORY** 读 [`references/test-helpers.md`](references/test-helpers.md)：
- 三件套 helper 模板（`build<X>TestApp` / `simulate<X>` / `buildStackWith<X>`）
- 命名规范（`OHOS Regression:` prefix）
- 一次跑 vs 单独跑 trade-off
- 三个高频反模式代码

### 5.3 通用 pattern：环境隔离（任何 widget 测试都成立）

| 测的对象 | 必须做 | 反例 |
|---------|--------|------|
| StatefulWidget + animation | `await tester.pumpAndSettle()` 后再断言 | `tester.pump()` 单帧 + 立刻断言 |
| 依赖平台特定 behavior | `debugDefaultTargetPlatformOverride` + `addTearDown` reset | 只 set 不 reset（污染后续测试） |
| 依赖滚动 controller | `tester.fling` / `tester.drag` | `ScrollController.jumpTo(...)`（不触发 listener） |

---

## 6. NEVER 列表（这些坑每个都浪费过 1 小时以上）

### 6.1 文件操作

- **NEVER** `git checkout <modified_test_file>` — 立刻丢失所有未提交修改。**Why**：git checkout 默认从 HEAD 覆盖工作区，VS Code 自动保存的也不算数。**Use**：`git stash push <file>` 然后再 checkout，或 `git diff > /tmp/patch.txt` 先保存。
- **NEVER** 用 `git rebase -i HEAD~5` 整理还没确认能编译通过的测试代码 — rebase 冲突 + framework 编译重做 = 30 分钟起跳。**Use**：先本地跑通 `--plain-name "<prefix>:"` 一次跑完，再 rebase。

### 6.2 Flutter 测试代码（通用）

- **NEVER** 在 `testWidgets` 中忘 `addTearDown(() => debugDefaultTargetPlatformOverride = null)` — 污染后续测试的 targetPlatform，间歇性出现"listener not registered"等不可解释错误。**Use**：配对使用（set + addTearDown reset）。
- **NEVER** 测试名靠手写 — `No tests match "<typo>"` 是常见坑。**Use**：先 `grep -nE "^    testWidgets" <test_file>` 把名字复制出来。
- **NEVER** 在动画未完成时断言 — `tester.pump()` 只 pump 一帧，动画、路由切换、滚动可能进行到一半。**Use**：必须 `tester.pumpAndSettle()` 或显式 `await tester.pump(Duration(...))`。
- **NEVER** 用 `controller.jumpTo(...)` 在 testWidgets 里驱动滚动 — 不会触发 fling/scroll listener 等真实副作用。**Use**：`tester.fling(find.byType(ListView), Offset(0, -300), 1000)` 或 `tester.drag(...)`。

### 6.3 运行 / 编译

- **NEVER** 默认 `--timeout 30s` 跑含 `tester.pumpAndSettle()` 的测试 — 嵌套动画常常超出 30s。**Use**：`--timeout 120s` 起步。
- **NEVER** 用 `grep | head` pipeline 截 flutter test 输出 — flutter test 输出有 buffer，`head` 会让 grep 等满 buffer 才输出，看起来像"卡 9 分钟不动"。**Use**：要么去掉 head 跑全部并 `tee /tmp/run.log`，要么用 `--reporter=expanded` 减少行长度。
- **NEVER** 把每个测试单独跑一遍（浪费 1 分钟 × N 编译） — framework 测试首次冷编译 12 分钟，增量编译每测试 1 分钟，单独跑 N 个 = (12 + 1×N) 分钟 vs 一次跑 = (12 + 0.5N) 分钟。**Use**：给同一批测试加共同 prefix（如 `"OHOS Regression:"`），一次 `--plain-name` 跑完。
- **NEVER** 在没设置 timeout 的 bash 命令里跑 `flutter test` — pipeline hang 时无法 kill。**Use**：加 `timeout 600` 包裹。

### 6.4 Demo 真机运行

- **NEVER** `flutter run` 不加 `--verbose` 且不 tee 到日志 — OHOS 启动日志 50% 在 verbose 里，丢掉等于盲调。**Use**：`flutter run -d <device_id> --verbose 2>&1 | tee /tmp/demo.log &`。
- **NEVER** uitest 截图前不 `await driver.delay(2000)` — 路由切换 / 弹窗动画未完成，截图和预期不符。**Use**：固定每次操作后 `delay(2000)`。
- **NEVER** demo 里用 `print()` 替代 `debugPrint` — release 模式 `print` 被移除，导致 reviewer 在 release HAP 里看不到任何日志。**Use**：一律 `debugPrint('[Demo] Scenario X: ...')`。

### 6.5 Demo 设计（架构反模式）

- **NEVER** 引入 Bloc / Provider / Riverpod / GetX / Redux — reviewer 看到一堆状态管理框架会怀疑 bug 是 demo 自身引入的，且 80% 的 framework bug 不需要这些。**Use**：`setState` + `StatefulWidget` + `ValueNotifier` 就够。
- **NEVER** 给 demo 加第三方依赖（动画库、网络库、UI 库） — 编译时间 ×3，且第三方版本可能引入新 bug 让 demo 看起来"不稳定"。**Use**：`flutter create` 默认就够。
- **NEVER** 用 Material 3 复杂主题（如 `ColorScheme.fromSeed` + 12 个自定义 token） — reviewer 注意力被花哨主题分散，关注不到 bug 本身。**Use**：默认 `ThemeData()`，最多改 `primaryColor`。

### 6.6 复现验证（demo 核心职责）

- **NEVER** 写完 scenario 不在设备上验证就交付 — "代码看起来对"不等于"问题能复现"。**Why**：很多 bug 需要特定时机 / 前置状态 / 平台手势才能触发，纯看代码无法确认。**Use**：每个 scenario 必须跑一遍 uitest 脚本，确认问题行为（crash / 错误 UI / 内存增长）确实出现。
- **NEVER** scenario 不能复现问题时归因为"framework 已修复"而不验证 — 可能是触发条件不对。**Use**：先用预编译 Engine（修改前）跑一遍确认能复现，再切到本地修改后 Engine 验证修复效果。
- **NEVER** scenario 描述与实际行为不符 — reviewer 按 scenario 描述操作却看不到描述的现象，会怀疑 demo 整体可信度。**Use**：scenario 页面的文字描述必须与 uitest 脚本实际触发的行为一致，描述更新时代码也要同步更新。

### 6.7 Issue 场景覆盖（给定 Issue 时）

- **NEVER** 给定 Issue 只复现其中一个场景就交付 — Issue 通常包含多个现象/复现步骤，只覆盖一个会让 reviewer 误以为"其他场景已没问题"。**Why**：未覆盖的场景可能仍存在 bug，demo 给出虚假的"已验证"信号。**Use**：通读 Issue 全文（标题 + 描述 + 评论 + 附图），提取所有场景清单，每个场景一个 scenario。
- **NEVER** 默默省略无法复现的场景 — reviewer 看不到"哪些覆盖了、哪些没覆盖"，无法判断 demo 完整性。**Use**：在 README 中明确列出"场景覆盖矩阵"（场景 → scenario ID → 复现状态 → 未覆盖原因），未覆盖的场景也要标注。
- **NEVER** Issue 评论中的补充场景不纳入 — Issue 讨论中经常出现新的复现步骤/边界条件，只看标题描述会遗漏。**Use**：必须读完全部评论，评论中提到的每个新现象都纳入场景清单。

### 6.8 设备运行验证

> 核心要求（编译通过 ≠ 能跑起来、有真机优先真机、启动后必进 scenario）见 §3.4。以下仅列 §3.4 未强调的专家级反模式。

- **NEVER** 没有安卓真机就跳过 Android 对照 — 没真机必须起 AVD。**Use**：按 [`references/device-emulator-setup.md`](references/device-emulator-setup.md) 启动模拟器，等 `boot_completed=1` 再跑同样 scenario。
- **NEVER** 在 Windows 上用 `nohup emulator ... & disown` — PowerShell 下模拟器常被一起杀掉。**Use**：`Start-Process emulator.exe -ArgumentList '-avd',<name>,...`。Linux/macOS 才用 nohup+disown。
- **NEVER** 启动模拟器后不验证 boot_completed 就直接 `flutter run` — 模拟器可能还在启动中，`flutter run` 会报 "No devices found"。**Use**：等待 `adb shell getprop sys.boot_completed` 返回 `1`（Android）或 `xcrun simctl list devices booted` 列出设备（iOS）后再运行。

### 6.9 复现效果验证与迭代

> 核心要求（跑起来 ≠ 复现成功、迭代循环、未复现需标注）见 §3.5。以下仅列 §3.5 未强调的专家级反模式。

- **NEVER** 验证复现效果时只看"有没有 crash" — 有些 bug 表现为错误 UI 状态（如计数不对 / 后台响应 / 状态泄漏），不 crash 但行为错误。**Use**：对照 §3.5 检查清单，验证每个 scenario 的具体预期效果（计数 / 日志 / UI 状态 / 异常）。
- **NEVER** 只看"有响应"不看"黄金标志" — "两个 View 都收到 touch"不能确认 PV-04 复现，必须验证 `LOWER=2` 这个唯一判据。**Use**：在 README 中定义每个 scenario 的黄金标志（唯一能确认 bug 复现的关键判据），验证时对照黄金标志。
- **NEVER** 只验证部分字段 — PV-03 鼠标注入只看 `mouse=1` 不够，必须逐字段对比 local/window/display/screen 四组值。**Use**：字段级预期表（见 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §B）。
- **NEVER** 代码修改后不更新 README 描述 — 代码改了但 README 仍写旧预期，reviewer 按描述操作发现不符会怀疑 demo 可信度。**Use**：每次修改代码后同步更新 README 字段级预期表 + scenario 页面文字描述。
- **NEVER** 跨平台验证只覆盖部分 scenario — iOS 端只有 PV-03 没有 PV-04，用户问"iOS 上怎么验证 PV-04"时才发现。**Use**：每个 scenario 都要在三平台上有对应实现和验证方式（见 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §D）。
- **NEVER** 忽略 API 级别差异 — OHOS API 20-23 和 API 24+ 走不同代码路径，同一 scenario 在不同 API 级别上表现可能不同。**Use**：在 README 中标注 API 级别差异表，即使只在一个 API 级别上验证也要标注"未覆盖其他 API 级别 + 原因"（见 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §E）。
- **NEVER** 迭代 3 次仍不匹配就默默跳过 — 必须标注"未复现 + 已尝试方法 + 可能原因"，不能让 reviewer 误以为已验证。**Use**：按迭代决策树执行（见 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §G）。
- **NEVER** 验证结论不带证据 — "我验证过了"不算验证，reviewer 无法复核的结论无效。**Use**：每次验证采集截图 + 日志 + UI dump 三件套，证据路径写入 README（见 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §I）。
- **NEVER** 只采集 after 截图不带 before — 没有 before 对比，after 截图无法证明"状态发生了变化"。**Use**：操作前采 before，操作后采 after，两张并排对比。
- **NEVER** 证据文件名随意命名（如 `1.png`、`test.png`） — 半年后回看不知道是哪个 scenario 哪个平台的证据。**Use**：按 `pv<NN>_<platform>_<path>_<phase>.<ext>` 规范命名（见 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §I.2）。
- **NEVER** 跨平台证据格式不一致 — OHOS 用 png、Android 用 jpg、iOS 用 simctl 截图但命名混乱，无法并排对比。**Use**：三平台证据同路径、同命名、同格式，README 对照表引用具体文件路径。

### 6.10 跨平台对照验证

> 核心要求（能复现 ≠ OHOS 独有、需记录预期差异、无设备需标注）见 §3.6。以下仅列 §3.6 未强调的专家级反模式。

- **NEVER** 在 Dart 代码中直接用 `Platform.isOhos` / `OhosView` / `PlatformViewHitTestBehavior` 而不加条件导入保护 — 这些是 OHOS Flutter SDK 扩展，标准 Flutter SDK 中不存在，会导致 Android/iOS integration test 编译报 `No static getter 'isOhos'` 或 `Undefined name 'OhosView'`。**Use**：用条件导入模式（`ohos_view_builder.dart` + `ohos_view_builder_stub.dart` + `ohos_view_builder_ohos.dart`），详见 [`references/cross-platform-integration-test.md`](references/cross-platform-integration-test.md) §B。
- **NEVER** integration test 中用 `find.text()` 查找原生 View 内的文本 — PlatformView 的内容在原生平台层渲染，不在 Flutter widget tree 中，`find.text()` 永远找不到。**Use**：改为验证 Flutter 侧的状态变化（如按钮文字从"显示"变为"隐藏"），或用 `binding.takeScreenshot()` 截图作为视觉证据。
- **NEVER** integration test 中调用 `binding.takeScreenshot()` 不处理异常 — Android 模拟器上 `takeScreenshot` 可能抛 `StateError`（`_IOCallbackManager.takeScreenshot`），导致测试失败。**Use**：如果截图非必要则移除；如果必要则用 try-catch 包裹或仅在 iOS 上调用。

### 6.11 三平台工程生成与编译（平台坑）

- **NEVER** 用 Community flutter 生成 ohos 工程 — `flutter create --platforms=ohos` 会报 "Could not find an option named --enable-ohos" 或 ohos 平台不在可选列表。**Why**：Community flutter 不含 OHOS engine。**Use**：必须用 OHOS flutter SDK（`flutter --version` 输出含 `-ohos-` 后缀）。
- **NEVER** 生成平台工程后不验证目录存在 — `flutter create` 有时静默跳过失败平台。**Use**：生成后立即 `ls ohos/ android/ ios/` 确认三个目录都存在。
- **NEVER** 忘记配置 OHOS 签名就跑 `flutter build hap` — 会报 "请通过DevEco Studio配置调试签名"，浪费 5 分钟等编译才发现。**Use**：写代码前先按 §3.2 三步配置签名，或 README 中明确说明签名步骤。
- **NEVER** 签名 bundleName 与 app.json5 bundleName 不匹配 — hap 安装时报 "signature verification failed"。**Use**：按 §3.2 步骤 3 确保 bundleName 匹配（`com.example.flutterproject`）；自定义 bundleName 需在 DevEco Studio 重新生成签名。
- **NEVER** 忽略证书有效期 — 过期证书会导致 `The certificate has expired` 错误。**Use**：`signing.conf.example` 中的签名有效期至 2027-07-23，过期后需更新。
- **NEVER** 手动生成签名证书 — 直接从 `references/signing.conf.example` 复制即可。
- **NEVER** 只验证 OHOS hap 编译而忽略 android/ios — reviewer 可能在 Android/iOS 设备上跑 demo 验证对照。**Use**：三平台 `flutter build` 都要跑一遍（§3.3）。
- **NEVER** 在 `const Text` 中写含 `$(...)` 的 shell 命令字符串 — Dart 会把 `$(` 当作字符串插值，报 `missing_identifier` error。**Use**：用 `\$` 转义，或去掉 `const` 改用 `Text(..., style: const TextStyle(...))`。
- **NEVER** `flutter build apk` 不设 timeout — 首次 Gradle 编译可能 10+ 分钟，终端可能 hang。**Use**：`timeout 600 <ohos_flutter>/bin/flutter build apk --debug`。
- **NEVER** 修 `flutter_embedding` / embedding ArkTS 后，不读 Demo 的 `oh-package.json5` 和 `ohos/oh_modules/.ohpm/lock.json5` 就盖 `flutter.har` — 工具链同时有 `flutter.har`（`ohos_builder` / `Artifact.flutterEngineHar`）和 `flutter_embedding_${mode}.har`（`hvigor.dart` 拷贝，官方 `@ohos/flutter_ohos` 消费名）。盖错文件时黄金标志仍在，像修复没生效。**Use**：先对齐 `repo/` 与编 hap 用的 SDK（同一套 so + HAR）；再看 `@ohos/flutter_ohos` 指向哪个文件，换那个。`flutter build hap` 默认吃 **release** HAR；换完删 `ohos/oh_modules` **并清 `~/.ohpm/cache`**。黄金标志跟 Issue 正文验收，不跟本机碰巧更重的症状。详见 [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §J。
- **NEVER** 用本机另一套 Flutter SDK 的 HAR / `libflutter.so` 给 `repo/` 补丁背书，或改用户日常 SDK 缓存来凑真机。**Use**：读 `outputs/ohos-flutter-sdk.json`，`matched=true` 用 `flutterBin`；`matched=false` 不要退回日常 SDK。对不上则 `conditional_pass` + `needs_runtime_validation`，禁止 `issue_resolved=yes` / `bug_fixed=true`。

---

## 7. 端到端工作流（步骤速查表）

> 每步的详细命令、检查清单、错误处理见对应章节，此处仅列步骤顺序与 MANDATORY 产出。

| Step | 任务 | 对应章节 | MANDATORY 产出 |
|------|------|----------|----------------|
| 0 | （给定 Issue 时）提取场景清单 | §2 第 5 问 + §6.7 | 场景覆盖矩阵（每个场景一个 scenario） |
| 1-3 | 工程准备（SDK + 脚手架 + 签名） | §3.1 + §3.2 | ohos/android/ios 三平台工程 + 签名配置 |
| 4 | 写 main.dart | [`references/scenario-template.md`](references/scenario-template.md) §A | 1 home + N scenarios（N = Step 0 场景数） |
| 5 | 本地编译验证 | §3.3 步骤 1-3 | `analyze` 0 error + `test` passed |
| 6 | 写 testWidgets（可选，仅 framework bug） | §5 + [`references/test-helpers.md`](references/test-helpers.md) | framework 测试（三件套 helper） |
| 7 | 写 uitest 脚本（每个 scenario 一个） | §4 + [`references/uitest-snippets.md`](references/uitest-snippets.md) | 进入页面 → 模拟操作 → delay(2000) → 截图 + dump |
| 8 | 跑测试（一次跑完，不用 grep \| head） | §3.3 步骤 3 | All tests passed |
| 9 | 三平台编译验证 | §3.3 步骤 4-6 | `build/ohos/hap/entry-default-signed.hap` + `app-debug.apk` + `Runner.app` |
| 10 | 设备运行验证（三平台） | §3.4 + §3.4.1 | OHOS: app 启动 + scenario 可操作；Android/iOS: app 能启动（无设备时先启动模拟器） |
| 11 | 复现效果验证与迭代（OHOS） | §3.5 + [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) | 所有 scenario 字段级预期 = 实际值（含黄金标志）+ 证据三件套（截图+日志+dump）归档，不符则迭代循环 |
| 12 | 跨平台对照验证（Android/iOS） | §3.6 + [`references/cross-platform-integration-test.md`](references/cross-platform-integration-test.md) + [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §D+§I | 每个 scenario 在三平台都有实现 + 验证 + 证据（同路径同命名同格式），OHOS bug / Android·iOS 正常 |
| 13 | （给定 Issue 时）场景覆盖检查 | §6.7 | 覆盖矩阵逐条确认，未覆盖场景在 README 标注 |
| 14 | 交付前最终检查 | [`references/verification-depth-checklist.md`](references/verification-depth-checklist.md) §H+§I | 字段级预期 + 黄金标志 + 三平台 + API 差异 + 描述同步 + 迭代完成 + **证据三件套齐全且路径写入 README** |

---

## 8. 相关 Skill（触发决策表）

| 用户说… | 用这个 Skill | 为什么不是本 Skill |
|---------|-------------|-------------------|
| "我贴了 crash 日志，帮我看看 OHOS 上 Flutter 出啥问题了" | `cpf-ohos-issue-analysis` | 那是问题诊断；本 SKILL 只在**已知 bug + 已知修复**场景下写回归 demo |
| "评估 Android 三方库迁移到 OHOS 的可行性" | `harmonyos-migration-analyzer` | 那是迁移分析；本 SKILL 跟三方库没关系 |
| "帮我跑一下这个 Flutter demo 在 OHOS 上能不能起来" | `flutter-ohos-samples-runner` | 那是已有 demo 批量验证；本 SKILL 是**从零写** demo |
| "给这个 Flutter app 配 OHOS 签名" | 本 Skill §3.2 | 签名配置步骤已融入本 Skill §3.2 + references/scenario-template.md §E.2 |
| "ArkTS Demo / 鸿蒙原生 UI" | `hmos-arkui-develop-skill` | 那是 ArkUI（非 Flutter），不要混用 |
| "在折叠屏 / 平板上验证 demo 适配" | `deveco-studio-verify` | 那是多设备适配验证；本 SKILL 只做单设备烟测 |

**判别原则**：
- 用户在**"修代码"** → 用对应诊断 Skill（cpf-ohos-issue-analysis 等）
- 用户在**"写新工程"** → 看场景：
  - "批量验证已有 demo" → flutter-ohos-samples-runner
  - "OHOS Flutter 回归 demo / 单文件 / 设备验证" → **本 Skill** ✅