# 日志采集命令模板

> 用于 diagnosis-collector Agent 的日志采集参考

## 通用日志采集

### 完整 hilog

```bash
# 采集完整 hilog（所有类型必采）
hdc hilog > hilog_full.txt

# 采集带时间戳的 hilog
hdc hilog -T > hilog_timestamped.txt

# 采集指定应用的 hilog
hdc hilog | grep "com.example.app" > app_hilog.txt
```

### 按级别过滤

```bash
# 只采集 ERROR 及以上级别
hdc hilog -L E > hilog_error.txt

# 只采集 FATAL 级别
hdc hilog -L F > hilog_fatal.txt
```

### 按标签过滤

```bash
# 采集 Flutter 相关日志
hdc hilog -T Flutter > flutter_log.txt

# 采集 ArkTS 相关日志
hdc hilog -T ArkTS > arkts_log.txt

# 采集 XComponent 相关日志
hdc hilog -T XComponent > xcomponent_log.txt
```

## 稳定性问题日志采集

### faultlog

```bash
# 采集 faultlog 目录
hdc file recv /data/log/faultlog/ ./faultlog/

# 查看最新的 faultlog
hdc shell "ls -lt /data/log/faultlog/faultlogger/"

# 采集特定进程的 faultlog
hdc shell "cat /data/log/faultlog/faultlogger/cppcrash-$(pidof com.example.app)-*.log"
```

### crash 前后日志

```bash
# 采集 crash 前后 100 行日志
hdc hilog | grep -B100 -A100 "Fatal signal" > crash_context.txt

# 采集 crash 堆栈
hdc shell "cat /data/log/faultlog/faultlogger/cppcrash-*.log" | grep -A50 "Reason:Signal"
```

### ANR 日志

```bash
# 采集 ANR 日志
hdc file recv /data/log/faultlog/ ./anr_logs/

# 采集主线程阻塞日志
hdc hilog | grep -i "AppFreeze\|ANR\|blocked" > anr_log.txt
```

## 内存问题日志采集

### 内存趋势

```bash
# 采集内存趋势数据（每5秒一次，持续5分钟）
for i in $(seq 1 60); do
  echo "=== $(date) ===" >> mem_trend.txt
  hdc shell "hidumper --mem $(pidof com.example.app)" >> mem_trend.txt
  sleep 5
done
```

### GC 日志

```bash
# 采集 GC 日志
hdc hilog | grep -i "gc\|heap\|memory" > gc_log.txt

# 采集 Dart VM 日志
hdc hilog | grep -i "dart\|vm" > dart_vm_log.txt
```

### 内存映射

```bash
# 采集进程内存映射
hdc shell "cat /proc/$(pidof com.example.app)/maps" > mem_maps.txt

# 采集内存使用详情
hdc shell "hidumper --mem $(pidof com.example.app)" > mem_detail.txt
```

## 性能问题日志采集

### Performance Trace

```bash
# 采集性能 trace
hdc shell "hidumper --trace" > perf_trace.txt

# 采集 CPU 使用率
hdc shell "hidumper --cpu" > cpu_data.txt

# 采集线程信息
hdc shell "ps -T | grep com.example.app" > threads.txt
```

### 帧率数据

```bash
# 采集帧率数据（持续采集）
hdc shell "hidumper --fps" > fps_data.txt

# 采集渲染性能
hdc shell "hidumper --render" > render_perf.txt
```

## 渲染问题日志采集

### 渲染日志

```bash
# 采集渲染相关日志
hdc hilog | grep -i "render\|surface\|gpu\|skia\|impeller" > render_log.txt

# 采集 Surface 生命周期日志
hdc hilog | grep -i "surface\|XComponent" > surface_log.txt
```

### 截图

```bash
# 采集截图
hdc shell "snapshot_display -f /tmp/screenshot.png"
hdc file recv /tmp/screenshot.png ./screenshot.png

# 采集多张截图（每秒一张，持续10秒）
for i in $(seq 1 10); do
  hdc shell "snapshot_display -f /tmp/screenshot_$i.png"
  hdc file recv /tmp/screenshot_$i.png ./screenshot_$i.png
  sleep 1
done
```

### GPU 日志

```bash
# 采集 GPU dump
hdc shell "hidumper --render" > gpu_dump.txt

# 采集 Surface dump
hdc shell "hidumper --surface" > surface_dump.txt

# 采集 RenderService dump
hdc shell "hidumper --render_service" > render_service_dump.txt
```

## 日志采集注意事项

1. **采集时机**：在问题复现时采集，确保日志包含问题发生时的信息
2. **采集范围**：尽量采集完整日志，不要过滤太严格
3. **时间对齐**：记录采集时间，便于与问题发生时间对齐
4. **多次采集**：偶现问题需要多次采集，对比差异
5. **权限检查**：部分日志需要 root 权限，确认设备已 root 或使用 debug 版本
