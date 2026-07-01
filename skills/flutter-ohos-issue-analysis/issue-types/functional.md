# 功能问题根因模式库

> 问题类型：functional（功能不工作/行为异常）

## 根因模式

### RC-F-01: MethodChannel 通信失败 (Channel Communication)

**现象**：Flutter 调用原生功能无响应或报错

**日志特征**：
```
E MethodChannel: Failed to handle method call: xxx
E FlutterError: PlatformException: xxx
```

**根因**：MethodChannel 名称不匹配，或原生侧未实现对应方法

**修复方向**：
- 检查 Flutter 侧和原生侧的 channel name 是否一致
- 确认原生侧已实现所有 method handler
- 检查参数序列化/反序列化是否正确

**置信度**：0.88

---

### RC-F-02: 插件鸿蒙化缺失 (Plugin OHOS Port Missing)

**现象**：插件功能不可用，日志显示未找到实现

**日志特征**：
```
E FlutterEngine: No OHOS implementation for plugin: xxx
W MethodChannel: Plugin not registered on OHOS platform
```

**根因**：插件只有 Android/iOS 实现，缺少鸿蒙化适配

**修复方向**：
- 为插件添加 ohos 目录和鸿蒙化实现
- 在插件的 pubspec.yaml 中配置 ohos 平台
- 参考插件的 Android 实现编写 ArkTS 等效代码

**置信度**：0.90

---

### RC-F-03: 平台 API 差异 (Platform API Difference)

**现象**：功能在 Android 正常，鸿蒙异常

**日志特征**：
```
W ArkTS: API not available: xxx
E Flutter: PlatformException: Unsupported operation
```

**根因**：鸿蒙系统 API 与 Android API 存在差异，直接移植导致功能异常

**修复方向**：
- 查找鸿蒙等效 API 替代
- 使用条件编译区分平台
- 封装平台适配层

**置信度**：0.82

---

### RC-F-04: 权限申请流程错误 (Permission Flow Error)

**现象**：功能调用时权限被拒绝

**日志特征**：
```
E AbilityContext: Permission denied: ohos.permission.xxx
W Flutter: User denied permission request
```

**根因**：权限申请时序错误，或未在 module.json5 中声明

**修复方向**：
- 在 module.json5 的 requestPermissions 中声明权限
- 在调用功能前动态申请权限
- 处理权限被拒绝的场景

**置信度**：0.87

---

### RC-F-05: 异步初始化未完成 (Async Init Incomplete)

**现象**：功能偶发不可用，重启后恢复

**日志特征**：
```
W FlutterEngine: Plugin initialization not complete
E MethodChannel: Call before plugin ready
```

**根因**：插件异步初始化未完成时就调用了功能方法

**修复方向**：
- 添加初始化完成回调
- 在调用前检查初始化状态
- 使用 Future 确保初始化完成后再调用

**置信度**：0.80

---

### RC-F-06: 数据序列化不兼容 (Serialization Mismatch)

**现象**：跨平台数据传递时数据丢失或格式错误

**日志特征**：
```
E MethodChannel: Argument deserialization failed
W Flutter: Received unexpected type: xxx
```

**根因**：Flutter 侧和原生侧的数据类型映射不一致

**修复方向**：
- 统一使用 JSON 格式传递复杂数据
- 检查基本类型映射（int/double/String/List/Map）
- 避免传递平台特有类型

**置信度**：0.84

---

### RC-F-07: 路由导航异常 (Route Navigation Error)

**现象**：页面跳转失败或跳转到错误页面

**日志特征**：
```
E Navigator: Route not found: /xxx
W Flutter: Could not navigate to route
```

**根因**：路由表配置错误，或命名路由未注册

**修复方向**：
- 检查路由表配置
- 确保所有命名路由已注册
- 使用 onGenerateRoute 处理动态路由

**置信度**：0.86

---

### RC-F-08: 生命周期状态错误 (Lifecycle State Error)

**现象**：特定生命周期阶段功能不可用

**日志特征**：
```
W FlutterEngine: Operation not allowed in current state: xxx
E Ability: Method called in wrong lifecycle phase
```

**根因**：在错误的生命周期阶段调用了功能方法

**修复方向**：
- 检查调用时的生命周期状态
- 在正确的生命周期回调中执行操作
- 添加状态检查守卫

**置信度**：0.83

## 诊断方法

### MethodChannel 日志采集

```bash
# 采集 MethodChannel 通信日志
hdc hilog | grep -i "method\|channel\|plugin" > channel_log.txt

# 采集插件注册日志
hdc hilog | grep -i "plugin\|register" > plugin_log.txt
```

### 跨平台对比分析

1. **Android 对比**：在 Android 设备上复现，对比行为差异
2. **日志对比**：对比 Android 和鸿蒙的 MethodChannel 日志
3. **API 对比**：对比 Android API 和鸿蒙 API 的差异

## 上游搜索关键词

| 场景 | 搜索源 | 关键词策略 |
|------|--------|-----------|
| 功能不工作 | Flutter Issues + 插件仓库 | 错误信息 + 组件名 |
| 鸿蒙特有 | Flutter-OHOS Issues | ohos + 功能名 + 现象 |
| 插件问题 | 插件仓库 Issues | 插件名 + ohos |
