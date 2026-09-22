/**
 * 1913/1914 PR 检视意见修复的回归 fixture：取自 2026-09-04 两次真实工作流运行抓取的
 * 全部 PR 评论（旧版 fetch-ai-review.mjs 把这 20 条全判成 actionable）。
 * 原始数据没有 created_at，这里按评论 id 顺序合成递增时间戳（GitCode id 单调递增，
 * 顺序与真实时间序一致），用于 stale 边界判定。
 */

export const PR1913_COMMENTS = [
  {
    "source": "diff",
    "id": 187581506,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>",
    "html_url": "",
    "created_at": "2026-09-04T06:00:00.000Z"
  },
  {
    "source": "diff",
    "id": 187999739,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-09T02:10:33.000Z"
  },
  {
    "source": "diff",
    "id": 188007755,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-09T04:24:09.000Z"
  },
  {
    "source": "diff",
    "id": 188015771,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-09T06:37:45.000Z"
  },
  {
    "source": "diff",
    "id": 188024684,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-09T09:06:18.000Z"
  },
  {
    "source": "diff",
    "id": 188026449,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "start build",
    "html_url": "",
    "created_at": "2026-09-09T09:35:43.000Z"
  },
  {
    "source": "diff",
    "id": 188026515,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "非PR提交人或管理员不允许触发门禁",
    "html_url": "",
    "created_at": "2026-09-09T09:36:49.000Z"
  },
  {
    "source": "diff",
    "id": 188125936,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-10T13:13:50.000Z"
  },
  {
    "source": "diff",
    "id": 188126143,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-10T13:17:17.000Z"
  },
  {
    "source": "diff",
    "id": 188126598,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-10T13:24:52.000Z"
  },
  {
    "source": "diff",
    "id": 188136368,
    "author": "huhaodong",
    "path": "",
    "line": "",
    "body": "start build",
    "html_url": "",
    "created_at": "2026-09-10T16:07:42.000Z"
  },
  {
    "source": "diff",
    "id": 188136512,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "首次触发\n门禁构建开始,包含静态检查、代码编译和测试【oh-3.35.7-sdk-smoke编译, oh-3.35.7-test_flutter编译, oh-3.35.7-dev_flutter编译, oh-3.35.7-sdk-smoke测试, oh-3.35.7-dev_flutter测试】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a9a3e2864650f998ba24bb1/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a9a3e2864650f998ba24bb1/runlist</a>",
    "html_url": "",
    "created_at": "2026-09-10T16:10:06.000Z"
  },
  {
    "source": "diff",
    "id": 188138407,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a9a3e2864650f998ba24bb1/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a9a3e2864650f998ba24bb1/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>noPass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6a9a3e2864650f998ba24bb1/runlist?pop=codecheck&taskId=MR_3faa2d0c84d640e89e525e954e2c4107'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>oh-3.35.7-dev_flutter</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>2</td> <td>oh-3.35.7-test_flutter</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>3</td> <td>oh-3.35.7-sdk-smoke</td> <td>pending</td> <td>NA</td> </tr> </tbody> </table>",
    "html_url": "",
    "created_at": "2026-09-10T16:41:41.000Z"
  },
  {
    "source": "diff",
    "id": 188141551,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "代码有更新,重置PR验证状态",
    "html_url": "",
    "created_at": "2026-09-10T17:34:05.000Z"
  },
  {
    "source": "diff",
    "id": 188141574,
    "author": "huhaodong",
    "path": "",
    "line": "",
    "body": "start build",
    "html_url": "",
    "created_at": "2026-09-10T17:34:28.000Z"
  },
  {
    "source": "diff",
    "id": 188141596,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "<p>感谢提交 Pull Requests ！此PR未通过DCO校验。<br>校验失败可能原因：</br><br>1. 未签署“DCO协议”（开发者原创声明协议），<a href=\"https://dco.openharmony.cn/sign/Z2l0ZWUlMkZvcGVuX2hhcm1vbnk=\">在线签署、查看签署状态</a>。</br><br>2. Commits 中未包含 Signed-off-by信息，<a href=\"https://gitcode.com/openharmony/docs/blob/master/zh-cn/contribute/FAQ.md\">参考FAQ处理</a>。</br><br>修复上述问题后，在PR的评论框输入“check dco” ，单击”评论”，系统将再次进行DCO校验。</br><br>当前检测到如下Commits的Signed-off-by邮箱未签署DCO协议：</br><ul><li><a href=\"https://gitcode.com/CPF-Flutter/flutter_flutter/commits/detail/43edcb3bf51ce027c95c641290368eaaf530260c?ref=oh-3.35.7-dev&prId=1913\">43edcb3</a></li></ul><hr></hr><p>Thanks for submitting a pull request. This pull request has not passed the DCO check.<br>Possible causes:</br><br>1. You have not signed the Developer Certificate of Origin (DCO). <a href=\"https://dco.openharmony.cn/sign/Z2l0ZWUlMkZvcGVuX2hhcm1vbnk=\">Sign the DCO and check DCO status</a>.</br><br>2. The commits do not contain the Signed-off-by information. To resolve this issue, <a href=\"https://gitcode.com/openharmony/docs/blob/master/en/contribute/faqs.md\">see FAQs</a>.</br><br>After resolving the preceding issues, enter check dco in the comment box of this pull request and click Comment. The system will check DCO status again.</br><br>The Signed-off-by emails in the following commits have not signed the DCO:</br><ul><li><a href=\"https://gitcode.com/CPF-Flutter/flutter_flutter/commits/detail/43edcb3bf51ce027c95c641290368eaaf530260c?ref=oh-3.35.7-dev&prId=1913\">43edcb3</a></li></ul>",
    "html_url": "",
    "created_at": "2026-09-10T17:34:50.000Z"
  },
  {
    "source": "diff",
    "id": 188141716,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "本地或库上代码有更新,全量重新构建,重置所有关联PR的验证状态\n门禁构建开始,包含静态检查、代码编译和测试【oh-3.35.7-dev_flutter测试, oh-3.35.7-test_flutter编译, oh-3.35.7-dev_flutter编译, oh-3.35.7-sdk-smoke测试, oh-3.35.7-sdk-smoke编译】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a9a420564650f998ba3ef53/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a9a420564650f998ba3ef53/runlist</a>",
    "html_url": "",
    "created_at": "2026-09-10T17:36:50.000Z"
  },
  {
    "source": "diff",
    "id": 188143743,
    "author": "cpf-manager",
    "path": "",
    "line": "",
    "body": "【AI-Review】【建议】【基础代码问题】【其他】插件状态恢复路径缺少单元测试覆盖\n\n● 问题: PR 在 FlutterAbilityAndEntryDelegate.onRestoreInstanceState 中新增了插件状态恢复逻辑（head 版本第 166-176 行），当 host.shouldAttachEngineToAbility() 为 true 时，从 wantParam[PLUGINS_RESTORATION_BUNDLE_KEY] 提取插件状态并经 FlutterEngineConnectionRegistry.onRestoreInstanceState 分发给所有 OnSaveStateListener。但 FlutterAbilityAndEntryDelegateTest.test.ets 中现有的 TestOnRestoreInstanceState 系列用例（第 219-251 行）均以 `new FlutterAbilityAndEntryDelegate()` 构造无 host 的 delegate，this.host 为 undefined，导致 this.host?.shouldAttachEngineToAbility() 恒为 falsy，第 167-176 行的插件状态恢复分支从未被任何测试用例覆盖。同时 PR Checklist 标注 \"[x] necessary self-test cases have been added\"，但本次 diff 仅含 4 个源文件，未修改任何测试文件。\n\n● 影响: 建议。插件状态分发链路（pluginState 提取、空对象兜底、onRestoreInstanceState 调用、listener?.onRestoreInstanceState?.(wantParam) 可选调用）缺乏自动化测试保护，后续重构或 cherry-pick 到其他分支时回归缺陷无法被及时捕获。PR 描述也已承认设备验证 \"to be completed on CI/reviewer devices\"。\n\n● 建议: 在 FlutterAbilityAndEntryDelegateTest 中补充以下场景的单元测试：1) 构造带 mock host 且 shouldAttachEngineToAbility() 返回 true 的 delegate，验证 onRestoreInstanceState 会调用 flutterEngine.getAbilityControlSurface().onRestoreInstanceState(pluginState)；2) wantParam 中包含 PLUGINS_RESTORATION_BUNDLE_KEY 时，验证传入控制面的 pluginState 为实际保存的 Record；3) wantParam 中不包含该 key 时，验证传入空对象 {} 且不抛异常。",
    "html_url": "",
    "created_at": "2026-09-10T18:10:37.000Z"
  },
  {
    "source": "diff",
    "id": 188144543,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "监测到PR: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1913 代码有更新,当前正在执行的门禁任务已自动中止,如有需要,可重新触发",
    "html_url": "",
    "created_at": "2026-09-10T18:23:57.000Z"
  },
  {
    "source": "diff",
    "id": 188144558,
    "author": "huhaodong",
    "path": "",
    "line": "",
    "body": "start build",
    "html_url": "",
    "created_at": "2026-09-10T18:24:12.000Z"
  }
] as const;

