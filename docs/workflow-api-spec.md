# ACEHarness 工作流 API 接口规格说明

> **用途**：本文档定义 ACEHarness 平台工作流核心 API 的请求/响应规格与使用方法，供前端、第三方集成、自动化脚本调用参考。
>
> **Base URL**：`http://<host>:<port>`（开发环境默认 `http://127.0.0.1:3031`）
>
> **认证**：除特别说明外，所有接口需在请求头携带 JWT：
> ```
> Authorization: Bearer <token>
> ```
> Token 通过登录接口获取，存储在客户端 localStorage 的 `auth-token` 键。

---

## 接口总览

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 1 | `POST` | `/api/workflow/start` | 启动一个工作流任务 |
| 2 | `GET` | `/api/workflow/status` | 查询工作流运行状态（含最终报告） |
| 3 | `GET` | `/api/runs/{runId}/outputs` | 列出 / 读取某个 run 的步骤输出文件 |
| 4 | `GET` | `/api/runs/{runId}/final-review` | 获取 Supervisor 最终评审报告（可选） |

---

## 1. 启动工作流任务

### `POST /api/workflow/start`

启动一个工作流 run。每次调用都会生成一个独立的 `runId`，创建专属的 Manager 实例，不阻塞其他 run。

#### 请求

**Headers**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Body 参数**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `configFile` | `string` | ✅ | 工作流配置文件名，如 `"flutter-ohos-issue-diagnosis.yaml"` |
| `frontendSessionId` | `string` | ❌ | 前端已有的聊天会话 ID。传入则复用，不传则新建 |
| `creationSessionId` | `string` | ❌ | Spec Coding 创建会话 ID，用于绑定 task。不传则自动查找该 configFile 的最新创建会话 |
| `skipPreflight` | `boolean` | ❌ | `true` 跳过启动前检查。默认 `false` |
| `rehearsal` | `boolean` | ❌ | `true` 演练模式（不真正执行，只返回摘要和建议）。默认 `false` |
| `preflightChecks` | `PersistedQualityCheck[]` | ❌ | 自定义启动前检查项。不传则由 preflight 自动生成 |
| `initialContexts` | `object` | ❌ | 初始上下文注入 |
| `initialContexts.globalContext` | `string` | ❌ | 全局上下文（所有步骤可见），如 issue 描述、堆栈信息 |
| `initialContexts.phaseContexts` | `Record<string, string>` | ❌ | 按阶段名注入的上下文，key 为 phase/state 名称 |

**请求示例**

```bash
curl -X POST http://127.0.0.1:3031/api/workflow/start \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "configFile": "flutter-ohos-issue-diagnosis.yaml",
    "initialContexts": {
      "globalContext": "issue-key: PROJ-123\nstack trace: NullPointerException at ..."
    }
  }'
```

#### 响应

**✅ 200 — 启动成功**

```json
{
  "success": true,
  "message": "工作流已启动",
  "runId": "run-1721036800000-a1b2c3d4",
  "frontendSessionId": "workflow-1721036800000-e5f6g7h8",
  "sessionWorkbenchState": {
    "title": "鸿蒙问题诊断 · 工作流协作",
    "participants": [...]
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `success` | `boolean` | 固定 `true` |
| `message` | `string` | `"工作流已启动"` |
| `runId` | `string` | 本次运行的唯一标识，格式 `run-{timestamp}-{uuid8}`。**后续查询状态的凭证** |
| `frontendSessionId` | `string` | 关联的聊天会话 ID |
| `sessionWorkbenchState` | `object` | 工作台状态（含标题、参与者列表） |

**✅ 200 — 演练模式完成**（`rehearsal: true` 时）

```json
{
  "success": true,
  "message": "演练模式已完成",
  "frontendSessionId": "...",
  "sessionWorkbenchState": {...},
  "rehearsal": {
    "enabled": true,
    "runId": "run-...",
    "summary": "本次演练覆盖 7 个步骤...",
    "recommendedNextSteps": ["步骤1", "步骤2"]
  }
}
```

**❌ 400 — 参数错误 / Spec 绑定校验失败**

```json
// 缺少 configFile
{ "error": "缺少配置文件参数" }

