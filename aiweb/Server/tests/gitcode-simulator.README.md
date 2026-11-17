# GitCode 本地模拟器使用指南

## 目的

在**不请求真实 GitCode、不创建真实 PR**的前提下，测试 ACEHarness/AIWeb 的 PR 提交与监控链路：

- PR 提交：创建 Issue/PR、按作者搜索 Issue、分支和仓库文件读取
- PR 监控：门禁分类、AI 检视意见、diff 拉取、测试人审批、webhook 唤醒
- 修复回推：本地 bare 仓、push 确认、版本重置和重新触发门禁

模拟器只模拟 GitCode API，不是 GitCode 的完整克隆。外部 DCP 报告和日志下载协议的覆盖范围见「当前边界」。

## 启动

在仓库根目录执行：

```bash
node aiweb/Server/tests/gitcode-simulator.mjs --port 3999 --root /tmp/ace-gitcode-sim
curl http://127.0.0.1:3999/_sim/reset
```

需要脱离终端常驻时，可用 `nohup` 启动并记录 PID：

```bash
nohup node aiweb/Server/tests/gitcode-simulator.mjs --port 3999 --root /tmp/ace-gitcode-sim \
  >/tmp/gitcode-sim.log 2>&1 & echo $! >/tmp/gitcode-sim.pid
```

服务仅监听 `127.0.0.1`。模拟器没有真正的鉴权，不应暴露到公网。控制接口与 GitCode API 均不需要有效线上令牌。

```bash
# AIWeb、能力探测和技能脚本全部指向本地服务
export GITCODE_API_ROOT=http://127.0.0.1:3999/api/v5
export GITCODE_ORG_API_ROOT=http://127.0.0.1:3999/api/v5
export ACE_GITCODE_WEBHOOK_SECRET=test-webhook-secret
```

**环境变量必须在启动 AIWeb/ACE 进程之前设置。** 仅修改当前终端不会重配已经运行的服务。

## 本地 git 承载

用 `GIT_CONFIG_GLOBAL` 隔离改写规则，不能写入日常 `~/.gitconfig`：

```bash
export GIT_CONFIG_GLOBAL=/tmp/ace-gitcode-sim/gitconfig
git config --global url.file:///tmp/ace-gitcode-sim/host/.insteadOf https://gitcode.com/
```

准备上游仓、fork 仓和初始 master 分支：

```bash
mkdir -p /tmp/ace-gitcode-sim/host/CPF-Flutter /tmp/ace-gitcode-sim/host/z2036709353
git init --bare /tmp/ace-gitcode-sim/host/CPF-Flutter/flutter_flutter.git
git init --bare /tmp/ace-gitcode-sim/host/z2036709353/flutter_flutter.git

SEED=$(mktemp -d)
git -C "$SEED" init -b master
git -C "$SEED" config user.email seed@example.com
git -C "$SEED" config user.name seed
echo base >"$SEED/a.txt"
git -C "$SEED" add a.txt
git -C "$SEED" commit -m base
git -C "$SEED" push /tmp/ace-gitcode-sim/host/CPF-Flutter/flutter_flutter.git master:master
git -C "$SEED" push /tmp/ace-gitcode-sim/host/z2036709353/flutter_flutter.git master:master
```

将以下内容保存为 `/tmp/ace-gitcode-sim/host/z2036709353/flutter_flutter.git/hooks/post-receive`，并执行 `chmod +x`：

```bash
#!/bin/bash
while read -r oldrev newrev refname; do
  case "$refname" in
    refs/heads/*)
      curl -sS -m 5 -X POST http://127.0.0.1:3999/_sim/git-push \
        -H 'Content-Type: application/json' \
        -d "{\"fork\":\"z2036709353/flutter_flutter\",\"branch\":\"${refname#refs/heads/}\",\"sha\":\"$newrev\"}" \
        >/dev/null 2>&1 || true
      ;;
  esac
done
```

`git push` 会更新对应 PR 的 `head.sha`、提交列表，取消旧版本剧本并清除旧门禁结果标签，然后发送版本重置评论和 webhook。先 push 再创建 PR 时也会采用保存的真实 SHA。

模拟器不自动派生 diff：注册/创建 PR 时用 `files` 提供变更，未提供时使用 `README.md` 示例补丁。模拟文件与本地 git 文件内容不会自动同步。

## 注册 PR 和 CI 剧本

