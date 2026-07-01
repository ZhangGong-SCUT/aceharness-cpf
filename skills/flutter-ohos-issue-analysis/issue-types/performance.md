# 性能问题根因模式库

> 问题类型：performance（卡顿/掉帧/启动慢）

## 根因模式

### RC-P-01: 主线程耗时操作 (Main Thread Blocking)

**现象**：UI 卡顿，掉帧

**日志特征**：
```
W Choreographer: Frame skipped: 120ms
E MainThread: Blocked for 80ms
```

**根因**：主线程执行了耗时操作（IO/计算/序列化）

**修复方向**：
- 将耗时操作移到子线程（compute/isolate）
- 使用 TaskPool 或 Worker
- 添加加载占位 UI

**置信度**：0.88

---

### RC-P-02: Widget 重建过度 (Excessive Rebuild)

**现象**：列表滚动卡顿，频繁重建

**日志特征**：
```
W Flutter: Widget rebuild count: 500/frame
E Performance: Build time: 32ms (target: <16ms)
```

**根因**：Widget 未使用 const、未拆分 setState 范围、未使用 keys

**修复方向**：
- 使用 const Widget
- 拆分 setState 范围，缩小重建区域
- 使用 const Key 和 ValueKey
- 使用 ListView.builder 替代 ListView

**置信度**：0.85

---

### RC-P-03: 图片加载未优化 (Unoptimized Image Loading)

**现象**：图片列表卡顿，内存波动大

**日志特征**：
```
W ImageCache: Decoding image: 150ms
E Performance: Image load blocking UI
```

**根因**：大图未压缩、未使用缓存、在主线程解码

**修复方向**：
- 使用 resize 后的缩略图
- 使用 cached_network_image 缓存
- 使用 precacheImage 预加载
- 使用 isolate 解码大图

**置信度**：0.82

---

### RC-P-04: 启动耗时过长 (Slow Startup)

**现象**：冷启动超过 3 秒

**日志特征**：
```
I FlutterEngine: Engine start: 1200ms
I Flutter: First frame: 2800ms
```

**根因**：启动时加载过多资源、初始化过多插件、同步阻塞

**修复方向**：
- 延迟加载非必要插件
- 使用 splash screen 占位
- 异步初始化非关键模块
- 减少启动时的网络请求

**置信度**：0.80

---

### RC-P-05: 动画性能差 (Poor Animation Performance)

**现象**：动画卡顿，不流畅

**日志特征**：
```
W Flutter: Animation FPS: 30 (target: 60)
E Performance: Animation jank detected
```

**根因**：动画使用 setState 驱动、动画对象过多、未使用硬件加速

**修复方向**：
- 使用 AnimatedBuilder/AnimatedWidget 替代 setState
- 使用 Transform/Opacity 等硬件加速属性
- 减少同时运行的动画数量
- 使用 Lottie/Rive 替代复杂动画

**置信度**：0.84

---

### RC-P-06: 网络请求阻塞 (Network Blocking)

**现象**：网络请求期间 UI 卡顿

**日志特征**：
```
W HttpClient: Request blocked UI for 200ms
E Performance: Network call on main thread
```

**根因**：网络请求在主线程执行，或请求过多并发

**修复方向**：
- 确保网络请求在异步方法中
- 使用连接池和缓存
- 添加请求超时和重试
- 使用 Dio/Http 等异步 HTTP 库

**置信度**：0.86

## 诊断方法

### 性能数据采集

```bash
# 采集 Performance trace
hdc shell "hidumper --trace" > perf_trace.txt

# 采集帧率数据
hdc shell "hidumper --fps" > fps_data.txt

# 采集 CPU/内存
hdc shell "hidumper --cpu" > cpu_data.txt
hdc shell "hidumper --mem $(pidof com.example.app)" > mem_data.txt
```

### 性能分析要点

1. **帧率分析**：FPS 是否稳定在 60
2. **构建时间**：Widget build time 是否 <16ms
3. **主线程阻塞**：是否有 >16ms 的阻塞
4. **内存波动**：是否有频繁的 GC

## 上游搜索关键词

| 场景 | 搜索源 | 关键词策略 |
|------|--------|-----------|
| 性能问题 | Flutter Issues | 现象 + performance |
| 卡顿 | Flutter Engine Issues | jank + 现象 |
| 鸿蒙特有 | Flutter-OHOS Issues | ohos + performance + 现象 |
