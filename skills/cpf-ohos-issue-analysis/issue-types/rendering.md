# 渲染问题根因模式库

> 问题类型：rendering（黑屏/白屏/花屏/错位）

## 根因模式

### RC-R-01: XComponent Surface 未重建 (Surface Not Rebuilt)

**现象**：切后台切前台后黑屏

**日志特征**：
```
E XComponent: Surface destroyed
I XComponent: onForeground called
// 缺少 Surface create 日志
```

**根因**：XComponent 的 Surface 在切后台时被销毁，切前台时未正确重建

**修复方向**：
- 在 onForeground 中手动触发 Surface 重建
- 添加 XComponent 生命周期监听
- 在 SurfaceCreated 回调中重新初始化渲染上下文

**置信度**：0.85

---

### RC-R-02: 黑屏 - 引擎未启动 (Engine Not Started)

**现象**：应用启动后黑屏，无 UI 显示

**日志特征**：
```
I FlutterEngine: Engine created
// 缺少 Engine startRun 日志
W Flutter: No rendering surface attached
```

**根因**：FlutterEngine 未调用 startRun()，或调用时序错误

**修复方向**：
- 在 onWindowStageCreated 中调用 flutterEngine.startRun()
- 确保 XComponent 已 attached 后再启动引擎
- 检查 initialRoute 配置

**置信度**：0.88

---

### RC-R-03: 白屏 - 路由未加载 (Route Not Loaded)

**现象**：应用启动后白屏，无内容显示

**日志特征**：
```
I Flutter: Engine started
W Flutter: Route '/' not found
E Navigator: No routes found to display
```

**根因**：路由配置错误，或 home/initialRoute 未设置

**修复方向**：
- 检查 MaterialApp 的 home 或 initialRoute 配置
- 确保路由表已注册
- 检查 onGenerateRoute 回调

**置信度**：0.86

---

### RC-R-04: 花屏 - GPU 上下文异常 (GPU Context Error)

**现象**：UI 显示花屏、纹理错乱

**日志特征**：
```
E GPU: GL context lost
E Skia: Failed to create surface
W Impeller: Invalid GPU state
```

**根因**：GPU 上下文丢失或未正确恢复，Skia/Impeller 渲染异常

**修复方向**：
- 在 Surface 重建后重新创建 GPU 上下文
- 检查 EGL 上下文管理
- 尝试切换 Skia/Impeller 渲染后端

**置信度**：0.78

---

### RC-R-05: UI 错位 - 安全区域未适配 (SafeArea Not Adapted)

**现象**：UI 元素被状态栏/导航栏遮挡

**日志特征**：
```
W Flutter: Layout overflowed by 44px
I Flutter: MediaQuery.padding not applied
```

**根因**：未使用 SafeArea，或 MediaQuery 数据不正确

**修复方向**：
- 使用 SafeArea 包裹内容
- 检查 MediaQuery.of(context).padding
- 适配鸿蒙的状态栏和导航栏

**置信度**：0.90

---

### RC-R-06: 闪烁 - 频繁重建 (Frequent Rebuild)

**现象**：UI 频繁闪烁，不稳定

**日志特征**：
```
W Flutter: Widget rebuilt 10 times in 1s
E Performance: Excessive rebuild detected
```

**根因**：Widget 频繁重建，setState 调用过于频繁

**修复方向**：
- 优化 setState 调用频率
- 使用 const Widget
- 拆分 StatefulWidget 范围
- 使用 AnimatedBuilder 替代手动 setState

**置信度**：0.83

---

### RC-R-07: 字体渲染异常 (Font Rendering Error)

**现象**：文字显示异常、乱码、缺失

**日志特征**：
```
W Flutter: Font not found: xxx
E Skia: Failed to load font
```

**根因**：字体文件未正确打包，或字体路径配置错误

**修复方向**：
- 检查 pubspec.yaml 中的字体配置
- 确保字体文件在 assets 目录中
- 使用系统默认字体作为 fallback

**置信度**：0.87

## 诊断方法

### 渲染日志采集

```bash
# 采集渲染日志
hdc hilog | grep -i "render\|surface\|gpu\|skia\|impeller" > render_log.txt

# 采集截图
hdc shell "snapshot_display -f /tmp/screenshot.png"
hdc file recv /tmp/screenshot.png ./screenshot.png

# 采集 GPU 日志
hdc shell "hidumper --render" > gpu_dump.txt
hdc shell "hidumper --surface" > surface_dump.txt
```

### 渲染分析要点

1. **Surface 生命周期**：Surface create/destroy 是否成对
2. **GPU 状态**：GPU 上下文是否正常
3. **渲染后端**：Skia/Impeller 的状态
4. **布局日志**：是否有 overflow 告警

## 上游搜索关键词

| 场景 | 搜索源 | 关键词策略 |
|------|--------|-----------|
| 渲染异常 | Flutter Engine Issues | 现象描述 + Skia/Impeller |
| 黑屏 | Flutter Issues | black screen + 现象 |
| 鸿蒙特有 | Flutter-OHOS Issues | ohos + rendering + 现象 |
| XComponent | Flutter-OHOS Issues | XComponent + 现象 |
