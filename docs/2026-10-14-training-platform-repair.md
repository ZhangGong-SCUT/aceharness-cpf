# 训练平台修复记录（2026-10-14）

时间：2026-10-13 23:28 开始，2026-10-14 上午持续验证（北京时间）。对照外部审核文档《2026-10-13-晚间再次复核报告》和原 F01–F12 台账。

## 本次修复

| 问题 | 实施方案 | 验证 |
|---|---|---|
| B01：相互冲突的结论仍 verified | 收集多个 step-conclusion/result 与关键布尔字段的冲突，传递至 context、finish 和终态门禁；冲突为 evidence_conflict | 同标签、跨标签及 bug_fixed 冲突测试；全部禁止 verified/completed |
| F02：结构化结果与摘要脱节 | 每次步骤尝试先保存完整输出，再写 version/runId/attemptId/outputSha256/fields/sources/conflicts/verdict 的 JSON；摘要不能覆盖已归档输出 | 真实 saveRunState 往返、重复保存、错 attempt/hash/字段验证 |
| B02/F01/F05：证据归档漏文件 | 递归归档 outputs 普通文件；处理 evidenceRefs、旧报告引用、step log/result/raw 引用；校验相对路径和符号链接，校验 hash；缺失/失败阻断完成 | HAP/APK、子目录日志、Dart 源码、lock 文件；删除临时工作目录后回读归档；越界链接与缺失引用拒绝 |
| B03/F11：SDK 仍写回共享目录 | SDK 全量独立副本，支持 reflink 回退普通复制，不使用硬链接；内部链接重定位，外部链接拒绝；临时目录构建后发布；旧 v1 隔离目录拒绝复用；创建异常不再吞掉 | 入口解析、packages/cache 写入、两个 run 独立、失败重试；恢复流程同样创建独立 SDK |
| B04/F12：把 HAR 交给 hdc install | 新增 ohos-hap-build.mjs：产生新 HAP，读取实际 ohpm lock，绑定 HAR/HAP/hash/mode/target；安装脚本校验清单及当前依赖，仅安装 HAP | 合成 Flutter/hdc 实际参数测试；HAR 单独安装、产物篡改、锁文件变更、路径逃逸拒绝；未连接设备 |
| F03：题面冻结被当成盲测隔离 | 默认 guided_replay；CPF 和执行器双端拒绝 blind_eval，明确当前没有答案文件/未来 Git/网络隔离；记录非独立评估属性 | 拒绝路径测试；快照回放仍校验 hash、不访问 issue API |
| F07：记录的 CLI 与启动命令可能不同 | 将解析到的 CLI 所在目录置于启动 PATH 首位；池健康探测要求 /global/health 的 healthy/version | wrapper 与 HTTP adapter 回归；真实模型协议未在本次重新调用 |
| F10：用量硬编码为零、工具参数提前截空 | 从 assistant 消息采集累计 usage/cost，按消息 ID 去重并排除历史；工具参数存在后才记录；失败与重试纳入已上报用量；新增 elapsedMs 区分墙钟与引擎 durationMs | collector、wrapper、summary 测试；未知费用 reportedCost=null；历史页/列表显示未知或部分 |
| F08：并发请求重复派发窗口 | CPF 将查重、创建、派发合并为同键 single-flight；idle/不确定状态不触发盲目重提 | CPF service 集成测试和 20 个并发请求测试 |
| 列表接口异常与健康口径 | 修复任务列表 meta 作用域错误；页面显示冲突；/alive 回到进程存活检查，诊断依赖仍查专用 health | 路由集成测试；部署后另做只读接口核对 |
| F04/F06/F09 与配置一致性 | 保留此前修复与回归；三个诊断模板统一 HAP 门禁，禁止清理共享 ohpm cache，反馈 Demo 明确使用当前 run 副本 | 原回归及配置 schema 校验；运行时同步在部署记录中追加 |

## 验证命令与结果

- `./node_modules/.bin/vitest run --config tests/training-audit.vitest.config.ts --silent`：09:16，18 个测试文件、210 项通过。后续归档引用补充和独立构建的复验见部署追加记录。
- `./node_modules/.bin/tsc --noEmit --pretty false -p tsconfig.build.json`：生产源码检查通过；最终构建会再次检查。
- 全仓 `tsc --noEmit` 存在既有其他测试类型错误（PR gate/mock 等）；未将它宣称为通过，也未修改他人的测试改动。
- CPF 的 service/并发/快照/终态时间/链路指标：25 项通过，详见对应仓库修复记录。
- 原晚间安装反例没有 HAP 参数，新接口会直接拒绝；正确验收为“缺 HAP 不调用 hdc”及“清单匹配后只安装 HAP”，已保留为仓库回归，未改原外部失败日志。

