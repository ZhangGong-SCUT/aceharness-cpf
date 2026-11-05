# GitCode PR 自修 API

默认 API 根：`https://gitcode.com/api/v5`  
Token：每人 `GITCODE_TOKEN_{用户名}`。评论 `start build` 必须用 PR 作者自己的密钥。未匹配到具体人时才回退 `GITCODE_TOKEN` / `ACE_GITCODE_TOKEN`。

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
GET /repos/{owner}/{repo}/pulls/{number}/comments
```

看标签：`dco检查成功/失败`、`静态检查成功/失败`、`编译成功/失败`、`冒烟测试成功/失败`。  
看 `openharmony_ci` 评论和作者的 `start build`。

GitCode 的 **Issue 号和 PR 号独立**。`GET issues/{n}/comments` 可能是另一张同号 Issue，不能当成 PR 讨论区。  
PR 页上的欢迎语、`start build`、文件区 Note 在 `pulls/{n}/comments`（`comment_type=pr_comment`）。  
同号 Issue 的 `DiscussionNote` 必须丢掉，否则会误判已经 `start build`。

## AI 检视意见

```
GET /repos/{owner}/{repo}/pulls/{number}/comments
GET /repos/{owner}/{repo}/pulls/{number}/reviews
```

`issues/{number}/comments` 只作兼容读取，且必须丢掉 `target.issue` / `DiscussionNote`（同号 Issue）。

只有标签、没有意见正文 → 无需改。

## 评论 start build

```
POST /repos/{owner}/{repo}/pulls/{number}/comments
{ "body": "start build" }
```

不要 POST `issues/{number}/comments`：会写到同号 Issue，PR 网页上看不见，也不会触发 DCP。  
`path` / `position` 可省略，这样才是 PR 讨论区评论，不是文件行评。

禁止自动发 `submit`。

## Webhook

- URL：`{公网 origin}/api/gitcode/webhook?password={ACE_GITCODE_WEBHOOK_SECRET}`
- 事件：Merge Request + Note
- `ACE_GITCODE_PR_AUTHOR=你的GitCode用户名`
- 正式监听：`ACE_GITCODE_WATCH_REPOS=CPF-Flutter/*`；如需限定范围，可列出逗号分隔的具体 `owner/repo`。
