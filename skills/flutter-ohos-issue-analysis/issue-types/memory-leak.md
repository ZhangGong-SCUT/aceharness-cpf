# 内存泄漏问题根因模式库

> 问题类型：memory-leak（内存持续增长/OOM）

## 根因模式

### RC-M-01: Widget 未释放 (Widget Leak)

**现象**：页面切换后内存不下降，多次切换后内存持续增长

**日志特征**：
```
W FlutterMemory: Memory usage increased after route change
I GC: Dart heap: 256MB → 280MB (not reclaimed)
```

**根因**：Widget 持有全局引用（如 Singleton、Stream 订阅未取消），导致无法 GC

**修复方向**：
- 在 dispose() 中取消 Stream 订阅
- 避免在 Widget 中持有全局 Singleton 引用
- 使用 WeakReference 管理外部引用

**置信度**：0.85

---

### RC-M-02: 原生对象未释放 (Native Object Leak)

**现象**：ArkTS 侧内存持续增长

**日志特征**：
```
W ArkTS: Object count increased: 1024 → 2048
E Memory: Native heap: 150MB → 200MB
```

**根因**：ArkTS 原生对象（如 XComponent、PixelMap）未手动释放

**修复方向**：
- 在 onDetach / onDestroy 中释放原生对象
- 使用 try-finally 确保资源释放
- 添加对象池管理

**置信度**：0.82

---

### RC-M-03: MethodChannel 回调泄漏 (Channel Callback Leak)

**现象**：频繁 MethodChannel 调用后内存增长

**日志特征**：
```
W MethodChannel: Pending callback count: 50
E FlutterMemory: Callback objects not released
```

**根因**：MethodChannel 的回调对象被持有，调用完成后未释放

**修复方向**：
- 使用一次性回调（调用后自动移除）
- 在页面销毁时取消未完成的回调
- 避免在回调中持有外部引用

**置信度**：0.78

---

### RC-M-04: 图片缓存溢出 (Image Cache Overflow)

**现象**：加载大量图片后内存增长，不释放

**日志特征**：
```
W ImageCache: Cache size: 500MB (limit: 100MB)
E FlutterMemory: Image objects: 200+
```

**根因**：图片缓存未设置上限，或大图未压缩

**修复方向**：
- 设置 PaintingBinding.instance.imageCache.maximumSize
- 使用 cached_network_image 等缓存管理库
- 大图使用 resize 后再加载

**置信度**：0.88

---

### RC-M-05: AnimationController 未释放 (Animation Leak)

**现象**：页面切换后 AnimationController 仍在运行

**日志特征**：
```
W Flutter: AnimationController still active after dispose
E Ticker: Ticker was not disposed
```

**根因**：AnimationController 未在 dispose() 中调用 dispose()

**修复方向**：
- 在 State.dispose() 中调用 controller.dispose()
- 使用 vsync 机制确保 AnimationController 与 State 生命周期绑定

**置信度**：0.92

---

### RC-M-06: 全局事件监听未移除 (Event Listener Leak)

**现象**：多次页面切换后内存增长

**日志特征**：
```
W EventBus: Listener count: 50 (expected: 5)
E FlutterMemory: Event listener objects not released
```

**根因**：全局事件监听（EventBus、BroadcastReceiver）在页面销毁时未移除

**修复方向**：
- 在 dispose() 中移除所有事件监听
- 使用自动管理的事件订阅库

**置信度**：0.86

## 诊断方法

### 内存趋势采集

```bash
# 采集内存趋势数据（每5秒一次，持续5分钟）
for i in $(seq 1 60); do
  hdc shell "hidumper --mem $(pidof com.example.app)" >> mem_trend.txt
  sleep 5
done

# 采集 GC 日志
hdc hilog | grep -i "gc\|heap\|memory" > gc_log.txt
```

### 内存分析要点

1. **趋势分析**：内存是否持续增长（斜率）
2. **GC 分析**：GC 后内存是否回落
3. **对象分析**：哪类对象数量异常
4. **对比分析**：正常路径 vs 异常路径的对象差异

## 上游搜索关键词

| 场景 | 搜索源 | 关键词策略 |
|------|--------|-----------|
| 内存泄漏 | Flutter Issues | memory leak + 现象 |
| 鸿蒙特有 | Flutter-OHOS Issues | ohos + memory leak |
| 图片缓存 | Flutter Issues | image cache + memory |
