# testWidgets Helper 模板

> **MANDATORY - READ ENTIRE FILE** when writing the FIRST `testWidgets` for any demo.
> After reading, adapt these three helpers — don't design from scratch.

---

## A. 三件套 helper（每个 framework 测试文件必备）

```dart
// 1. 构造测试 app（adapt widget tree 到你的场景）
Widget build<X>TestApp(/* 必要参数：controllers, keys, etc. */) {
  return MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(platformBrightness: Brightness.light),
      child: <构造 widget tree>,
    ),
  );
}

// 2. 模拟平台事件（MethodChannel → framework listener）
Future<void> simulate<X>(WidgetTester tester) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.ohos;
  addTearDown(() => debugDefaultTargetPlatformOverride = null);

  const channel = MethodChannel('<your-channel-name>');
  await channel.invokeMethod<void>('<method>', <args>);
  await tester.pump();
}

// 3. 嵌套 / 复杂场景 helper（可选，按需）
Widget buildStackWith<X>(List<Widget Function()> factories) {
  return Stack(
    children: [for (var i = 0; i < factories.length; i++) factories[i]()],
  );
}
```

---

## B. 命名规范（影响 `--plain-name` 跑法）

```dart
testWidgets('OHOS Regression: A1: <scenario short>', ...)  // framework 侧
testWidgets('Demo: scenario_<id>: <scenario short>', ...)   // demo 侧（test/ 目录）
```

**关键**：前缀必须带冒号 — `--plain-name "OHOS Regression:"` 才能一次跑完所有以 `OHOS Regression:` 开头的测试。

---

## C. 一次跑全部 vs 单独跑（编译时间 trade-off）

| 方式 | 命令 | 时间 | 适合 |
|------|------|------|------|
| 一次跑全部（推荐） | `flutter test <file> --plain-name "<prefix>:"` | 12 + 0.5N min | 已稳定测试，全跑验证 |
| 单独跑 | `flutter test <file> --plain-name "<exact name>"` | 12 + 1 min × N | 调试单个失败测试 |
| 全文件跑 | `flutter test <file>` | 12 + 0.5 × (全部测试数) min | 上线前 CI |

**禁止**：`grep | head` pipeline 截输出（见 SKILL §6.3 NEVER）。

---

## D. 三个高频反模式（已在 SKILL §5.3 列出，这里给反例代码）

```dart
// ❌ 1. 忘 addTearDown
debugDefaultTargetPlatformOverride = TargetPlatform.ohos;
// 缺 addTearDown(() => debugDefaultTargetPlatformOverride = null);

// ❌ 2. controller + primary 互斥（仅 CustomScrollView）
Scaffold(
  body: CustomScrollView(controller: ctrl, primary: true, ...),
)
// → framework assert: "A controller must not be provided if primary is true"

// ❌ 3. 动画未完成就断言
await tester.pump();  // 只 pump 一帧
expect(widget.height, 100);
// 必须 await tester.pumpAndSettle();
```

---

## E. 占位符替换清单

| 占位符 | 替换为 | 示例 |
|--------|--------|------|
| `<X>` | 场景短名 | `StatusBar` / `BackGesture` / `Scroll` |
| `<构造 widget tree>` | 你要测的 widget | `Scaffold(body: CustomScrollView(...))` |
| `<your-channel-name>` | channel 名 | `flutter/statusBarClick` |
| `<method>` | 方法名 | `''` (空 payload, just notify) |
| `<args>` | 参数 Map | `null` 或 `{'x': 0.0}` |