export const PR1914_COMMENTS = [
  {
    "source": "diff",
    "id": 187581555,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>",
    "html_url": "",
    "created_at": "2026-09-04T06:00:00.000Z"
  },
  {
    "source": "diff",
    "id": 187986972,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-08T22:36:57.000Z"
  },
  {
    "source": "diff",
    "id": 188020317,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-09T07:52:42.000Z"
  },
  {
    "source": "diff",
    "id": 188021309,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-09T08:09:14.000Z"
  },
  {
    "source": "diff",
    "id": 188068606,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-09T21:17:31.000Z"
  },
  {
    "source": "diff",
    "id": 188069415,
    "author": "huhaodong",
    "path": "",
    "line": "",
    "body": "start build",
    "html_url": "",
    "created_at": "2026-09-09T21:31:00.000Z"
  },
  {
    "source": "diff",
    "id": 188069470,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "首次触发\n门禁构建开始,包含静态检查、代码编译和测试【oh-3.44.9-dev_flutter编译, oh-3.44.9-dev_flutter测试】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a997d4864650f998b6b1571/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a997d4864650f998b6b1571/runlist</a>",
    "html_url": "",
    "created_at": "2026-09-09T21:31:55.000Z"
  },
  {
    "source": "diff",
    "id": 188070978,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a997d4864650f998b6b1571/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a997d4864650f998b6b1571/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>noPass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6a997d4864650f998b6b1571/runlist?pop=codecheck&taskId=MR_3ab687e62f084ac7924f8ff99a9e2547'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>oh-3.44.9-dev_flutter</td> <td>pending</td> <td>NA</td> </tr> </tbody> </table>",
    "html_url": "",
    "created_at": "2026-09-09T21:57:03.000Z"
  },
  {
    "source": "diff",
    "id": 188073841,
    "author": "huhaodong",
    "path": "",
    "line": "",
    "body": "start build",
    "html_url": "",
    "created_at": "2026-09-09T22:44:46.000Z"
  },
  {
    "source": "diff",
    "id": 188073880,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "部分构建失败,仅触发失败构建\n门禁构建开始,包含静态检查、代码编译和测试【oh-3.44.9-dev_flutter编译, oh-3.44.9-dev_flutter测试】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a99861664650f998b6de393/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a99861664650f998b6de393/runlist</a>",
    "html_url": "",
    "created_at": "2026-09-09T22:45:25.000Z"
  },
  {
    "source": "diff",
    "id": 188074333,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a99861664650f998b6de393/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a99861664650f998b6de393/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>noPass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6a99861664650f998b6de393/runlist?pop=codecheck&taskId=MR_bf6cb7de282f4d9e9cd452dffbe0253c'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>oh-3.44.9-dev_flutter</td> <td>pending</td> <td>NA</td> </tr> </tbody> </table>",
    "html_url": "",
    "created_at": "2026-09-09T22:52:58.000Z"
  },
  {
    "source": "diff",
    "id": 188074344,
    "author": "huhaodong",
    "path": "",
    "line": "",
    "body": "start build",
    "html_url": "",
    "created_at": "2026-09-09T22:53:09.000Z"
  },
  {
    "source": "diff",
    "id": 188074384,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "部分构建失败,仅触发失败构建\n门禁构建开始,包含静态检查、代码编译和测试【oh-3.44.9-dev_flutter测试, oh-3.44.9-dev_flutter编译】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a99877864650f998b6e4e9a/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a99877864650f998b6e4e9a/runlist</a>",
    "html_url": "",
    "created_at": "2026-09-09T22:53:49.000Z"
  },
  {
    "source": "diff",
    "id": 188074696,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a99877864650f998b6e4e9a/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a99877864650f998b6e4e9a/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>noPass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6a99877864650f998b6e4e9a/runlist?pop=codecheck&taskId=MR_c678cb90c93d4209811bc36b9522226b'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>oh-3.44.9-dev_flutter</td> <td>pending</td> <td>NA</td> </tr> </tbody> </table>",
    "html_url": "",
    "created_at": "2026-09-09T22:59:01.000Z"
  },
  {
    "source": "diff",
    "id": 188095091,
    "author": "z2036709353",
    "path": "",
    "line": "",
    "body": "1",
    "html_url": "",
    "created_at": "2026-09-10T04:38:56.000Z"
  },
  {
    "source": "diff",
    "id": 188102594,
    "author": "huhaodong",
    "path": "",
    "line": "",
    "body": "start build",
    "html_url": "",
    "created_at": "2026-09-10T06:43:59.000Z"
  },
  {
    "source": "diff",
    "id": 188102697,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "本地或库上代码有更新,全量重新构建,重置所有关联PR的验证状态\n门禁构建开始,包含静态检查、代码编译和测试【oh-3.44.9-dev_flutter测试, oh-3.44.9-dev_flutter编译】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6a9a243664650f998b976518/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6a9a243664650f998b976518/runlist</a>",
    "html_url": "",
    "created_at": "2026-09-10T06:45:42.000Z"
  },
  {
    "source": "diff",
    "id": 188102742,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "监测到PR: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/1914 代码有更新,当前正在执行的门禁任务已自动中止,如有需要,可重新触发",
    "html_url": "",
    "created_at": "2026-09-10T06:46:27.000Z"
  },
  {
    "source": "diff",
    "id": 188102818,
    "author": "openharmony_ci",
    "path": "",
    "line": "",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>",
    "html_url": "",
    "created_at": "2026-09-10T06:47:43.000Z"
  },
  {
    "source": "diff",
    "id": 188103444,
    "author": "openharmony_dcp",
    "path": "",
    "line": "",
    "body": "你因提交次数过多被限制提交，为保障上库效率、避免资源浪费，请先观看学习视频：<a href='https://dcp.openharmony.cn/workbench/video/videoDisplay'>https://dcp.openharmony.cn/workbench/video/videoDisplay</a>",
    "html_url": "",
    "created_at": "2026-09-10T06:58:09.000Z"
  }
] as const;

