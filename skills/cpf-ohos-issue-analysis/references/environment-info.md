# 环境信息采集清单

> 用于 diagnosis-collector Agent 的环境信息采集参考

## 必采环境信息（所有问题类型）

### 设备信息

```bash
# 设备型号
hdc shell param get const.product.model

# 系统版本
hdc shell param get const.ohos.fullname.release

# API 版本
hdc shell param get const.ohos.apiversion

# 设备唯一标识
hdc shell param get const.product.serialno
```

### 框架版本

```bash
# Flutter 版本
flutter --version

# Flutter-OHOS 引擎版本
cat bin/cache/engine.ohos.stamp

# Dart 版本
dart --version

# pub 依赖列表
cat pubspec.lock | head -100
```

### 应用信息

```bash
# 应用包名和版本
hdc shell "bm dump -n com.example.app"

# 应用进程信息
hdc shell "ps -ef | grep com.example.app"

# 应用 UID
hdc shell "hidumper --mem $(pidof com.example.app)"
```

## 按问题类型的选采信息

### 稳定性问题

```bash
# faultlog（必采）
hdc file recv /data/log/faultlog/ ./faultlog/

# crash 前后 hilog（必采）
hdc hilog > hilog_full.txt

# 进程信息
hdc shell "ps -T | grep com.example.app"

# ANR 日志（选采）
hdc file recv /data/log/faultlog/ ./anr_logs/
```

### 内存泄漏问题

```bash
# 内存趋势数据（必采，每5秒一次，持续5分钟）
for i in $(seq 1 60); do
  hdc shell "hidumper --mem $(pidof com.example.app)" >> mem_trend.txt
  sleep 5
done

# GC 日志（必采）
hdc hilog | grep -i "gc\|heap\|memory" > gc_log.txt

# 内存告警日志（选采）
hdc hilog | grep -i "memory warning\|low memory" > mem_warning.txt

# Dart heap snapshot（选采）
# 通过 Flutter DevTools 采集
```

### 功能问题

```bash
# MethodChannel 日志（必采）
hdc hilog | grep -i "method\|channel\|plugin" > channel_log.txt

# 跨平台对比（选采）
# 在 Android 设备上复现并采集相同日志

# 插件依赖列表（选采）
cat pubspec.lock | grep -A5 "plugins"
```

### 性能问题

```bash
# Performance trace（必采）
hdc shell "hidumper --trace" > perf_trace.txt

# 帧率数据（必采）
hdc shell "hidumper --fps" > fps_data.txt

# CPU 数据（必采）
hdc shell "hidumper --cpu" > cpu_data.txt

# 启动时间数据（选采）
hdc shell "hidumper --startup" > startup_data.txt
```

### 渲染问题

```bash
# 渲染日志（必采）
hdc hilog | grep -i "render\|surface\|gpu\|skia\|impeller" > render_log.txt

# 截图（必采）
hdc shell "snapshot_display -f /tmp/screenshot.png"
hdc file recv /tmp/screenshot.png ./screenshot.png

# GPU 日志（选采）
hdc shell "hidumper --render" > gpu_dump.txt

# RenderService dump（选采）
hdc shell "hidumper --surface" > surface_dump.txt
```

## 素材完整性校验

采集完成后，按以下清单校验素材完整性：

| 校验项 | 检查内容 | 缺失处理 |
|--------|---------|---------|
| environment_info | 设备型号、系统版本、API版本、框架版本 | 必须补充 |
| hilog | 完整的 hilog 文件 | 必须补充 |
| faultlog | faultlog 目录（稳定性问题） | 必须补充 |
| reproduction_steps | 完整的复现步骤 | 必须补充 |
| mem_trend | 内存趋势数据（内存泄漏问题） | 必须补充 |
| perf_trace | 性能 trace（性能问题） | 必须补充 |
| screenshot | 截图（渲染问题） | 必须补充 |

## 素材包组织

采集的素材按以下结构组织：

```
material-package/
├── environment/
│   ├── device_info.txt
│   ├── framework_version.txt
│   └── app_info.txt
├── logs/
│   ├── hilog_full.txt
│   ├── faultlog/
│   └── gc_log.txt
├── performance/
│   ├── perf_trace.txt
│   ├── fps_data.txt
│   └── mem_trend.txt
├── rendering/
│   ├── screenshot.png
│   └── gpu_dump.txt
└── reproduction/
    ├── steps.md
    └── preconditions.md
```
