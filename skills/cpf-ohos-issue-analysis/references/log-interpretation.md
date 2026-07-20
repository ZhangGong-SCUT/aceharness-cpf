# 日志解读方法

> 用于 diagnosis-root-cause-analyzer Agent 的日志解读参考

## hilog 日志结构

### 日志格式

```
01-01 12:00:00.123  1001  2001  E 01234/FlutterEngine: Message content
^^^^^^^^^^^^^^^^^^^ ^^^^ ^^^^ ^ ^^^^^/^^^^^^^^^^^^^^^^: ^^^^^^^^^^^^^^^^
时间戳              UID  PID  级别 标签/进程名          日志内容
```

### 日志级别

| 级别 | 缩写 | 含义 | 诊断价值 |
|------|------|------|---------|
| FATAL | F | 致命错误，进程崩溃 | ★★★★★ 必须分析 |
| ERROR | E | 错误，功能异常 | ★★★★★ 必须分析 |
| WARN | W | 警告，潜在问题 | ★★★★ 需要关注 |
| INFO | I | 信息，正常运行 | ★★★ 上下文参考 |
| DEBUG | D | 调试信息 | ★★ 辅助分析 |
| TRACE | T | 详细跟踪 | ★ 辅助分析 |

## 关键日志模式

### 崩溃日志

#### SIGABRT（主动中止）

```
F libc: Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE) in tid 12345
F libc: backtrace:
  #00 pc 0xxxx /system/lib/.../libc.so
  #01 pc 0xxxx /data/.../libflutter_engine.so (FlutterEngineXXX+123)
```

**解读**：
- `SIGABRT` 通常是主动调用 abort() 或 assert 失败
- 查看堆栈中的 `libflutter_engine.so` 函数名，定位引擎层问题
- 查看堆栈中的应用 .so，定位原生代码问题

#### SIGSEGV（段错误）

```
F libc: Fatal signal 11 (SIGSEGV) at 0x00000000
F libc: backtrace:
  #00 pc 0xxxx /data/.../libflutter_engine.so
```

**解读**：
- `SIGSEGV` 通常是空指针访问或非法内存访问
- 地址 `0x00000000` 表示空指针解引用
- 查看堆栈定位访问非法内存的代码位置

#### SIGBUS（总线错误）

```
F libc: Fatal signal 7 (SIGBUS) at 0x12345678
```

**解读**：
- `SIGBUS` 通常是内存对齐错误或映射文件访问错误
- 检查原生代码的内存对齐

### ArkTS 异常日志

```
E ArkTS: TypeError: Cannot read property 'xxx' of null
E ArkTS:     at xxx (file:///entry/src/main/ets/pages/Index.ets:45:10)
F com.ohos.arkts: Fatal JS exception
```

**解读**：
- `TypeError` 是 ArkTS 常见异常
- 查看文件路径和行号定位代码
- `of null` 表示对象为 null，需要添加空检查

### Flutter 异常日志

```
E FlutterError: MissingPluginException: No implementation found for method xxx on channel xxx
E FlutterError:    at MethodChannel._invokeMethod (package:flutter/src/services/platform_channel.dart:xxx)
```

**解读**：
- `MissingPluginException` 表示插件未注册
- 检查 channel name 是否匹配
- 检查插件是否在 EntryAbility 中注册

### 渲染异常日志

```
E XComponent: Surface destroyed unexpectedly
E Skia: Failed to create surface: GL error 0x300
W Impeller: Invalid GPU state
```

**解读**：
- `Surface destroyed` 表示渲染表面被销毁
- `GL error` 表示 GPU 上下文异常
- 检查 XComponent 生命周期管理

### 性能告警日志

```
W Choreographer: Frame skipped: 120ms
W Flutter: Widget rebuild count: 500/frame
E Performance: Build time: 32ms (target: <16ms)
```

**解读**：
- `Frame skipped` 表示掉帧，超过 16ms
- `Widget rebuild count` 过高表示过度重建
- `Build time` 超过 16ms 会导致掉帧

### 内存告警日志

```
W FlutterMemory: Memory usage increased after route change
E Memory: Native heap: 200MB (limit: 256MB)
W GC: Dart heap: 280MB (not reclaimed after GC)
```

**解读**：
- `Memory usage increased` 表示内存增长
- `Native heap` 接近限制表示可能 OOM
- `not reclaimed after GC` 表示内存泄漏

## 堆栈分析

### 堆栈结构

```
#00 pc 0x00012345  /system/lib/libc.so (abort+123)
#01 pc 0x00067890  /data/.../libflutter_engine.so (FlutterEngineNotifyDisplayChange+456)
#02 pc 0x000abcde  /data/.../libflutter_engine.so (FlutterEngine::OnVSync+789)
#03 pc 0x000f0123  /data/.../libapp.so (main+456)
```

**解读顺序**（从下往上）：
1. `#03 main` - 程序入口
2. `#02 OnVSync` - VSync 回调
3. `#01 NotifyDisplayChange` - 显示变更通知
4. `#00 abort` - 最终崩溃点

### 关键库识别

| 库名 | 含义 | 问题层面 |
|------|------|---------|
| `libc.so` | C 标准库 | 系统层 |
| `libflutter_engine.so` | Flutter 引擎 | 引擎层 |
| `libflutter.so` | Flutter 框架 | 框架层 |
| `libapp.so` | 应用 Dart 代码 | 应用层 |
| `libxxx_plugin.so` | 插件原生代码 | 插件层 |
| `libarkts.so` | ArkTS 运行时 | 系统层 |

## 日志分析策略

### 1. 时间线分析

按时间顺序梳理日志，定位问题发生的时间点：

```
12:00:00.000  I  App started
12:00:01.234  I  FlutterEngine created
12:00:02.567  W  XComponent Surface created
12:00:03.123  E  Plugin not registered: MyPlugin  ← 问题开始
12:00:03.456  E  MissingPluginException
12:00:03.789  F  Fatal signal 6 (SIGABRT)         ← 崩溃
```

### 2. 关键词搜索

按问题类型搜索关键词：

| 问题类型 | 关键词 |
|---------|--------|
| 稳定性 | `Fatal signal`, `SIGABRT`, `SIGSEGV`, `crash`, `abort` |
| 内存 | `memory`, `heap`, `GC`, `OOM`, `leak` |
| 功能 | `Exception`, `Error`, `MissingPlugin`, `not found` |
| 性能 | `Frame skipped`, `jank`, `slow`, `blocked` |
| 渲染 | `Surface`, `render`, `GPU`, `Skia`, `Impeller` |

### 3. 上下文分析

找到关键错误日志后，查看前后 100 行上下文：

```bash
grep -B100 -A100 "Fatal signal" hilog.txt > crash_context.txt
```

### 4. 对比分析

对比正常和异常场景的日志差异：

```bash
diff normal_hilog.txt abnormal_hilog.txt > log_diff.txt
```

## 日志解读输出

日志分析完成后，输出结构化结论：

```json
{
  "error_type": "SIGABRT|SIGSEGV|TypeError|MissingPluginException|...",
  "error_location": {
    "file": "源码文件路径",
    "line": 行号,
    "function": "函数名"
  },
  "error_cause": "错误原因分析",
  "stack_trace_summary": "堆栈摘要",
  "related_logs": ["相关日志行1", "相关日志行2"],
  "confidence": 0.0-1.0
}
```
