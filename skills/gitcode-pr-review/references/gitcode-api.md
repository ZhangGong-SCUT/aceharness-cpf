# GitCode PR 自修 API

默认 API 根：`https://gitcode.com/api/v5`  
Token：`GITCODE_TOKEN` / `ACE_GITCODE_TOKEN`。

## PR 与作者

```
GET /repos/{owner}/{repo}/pulls/{number}
```

`user.login` 必须在 `ACE_GITCODE_PR_AUTHOR` 白名单。  
`head.repo.full_name` 是 fork，push 目标是它，不是上游仓。

## 门禁

不要用 `GET /repos/{owner}/{repo}/commits/{sha}/status`（本仓 404）。

改读：

```
GET /repos/{owner}/{repo}/pulls/{number}
GET /repos/{owner}/{repo}/issues/{number}/labels
GET /repos/{owner}/{repo}/issues/{number}/comments
```

看标签：`dco检查成功/失败`、`静态检查成功/失败`、`编译成功/失败`、`冒烟测试成功/失败`。  
看 `openharmony_ci` 评论和作者的 `start build`。

## AI 检视意见

```
GET /repos/{owner}/{repo}/pulls/{number}/comments
GET /repos/{owner}/{repo}/issues/{number}/comments
GET /repos/{owner}/{repo}/pulls/{number}/reviews
```

只有标签、没有意见正文 → 无需改。

## 评论 start build

```
POST /repos/{owner}/{repo}/issues/{number}/comments
{ "body": "start build" }
```

禁止自动发 `submit`。

## Webhook

- URL：`{公网 origin}/api/gitcode/webhook?password={ACE_GITCODE_WEBHOOK_SECRET}`
- 事件：Merge Request + Note
- `ACE_GITCODE_PR_AUTHOR=你的GitCode用户名`
- 正式监听：`ACE_GITCODE_WATCH_REPOS=CPF-Flutter/flutter_flutter`
