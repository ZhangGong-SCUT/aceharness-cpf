# 跨平台 Integration Test 指南

> **用途**：在 Android/iOS 上自动运行 scenario 并断言"bug 不复现"，形成跨平台对照证据。
> **何时读**：写跨平台 integration test 前 **MANDATORY** 读本文件。
> **前置条件**：已完成 §3.4 设备运行验证（OHOS 上 bug 能复现），现在需要在 Android/iOS 上验证 bug 不复现。

---

## A. 为什么用 integration test 而非手动运行

| 方法 | 优点 | 缺点 |
|------|------|------|
| **方法 A：`flutter run` 手动观察** | 简单，无需额外代码 | 无法精确断言；不可重复；靠肉眼观察易遗漏 |
| **方法 B：`flutter drive` integration test**（推荐） | 自动断言（`expect()`）；可重复执行；CI 可集成 | 需写测试代码；需处理条件导入 |

**优先使用方法 B**，方法 A 仅作为补充（如 FV-03 这种需要肉眼观察颜色的场景）。

---

## B. 条件导入模式（跨平台编译必备）

### 问题

Demo 代码中如果直接用 `Platform.isOhos` 或 `OhosView`（OHOS Flutter SDK 扩展），在标准 Flutter SDK（Android/iOS）中编译会报：

```
No static getter 'isOhos' declared in class 'null'.
Undefined name 'OhosView'.
```

### 解决方案：三文件条件导入

```
lib/
├── ohos_view_builder.dart          # 条件导入入口
├── ohos_view_builder_ohos.dart     # OHOS 平台实现（用真正的 OhosView）
└── ohos_view_builder_stub.dart     # 非 OHOS 平台占位实现
```

#### `lib/ohos_view_builder.dart`（入口 — 条件选择）

```dart
// 根据 dart.library.ohos 是否存在，选择导入 ohos 版本还是 stub 版本
export 'ohos_view_builder_stub.dart'
    if (dart.library.ohos) 'ohos_view_builder_ohos.dart';
```

#### `lib/ohos_view_builder_ohos.dart`（OHOS 实现）

```dart
// OHOS-specific OhosView builder.
// This file is only used when the OHOS Flutter SDK is available.
//
// The following ignores suppress errors when analyzing with standard
// Flutter SDK (non-OHOS). On OHOS, these symbols exist and the file
// compiles correctly.

// ignore_for_file: uri_does_not_exist, undefined_class, undefined_identifier

import 'package:flutter/ohos.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Builds a real OhosView on OHOS.
Widget ohosViewBuilder({
  required String viewType,
  required Map<String, Object> creationParams,
  required MessageCodec<Object?> creationParamsCodec,
}) {
  return OhosView(
    viewType: viewType,
    creationParams: creationParams,
    creationParamsCodec: creationParamsCodec,
    hitTestBehavior: PlatformViewHitTestBehavior.translucent,
  );
}
```

#### `lib/ohos_view_builder_stub.dart`（非 OHOS 占位）

```dart
// Stub for non-OHOS platforms (Android/iOS).
// On OHOS, the real OhosView from the OHOS Flutter SDK is used via
// conditional import (ohos_view_builder_ohos.dart).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Builds a placeholder on Android/iOS (OhosView is not available).
/// This is only called if the code somehow reaches the OHOS branch
/// on a non-OHOS platform, which should not happen in practice.
Widget ohosViewBuilder({
  required String viewType,
  required Map<String, Object> creationParams,
  required MessageCodec<Object?> creationParamsCodec,
}) {
  return ColoredBox(
    color: const Color(0xFFCCCCCC),
    child: Center(
      child: Text('OhosView placeholder\n(viewType: $viewType)'),
    ),
  );
}
```

#### `lib/main.dart` 中的使用

```dart
import 'ohos_view_builder.dart';  // 条件导入入口

class NativeReproView extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final Map<String, Object> creationParams = <String, Object>{'label': label};

    // Android — 用 AndroidView
    if (Platform.isAndroid) {
      return AndroidView(
        viewType: platformViewType,
        creationParams: creationParams,
        creationParamsCodec: const StandardMessageCodec(),
        hitTestBehavior: PlatformViewHitTestBehavior.translucent,
      );
    }

    // iOS — 用 UiKitView
    if (Platform.isIOS) {
      return UiKitView(
        viewType: platformViewType,
        creationParams: creationParams,
        creationParamsCodec: const StandardMessageCodec(),
        hitTestBehavior: PlatformViewHitTestBehavior.translucent,
      );
    }

    // OHOS — 用条件导入的 ohosViewBuilder（在 OHOS 上返回真正的 OhosView）
    return ohosViewBuilder(
      viewType: platformViewType,
      creationParams: creationParams,
      creationParamsCodec: const StandardMessageCodec(),
    );
  }
}
```