## 适用边界

本次修复的是已定位的平台缺陷，不证明各 issue 的补丁本身正确。没有发起付费模型训练、没有执行真机安装，没有改写历史运行结果。历史缺失 token/原始日志不能追溯补造。

独立盲测执行环境尚未实现，所以主动关闭 blind_eval；guided_replay 可继续演练，不能作为独立修复能力成绩。SDK 独立副本提供文件写入隔离，不宣称当前同一 Unix 用户下已实现答案访问权限隔离。构建清单用于可信工作流的来源一致性校验，不是抵抗恶意代理篡改的签名证明。

部署前在线核对：23 个 Issue 全部终态、active=0；另有 6 个 PR 停在人工审批且没有 currentProcesses。只提交本次文件。后续发现线上已包含其他 AI 尚未提交的鉴权等改动，因此构建保留这份既有基线，防止部署回退；没有把其他人的改动提交到本次修复中。

## 最终验证与部署（2026-10-14 16:36–16:55，北京时间）

- 修复代码：`bf1725d`，分支 `cpf-ohos-issue-diagnosis`，已推送。CPF 对应 `d9effb2`，分支 `feat/pr-review-subsystem`。
- 纯提交副本曾通过 18 文件、206 项测试；随后保留已有 24 个修改文件作为部署构建基线，最终通过 **18 文件、210 项测试**。多出的 4 项来自既有测试改动，不将两次结果相加。CPF 最终 **25/25** 项通过。
- 生产构建成功，包含 TypeScript 检查、页面数据收集及静态生成。最终使用默认 Turbopack、独立依赖副本、8 GiB 堆上限，在沙箱外完成；无需修改项目构建配置。
- 构建排障如实留档：最初的跨目录 node_modules 链接被 Turbopack 拒绝；默认 Webpack 达到堆上限；12 GiB Webpack 运行约十分钟后主动终止；本地依赖的沙箱内 Turbopack 长时间无进展后终止。以上均不是成功构建。最后一轮沙箱外构建退出码为 0，编译耗时 30.3 秒。
- **16:53:34 完成部署**：替换 `.next`、`dist`，同步三个诊断模板。Build ID：`FqSsrBybnBIveVhyNkJvS`。旧构建、旧模板和六条审批的状态文件保存在本机备份目录。
- **16:54–16:55 只读验收**：三个 systemd 服务均 active；诊断 health HTTP 200、healthy=true、active=0、queryDegraded=0；23 个 Issue 仍为 15 failed、8 complete，没有改写历史成绩。ACE 登录态列表返回 91 个 run。
- 六个 PR 仍是 `running / __human_approval__`，pendingHumanQuestion=true、currentProcesses 为空；部署前后 `state.yaml` 与 `summary.json` 的 SHA-256 均一致。
- 三份运行时模板与源码 hash 一致。无身份访问 workflow/status、workflow/events、run stream 均返回 401；页面脚本包含 evidence_conflict 展示。
- CPF 列表在部署前带登录身份返回 500，16:43 单独重启加载修复后返回 200；最终再次验收为 200、23 条记录。最早无身份探测返回 401 属于正确鉴权，不能作为列表缺陷证据。
- 部署后读取新增日志：未命中 ReferenceError、TypeError、未处理异常、端口冲突、模块缺失或 ERROR 日志。此结论只覆盖本次短时验收窗口，不等价于长期运行无故障。

辅助端口 4096 在重启后未存活，但诊断 health 仍正常：它不是 SDK 按需创建随机端口会话的必要服务。这次未调用真实模型，因此不宣称真实引擎会话已完成端到端验收。

## 证据位置与剩余验收

本机证据根目录：`/home/flutter/issue-training-review/fix-20261014/`。

- `final-vitest.log`、`final-cpf-tests.log`：最终回归原始日志。
- `build-turbopack-unrestricted.log`：成功构建日志；其他 build 日志保留失败或中止结果。
- `preserved-baseline.json`、`preserved-baseline.patch`：构建保留的既有改动及 hash，仅本机保存。
- `deployment.json`、`runtime-*.json`、`smoke-*.json`、`post-deployment-log-check.json`：部署时间、接口结果、审批核对与日志检查。
- `deployment-backup-20261014-165328/`：可恢复的旧构建、模板和审批状态备份。

后续真实运行仍需验收：选择人工审核过的 issue，在 guided_replay 下检查完整输出/结果 JSON/证据清单、失败与重试用量、不同 run 的 SDK 写入，以及真机 HAP 安装和应用启动。现有合成测试不能代替模型任务和设备验收。若要恢复 blind_eval，须先实现并验证答案文件、未来 Git 历史和网络访问隔离；不能仅修改开关或模式名称。