```bash
curl -X POST http://127.0.0.1:3999/_sim/pr \
  -H 'Content-Type: application/json' -d '{
    "owner":"CPF-Flutter","repo":"flutter_flutter","number":"100",
    "author":"z2036709353","head_ref":"feature-sim",
    "head_repo":"z2036709353/flutter_flutter",
    "files":[{"filename":"src/main.ets","patch":"@@ -1 +1 @@\n-old\n+new"}]
  }'

curl -X POST http://127.0.0.1:3999/_sim/scenario \
  -H 'Content-Type: application/json' -d '{
    "owner":"CPF-Flutter","repo":"flutter_flutter","number":"100",
    "script":[
      {"waitMs":300,"who":"openharmony_ci","comment":"门禁构建开始：静态检查、编译。","webhook":true},
      {"waitMs":400,"who":"openharmony_ci","labels":["静态检查成功"],"comment":"静态检查已通过。"},
      {"waitMs":400,"who":"openharmony_ci","labels":["编译失败"],"comment":"门禁未通过：noPass。","webhook":true}
    ]
  }'

# 由平台真实脚本发 start build，模拟器才推进剧本
GITCODE_API_ROOT=http://127.0.0.1:3999/api/v5 GITCODE_TOKEN=test-token \
  node skills/gitcode-pr-review/scripts/post-pr-comment.mjs \
  --owner CPF-Flutter --repo flutter_flutter --number 100 --body 'start build'
```

剧本字段：
- `waitMs`：距上一步的延迟，单位毫秒
- `who`：`openharmony_ci` 为 CI 机器人，`cpf-manager` 为 AI 检视机器人
- `comment`：评论正文；关键词由真实的 `ohos-pr-gates.mjs` 分类
- `labels`：增量标签数组
- `webhook`：是否在此步骤向 ACE 发送 note 事件
- `webhookSecret`（与 `script` 同级）：当前 ACE 使用非默认 webhook secret 时显式指定

常见关键词：`门禁构建开始`、`代码有更新`、`重置PR验证状态`、`门禁未通过`、`noPass`、`failed(ecotest timeout)`、`限制提交`、`未关联 issue`。

同一剧本运行中重复发 `start build` 不会重复启动；剧本结束后允许人工再次触发。新 push 会取消旧剧本的未执行步骤；之后再次 `start build` 可对新 SHA 重跑。

## 真实回放与人工异常剧本

`fixtures/gate-scenarios/` 保存两类独立剧本：

- `kind=real_replay`：来自本机真实监控保存的 `gate-source.json`，保留评论正文和相对时间，脱敏作者、URL 和邮箱。当前包含 Flutter 全量构建成功、Flutter 冒烟超时、Engine 编译成功、三方插件静态检查成功。历史最终标签附在结果事件，**不代表已掌握标签的真实变更时刻**。
- `kind=synthetic`：人工制造 CI 接收延迟、重复结果、新 push 打断、旧成功迟到、确定性静态失败和 AI 待处理意见；不声称来自线上记录。

运行：

```bash
node --test aiweb/Server/tests/gitcode-scenario-replay.test.mjs
```

`gitcode-scenario-replay.mjs` 统一加载夹具、压缩真实时间、经真实 `post-pr-comment.mjs` 触发，并调用 `check-pr-gates.mjs` 验证阶段；AI 场景继续调用 `fetch-ai-review.mjs`，按工作流 `actionable_count>0 → 检视修复` 验证。需要中间断言或 push 打断的人工场景使用 `manual=true` 和 `/_sim/scenario-step` 单步推进；真实回放仍按压缩时间自动执行。测试使用独立临时端口和目录，不访问真实 PR。

从新的真实快照生成脱敏回放：

```bash
node aiweb/Server/tests/import-real-gate-scenario.mjs \
  --source /path/to/outputs/gate-source.json \
  --id real-new-case --expected-phase green \
  --output aiweb/Server/tests/fixtures/gate-scenarios/real-new-case.json
```

导入器只选择有 CI「门禁构建开始」回应的 `start build`，并保留历史评论；多个版本时必须用 `--comment-id` 明确起点。`--time-scale` 默认 `0.0001`，一小时压缩为 360ms。生成后人工检查预期阶段，尤其不要把 `review_pending_decision`、`user_fix` 等后续人工覆盖状态当作纯门禁结果。

