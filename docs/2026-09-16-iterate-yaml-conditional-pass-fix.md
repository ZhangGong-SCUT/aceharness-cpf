# 2026-09-16 反馈迭代工作流启动失败——上下文装载缺 conditional_pass 转移

## 时间

2026-09-16 18:00 – 18:10（+0800）

## 解决了什么问题

### 问题

用户在 AIWeb 提交诊断反馈迭代（issue 2646），任务 3 秒后即失败：

```
AceHarness run run-1789551765583-1a30629d 已丢失（服务可能已重启）
```

实查（`/tmp/opencode/aceharness-server.log`）真实原因：

```
[Workflow] start failed for cpf-ohos-diagnosis-iterate.yaml:
状态机运行前校验失败：非终止状态必须完整配置 pass / conditional_pass / fail
三条转移路径。异常状态：上下文装载（缺少 conditional_pass）
```

因果链：
1. 新引擎硬门禁 `assertRequiredVerdictTransitions`（workflow-manager.ts:7872）要求每个非终态
   三条 verdict 转移齐全且无额外转移——`8826a7d` 新增的迭代配置漏配；
2. 启动接口对 `manager.start()` 是异步发射后不管（start/route.ts:404），校验失败照样返回
   `success: true + runId`，错误只写服务日志——调用方（AIWeb）无法感知；
3. run 目录只建了 `configs/` 快照就死亡（无 state.yaml、零事件）；
4. AIWeb 首次轮询判"run 丢失"，自愈读盘无报告 → 标记 failed，猜测文案"服务可能已重启"误导排查方向。

### 方案

`configs/cpf-ohos-diagnosis-iterate.yaml` 上下文装载状态补齐转移（与任务文本中
`context_completeness（complete|partial）` 的既定语义对齐）：

- pass → 方案设计（p1，恢复完整）
- **conditional_pass → 方案设计（p2，新增：repo 未还原到原轮精确 commit、回退分支最新，
  context_completeness=partial，带标注继续）**
- fail → 终止（p2→p3，黄金标志/Demo 不可恢复）

同步修改任务文本第 3 条，明确 conditional_pass 的判定条件。仓库副本与部署副本
（`~/.aceharness/configs/`）已同步。

### 验证结果

1. 硬门禁静态扫描（复刻引擎规则）：4 个 state-machine 配置全部通过
   （主诊断 / flutter-ohos-diagnosis / gitcode-pr-review 此前已适配，仅迭代配置违规）；
2. **端到端**：以用户原始反馈重新提交 → 新 run `run-1789560381651-101538ea` 通过门禁，
   事件库正常记录（preparing → running → 进入上下文装载），run 目录含 state.yaml，
   AIWeb 任务进入 `issueanalysis_analyzing`；服务日志无新增 start failed。

## 遗留（引擎侧建议，未随本次修改）

- `start/route.ts:404` 异步发射后不管：运行前校验宜同步执行并在启动接口返回 400，
  否则调用方永远拿不到失败原因（AIWeb 侧已在 run 丢失文案中区分"启动失败/重启丢失"两种症状兜底）。
