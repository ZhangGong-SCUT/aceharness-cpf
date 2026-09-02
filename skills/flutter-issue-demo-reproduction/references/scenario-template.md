# Scenario 模板参考

> **MANDATORY - READ ENTIRE FILE** before writing the first scenario page in any new demo.
> This is the only authoritative template — copying it is faster than designing from scratch.

---

## A. Scenario Dart 模板（每个场景一份）

```dart
// ===========================================================================
// Scenario <ID>: <简短中文名>  <英文一句>
// OHOS expected: <期望行为一句话>
// regression target: <issue/commit/源码位置>
// ===========================================================================
class Scenario<Id>Page extends StatelessWidget {
  const Scenario<Id>Page({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('<ID>: <中文名>')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    // 1. controller / key（如需要）
    // 2. 构造 widget tree
    // 3. 加 debugPrintBanner 标记
    debugPrint('[Demo] === Scenario <ID>: <name> ===');
    return ...;
  }
}
```

---

## B. 关键约定（4 条，专家经验）

1. **每个 scenario 都用独立的 `Scaffold`**（不要共用）
2. **每个 scenario 在第一次 build 时 `debugPrint` 一次场景名** — `debugPrint` 在 release HAP 也保留，而 `print` 在 release 模式被移除（见 SKILL §6.4）
3. **详情页必须包含"操作按钮"**（"模拟系统手势"/"弹新页面"/"切 tab"），不要依赖纯 reviewer 手动操作
4. **如果依赖平台手势**，写一个 `_simulate<X>()` 函数 + 一个 ElevatedButton 触发 — 比让 reviewer 找系统手势按钮更可靠

---

## C. MethodChannel 三种用法（按场景选）

### C.1 demo 主动发（Dart → 原生）

```dart
const _channel = MethodChannel('<your-domain>/<event-name>');

Future<void> _simulateFromDemo() async {
  await _channel.invokeMethod<void>('tap', {'x': 0.0, 'y': 0.0});
}
```

### C.2 demo 收（原 → Dart）

```dart
@override
void initState() {
  super.initState();
  _channel.setMethodCallHandler((call) async {
    debugPrint('[Demo] received: ${call.method} ${call.arguments}');
    return null;
  });
}
```

### C.3 framework testWidgets 模拟（tester → framework listener）

**仅在测 framework 源码时用**（不是 demo 测试）：

```dart
Future<void> simulate<X>(WidgetTester tester) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.ohos;
  addTearDown(() => debugDefaultTargetPlatformOverride = null);

  const channel = MethodChannel('<your-channel-name>');
  await channel.invokeMethod<void>('<method>', <args>);
  await tester.pump();
}
```

**关键**：`debugDefaultTargetPlatformOverride` 必须配 `addTearDown` reset，否则污染后续测试（见 SKILL §6.2 NEVER 列表第 1 条）。

---

## D. 占位符替换清单

写新场景时需替换的占位符：

| 占位符 | 替换为 | 示例 |
|--------|--------|------|
| `<ID>` | 场景编号 | `A1` / `B2` / `Custom` |
| `<简短中文名>` | 3-8 字 | `背景 Scaffold 不响应状态栏点击` |
| `<英文一句>` | 1 句英文 | `Background Scaffold ignores status bar tap` |
| `<OHOS expected>` | 期望行为 | `前台 Scaffold 滚动到顶，背景 Scaffold 不响应` |
| `<regression target>` | 源码位置 | `flutter/scaffold.dart:2799` 或 issue `#2322` |
| `<your-domain>` | channel 域 | `flutter` / `app` / `<package_name>` |
| `<event-name>` | 事件名 | `statusBarClick` / `backGesture` |

---

## E. 工程脚手架与三平台编译验证（MANDATORY）

每个 Demo **必须**包含 ohos/android/ios 三个原生工程且能编译通过。写完 `main.dart` 后必须执行以下步骤：

### E.1 生成三平台工程

```bash
# 必须用 OHOS flutter SDK（Community flutter 不支持 ohos）
<ohos_flutter>/bin/flutter create --platforms=ohos,android,ios \
  --project-name <topic>_demo .

# 验证三平台目录都已生成（MANDATORY）
ls ohos/ android/ ios/  # 三个都必须存在
```

### E.2 配置 OHOS 签名

