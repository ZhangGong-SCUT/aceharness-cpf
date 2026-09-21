# 2026-09-21 批量启动监控失败（续）——共享 _template 工作目录致并发 run 互相 abort

## 时间

2026-09-21 11:30 – 12:10（+0800）

## 解决了什么问题

### 问题

启动串行限流（见 2026-09-21-monitor-start-throttle.md）部署后，用户 11:24 再次批量开启监控
（10s 间隔排队正常工作），**仍然大面积失败**（同批也有部分成功）。错误仍是
`event stream ended before session idle` / `AI 服务中断：未产生任何输出`。

### 排查过程（关键证据链）

1. 失败 session 在用户的专属 opencode 服务器（按用户 spawn，40807）上：assistant 消息
   **0 token、472ms 即 `MessageAbortedError: Aborted`**——模型根本没开始生成就被中止；
2. 同服务器裸测（session/prompt/异步链路/目录过滤 SSE）全部正常——排除服务器与模型问题；
3. **快照对比 162 个 PR run**：失败的 run `workingDirectory` 全是共享模板目录
   `~/.aceharness/_template`，健康的 run（如 pr2081，webhook 启动）全用独立目录
   `/home/flutter/run-<runId>`；
4. 用户记录对比：admin(flutter) `personalDir=/home/flutter`（webhook 以它启动 → 独立目录），
   **zhanggong1 / zhanggong 的 `personalDir` 为空** → 引擎 `isolated-copy` 隔离条件
   `&& this._userPersonalDir` 不满足 → **跳过目录隔离，全部 run 共享 _template**。

### 根因

多个并发 run 共享同一个 opencode 项目目录（_template）：每个步骤启动都要
`config.update` 注册 agent → opencode 项目热重载 → **把其他 run 正在生成中的消息 abort 掉、
SSE 流断开**。识别步骤耗时 20-60s，10s 间隔的排队反而保证了每个新 run 的注册必然落在
前序 run 的生成窗口内。同批成败混合 = 注册与生成窗口重叠的时序运气。
（引擎 3 次瞬时自动恢复重试也全落在 churn 窗口内——退避修复已另行提交待重启生效。）

### 方案（双层）

1. **数据修复（立即生效，users.json 无缓存每次读盘）**：zhanggong1、zhanggong 的
   `personalDir` 置为 `/home/flutter`（与 admin 相同，运行目录 `/home/flutter/run-<runId>`）。
   已备份 `users.json.bak-20260921`。
2. **引擎兜底（已构建，下次重启生效）**：`isolated-copy` 不再依赖 personalDir 非空——
   为空时回退 `~/.aceharness/run-workspaces/<runId>` 独立目录，杜绝未来新用户踩同坑。

### 验证结果

- 用户数据修复后无需重启（user-store 每次读盘），下一次启动监控即获得独立工作目录；
- 引擎改动 `tsc --noEmit` 通过、生产构建成功；提交时分离暂存（workflow-manager.ts 混有
  他人未提交的 consumeQueuedApproval 功能，已按规范只提交自己的 hunk）；
- 建议用户先开 1 个监控验证（快照 workingDirectory 应为 /home/flutter/run-<runId>），再批量。

## 关联

- 前置：docs/2026-09-21-monitor-start-throttle.md（启动串行限流，本篇证明它必要但不充分）
- 引擎自动恢复退避（20/40/60s）已提交待重启，与本修复互补。
