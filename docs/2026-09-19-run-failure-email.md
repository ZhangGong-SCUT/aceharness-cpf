# 2026-09-19 邮箱通知补全——run 级失败（failed/crashed）必发邮件

## 时间

2026-09-19 15:30 – 15:45（+0800）

## 解决了什么问题

### 问题

用户反馈希望"失败或成功时发邮件"。现状盘点（邮件系统启用中，QQ SMTP）：

| 场景 | 事件 | 之前是否发邮件 |
|---|---|---|
| PR 门禁全绿等人评审 | state-change → 就绪 | ✅ |
| run 正常完成 | state-change → 完成 | ✅ |
| run 正常终止 | state-change → 终止 | ✅ |
| 人工确认/检视修复决策 | human-question-required | ✅ |
| **run 引擎异常停止** | **status=failed**（"引擎异常，已停止工作流：ACP timeout" 等） | ❌ 缺口 |
| **硬门禁拒绝标 completed**（修复验证未过黄金标志） | **status=failed** | ❌ 缺口 |
| run 崩溃 | status=crashed | ❌ 缺口 |

近 400 条 status 事件中 failed 占 16 条——含引擎异常与"不得标 completed"硬门禁拒绝，均无任何通知，
用户只能自己发现任务"卡住"。根因：渠道事件桥只订阅了 6 种事件（human-question/approval-required、
state-change、step-complete、transition、feedback-injected），未订阅 `status`。

### 方案

1. `src/lib/notify/workflow-event-email.ts` 新增 `sendWorkflowRunFailureEmailNotification`：
   - status ∈ {failed, crashed} 触发；**绕过 notifyStates 过滤**（失败是安全网事件，邮件启用即必发）
   - 收件人/线程/主题/gate 摘要逻辑与状态邮件一致（owner + cc，PR 邮件带门禁失败原因，同 run 线程折叠）
   - 文案区分「运行失败 / 运行崩溃」；去重键 `runId:run-status`（内存级）
   - 手动 stop（stopped）**不**发——用户自己停的，自己知道
2. `src/lib/channel/delivery.ts`：事件桥订阅 `status`；邮件钩子置于 `formatWorkflowEvent` 过滤之前
   （status 不进渠道分发，仅触发失败邮件——running/preparing 等高频状态零成本跳过）。

成功侧（就绪/完成/终止）已有 notifyStates 覆盖，未改动。

### 验证结果

1. 单测 `tests/workflow-run-failure-email.test.ts` 5 项全过（failed 发送、非失败状态不发、
   同 run 去重、crashed 文案、缺 runId 拒绝）；既有状态邮件测试 11 项无回归（共 16/16）；
2. `tsc --noEmit` 无本次文件错误；`npm run build` 生产构建成功；
3. 构建产物（.next chunks）含新函数；已按标准环境变量（ACE_PORT=3031 等）重启 AceHarness，
   `:3031/:3000` 双服务健康；
4. 真实失败场景（引擎异常等）将在下次自然发生时验证端到端投递。

## 备注

- delivery.ts 混有他人未提交的状态邮件功能 hunks，本次仅用 git add 分离暂存自己的改动；
  工作区保留双方改动，运行版本含两者。
- 已知未覆盖：启动前校验失败（fire-and-forget，零事件）仍无通知——见
  `docs/2026-09-16-iterate-yaml-conditional-pass-fix.md` 遗留项。
