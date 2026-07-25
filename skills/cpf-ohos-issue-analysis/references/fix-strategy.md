# OHOS 跨平台框架修复策略

> 本文档定义 OHOS 跨平台框架（Flutter-OHOS / React Native-OHOS / KMP-CMP 等）问题的修复策略，
> 供 `diagnosis-fix-advisor`（修复方案设计）和 `diagnosis-fix-verifier-advisor`（修复验证）参考。

## 核心原则：OHOS 独有问题优先 Native 层修复

### 为什么优先 Native 层

OHOS 跨平台框架的问题分两类：

| 问题类型 | 定义 | 修复策略 |
|---|---|---|
| **三端共性问题** | Android/iOS/OHOS 都存在 | 跟随上游修复，cherry-pick 或升级 |
| **OHOS 独有问题** | Android/iOS 正常，仅鸿蒙出现 | **优先 Native 层修复** |

OHOS 独有问题的根因通常在：
- Native 层（C++ Engine/Embedder）的平台适配代码
- ArkTS 平台实现层（MethodChannel/Plugin 的鸿蒙端）

在 Dart 层打补丁的问题：
1. **治标不治本**——Dart 层 workaround 只是绕过症状，Native 层的根因仍在
2. **引入分支逻辑**——Dart 层需要 `if (Platform.isOHOS)` 判断，增加维护成本
3. **三端行为不一致**——Dart 层补丁只影响 OHOS，可能导致后续三端逻辑分叉
4. **性能损耗**——Dart 层的额外检查/转换有运行时开销

### 修复层级优先级

```
1. Native 层（C++ / ArkTS）     ← 优先
   ↓ 无法修复时
2. Framework 鸿蒙化层            ← 其次
   ↓ 无法修复时
3. Dart 层 workaround            ← 最后（仅短期止血）
```

#### 各层适用场景

| 层级 | 适用场景 | 示例 |
|---|---|---|
| **Native (C++)** | Engine/Embedder 的平台适配缺陷 | 渲染管线、线程调度、内存管理、GPU 调用 |
| **Native (ArkTS)** | 平台 Channel/Plugin 的鸿蒙端实现 | MethodChannel 通信、权限处理、系统能力调用 |
| **Framework** | Flutter framework 的 OHOS 适配代码 | 平台视图、手势识别、生命周期适配 |
| **Dart** | 仅作为短期止血，等待 Native 修复 | 临时参数调整、输入预处理、降级方案 |

### 降级到 Dart 层的判断依据

只有满足以下**至少一项**时，才允许选择 Dart 层修复：

1. **Native 层无法修改**——闭源 SDK / 无源码权限 / 依赖未开源
2. **Native 层修改成本过高**——需要改 Engine 编译链，超出 Issue 修复范围
3. **紧急止血**——线上故障需要立即恢复，Native 修复周期长
4. **Dart 层修复更通用**——问题本质是跨平台逻辑，三端都需要调整

选择 Dart 层修复时，必须在 `risk_assessment` 中说明：
- 为何无法在 Native 层修复（对应上述 1-4 中的哪项）
- Native 层修复的长期计划（如"已提 Issue，等待 Engine 升级"）

## 输出字段规范

修复方案 JSON 中必须包含以下字段：

| 字段 | 值 | 说明 |
|---|---|---|
| `fix_code_layer` | `native` / `framework` / `dart` | 修复代码所在的层 |
| `is_ohos_specific` | `true` / `false` | 根因是否为 OHOS 端独有 |
| `fix_layer` | `application` / `plugin` / `framework` / `engine` / `system` | 根因所在层面（与 fix_code_layer 不同，前者是问题层面，后者是修复层面） |

### 字段组合判断

| is_ohos_specific | fix_code_layer | 要求 |
|---|---|---|
| `true` | `native` | ✅ 最佳实践 |
| `true` | `framework` | ⚠️ 可接受，说明为何 Native 层不合适 |
| `true` | `dart` | ❌ 必须在 risk_assessment 中说明降级理由 |
| `false` | 任意 | 跟随上游策略，无强制要求 |

## 验证要点（供 verifier-advisor 使用）

修复验证 Agent 应检查：

1. **`is_ohos_specific=true` 时是否遵循了 Native 优先**
   - `fix_code_layer=native` → 通过
   - `fix_code_layer=dart` → 检查 `risk_assessment` 是否说明了降级理由，未说明则 `verdict=fail`

2. **`fix_code_layer` 与 `root_cause_fix.file` 的一致性**
   - `native` → file 应为 `.cpp` / `.h` / `.ts` / `.ets`
   - `framework` → file 应在 framework ohos 适配目录
   - `dart` → file 应为 `.dart`

3. **Dart 层修复的长期计划**
   - `fix_code_layer=dart` 时，`upstream_collaboration` 中应有 Native 层修复的跟踪计划

## 典型案例

### 案例 1：Native 层修复（推荐）

**问题**：OHOS 端 JSON StringList 解码错误，Android/iOS 正常

**根因**：ArkTS 端 `Number.isInteger` 对 1.0 误判为 INT32

**修复**：
```json
{
  "is_ohos_specific": true,
  "fix_code_layer": "native",
  "root_cause_fix": {
    "file": "packages/pigeon/arkts/arkts_generator.ts",
    "change": "同步 Android 三态识别逻辑，1.0 不强制转 INT32"
  }
}
```

### 案例 2：Dart 层降级（需说明理由）

**问题**：OHOS 端某个 Engine API 返回值异常

**根因**：Engine C++ 层 bug，但 Engine 闭源无法修改

**修复**：
```json
{
  "is_ohos_specific": true,
  "fix_code_layer": "dart",
  "root_cause_fix": {
    "file": "lib/src/platform/ohos_codec.dart",
    "change": "对 OHOS 端返回值做二次校验"
  },
  "risk_assessment": {
    "regression_risk": "中",
    "dart_layer_reason": "Engine 闭源无法修改，已提 Issue 跟踪，Dart 层为临时止血"
  }
}
```
