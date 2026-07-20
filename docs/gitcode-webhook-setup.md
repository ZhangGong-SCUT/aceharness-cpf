# GitCode Webhook 自动诊断配置指南

## 功能概述

在 GitCode 仓库中创建 Issue 时，自动触发 ACEHarness 诊断工作流，分析完成后将诊断报告回写到 Issue 评论。

## 工作流程

```
GitCode Issue 创建 → Webhook → ACEHarness API → 启动诊断工作流
                                                    ↓
                                              信息采集 → 问题复现 → 分类定界 → 根因分析 → 修复建议 → 报告沉淀 → 完成
                                                    ↓
                                              读取诊断报告 → 回写到 Issue 评论
```

## 配置步骤

### 第一步：配置环境变量

在 ACEHarness 服务启动前设置以下环境变量：

```bash
# Webhook 密钥（与 GitCode webhook 设置中的 Secret 一致）
export WEBHOOK_SECRET="your-webhook-secret"

# GitCode API token（用于回写评论，需要 issues:write 权限）
export GITCODE_ACCESS_TOKEN="your-gitcode-access-token"

# 工作流配置文件（默认 cpf-ohos-diagnosis.yaml）
export WEBHOOK_CONFIG_FILE="cpf-ohos-diagnosis.yaml"

# 默认用户 ID（可选，不设则自动选择第一个用户）
export WEBHOOK_DEFAULT_USER_ID=""
```

或写入 `.env` 文件：

```env
WEBHOOK_SECRET=your-webhook-secret
GITCODE_ACCESS_TOKEN=your-gitcode-access-token
WEBHOOK_CONFIG_FILE=cpf-ohos-diagnosis.yaml
WEBHOOK_DEFAULT_USER_ID=
```

### 第二步：在 GitCode 仓库配置 Webhook

1. 打开 GitCode 仓库 → **设置** → **Webhooks**
2. 点击 **添加 Webhook**
3. 填写配置：

| 字段 | 值 |
|------|-----|
| **URL** | `http://<your-server>:3000/api/webhook/gitcode` |
| **Content-Type** | `application/json` |
| **Secret** | 与 `WEBHOOK_SECRET` 环境变量一致 |
| **触发事件** | 勾选 **Issue events** |

4. 点击 **添加**

### 第三步：测试 Webhook

#### 方法 1：在 GitCode 中创建测试 Issue

在配置了 webhook 的仓库中创建一个新 Issue，观察 ACEHarness 是否自动启动诊断。

#### 方法 2：用 curl 模拟 Webhook

```bash
curl -X POST http://127.0.0.1:3000/api/webhook/gitcode \
  -H "Content-Type: application/json" \
  -H "X-Gitcode-Token: your-webhook-secret" \
  -d '{
    "action": "opened",
    "issue": {
      "number": 1,
      "title": "测试 Issue",
      "body": "测试自动诊断",
      "state": "open",
      "html_url": "https://gitcode.com/your-org/your-repo/issues/1",
      "created_at": "2026-07-09T12:00:00+08:00",
      "user": { "login": "test-user" }
    },
    "repository": {
      "full_name": "your-org/your-repo",
      "name": "your-repo",
      "namespace": "your-org"
    }
  }'
```

#### 方法 3：查看 Webhook 状态

```bash
curl http://127.0.0.1:3000/api/webhook/gitcode
```

返回：

```json
{
  "endpoint": "/api/webhook/gitcode",
  "method": "POST",
  "description": "GitCode Issue Webhook 接收端点，自动触发诊断工作流并回写报告",
  "config": {
    "webhookSecret": "已配置",
    "gitcodeToken": "已配置",
    "configFile": "cpf-ohos-diagnosis.yaml",
    "defaultUserId": "自动选择第一个用户"
  }
}
```

## API 说明

### POST /api/webhook/gitcode

接收 GitCode Issue webhook 事件，自动启动诊断工作流。

**请求头**：
- `Content-Type: application/json`
- `X-Gitcode-Token: <webhook-secret>`（可选，如果配置了 WEBHOOK_SECRET）

**请求体**（GitCode webhook 标准格式）：

```json
{
  "action": "opened",
  "issue": {
    "number": 1,
    "title": "Issue 标题",
    "body": "Issue 正文",
    "state": "open",
    "html_url": "https://gitcode.com/{owner}/{repo}/issues/{number}",
    "created_at": "2026-07-09T12:00:00+08:00",
    "user": { "login": "username" }
  },
  "repository": {
    "full_name": "{owner}/{repo}",
    "name": "repo-name",
    "namespace": "owner"
  }
}
```

**响应**：

```json
{
  "success": true,
  "message": "诊断工作流已启动，完成后将自动回写报告到 Issue 评论",
  "runId": "run-1783599932104-f068dd7f",
  "issue": {
    "number": "1",
    "title": "Issue 标题",
    "url": "https://gitcode.com/...",
    "repository": "owner/repo"
  }
}
```

### 自动回写评论

工作流完成后（最多等待 1 小时），自动将诊断报告回写到 Issue 评论：

```markdown
## 🤖 ACEHarness 自动诊断报告

> 本报告由 ACEHarness 自动诊断工作流生成，Issue 创建后自动触发。

**Issue**: Issue 标题
**Run ID**: `run-xxx`
**诊断状态**: ✅ 完成
**诊断时间**: 2026-07-09T12:30:00.000Z

---

（诊断报告内容）

---

> 由 [ACEHarness](http://127.0.0.1:3000) 自动生成 | Run ID: `run-xxx`
```

## 注意事项

1. **Webhook 密钥**：建议配置 `WEBHOOK_SECRET`，防止未授权请求
2. **GitCode Token**：`GITCODE_ACCESS_TOKEN` 需要有 `issues:write` 权限才能回写评论
3. **工作流排队**：如果已有工作流在运行，新 webhook 请求会返回 409
4. **超时**：监控工作流最多等待 1 小时，超时后不再回写评论
5. **网络**：ACEHarness 服务需要能访问 GitCode API（`https://gitcode.com`）
6. **用户**：webhook 触发的工作流需要一个系统用户，默认使用 tokens.json 中的第一个用户

## 故障排查

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| Webhook 返回 401 | 密钥不匹配 | 检查 `WEBHOOK_SECRET` 与 GitCode webhook 设置中的 Secret |
| Webhook 返回 409 | 工作流已在运行 | 等待当前工作流完成，或手动停止 |
| Webhook 返回 500 | 用户未配置 | 设置 `WEBHOOK_DEFAULT_USER_ID` 或确保 tokens.json 有用户 |
| 评论未回写 | GitCode token 无权限 | 检查 `GITCODE_ACCESS_TOKEN` 是否有 issues:write 权限 |
| 评论未回写 | 工作流超时 | 检查工作流是否在 1 小时内完成 |
| 工作流未启动 | 配置文件不存在 | 检查 `WEBHOOK_CONFIG_FILE` 指向的配置文件是否存在 |
