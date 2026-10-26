# CPF-Flutter 全仓 PR 监控准入

- 时间：2026-10-26 09:17 Asia/Shanghai
- 范围：PR 工作流仓库白名单匹配、Webhook 仓库解析及身份校验 Skill

## 问题

仓库准入只支持精确的 `owner/repo`，默认没有仓库限制时会放行任意仓库。CPF-AIWeb 扩展为 CPF-Flutter 组织所有代码仓后，ACEHarness 也需要接受同一仓库范围，同时保留作者白名单及手动启动本人 PR 的校验。

## 修改

- `isWatchedRepo` 和 `validate-pr-identity.mjs` 支持不区分大小写的 `owner/*`，仍支持精确 `owner/repo` 规则，并去掉仓库名末尾的 `.git` 再比较。
- Webhook 的仓库规则在环境变量、系统设置均未配置时默认为 `CPF-Flutter/*`。作者白名单和 `ACE_GITCODE_AUTO_MONITOR` 的人工模式开关不变。
- PR 身份校验 Skill 在未注入仓库变量时同样默认 `CPF-Flutter/*`；具体配置仍可以显式收窄到一组 `owner/repo`。
- 更新 GitCode PR Review Skill 中过时的单仓配置示例。

## 部署配置与限制

`ACE_GITCODE_WATCH_REPOS` 环境变量会同时约束工作流身份校验和 Webhook。系统设置中的 `gitcodeWatchRepos` 约束 Webhook 准入；身份校验 Skill 读取环境变量，未设置时默认 `CPF-Flutter/*`。若线上仍有显式的两仓环境变量或系统设置，它们会让 Webhook 继续只接收原范围；要统一扩到所有 CPF-Flutter 代码仓，应把环境变量和系统设置都改为 `CPF-Flutter/*`。本次没有修改线上配置，也没有开启自动监控；是否自动启动仍由原有 `ACE_GITCODE_AUTO_MONITOR` 控制。

规则只做工作流仓库准入，不会枚举组织仓库。仓库作者仍受 `ACE_GITCODE_PR_AUTHOR` 限制；人工启动仍要求启动者就是 PR 作者。空的作者白名单和手动模式行为未在本次修改中放宽。

## 验证

- `node --check` 通过：身份校验 Skill 脚本；涉及文件的空白检查通过。
- 未运行测试套件，也未部署或改线上配置。