### 验证条件导入正确性

```bash
# 标准 Flutter SDK（Android/iOS）能编译
dart analyze --fatal-infos lib/

# OHOS Flutter SDK 也能编译
<ohos_flutter>/bin/dart analyze --fatal-infos lib/
```

两个 SDK 都应返回 `No issues found!`。

---

## C. Integration Test 工程结构

```
flutter_demos/<topic>_demo/
├── integration_test/               # 跨平台 integration test
│   ├── <scenario>_test.dart        # 每个 scenario 一个测试文件
│   └── ...
├── test_driver/
│   └── integration_test.dart       # flutter drive driver（固定内容）
└── pubspec.yaml                    # 需添加 integration_test 依赖
```

### `pubspec.yaml` 添加依赖

```yaml
dev_dependencies:
  flutter_test:
    sdk: flutter
  integration_test:
    sdk: flutter
```

### `test_driver/integration_test.dart`（固定内容）

```dart
import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver();
```

---

## D. Integration Test 模板

### D.1 MethodChannel 错误处理类（如 CC-01）

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:<topic>_demo/main.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('CC-01: Android correctly delivers error message and details', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    // 导航到 scenario 页面
    await tester.tap(find.textContaining('CC-01'));
    await tester.pumpAndSettle();

    // 点击触发按钮
    await tester.tap(find.byKey(const ValueKey<String>('cc01-trigger')));
    await tester.pumpAndSettle();

    // 断言 Android/iOS 上错误信息完整传递（bug 不复现）
    expect(find.textContaining('收到 PlatformException'), findsOneWidget);
    expect(find.textContaining('errorCode: cc01-native-error'), findsOneWidget);
    expect(
      find.textContaining('errorMessage: CC01 native exception'),
      findsOneWidget,
    );
    expect(
      find.textContaining('errorDetails: details-for-'),
      findsOneWidget,
    );
  });
}
```

### D.2 重复回复类（如 EM-01）

```dart
  testWidgets('EM-01: Android throws on double reply', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('EM-01'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey<String>('em01-trigger')));
    await tester.pumpAndSettle();

    // Android 上第二次 result.success() 应抛异常
    expect(find.text('状态：收到第一次回复'), findsOneWidget);
    expect(find.textContaining('第一次回复：em01-first-reply'), findsOneWidget);
  });
```

### D.3 PlatformView 类（如 FV-03）

```dart
  testWidgets('FV-03: no red background leakage on Android/iOS', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('FV-03'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey<String>('fv03-toggle')));
    await tester.pumpAndSettle();

    // 验证 toggle 生效 — 按钮文字变化
    expect(find.text('隐藏原生 View'), findsOneWidget);

    // 注意：不能用 find.text() 查找原生 View 内的文本
    // PlatformView 内容在原生层渲染，不在 Flutter widget tree 中
  });
```

---

## E. 运行 Integration Test

```bash
# Android 模拟器/真机
<ohos_flutter>/bin/flutter drive \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/<scenario>_test.dart \
  -d <android_device_id>

# iOS 模拟器
<ohos_flutter>/bin/flutter drive \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/<scenario>_test.dart \
  -d <ios_simulator_id>
```

成功标志：`All tests passed!`

---

## F. 常见坑与解决方案

### F.1 `find.text()` 找不到原生 View 内的文本

**原因**：PlatformView 的内容在原生平台层渲染（Android 的 TextView / iOS 的 UILabel），不在 Flutter widget tree 中。

**解决**：改为验证 Flutter 侧的状态变化：
- 按钮文字从"显示"变为"隐藏" → `expect(find.text('隐藏原生 View'), findsOneWidget)`
- 状态文本更新 → `expect(find.textContaining('收到'), findsOneWidget)`

### F.2 `takeScreenshot()` 在 Android 模拟器上抛异常

**原因**：`_IOCallbackManager.takeScreenshot` 在某些 Android 模拟器上有 bug。

**解决**：移除 `takeScreenshot()` 调用，或用 try-catch 包裹。截图非必要时不要调用。

### F.3 `Platform.isOhos` 编译报错

**原因**：标准 Flutter SDK 中 `Platform` 类没有 `isOhos` 属性。

**解决**：用 §B 条件导入模式，不在 `main.dart` 中直接引用 `Platform.isOhos` / `OhosView`。

### F.4 `find.textContaining()` 匹配多个 widget

**原因**：状态文字和"缺陷判据"文字都包含相同子串。

**解决**：用 `find.text()` 精确匹配，或用更具体的 `find.byKey()`。

### F.5 integration test 超时

**原因**：首次编译可能需要 10+ 分钟。

**解决**：`flutter drive` 默认 timeout 较长，但如果模拟器启动慢可能导致超时。确保模拟器已完全启动后再运行。