// Spec task 绑定不一致
{
  "error": "Spec task 绑定校验失败",
  "bindingValidation": {
    "ok": false,
    "errors": ["步骤 'reproduce' 未绑定到任何 Spec task"]
  }
}
```

**❌ 412 — 启动前检查未通过**

```json
{
  "error": "启动前检查未通过：2 项失败",
  "checks": [
    { "name": "engine-available", "ok": true, "message": "..." },
    { "name": "project-root-exists", "ok": false, "message": "路径不存在: /tmp/xxx" }
  ],
  "cwd": "/Users/hyh/project"
}
```

**❌ 500 — 启动异常**

```json
{
  "error": "启动工作流失败",
  "message": "详细错误信息"
}
```

#### 使用说明

1. **`runId` 是核心凭证**：启动后立即返回，用于后续所有状态查询和输出读取
2. **异步执行**：`start` 接口在 Manager 开始执行后立即返回（不等工作流跑完），工作流在后台继续
3. **多次调用**：支持多次调用启动多个 run，每个 run 独立隔离（不同 working dir、不同 engine 进程）
4. **`initialContexts.globalContext`**：推荐注入 issue 描述、堆栈、复现步骤等，所有 Agent 可见

---

## 2. 查询工作流状态与最终报告

### `GET /api/workflow/status`

查询单个工作流的实时状态、步骤日志、Spec Coding 进度、最终评审报告。

#### 请求

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `runId` | `string` | 推荐 | 指定 run 查询。不传则回退到 configFile 对应的共享 manager |
| `configFile` | `string` | ❌ | 配置文件名，配合 `runId` 使用可精确定位 |
| `live` | `0\|1` | ❌ | `1` 返回 SSE 事件流（实时推送）。默认 `0` 返回 JSON |
| `compact` | `0\|1` | ❌ | `1` 返回精简状态（仅核心字段）。默认 `0` 返回完整状态 |

**请求示例**

```bash
# 查询完整状态
curl http://127.0.0.1:3031/api/workflow/status?runId=run-1721036800000-a1b2c3d4 \
  -H "Authorization: Bearer $TOKEN"

# 查询精简状态（适合轮询）
curl "http://127.0.0.1:3031/api/workflow/status?runId=run-...&compact=1" \
  -H "Authorization: Bearer $TOKEN"

# SSE 实时事件流
curl -N "http://127.0.0.1:3031/api/workflow/status?runId=run-...&live=1" \
  -H "Authorization: Bearer $TOKEN"
