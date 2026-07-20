# 稳定性问题根因模式库

> 问题类型：stability（崩溃/ANR/闪退/冻结）

## 根因模式

### RC-S-01: 插件未注册 (Plugin Not Registered)

**现象**：`MissingPluginException`，功能调用时崩溃

**日志特征**：
```
E FlutterEngine: Plugin not registered: com.example.my_plugin.MyPlugin
E FlutterError: MissingPluginException: No implementation found for method xxx on channel xxx
```

**根因**：鸿蒙化插件未在 EntryAbility 中注册，或注册时序错误

**修复方向**：
- 在 EntryAbility 的 onWindowStageCreated 中添加 `flutterEngine.getPlugins().add(MyPlugin())`
- 确保插件注册在 FlutterEngine 启动前完成

**置信度**：0.9

---

### RC-S-02: 引擎初始化时序错误 (Engine Init Timing)

**现象**：冷启动闪退，日志显示引擎未就绪

**日志特征**：
```
F FlutterEngine: Engine not ready, cannot execute method
F libc: Fatal signal 6 (SIGABRT)
```

**根因**：FlutterEngine 初始化未完成时就调用了 Flutter API

**修复方向**：
- 确保 FlutterEngine.startRun() 在 onWindowStageCreated 中调用
- 添加引擎就绪回调监听

**置信度**：0.85

---

### RC-S-03: XComponent 生命周期异常 (XComponent Lifecycle)

**现象**：切后台切前台后崩溃，或页面切换时崩溃

**日志特征**：
```
E XComponent: Surface destroyed unexpectedly
F flutter: RenderFlex overflowed
```

**根因**：XComponent 的 Surface 在切后台时被销毁，切前台时未正确重建

**修复方向**：
- 在 onForeground 中手动触发 Surface 重建
- 添加 XComponent 生命周期监听

**置信度**：0.82

---

### RC-S-04: 原生线程访问 Flutter (Thread Violation)

**现象**：偶现崩溃，堆栈在原生线程

**日志特征**：
```
F libc: Fatal signal 11 (SIGSEGV) at 0x00000000
#00 pc 0xxxx /data/.../libflutter_engine.so (FlutterEngineNotifyDisplayChange+...)
```

**根因**：原生线程直接访问 Flutter 引擎 API，未通过 Platform Thread

**修复方向**：
- 使用 `runOnUiThread` 或等效机制切换到主线程
- 使用 MethodChannel 进行线程间通信

**置信度**：0.80

---

### RC-S-05: ArkTS 空指针崩溃 (Null Pointer)

**现象**：ArkTS 侧崩溃，NullPointerException

**日志特征**：
```
E ArkTS: TypeError: Cannot read property 'xxx' of null
F com.ohos.arkts: Fatal JS exception
```

**根因**：ArkTS 代码未做空检查，或异步回调时对象已被释放

**修复方向**：
- 添加空值检查
- 使用 Optional 链式调用
- 异步回调前检查对象生命周期

**置信度**：0.88

---

### RC-S-06: 内存溢出崩溃 (OOM)

**现象**：长时间运行后崩溃，日志显示 OOM

**日志特征**：
```
E libc: Failed to allocate memory
F libc: Fatal signal 6 (SIGABRT) - out of memory
```

**根因**：内存泄漏导致持续增长，最终触发 OOM

**修复方向**：
- 参考内存泄漏根因模式（RC-M-xx）
- 添加内存监控和告警
- 优化大对象加载策略

**置信度**：0.75

---

### RC-S-07: 权限缺失崩溃 (Permission Denied)

**现象**：调用系统功能时崩溃

**日志特征**：
```
E AbilityContext: Permission denied: ohos.permission.xxx
F flutter: PlatformException: Permission denied
```

**根因**：module.json5 中未声明所需权限，或权限申请时序错误

**修复方向**：
- 在 module.json5 的 requestPermissions 中声明权限
- 在调用前动态申请权限

**置信度**：0.92

---

### RC-S-08: ANR 主线程阻塞 (Main Thread Block)

**现象**：应用无响应（ANR），主线程被阻塞

**日志特征**：
```
W AppFreeze: Application is not responding
E MainThread: Blocked for 5000ms
```

**根因**：主线程执行耗时操作（网络/IO/大量计算）

**修复方向**：
- 将耗时操作移到子线程
- 使用 TaskPool 或 Worker
- 添加异步加载占位 UI

**置信度**：0.85

## 修复建议通用策略

| 根因层面 | 修复策略 |
|---------|---------|
| 应用层 | 修改用户代码，添加生命周期处理 |
| 插件层 | 修改插件鸿蒙化实现，确保注册时序 |
| 框架层 | 修改 Flutter framework 鸿蒙化代码 |
| 引擎层 | 提 Issue + 临时 patch |
| 系统层 | 使用等效 API 替代 |

## 上游搜索关键词

| 场景 | 搜索源 | 关键词策略 |
|------|--------|-----------|
| Crash + 堆栈 | Flutter Engine Issues | 堆栈中的函数名 |
| 插件问题 | Flutter Issues + 插件仓库 | MissingPluginException + 插件名 |
| 鸿蒙特有 | Flutter-OHOS Issues | ohos + crash + 现象 |
