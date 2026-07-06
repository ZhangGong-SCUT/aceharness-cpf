# 鸿蒙跨平台框架 AI 诊断工作流 — 测试 Issue 集

> **筛选标准**:
> - 来源：仅 `CPF-Flutter/flutter_flutter`
> - Issue 已关闭 + 有对应已合并 PR（通过 GitCode API `/issues/{number}/pull_requests` 正向查询获取关联）
> - PR 合并状态已通过 GitCode API 逐一验证（`state=merged` 且 `merged_at` 非空）
> - PR 合入时间在近 6 个月内（2026-01-04 之后）
> - Issue 质量评分 ≥ 5（body长度 + 复现步骤 + 代码 + 错误信息 + 环境信息 + 截图 + 评论）
>
> **收集日期**: 2026-07-03
> **数据规模**: 扫描 2080 个已关闭 Issue，质量评分达标 455 个，最终匹配已合入 PR（近 6 个月内）22 个

---

## 测试 Issue 总览（22 个，全部来自 CPF-Flutter/flutter_flutter，PR 近 6 个月内合并）

| # | Issue | 标题 | PR | PR创建人 | PR合并日期 | 类型 | 评分 | Body | 评论 |
|---|--------|------|-----|---------|-----------|------|------|------|------|
| 1 | [#2012](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2012) | [3.41] 无法正常加载鸿蒙系统前置摄像头加载的图片 | [#1392](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1392) | huhaodong | 2026-06-17 | functional | 14 | 2736 | 3 |
| 2 | [#1919](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1919) | When the configuration item value in the split view configuration file is empty, the SDK will recognize its value as not empty. | [#1261](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1261) | liujiake | 2026-05-27 | functional | 14 | 3157 | 0 |
| 3 | [#1712](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1712) | TextField在选中文本的情况下，将应用切到后台，再切回来后选中文本被删除了 | [#1060](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1060) | ZuoYueLiang | 2026-04-14 | functional | 14 | 4654 | 1 |
| 4 | [#1551](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1551) | 3.35 Impeller issue drawing gradient on HarmonyOS | [#920](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/920) | zzx89757 | 2026-02-11 | rendering | 14 | 7294 | 0 |
| 5 | [#2078](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2078) | [3.41][LTPO]LTPO Performance Optimization | [#1430](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1430) | Kemin123 | 2026-06-25 | performance | 13 | 1614 | 1 |
| 6 | [#1546](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1546) | flutter3.32上PlatformViewOHOS::NotifyCreate中使用platform线程执行PlatformView::NotifyCreated(),可能导致crash | [#918](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/918) | liujiake | 2026-03-31 | stability | 13 | 2257 | 0 |
| 7 | [#1975](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1975) | [3.41]Fixed the issue of small mouse scroll step value | [#1327](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1327) | Kemin123 | 2026-06-04 | functional | 12 | 3960 | 0 |
| 8 | [#1781](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1781) | [OHOS][3.35] Fix PlatformView detach lifecycle | [#1117](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1117) | ZuoYueLiang | 2026-04-28 | rendering | 12 | 3641 | 0 |
| 9 | [#1765](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1765) | [ohos][3.35] Stop debug packaging after flutter assemble failure | [#1103](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1103) | ZuoYueLiang | 2026-04-21 | functional | 12 | 5252 | 0 |
| 10 | [#1763](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1763) | [OHOS][3.35] Fix physical PlatformView text-input focus handoff | [#1102](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1102) | ZuoYueLiang | 2026-05-11 | functional | 12 | 3293 | 0 |
| 11 | [#1761](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1761) | [3.35] Fix OHOS platform view direction binding | [#1101](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1101) | ZuoYueLiang | 2026-04-20 | functional | 12 | 3388 | 0 |
| 12 | [#1709](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1709) | 鸿蒙 flutter 应用都有的鼠标问题：按住左键时，点击右键，会导致左键无法释放。 | [#1189](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1189) | zhong_ning | 2026-05-18 | functional | 11 | 1259 | 6 |
| 13 | [#1772](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1772) | # Flutter OHOS SDK 问题报告：`EventChannel.endOfStream()` 未触发 Dart `onDone` | [#1116](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1116) | zhong_ning | 2026-04-25 | functional | 10 | 2980 | 2 |
| 14 | [#1574](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1574) | [CP] [3.35] [Bug]: On some GPUs, when the blending mode is set to multiply, a rendering error occurs where colors appear grayed out or whitened out. | [#936](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/936) | liujiake | 2026-02-25 | rendering | 10 | 1615 | 0 |
| 15 | [#2053](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2053) | Flutter 3.35.8-ohos-0.0.3，Dart 3.9.2，鸿蒙端启动后控制台上有NavigationChannel的崩溃报错 | [#1412](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1412) | zhong_ning | 2026-06-24 | stability | 9 | 3516 | 1 |
| 16 | [#1756](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1756) | [3.35]Fixed the issue where navigator steals/grabs focus. | [#1092](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1092) | Kemin123 | 2026-04-21 | functional | 9 | 1322 | 0 |
| 17 | [#1729](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1729) | [3.35][Bug]: Fixed incorrect tiltX and tiltY parameter passing in external texture scenarios | [#1070](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1070) | Kemin123 | 2026-04-15 | rendering | 9 | 1376 | 0 |
| 18 | [#1646](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1646) | [3.35]Fixed the bug of incorrect rate reporting for LTPO components, and added new debugging methods for LTPO | [#995](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/995) | Kemin123 | 2026-03-24 | performance | 9 | 1448 | 0 |
| 19 | [#1634](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1634) | [3.35] README and engine documentation contain outdated and inconsistent setup/build instructions | [#985](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/985) | ZuoYueLiang | 2026-03-16 | functional | 9 | 1244 | 1 |
| 20 | [#1572](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1572) | [3.35][Bug]: onInactive method was not triggered when the WebView became invisible. | [#934](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/934) | Kemin123 | 2026-03-04 | functional | 9 | 1264 | 0 |
| 21 | [#1527](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1527) | 【3.22】DFX能力路由跳转和标签页切换的检测 | [#903](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/903) | Kemin123 | 2026-02-04 | functional | 9 | 1160 | 0 |
| 22 | [#1941](https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1941) | 3.41.9 objective_c 编译报错 | [#1290](https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1290) | ZuoYueLiang | 2026-06-01 | functional | 8 | 1010 | 0 |

---

## 详细信息

### 1. #2012 — [3.41] 无法正常加载鸿蒙系统前置摄像头加载的图片（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2012
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1392 (merged 2026-06-17)
- **PR Title**: 【3.41】fix PixelMap ReadPixels
- **PR 创建人**: huhaodong
- **质量评分**: 14 | Body: 2736 chars | Comments: 3
- **评分明细**: body>500, body>1500, 复现步骤, 代码, 错误信息, 环境信息, 截图, 3+评论
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 2. #1919 — When the configuration item value in the split view configuration file is empty, the SDK will recognize its value as not empty.（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1919
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1261 (merged 2026-05-27)
- **PR Title**: 当分栏功能配置文件配置项值为空字符串时，要识别为无效值
- **PR 创建人**: liujiake
- **质量评分**: 14 | Body: 3157 chars | Comments: 0
- **评分明细**: body>500, body>1500, body>3000, 复现步骤, 代码, 错误信息, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 3. #1712 — TextField在选中文本的情况下，将应用切到后台，再切回来后选中文本被删除了（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1712
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1060 (merged 2026-04-14)
- **PR Title**: [OHOS] Fix #1712 avoid deleting selected text when finishing preview
- **PR 创建人**: ZuoYueLiang
- **质量评分**: 14 | Body: 4654 chars | Comments: 1
- **评分明细**: body>500, body>1500, body>3000, 复现步骤, 代码, 错误信息, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 4. #1551 — 3.35 Impeller issue drawing gradient on HarmonyOS（rendering）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1551
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/920 (merged 2026-02-11)
- **PR Title**: 【3.35】[Impeller] Fixed an issue where gradient effects on HarmonyOS devices exhibited clipping.
- **PR 创建人**: zzx89757
- **质量评分**: 14 | Body: 7294 chars | Comments: 0
- **评分明细**: body>500, body>1500, body>3000, 复现步骤, 代码, 错误信息, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 5. #2078 — [3.41][LTPO]LTPO Performance Optimization（performance）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2078
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1430 (merged 2026-06-25)
- **PR Title**: [3.41][LTPO]LTPO Performance Optimization
- **PR 创建人**: Kemin123
- **质量评分**: 13 | Body: 1614 chars | Comments: 1
- **评分明细**: body>500, body>1500, 复现步骤, 代码, 错误信息, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 6. #1546 — flutter3.32上PlatformViewOHOS::NotifyCreate中使用platform线程执行PlatformView::NotifyCreated(),可能导致crash（stability）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1546
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/918 (merged 2026-03-31)
- **PR Title**: [3.32]Change the execution thread of the NotifyCreated function to the raster thread. Previously, running it on the platform thread could cause timing issues in some scenarios.
- **PR 创建人**: liujiake
- **质量评分**: 13 | Body: 2257 chars | Comments: 0
- **评分明细**: body>500, body>1500, 复现步骤, 代码, 错误信息, 环境信息, 截图
- **问题描述**: ### Steps to reproduce 没有稳定的复现手段，问题现象是发生了crash，堆栈在PlatformViewOHOS::NotifyCreate中使用platform线程执行PlatformView::NotifyCreated()这一行。 ### Expected results

### 7. #1975 — [3.41]Fixed the issue of small mouse scroll step value（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1975
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1327 (merged 2026-06-04)
- **PR Title**: [3.41][AxisEvent]Fixed the issue of small mouse scroll step value
- **PR 创建人**: Kemin123
- **质量评分**: 12 | Body: 3960 chars | Comments: 0
- **评分明细**: body>500, body>1500, body>3000, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 8. #1781 — [OHOS][3.35] Fix PlatformView detach lifecycle（rendering）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1781
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1117 (merged 2026-04-28)
- **PR Title**: [OHOS][3.35] Fix PlatformView detach lifecycle
- **PR 创建人**: ZuoYueLiang
- **质量评分**: 12 | Body: 3641 chars | Comments: 0
- **评分明细**: body>500, body>1500, body>3000, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 9. #1765 — [ohos][3.35] Stop debug packaging after flutter assemble failure（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1765
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1103 (merged 2026-04-21)
- **PR Title**: [ohos][3.35] Stop debug packaging after flutter assemble failure
- **PR 创建人**: ZuoYueLiang
- **质量评分**: 12 | Body: 5252 chars | Comments: 0
- **评分明细**: body>500, body>1500, body>3000, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 10. #1763 — [OHOS][3.35] Fix physical PlatformView text-input focus handoff（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1763
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1102 (merged 2026-05-11)
- **PR Title**: [OHOS][3.35] Fix physical PlatformView text-input focus handoff
- **PR 创建人**: ZuoYueLiang
- **质量评分**: 12 | Body: 3293 chars | Comments: 0
- **评分明细**: body>500, body>1500, body>3000, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 11. #1761 — [3.35] Fix OHOS platform view direction binding（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1761
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1101 (merged 2026-04-20)
- **PR Title**: [3.35] Fix OHOS platform view direction binding
- **PR 创建人**: ZuoYueLiang
- **质量评分**: 12 | Body: 3388 chars | Comments: 0
- **评分明细**: body>500, body>1500, body>3000, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 12. #1709 — 鸿蒙 flutter 应用都有的鼠标问题：按住左键时，点击右键，会导致左键无法释放。（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1709
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1189 (merged 2026-05-18)
- **PR Title**: 修复鼠标左右键按键异常
- **PR 创建人**: zhong_ning
- **质量评分**: 11 | Body: 1259 chars | Comments: 6
- **评分明细**: body>500, 复现步骤, 代码, 环境信息, 截图, 3+评论, 5+评论
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 13. #1772 — # Flutter OHOS SDK 问题报告：`EventChannel.endOfStream()` 未触发 Dart `onDone`（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1772
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1116 (merged 2026-04-25)
- **PR Title**: Fixed the issue where EventChannel.endOfStream() method did not trigger the onDone event in Dart
- **PR 创建人**: zhong_ning
- **质量评分**: 10 | Body: 2980 chars | Comments: 2
- **评分明细**: body>500, body>1500, 复现步骤, 代码, 环境信息
- **问题描述**: # Flutter OHOS SDK 问题报告：`EventChannel.endOfStream()` 未触发 Dart `onDone` ## 背景 在 OHOS 原生侧通过 `@ohos/flutter_ohos` 的 `EventChannel` 调用 `EventSink.endOfStream()` 后，Dart 侧 `receiveBroadcastStream().listen(o

### 14. #1574 — [CP] [3.35] [Bug]: On some GPUs, when the blending mode is set to multiply, a rendering error occurs where colors appear grayed out or whitened out.（rendering）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1574
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/936 (merged 2026-02-25)
- **PR Title**: [3.35] [CP] Fixed the issue where the screen turns white/gray on some GPUs when using the multiply blend mode
- **PR 创建人**: liujiake
- **质量评分**: 10 | Body: 1615 chars | Comments: 0
- **评分明细**: body>500, body>1500, 复现步骤, 错误信息, 环境信息
- **问题描述**: ### The current branches can be found under release-candidate-branch.version for [beta](https://github.com/flutter/flutter/blob/beta/bin/internal/release-candidate-branch.version) and [stable](https:/

### 15. #2053 — Flutter 3.35.8-ohos-0.0.3，Dart 3.9.2，鸿蒙端启动后控制台上有NavigationChannel的崩溃报错（stability）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/2053
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1412 (merged 2026-06-24)
- **PR Title**: fix NavigationChannel crash error
- **PR 创建人**: zhong_ning
- **质量评分**: 9 | Body: 3516 chars | Comments: 1
- **评分明细**: body>500, body>1500, body>3000, 错误信息, 环境信息
- **问题描述**: 06-18 13:04:51.649   15179-15179   A000ff/Flutter                  com.babygada.app      E     MethodChannel# --> Failed to handle method callCannot read property get of null    at notifyPageChanged @

### 16. #1756 — [3.35]Fixed the issue where navigator steals/grabs focus.（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1756
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1092 (merged 2026-04-21)
- **PR Title**: [3.35]Fixed the issue where navigator steals/grabs focus.
- **PR 创建人**: Kemin123
- **质量评分**: 9 | Body: 1322 chars | Comments: 0
- **评分明细**: body>500, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 17. #1729 — [3.35][Bug]: Fixed incorrect tiltX and tiltY parameter passing in external texture scenarios（rendering）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1729
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1070 (merged 2026-04-15)
- **PR Title**: [3.35]Fixed incorrect tiltX and tiltY parameter passing in external texture scenarios
- **PR 创建人**: Kemin123
- **质量评分**: 9 | Body: 1376 chars | Comments: 0
- **评分明细**: body>500, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 18. #1646 — [3.35]Fixed the bug of incorrect rate reporting for LTPO components, and added new debugging methods for LTPO（performance）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1646
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/995 (merged 2026-03-24)
- **PR Title**: [3.35]Fixed the bug of incorrect rate reporting for LTPO components, and added new debugging methods for LTPO
- **PR 创建人**: Kemin123
- **质量评分**: 9 | Body: 1448 chars | Comments: 0
- **评分明细**: body>500, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 19. #1634 — [3.35] README and engine documentation contain outdated and inconsistent setup/build instructions（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1634
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/985 (merged 2026-03-16)
- **PR Title**: [3.35] docs: clean up OHOS readmes
- **PR 创建人**: ZuoYueLiang
- **质量评分**: 9 | Body: 1244 chars | Comments: 1
- **评分明细**: body>500, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: ### Steps to reproduce OHOS-related documentation in this repository: - `README.md`

### 20. #1572 — [3.35][Bug]: onInactive method was not triggered when the WebView became invisible.（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1572
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/934 (merged 2026-03-04)
- **PR Title**: [3.35] Fixed: onInactive method was not triggered when the WebView became invisible.
- **PR 创建人**: Kemin123
- **质量评分**: 9 | Body: 1264 chars | Comments: 0
- **评分明细**: body>500, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 21. #1527 — 【3.22】DFX能力路由跳转和标签页切换的检测（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1527
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/903 (merged 2026-02-04)
- **PR Title**: [3.22] Added detection capabilities for navigator and TabBarView switching.
- **PR 创建人**: Kemin123
- **质量评分**: 9 | Body: 1160 chars | Comments: 0
- **评分明细**: body>500, 复现步骤, 代码, 环境信息, 截图
- **问题描述**: Thank you for using Flutter! If you are looking for support, please check out our documentation or consider asking a question on Stack Overflow:

### 22. #1941 — 3.41.9 objective_c 编译报错（functional）

- **Issue**: https://gitcode.com/CPF-Flutter/flutter_flutter/issues/1941
- **PR**: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1290 (merged 2026-06-01)
- **PR Title**: Fix OHOS native asset hook OS compatibility
- **PR 创建人**: ZuoYueLiang
- **质量评分**: 8 | Body: 1010 chars | Comments: 0
- **评分明细**: body>500, 代码, 错误信息, 环境信息
- **问题描述**: 升级到 3.41.9 后 pubspec.lock 会强制增加一项 objective_c objective_c: dependency: transitive

---

## 统计

| 类型 | 数量 | 质量评分范围 |
|------|------|-------------|
| 稳定性 (stability) | 2 | 9-13 |
| 内存泄漏 (memory-leak) | 0 | — |
| 渲染 (rendering) | 4 | 9-14 |
| 性能 (performance) | 2 | 9-13 |
| 功能 (functional) | 14 | 8-14 |
| **总计** | **22** | **8-14** |

## 质量保证

每个 Issue 均满足以下全部条件：
- ✅ 来源：`CPF-Flutter/flutter_flutter`
- ✅ Issue 已关闭（state=closed）
- ✅ 有对应的已合并 PR（通过 GitCode API `/issues/{number}/pull_requests` 正向查询获取关联）
- ✅ PR 合入时间在近 6 个月内（2026-01-04 之后）
- ✅ PR 合并时间已确认（merged_at 字段非空）
- ✅ PR 合并状态已验证（state=merged）
- ✅ 质量评分 ≥ 5（body长度 + 复现步骤 + 代码 + 错误信息 + 环境信息 + 截图 + 评论）

## 数据收集方法

1. **获取已关闭 Issue**: 通过 GitCode API v5 `GET /repos/CPF-Flutter/flutter_flutter/issues?state=closed` 分页获取所有已关闭 Issue（共扫描 2080 条）
2. **时间范围过滤**: 按 `updated_at` 过滤近 6 个月内的 Issue（2026-01-04 之后，共 2078 条）
3. **质量评分**: 对每个 Issue 按 body长度、复现步骤、代码示例、错误信息、环境信息、截图、评论数进行评分，筛选 score ≥ 5（共 455 条）
4. **查询 Issue-PR 关联**: 通过 `GET /repos/CPF-Flutter/flutter_flutter/issues/{number}/pull_requests` 正向查询每个高质量 Issue 关联的 PR
5. **验证 PR 合并状态**: 逐一通过 `GET /repos/CPF-Flutter/flutter_flutter/pulls/{pr_number}` 获取 PR 详情，确认 `state=merged` 且 `merged_at` 非空，且合入时间在近 6 个月内
6. **最终匹配**: 同时满足「质量评分达标」和「关联了已合入 PR」的 Issue 纳入测试集（共 22 条）
