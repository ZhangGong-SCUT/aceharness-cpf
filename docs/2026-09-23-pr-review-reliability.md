# PR 检视稳定性与速度修复

- 时间：2026-09-23 10:14（Asia/Shanghai）
- 问题：PR 身份和门禁判定重复经过 AI 质疑/裁决，响应慢且可重复性差；运行状态详情接口还会聚合与步骤进度无关的大量数据。
- 方案：身份准入改由 `validate-pr-identity.mjs` 对运行上下文做确定性校验；保留 `check-pr-gates.mjs` 的实时门禁判定，删除两个状态中重复的 AI 质疑和裁决步骤。精确 runId 查询支持 run-history 过滤。紧凑状态响应附带轻量 final review，供进度卡片继续展示。
- 验证：身份脚本 `node --check`、PR 工作流 YAML 解析和本次涉及的 tracked 文件 `git diff --check` 通过；未运行测试套件。
