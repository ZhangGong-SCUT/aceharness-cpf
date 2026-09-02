# uitest 脚本模板

> **Use when**：demo 在真机上**行为差异不易肉眼观察**（如 scroll offset、动画帧、平台手势响应），或 reviewer 要求"附上 device 自动化日志"。
> **Not for**：纯 review 用 demo（手动点就行）；framework 行为测试（用 `testWidgets` 更准）。

---

## A. uitest 最小脚本（通用框架）

```javascript
// uitest 脚本：simulate_<action>.ets / uitest 格式
let driver = getDriver();

// 等首屏 + 路由/动画完成（2000ms 是经验值）
await driver.delay(2000);

// 触发目标操作
await driver.<action_method>(<args>);

// 等副作用完成
await driver.delay(500);

// 截图 + dump（reviewer 看）
await driver.screenshot('/tmp/after_<action>.png');
await driver.dump('/tmp/window_dump.xml');
```

---

## B. 常用 `driver` API（按场景选）

| 想做的事 | API | 备注 |
|---------|-----|------|
| 等动画 | `driver.delay(ms)` | 至少 2000ms 等路由/弹窗完成 |
| 模拟系统手势 | `driver.sendKeyEvent(keyCode, eventName)` | 视 uitest 版本 API 而定 |
| 模拟屏幕点击 | `driver.click(x, y)` 或 `driver.press(x, y)` | 坐标 = 物理像素 |
| 文本输入 | `driver.inputText(text)` | 焦点需先在输入框 |
| 滑动 | `driver.swipe(x1, y1, x2, y2, duration)` | duration ms |
| 截图 | `driver.screenshot(path)` | PNG 格式 |
| UI dump | `driver.dump(path)` | XML 格式，含所有 widget tree |

---

## C. uitest vs testWidgets 选择决策树

```
你想要精确断言 widget 状态 (offset, hit-test, key)?
├── 是 → 用 flutter testWidgets（不需要设备，VM 跑）
└── 否 → 你能在真机上肉眼看出差异吗?
    ├── 能 → 手动点设备，不写 uitest
    └── 不能 → 用 uitest 自动化（截图 + dump diff）
```

---

## D. uitest 三个高频坑（对应 SKILL §6.3 / §6.4）

1. **`driver.delay(2000)` 是最小值** — 路由切换 + 弹窗 + 动画常常超出，截图前再多 delay(500)
2. **坐标是物理像素** — OHOS 设备 1260×2720 不是逻辑像素 360×800，**需要 `driver.getDisplaySize()` 取实际值**
3. **`sendKeyEvent` keyCode 视 uitest 版本 API 而定** — 用错 keyCode 静默无效，**Use**：`adb shell input keyevent` 风格的 keyCode map 表（OHOS 与 Android 不完全一致）

---

## E. 与 Flutter test 对接

uitest 截到 dump XML 后，可以用 Dart 脚本解析 XML 验证 widget tree：

```dart
// 在 demo 内加这个 helper，让 uitest dump 内容可被 Dart 程序消费
import 'package:flutter/widgets.dart';

String dumpWidgetTree(Widget w) {
  // 把 widget tree 序列化为可 diff 的字符串
  // 配合 uitest dump 做 golden diff
  return w.toStringDeep().replaceAll(RegExp(r'\s+'), ' ');
}
```

**Use when**：做 nightly regression — uitest 跑 + 截图 + dump 三个一起，CI diff 截图/Dump XML 找回归。