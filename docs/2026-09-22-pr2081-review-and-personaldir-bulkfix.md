# 2026-09-22 PR 2081 停滞复盘 + 全量用户 personalDir 修复

## 时间

2026-09-22 18:10 – 18:30（+0800）

## 解决了什么问题

### PR 2081 停滞真相（回答"start build 失败为何不修代码"）

- **代码早已修复**：9/21 静态修复生成 4 行修复（MouseCursorPlugin.ets，fix.patch md5 4ef725a8），
  一直暂存在 run 工作区；作者 huangyouhua 本人 9/21 11:09 还手动 commit 过（191fe3c2）。
- **卡点是推送权限而非修复**：工作流推送需 `GITCODE_TOKEN_huangyouhua`，当时未配置（28 次实证），
  推送并触发 7 轮"推送无权限"→ 人工确认循环耗尽预算 → 9/22 09:39 run 被停止。
  start build 从未失败——修复没推出去，新 CI 没跑过。
- **令牌已注入但未被使用**：作者 Huangyouhua 已在 AIWeb 注入自己的令牌（da1d0fc7），
  但 run 在此之前已停止。
- **闭环条件**：引擎按 run 启动者注入环境变量 → 需 **Huangyouhua 本人**在 AIWeb 重新开启
  PR 2081 监控（其令牌才会进入 run 环境），工作流重新生成修复 → 有令牌 → 推送 + start build 闭环。
- 遗留风险提示：过静态后仍有 2 条【严重】AI 检视意见（destroy() 死代码 / L60 跨引擎干扰）会拦 PR。

### 全量 personalDir 数据修复（防共享 _template 复发）

PR 2081 复盘发现：若 Huangyouhua（personalDir 为空）启动监控，其 run 会再次共享
`_template` 触发并发互相 abort（引擎兜底代码需重启才生效，而当前有 parked run 不能重启）。
已将 **15 个 active 且 personalDir 为空的用户**（Huangyouhua/huangyouhua/CJ/huhaodong/
liujiake/hhd/gaoyu/hezhengyi/ouhaitao/lx123456789/HHHxm2/testnoCode/testBlocked/
huhaodong/ShijieQi）的 personalDir 置为 `/home/flutter`（备份 users.json.bak-20260922），
立即生效（user-store 每次读盘）。

### 验证

- PR 2081 当前：open、head 5179f00b 未变、labels 仍 [AI已检视, dco检查成功, 静态检查失败]；
- 旧 run 工作区仍在（staged 修复完好）；新监控 run 会重新生成修复，无需旧工作区；
- users.json 15 用户 personalDir 已生效。