```

#### 响应（完整状态，`compact=0`）

```jsonc
{
  "status": "running",            // idle | preparing | running | completed | failed | stopped | paused
  "runId": "run-1721036800000-a1b2c3d4",
  "currentConfigFile": "flutter-ohos-issue-diagnosis.yaml",
  "currentPhase": "root-cause-analysis",
  "currentStep": "analyze-stack-trace",
  "runStartTime": "2026-07-15T10:00:00.000Z",
  "runEndTime": null,

  // —— 最终评审报告（工作流完成后才有）——
  "finalReview": {
    "runId": "run-...",
    "configFile": "flutter-ohos-issue-diagnosis.yaml",
    "workflowName": "鸿蒙跨平台问题诊断",
    "supervisorAgent": "diagnosis-supervisor",
    "status": "completed",
    "summary": "本次诊断确认根因为 Flutter-OHOS engine 在 ARM64 下纹理上传路径...",
    "nextFocus": [
      "验证 fix 在 x86_64 模拟器上的兼容性",
      "补充 regression test 覆盖纹理上传边界"
    ],
    "experience": [
      "遇到 ARM64 特定 crash 时优先检查 engine 的 SIMD 代码路径",
      "Flutter texture upload 在鸿蒙上走的是 OHOS TextureImage 而非 GLTexImage2D"
    ],
    "scoreCards": [
      {
        "agent": "info-collector",
        "score": 8,
        "strengths": ["日志采集完整", "复现步骤清晰"],
        "weaknesses": ["未采集 native crash 的 tombstone"]
      }
    ],
    "agentNames": ["info-collector", "reproducer", "root-cause-analyzer", "fix-proposer"],
    "keywords": ["flutter-ohos", "arm64", "texture-upload"],
    "generatedAt": "2026-07-15T10:15:32.000Z"
  },

  // —— 快速访问冗余字段（避免深层取值）——
  "memoryLayers": {
    "review": {
      "summary": "本次诊断确认根因为...",
      "nextFocus": ["验证 fix...", "补充 regression test..."],
      "experience": ["遇到 ARM64 特定 crash 时...", "Flutter texture upload..."],
      "generatedAt": "2026-07-15T10:15:32.000Z"
    }
  },

  // —— 步骤日志（每个步骤的输出）——
  "stepLogs": [
    {
      "stepName": "collect-device-info",
      "agent": "info-collector",
      "status": "completed",
      "timestamp": "2026-07-15T10:01:23.000Z",
      "output": "设备型号: HUAWEI Mate 60 Pro\nAPI Level: 12\n...",
      "outputBytes": 2048,
      "outputRef": "outputs/step-logs/collect-device-info-abc123.md"
    }
  ],

  // —— 质量检查项 ——
  "qualityChecks": [
    { "name": "engine-available", "ok": true, "message": "opencode-sdk ready" }
  ],

  // —— Spec Coding 进度 ——
  "runSpecCoding": {
    "persistMode": "repository",
    "specRootDir": "/path/to/spec",
    "progress": { "completedTasks": 3, "totalTasks": 7 }
  },
  "specCoding": {
    "specCodingSummary": {
      "id": "spec-...",
      "version": 3,
      "status": "in-progress",
      "summary": "...",
      "phaseCount": 4,
      "taskCount": 7,
      "progress": { "completedTasks": 3, "totalTasks": 7 }
    },
    "specCodingDetails": {
      "phases": [...],
      "tasks": [...],
      "assignments": [...],
      "checkpoints": [...],
      "revisions": [...]
    }
  }
}
```

#### 响应（精简状态，`compact=1`）

```jsonc
{
  "status": "running",
  "runId": "run-...",
  "currentConfigFile": "flutter-ohos-issue-diagnosis.yaml",
  "currentPhase": "root-cause-analysis",
  "currentStep": "analyze-stack-trace",
  "pendingHumanQuestion": null
}
```

#### 响应（SSE 事件流，`live=1`）

```
Content-Type: text/event-stream

data: {"type":"status","status":"running","runId":"run-...","currentPhase":"..."}

data: {"type":"step-start","stepName":"collect-device-info","agent":"info-collector"}

data: {"type":"step-complete","stepName":"collect-device-info","outputBytes":2048}

data: {"type":"state-change","from":"info-gathering","to":"root-cause-analysis"}

data: {"type":"human-approval-required","checkpoint":"fix-review","message":"..."}
```

**SSE 事件类型**（部分）：
- `status` / `phase` / `step` / `step-start` / `step-complete` / `result`
- `state-change` / `transition` / `force-transition`
- `human-approval-required` / `human-question-required` / `human-question-answered`
- `iteration` / `iteration-complete` / `escalation`
- `token-usage` / `checkpoint` / `agents`
- `parallel-group-start` / `parallel-group-complete`
- `subworkflow-start` / `subworkflow-status` / `subworkflow-complete`
- `circuit-breaker` / `supervisor-review` / `agent-flow`

#### `status` 字段取值

| 值 | 含义 | 是否终态 |
|---|---|---|
| `idle` | 空闲，未启动 | — |
| `preparing` | 准备中（加载 config / preflight） | 否 |
| `running` | 运行中 | 否 |
| `paused` | 暂停（等待人工审批/问答） | 否 |
| `completed` | 正常完成 | ✅ |
| `failed` | 执行失败 | ✅ |
| `stopped` | 用户手动停止 | ✅ |

#### 使用说明

1. **轮询模式**：前端定时（如每 3 秒）调用 `?runId=xxx&compact=1`，直到 `status` 进入终态
2. **实时模式**：用 `?runId=xxx&live=1` 建立 SSE 连接，事件驱动更新 UI
3. **最终报告**：`status` 为 `completed` / `failed` / `stopped` 后，`finalReview` 字段才有值
4. **快速取报告摘要**：`memoryLayers.review.summary` 等价于 `finalReview.summary`，避免深层取值

---

## 3. 读取步骤输出文件

### `GET /api/runs/{runId}/outputs`

列出某个 run 的所有输出文件，或读取指定步骤的完整输出内容。

#### 请求

**路径参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `runId` | `string` | ✅ | URL 路径中的 run ID |

**Query 参数**（三选一）

| 参数 | 类型 | 说明 |
|---|---|---|
| （无） | — | 列出所有输出文件 |
| `step` | `string` | 按步骤名读取内容（如 `?step=collect-device-info`） |
| `outputRef` | `string` | 按 run 内部相对路径读取（如 `?outputRef=outputs/step-logs/xxx.md`） |

**请求示例**

```bash
# 1. 列出所有输出文件
curl http://127.0.0.1:3031/api/runs/run-1721036800000-a1b2c3d4/outputs \
  -H "Authorization: Bearer $TOKEN"