## 控制接口

| 接口 | 作用 |
|---|---|
| `GET /_sim/reset` | 清空状态并取消全部剧本和延迟任务 |
| `POST /_sim/pr` | 注册 PR；支持 `files`、`labels`、`related_issues`、`testers` |
| `POST /_sim/scenario` | 注册 start build 剧本，取消该 PR 的旧剧本 |
| `POST /_sim/comment` | 立即评论并广播 webhook |
| `POST /_sim/label` | 立即打标签并广播 webhook |
| `POST /_sim/state` | 设置 `state`、`merged`、`testers`、`related_issues`，也可直接替换 `comments`/`files` |
| `POST /_sim/contents` | 注册 `{owner,repo,path,content,ref?}` 仓库文本文件 |
| `POST /_sim/settings` | 配置 webhook 超时和 push 确认延迟（毫秒） |
| `POST /_sim/push-ack` | 按 `pushAckDelayMs` 发送 push 确认 |
| `POST /_sim/git-push` | bare 仓 hook 回调，也支持手动模拟真实 push |
| `GET /_sim/pr/<owner>/<repo>/<number>` | 查看 PR 全态 |

例如模拟约 70 秒的异步确认和短时 webhook 超时：

```bash
curl -X POST http://127.0.0.1:3999/_sim/settings \
  -H 'Content-Type: application/json' \
  -d '{"gitAckDelayMs":70000,"pushAckDelayMs":70000,"webhookTimeoutMs":1000}'
```

默认延迟为 0，便于快速测试。若 ACE 未启动，默认 webhook 超时为 8 秒；大量剧本测试建议设为 `50` 至 `1000` 毫秒，避免每个 webhook 步骤依次等待超时。

使用 `post-pr-comment.mjs --wait-push-ack` 时必须传本次 push 的有效 `--since <ISO时间>`。缺少或非法起点、确认超时都会停止发表评论，不会冒险发送 `start build`。

## 已覆盖的 GitCode API

- `GET /user`；支持 `Authorization: Bearer` 和 `access_token` 查询参数
- 仓库读取、分支列表和单分支详情、仓库文件内容
- PR 创建、列表、详情、组织级跨仓列表
- PR 评论、reviews、commits、关联 issues
- PR `diff` 和 `files`，兼容真实 `fetch-pr-diff.mjs` 与同类缺陷扫描
- Issue 创建、按作者查询、详情和评论；所有列表接口支持分页

## 验证

```bash
cd aiweb/Server
node --test tests/gitcode-simulator.test.mjs
```

测试使用独立临时端口和状态目录，直接调用真实 diff/门禁脚本和 AIWeb 客户端，覆盖 Issue 搜索、先 push 后建 PR、diff、105 条评论分页、旧版本取消、延迟确认、审批和全绿门禁。

`fetch-ai-review.mjs` 有 15 秒 `gate-source.json` 快照缓存；连续测试时更换输出目录、删除快照或等待缓存过期。

## 当前边界

- **DCP codeCheck**：真实脚本通过 Playwright 调用华为云 WAF 后的接口。可用 `DCP_ORIGIN` 指向单独实现的本地 DCP 服务；本模拟器目前未实现该协议，常规门禁测试使用 `ACE_GITCODE_DCP_REPORT=0`。
- **构建/跑测产物**：`fetch-gate-logs.mjs` 直接读取评论中的 URL，不经过 GitCode API。可用本地 HTTP 服务提供日志/压缩包，或设置 `ACE_GITCODE_GATE_LOGS=0`；本模拟器不托管这些文件。
- **Git 与 API diff 不自动关联**：`files` 由测试场景提供，不从 bare 仓自动计算。这足以验证消费 diff 的脚本，但不能替代真实 GitCode 的 diff 正确性。
- **权限模型简化**：令牌只决定身份，不模拟仓库成员、fork 写入权限、组织角色或真实 scope。
- **无持久 webhook 重试**：webhook 仅发送一次并记录日志，没有 GitCode 的签名算法、重试队列或全部事件类型。
- **不会自动合入**：`submit` 只记录日志；需用 `/_sim/state` 显式模拟合入/关闭。
- **运行可靠性**：内存中的计时器在重启后不会自动恢复，注册剧本会重置为待触发；`/_sim/reset` 会取消全部任务。大量评论写入时采用进程内顺序处理，不模拟多实例并发写入。