`flutter build hap` 必须配置签名，否则报错 "请通过DevEco Studio打开ohos工程后配置调试签名"。

**核心思维框架**（配置签名前 ask yourself）：
- **签名从哪来？** 直接从 [`signing.conf.example`](signing.conf.example) 复制，无需手动查找或生成。
- **bundleName 对得上吗？** 调试签名的 p7b 中绑定了 bundle-name，必须与应用的 bundleName 完全一致，否则构建报错。
- **证书过期了吗？** 调试证书有效期通常 1 年，过期证书会导致 `The certificate has expired` 错误。`signing.conf.example` 中的签名有效期至 2027-07-23。

**签名配置三步完成**：

**步骤 1：复制 signing.conf.example 到应用工程**

```bash
# 从 Skill 目录复制（路径根据实际安装位置调整）
cp <skill_dir>/references/signing.conf.example ohos/signing.conf
```

`signing.conf.example` 已包含可用的调试签名（`com.example.flutterproject`，有效期至 2027-07-23）。

**步骤 2：将签名写入 build-profile.json5**

```bash
python3 -c "
import json
signing = json.load(open('ohos/signing.conf'))
profile = {
  'app': {
    'signingConfigs': signing['signingConfigs'],
    'products': [{
      'name': 'default',
      'signingConfig': 'default',
      'compatibleSdkVersion': signing.get('compatibleSdkVersion', '5.0.0(12)'),
      'runtimeOS': 'HarmonyOS'
    }]
  },
  'modules': [{
    'name': 'entry', 'srcPath': './entry',
    'targets': [{'name': 'default', 'applyToProducts': ['default']}]
  }]
}
with open('ohos/build-profile.json5', 'w') as f:
    json.dump(profile, f, indent=2)
"
```

**步骤 3：将应用 bundleName 改为与签名一致**

```bash
sed -i '' 's/"bundleName": *"[^"]*"/"bundleName": "com.example.flutterproject"/' ohos/AppScope/app.json5
```

**签名 bundleName 匹配**：签名材料的 bundleName 必须与 `AppScope/app.json5` 的 `bundleName` 一致。`signing.conf.example` 对应 `com.example.flutterproject`；如果 demo 需要自定义 bundleName，需要在 DevEco Studio 中重新生成匹配签名。

**常见签名错误决策树**：

| 错误信息 | 根因 | 解决方案 |
|----------|------|----------|
| `The bundleName in app.json does not match...SigningConfigs` | 应用 bundleName 与签名 bundleName 不一致 | 执行步骤 3 改 bundleName |
| `The certificate has expired! NotAfter: ...` | 签名证书过期 | 更新 `signing.conf.example` 中的签名 |
| `请通过DevEco Studio打开ohos工程后配置调试签名` | build-profile.json5 中 signingConfigs 为空 | 执行步骤 2 写入签名配置 |
| 安装失败无明确原因 | hap 签名与设备不兼容或 bundleName 冲突 | 先卸载旧应用，检查签名配置 |

### E.3 三平台编译验证

```bash
# Dart 代码
<ohos_flutter>/bin/flutter analyze --no-fatal-infos  # 0 error
<ohos_flutter>/bin/dart format lib/main.dart

# widget 测试
<ohos_flutter>/bin/flutter test test/widget_test.dart --timeout 120s

# 三平台编译（签名配置后）
timeout 600 <ohos_flutter>/bin/flutter build hap --debug      # OHOS
timeout 600 <ohos_flutter>/bin/flutter build apk --debug     # Android
timeout 600 <ohos_flutter>/bin/flutter build ios --debug --no-codesign  # iOS
```

### E.4 常见编译错误速查

| 错误 | 原因 | 修复 |
|------|------|------|
| `Could not find an option named "--enable-ohos"` | 用了 Community flutter | 换 OHOS flutter SDK |
| `请通过DevEco Studio配置调试签名` | OHOS 未配签名 | §E.2 配置签名 |
| `missing_identifier` in `const Text` | `$(` 被当字符串插值 | 用 `\$` 转义或去掉 `const` |
| `signature verification failed` | bundleName 与签名不匹配 | 改 bundleName 或重新生成签名 |
| `No devices connected` | 设备未连接或未授权 | `hdc list devices` / `adb devices` 确认 |