# 2. 按步骤名读取
curl "http://127.0.0.1:3031/api/runs/run-.../outputs?step=collect-device-info" \
  -H "Authorization: Bearer $TOKEN"

# 3. 按 outputRef 读取（从 status 响应的 stepLogs[].outputRef 获取）
curl "http://127.0.0.1:3031/api/runs/run-.../outputs?outputRef=outputs/step-logs/collect-device-info-abc123.md" \
  -H "Authorization: Bearer $TOKEN"
```

#### 响应

**✅ 200 — 列出所有文件**（无 query 参数）

```json
{
  "files": [
    {
      "stepName": "collect_device_info",
      "filename": "collect-device-info-abc123.md",
      "size": 2048,
      "agent": "info-collector",
      "phaseName": "info-gathering",
      "role": "defender",
      "iteration": 1,
      "maxIterations": 3,
      "timestamp": "2026-07-15T10:01:23.000Z",
      "status": "completed"
    },
    {
      "stepName": "reproduce_issue",
      "filename": "reproduce-issue-def456.md",
      "size": 4096,
      "agent": "reproducer",
      "phaseName": "info-gathering",
      "role": "defender",
      "iteration": 1,
      "maxIterations": 3,
      "timestamp": "2026-07-15T10:03:45.000Z",
      "status": "completed"
    }
  ]
}
```

**✅ 200 — 读取指定步骤内容**（`?step=` 或 `?outputRef=`）

```json
{
  "stepName": "collect-device-info",
  "content": "# 设备信息采集结果\n\n设备型号: HUAWEI Mate 60 Pro\nAPI Level: 12\n...\n（完整 Markdown 内容，无截断）"
}
```

**❌ 404 — 未找到**

```json
{ "error": "未找到该步骤的输出" }
```

**❌ 400 — outputRef 不合法**

```json
{ "error": "outputRef 不合法" }
```

#### 使用说明

1. **先列再读**：先无参数调用拿到 `files[]`，再根据 `filename` 或 `stepName` 读取具体内容
2. **`outputRef` 优先**：如果从 `status` 接口拿到了 `stepLogs[].outputRef`，直接用它读取最精确
3. **内容无截断**：返回的 `content` 是完整文件内容，不受日志大小限制
4. **文件格式**：优先 `.md`，找不到则尝试 `.txt`

---

## 4. 获取最终评审报告（可选）

最终评审报告已内嵌在 `GET /api/workflow/status` 的 `finalReview` 字段中。如果只需要报告本身，也可直接读取 run 目录下的 `final-review.yaml` 或 `final-review.md` 文件。

### `WorkflowFinalReview` 数据结构

```typescript
interface WorkflowFinalReview {
  runId: string;
  configFile: string;
  workflowName?: string;
  projectRoot?: string;
  workflowMode?: string;           // 'phase-based' | 'state-machine'
  supervisorAgent: string;
  status: 'completed' | 'failed' | 'stopped';

  summary: string;                 // 诊断/工作流总结
  nextFocus: string[];             // 后续建议关注点
  experience: string[];            // 经验沉淀（可入库的知识）

  scoreCards: AgentScoreCard[];    // 各 Agent 评分卡
  agentNames?: string[];           // 参与的 Agent 列表
  keywords?: string[];             // 关键词标签

  childSpecDeltas?: WorkflowChildSpecDeltaSummary[];  // 子工作流 Spec 变更摘要
  generatedAt: string;             // ISO 8601 时间戳
}

interface AgentScoreCard {
  agent: string;
  score: number;                   // 0-10
  strengths: string[];
  weaknesses: string[];
}
```

### 文件系统位置

```
<workspace>/runs/<runId>/
├── state.yaml              ← 完整运行状态
├── final-review.yaml       ← 最终评审（YAML 格式）
├── final-review.md         ← 最终评审（Markdown 格式，人类可读）
└── outputs/
    ├── step-logs/
    │   ├── collect-device-info-abc123.md
    │   ├── reproduce-issue-def456.md
    │   └── ...
    └── <stepName>.md       ← 按步骤名命名的输出
```

---

## 5. 典型调用流程

### 场景：启动诊断 → 轮询状态 → 获取报告

```bash
# 步骤 1：启动工作流
RESP=$(curl -s -X POST http://127.0.0.1:3031/api/workflow/start \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "configFile": "flutter-ohos-issue-diagnosis.yaml",
    "initialContexts": {
      "globalContext": "issue: NullPointerException in texture upload"
    }
  }')

RUN_ID=$(echo "$RESP" | jq -r '.runId')
echo "Started run: $RUN_ID"

# 步骤 2：轮询状态（每 5 秒）
while true; do
  STATUS=$(curl -s "http://127.0.0.1:3031/api/workflow/status?runId=$RUN_ID&compact=1" \
    -H "Authorization: Bearer $TOKEN")
  STATE=$(echo "$STATUS" | jq -r '.status')
  echo "[$(date +%H:%M:%S)] status=$STATE step=$(echo $STATUS | jq -r '.currentStep')"

  case "$STATE" in
    completed|failed|stopped) break ;;
  esac
  sleep 5
done

# 步骤 3：获取最终报告
curl -s "http://127.0.0.1:3031/api/workflow/status?runId=$RUN_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '.finalReview'

# 步骤 4：读取某个步骤的完整输出
curl -s "http://127.0.0.1:3031/api/runs/$RUN_ID/outputs?step=collect-device-info" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.content'
```

### 场景：SSE 实时监听

```javascript
const eventSource = new EventSource(
  'http://127.0.0.1:3031/api/workflow/status?runId=run-...&live=1',
  { headers: { 'Authorization': `Bearer ${token}` } }
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.type}]`, data);

  if (data.type === 'human-approval-required') {
    // 弹出人工审批 UI
    showApprovalDialog(data);
  }
  if (data.type === 'status' && ['completed','failed','stopped'].includes(data.status)) {
    eventSource.close();
    loadFinalReport(data.runId);
  }
};
```

---

## 6. 错误码汇总

| HTTP Status | 含义 | 触发场景 |
|---|---|---|
| `200` | 成功 | 正常响应 |
| `400` | 参数错误 | 缺少 `configFile`、Spec 绑定校验失败、`outputRef` 含 `..` |
| `401` | 未认证 | 缺少或无效的 JWT |
| `404` | 未找到 | 指定的 step / outputRef 不存在 |
| `412` | 前置条件不满足 | 启动前检查（preflight）失败 |
| `500` | 服务器内部错误 | Manager 异常、文件读写失败等 |

---

## 7. 补充说明

### 7.1 `runId` 格式

```
run-{Unix毫秒时间戳}-{UUID前8位}
例: run-1721036800000-a1b2c3d4
```

- 全局唯一，可作为主键
- 时间戳部分可粗略排序

### 7.2 认证 Token 获取

```bash
# 登录获取 token
curl -X POST http://127.0.0.1:3031/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}'
# → { "token": "eyJ...", "user": {...} }
```

### 7.3 并发说明

- `POST /api/workflow/start` 支持多次调用，每次返回不同 `runId`
- 不同 `runId` 之间完全隔离（独立 working dir、engine 进程、Agent sessions）
- 同一 `runId` 重复 `start` 会被 Manager 自身守卫拒绝（`"已有工作流正在运行"`）

### 7.4 输出文件命名规则

| 类型 | 路径 | 说明 |
|---|---|---|
| 步骤日志 | `outputs/step-logs/{stepName}-{uuid8}.md` | 每次执行一个步骤生成一个文件 |
| 命名输出 | `outputs/{safeStepName}.md` | 按步骤名（特殊字符替换为 `_`） |
| 最终评审 | `final-review.yaml` / `final-review.md` | run 根目录 |
| 运行状态 | `state.yaml` | run 根目录，完整快照 |
