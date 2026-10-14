/**
 * 真实快照（PR2234 run-1791946826207-pr2234-38e3aaf5）。
 * 评论原文取自工作目录 outputs/gate-source.json，未改写；用于验收"限流/格式失败/关闭"回归。
 */
export const PR2234_COMMENTS = [
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T09:38:30+08:00",
    "body": "start build"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T09:39:01+08:00",
    "body": "首次触发\n门禁构建开始,包含静态检查、代码编译和测试【flutter_3.35.7-dev_flutter_integration编译, flutter_3.35.7-dev_flutter_integration测试, flutter_3.35.7-dev_flutter测试, flutter_3.35.7-dev_flutter编译, flutter_3.35.7-dev_flutter_sdk-unit编译】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acedd3164650f998bf17396/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acedd3164650f998bf17396/runlist</a>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T09:39:10+08:00",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T09:50:48+08:00",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acedd3164650f998bf17396/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acedd3164650f998bf17396/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>noPass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6acedd3164650f998bf17396/runlist?pop=codecheck&taskId=MR_1c16336e25684c15a1458deb1f8a07a8'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>flutter_3.35.7-dev_flutter</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>2</td> <td>flutter_3.35.7-dev_flutter_sdk-unit</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>3</td> <td>flutter_3.35.7-dev_flutter_integration</td> <td>pending</td> <td>NA</td> </tr> </tbody> </table>"
  },
  {
    "user": {
      "id": "69f01e36d681105ae27ffa06",
      "login": "cpf-manager",
      "object_id": "69f01e36d681105ae27ffa06",
      "name": "cpf-manager",
      "avatar_url": "https://cdn-img.gitcode.com/fa/da/f628a9511d78917587a1fb55f6999f829cdfb91ea56f4e913fa81f4628ca9d57.png?time=1777347931553",
      "html_url": "https://gitcode.com/cpf-manager"
    },
    "created_at": "2026-10-14T10:05:10+08:00",
    "body": "【AI-Review】【一般】【基础代码问题】【稳定性问题】\n● 问题: 在 ohos_image_generator.cpp:465 调用 atoi(loop_value.data) 解析 OHOS_IMAGE_PROPERTY_GIF_LOOP_COUNT 属性值时，假设 loop_value.data 是以 null 结尾的 C 字符串。但根据 OHOS SDK 头文件 image_common.h 的定义，Image_String 结构体同时返回 data 和 size 两个字段，size 字段的存在正是为兼容非 null 结尾的字符串。进一步查证 OHOS SDK 头文件 image_source_native.h 的 API 文档发现：OH_ImageSourceNative_GetImageProperty（@since 12，本 PR 使用的接口）的文档注释未声明 value.data 以 null 结尾；而新增的 OH_ImageSourceNative_GetImagePropertyWithNull（@since 19）才在文档中明确声明 \"The output value.data is null-terminated\"，这反证了 [@since](https://gitcode.com/since) 12 的旧接口不保证 null 结尾。同文件中 orientation 属性的处理（line 413-416）通过 ResolveEncodedOrigin(value.data, value.size, ...) 使用 size 进行 memcmp 比较，正确地未依赖 null 结尾；而此处 loop count 的解析仅用 atoi 并忽略了 size。\n\n● 影响: 当 OH_ImageSourceNative_GetImageProperty 返回的 loop_value.data 不以 null 结尾时，atoi 会从 loop_value.data 起持续读取内存直到遇到非数字字节或 null 终止符，可能导致：(1) 解析出错误的 loop count 值（例如缓冲区内容为 \"3\" 但后续堆内存中恰好有数字字节 '5'，atoi 返回 35），play_count_ 被设为 36，GIF 播放 36 次而非预期的 4 次；(2) 缓冲区越界读取，若读取超出已映射内存页则可能触发崩溃。该路径在每次构造多帧 GIF 的 OHOSImageGenerator 时都会执行。\n\n● 建议: 使用 loop_value.size 构造 null 结尾的字符串后再解析，例如：std::string loop_str(loop_value.data, loop_value.size); int loop = atoi(loop_str.c_str()); 或使用 std::stoi / strtol 配合 size 限定。若项目最低 compatibleSdkVersion 已 >= 19，也可升级使用 OH_ImageSourceNative_GetImagePropertyWithNull（该接口明确保证 value.data 以 null 结尾）。"
  },
  {
    "user": {
      "id": "69f01e36d681105ae27ffa06",
      "login": "cpf-manager",
      "object_id": "69f01e36d681105ae27ffa06",
      "name": "cpf-manager",
      "avatar_url": "https://cdn-img.gitcode.com/fa/da/f628a9511d78917587a1fb55f6999f829cdfb91ea56f4e913fa81f4628ca9d57.png?time=1777347931553",
      "html_url": "https://gitcode.com/cpf-manager"
    },
    "created_at": "2026-10-14T10:05:23+08:00",
    "body": "【AI-Review】【一般】【业务功能】【功能实现错误】\n● 问题: 在 ohos_image_generator.cpp:468-472 的 else 分支中，当 OH_ImageSourceNative_GetImageProperty 读取 OHOS_IMAGE_PROPERTY_GIF_LOOP_COUNT 失败（例如 GIF 文件未包含 NETSCAPE2.0 loop extension）时，play_count_ 保持头文件声明的默认值 -1。随后 GetPlayCount()（line 498-508）在 play_count_ <= 0 时返回 kInfinitePlayCount（无限循环）。而 Android/iOS 的 Skia 路径 BuiltinSkiaCodecImageGenerator::GetPlayCount()（image_generator.cc:122-125）对没有 NETSCAPE2.0 loop extension 的 GIF 返回 repetition_count = 0（Skia 默认值），经 repetition_count + 1 映射后 GetPlayCount() = 1（仅播放一次）。PR 描述称 \"this fix aligns OHOS with the cross-platform baseline\"，但该回退路径仍与 Skia 基线不一致。调用链验证：MultiFrameCodec::State::State()（multi_frame_codec.cc:31-38）将 GetPlayCount() == kInfinitePlayCount 映射为 repetitionCount = -1（无限），将 GetPlayCount() = 1 映射为 repetitionCount = 0（播放一次），该差异直接传递到 Dart 侧。\n\n● 影响: 未包含 NETSCAPE2.0 loop extension 的动画 GIF 在 OHOS 上会无限循环，而在 Android/iOS 上仅播放一次，造成跨平台行为不一致。这类 GIF 在实际场景中确实存在（部分图片编辑工具导出 GIF 时不写入 NETSCAPE2.0 扩展），用户通过 Image.network 加载此类 GIF 时会在 OHOS 设备上观察到与 Android/iOS 不同的播放行为。\n\n● 建议: 若 OH_ImageSourceNative_GetImageProperty 能区分\"属性读取失败（无 loop extension）\"与\"loop count = 0（无限循环）\"两种场景（前者返回错误码、后者返回 IMAGE_SUCCESS 且 data 为 \"0\"），建议在属性读取失败时将 play_count_ 设为 1（仅播放一次）以对齐 Skia 基线；若 OHOS 接口无法区分这两种场景，建议在 PR 描述中补充说明该 API 限制，并将 \"keep the legacy infinite-loop behavior as fallback\" 的理由从\"保留旧行为\"更新为\"OHOS API 无法区分无扩展与 loop=0\"。"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T10:56:45+08:00",
    "body": "代码有更新,重置PR验证状态"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T10:57:00+08:00",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>"
  },
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T11:06:57+08:00",
    "body": "start build"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T11:07:28+08:00",
    "body": "本地或库上代码有更新,全量重新构建,重置所有关联PR的验证状态\n门禁构建开始,包含静态检查、代码编译和测试【flutter_3.35.7-dev_flutter编译, flutter_3.35.7-dev_flutter_integration测试, flutter_3.35.7-dev_flutter测试, flutter_3.35.7-dev_flutter_integration编译, flutter_3.35.7-dev_flutter_sdk-unit编译】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acef1eb64650f998bfad987/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acef1eb64650f998bfad987/runlist</a>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T11:15:40+08:00",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acef1eb64650f998bfad987/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acef1eb64650f998bfad987/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>noPass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6acef1eb64650f998bfad987/runlist?pop=codecheck&taskId=MR_c8ad27bd72fd4f24bf4f280d4411a445'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>flutter_3.35.7-dev_flutter</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>2</td> <td>flutter_3.35.7-dev_flutter_sdk-unit</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>3</td> <td>flutter_3.35.7-dev_flutter_integration</td> <td>pending</td> <td>NA</td> </tr> </tbody> </table>"
  },
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T11:53:15+08:00",
    "body": "感谢检视，两条意见处理如下（commit 90037551a5f）：\n\n1. 【一般·稳定性】atoi 非 null 终止堆过读（已采纳）：确认 `OH_ImageSourceNative_GetImageProperty` 返回的 `Image_String` 不保证 null 终止，现改为 `std::string(loop_value.data, loop_value.size)` 按显式长度构造后再解析；属性 key 也改由 `std::string` 承载（顺带解决静态检查 G.STD.02-CPP），`free(loop_value.data)` 与错误码解耦，data 非 null 即释放，对齐同文件 orientation 属性的处理模式。\n\n2. 【一般·业务功能】无 NETSCAPE2.0 扩展 GIF 的兜底行为与 Skia 基线不一致（部分采纳）：观察属实，跨平台差异确实存在。但根因是 OHOS 属性 API 对\"无循环扩展\"与其它读取失败返回同样的错误码，无法区分；若读取失败一律改为\"只播 1 次\"，其它失败模式也会停止播放，且与 OHOS 历史行为不兼容，超出本 issue 范围。故保留无限循环兜底作为安全默认，并在代码注释与 PR 描述中明确记录该 API 限制与跨平台差异。"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T11:53:28+08:00",
    "body": "代码有更新,重置PR验证状态"
  },
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T11:53:41+08:00",
    "body": "start build"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T11:53:45+08:00",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T11:54:12+08:00",
    "body": "本地或库上代码有更新,全量重新构建,重置所有关联PR的验证状态\n门禁构建开始,包含静态检查、代码编译和测试【flutter_3.35.7-dev_flutter_integration测试, flutter_3.35.7-dev_flutter_integration编译, flutter_3.35.7-dev_flutter编译, flutter_3.35.7-dev_flutter_sdk-unit编译, flutter_3.35.7-dev_flutter测试】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acefce064650f998b00271b/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acefce064650f998b00271b/runlist</a>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T12:09:15+08:00",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acefce064650f998b00271b/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acefce064650f998b00271b/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>noPass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6acefce064650f998b00271b/runlist?pop=codecheck&taskId=MR_925d8e9822cc4f3797574c456281f6d3'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>flutter_3.35.7-dev_flutter</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>2</td> <td>flutter_3.35.7-dev_flutter_sdk-unit</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>3</td> <td>flutter_3.35.7-dev_flutter_integration</td> <td>pending</td> <td>NA</td> </tr> </tbody> </table>"
  },
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T12:12:43+08:00",
    "body": "start build"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T12:13:11+08:00",
    "body": "部分构建失败,仅触发失败构建\n门禁构建开始,包含静态检查、代码编译和测试【flutter_3.35.7-dev_flutter编译, flutter_3.35.7-dev_flutter_integration测试, flutter_3.35.7-dev_flutter_sdk-unit编译, flutter_3.35.7-dev_flutter_integration编译, flutter_3.35.7-dev_flutter测试】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acf015264650f998b021f0e/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acf015264650f998b021f0e/runlist</a>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T12:31:03+08:00",
    "body": "监测到PR: https://gitcode.com/CPF-Flutter/flutter_flutter/merge_requests/2234 代码有更新,当前正在执行的门禁任务已自动中止,如有需要,可重新触发"
  },
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T12:31:08+08:00",
    "body": "start build"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T12:31:21+08:00",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T12:31:35+08:00",
    "body": "本地或库上代码有更新,全量重新构建,重置所有关联PR的验证状态\n门禁构建开始,包含静态检查、代码编译和测试【flutter_3.35.7-dev_flutter_integration编译, flutter_3.35.7-dev_flutter_sdk-unit编译, flutter_3.35.7-dev_flutter编译, flutter_3.35.7-dev_flutter_integration测试, flutter_3.35.7-dev_flutter测试】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acf05a364650f998b03cbac/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acf05a364650f998b03cbac/runlist</a>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T12:40:03+08:00",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acf05a364650f998b03cbac/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acf05a364650f998b03cbac/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>noPass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6acf05a364650f998b03cbac/runlist?pop=codecheck&taskId=MR_bc26a7d3086d4f7f95d65c92c6c8de87'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>flutter_3.35.7-dev_flutter</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>2</td> <td>flutter_3.35.7-dev_flutter_sdk-unit</td> <td>pending</td> <td>NA</td> </tr> <tr> <td>3</td> <td>flutter_3.35.7-dev_flutter_integration</td> <td>pending</td> <td>NA</td> </tr> </tbody> </table>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T12:59:28+08:00",
    "body": "代码有更新,重置PR验证状态"
  },
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T12:59:34+08:00",
    "body": "start build"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T12:59:46+08:00",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T13:00:04+08:00",
    "body": "本地或库上代码有更新,全量重新构建,重置所有关联PR的验证状态\n门禁构建开始,包含静态检查、代码编译和测试【flutter_3.35.7-dev_flutter编译, flutter_3.35.7-dev_flutter测试, flutter_3.35.7-dev_flutter_integration编译, flutter_3.35.7-dev_flutter_integration测试, flutter_3.35.7-dev_flutter_sdk-unit编译】,预计在60分钟内完成,门禁结果会同步发送到注册邮箱。您可以通过如下链接跟踪门禁进展:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acf0c4f64650f998b060648/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acf0c4f64650f998b060648/runlist</a>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T13:57:05+08:00",
    "body": "代码门禁未通过  <br>您可以通过如下链接查看门禁报告:<a href=\"http://dcp.openharmony.cn/workbench/cicd/detail/6acf0c4f64650f998b060648/runlist\">http://dcp.openharmony.cn/workbench/cicd/detail/6acf0c4f64650f998b060648/runlist</a></br> <br>静态检查:</br> <table> <thead> <tr> <th>#</th> <th>check type</th> <th>result</th> <th>report</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>codeCheck</td> <td>pass</td> <td><a href='https://dcp.openharmony.cn/workbench/cicd/detail/6acf0c4f64650f998b060648/runlist?pop=codecheck&taskId=MR_c298f536038947f78a9577b992b315a9'>>>></a></td> </tr> </tbody> </table><br>编译测试:</br> <table> <thead> <tr> <th>#</th> <th>Device</th> <th>build result</th> <th>test result</th> <th>package</th> </tr> </thead> <tbody> <tr> <td>1</td> <td>flutter_3.35.7-dev_flutter</td> <td><a href='https://cidownload.openharmony.cn/Artifacts/flutter_3.35.7-dev_flutter/20261014-1-00024/log/build.log'>failed(compile failed)</a></td> <td>NA</td> <td><a href='None'>>>></a></td> </tr> <tr> <td>2</td> <td>flutter_3.35.7-dev_flutter_sdk-unit</td> <td><a href='https://cidownload.openharmony.cn/Artifacts/flutter_3.35.7-dev_flutter_sdk-unit/20261014-1-00026/log/build.log'>success</a></td> <td>NA</td> <td><a href='https://cidownload.openharmony.cn/Artifacts/flutter_3.35.7-dev_flutter_sdk-unit/20261014-1-00026/version/Artifacts-flutter_3.35.7-dev_flutter_sdk-unit-20261014-1-00026-version-flutter_3.35.7-dev_flutter_sdk-unit.tar.gz'>>>></a></td> </tr> <tr> <td>3</td> <td>flutter_3.35.7-dev_flutter_integration</td> <td><a href='https://cidownload.openharmony.cn/Artifacts/flutter_3.35.7-dev_flutter_integration/20261014-1-00025/log/build.log'>success</a></td> <td><a href=''>failed(IGNORE)(ecotest timeout)</a></td> <td><a href='https://cidownload.openharmony.cn/Artifacts/flutter_3.35.7-dev_flutter_integration/20261014-1-00025/version/Artifacts-flutter_3.35.7-dev_flutter_integration-20261014-1-00025-version-flutter_3.35.7-dev_flutter_integration.tar.gz'>>>></a></td> </tr> </tbody> </table>"
  },
  {
    "user": {
      "id": "66418d27e3ab8a2b018a30d3",
      "login": "openharmony_dcp",
      "object_id": "66418d27e3ab8a2b018a30d3",
      "name": "openharmony_dcp",
      "avatar_url": "https://cdn-img.gitcode.com/ed/ba/e9db93a970d4f4835964474f7ac999ed33f42303fc3989699e31c3be090ca988.png?time=1715914954470",
      "html_url": "https://gitcode.com/openharmony_dcp"
    },
    "created_at": "2026-10-14T13:58:02+08:00",
    "body": "你因提交次数过多被限制提交，为保障上库效率、避免资源浪费，请先观看学习视频：<a href='https://dcp.openharmony.cn/workbench/video/videoDisplay'>https://dcp.openharmony.cn/workbench/video/videoDisplay</a>"
  },
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T13:59:20+08:00",
    "body": "start build"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T13:59:46+08:00",
    "body": "<p>您提交的PR合入后可能会对门禁构建产生阻塞，触发门禁次数已达到上限，您可以去<a href=\"http://dcp.openharmony.cn/workbench/cicd/codecontrol/om-management/access\">Openharmony数字化协作平台</a>申请恢复。如有疑问，请按照<a href=\"https://gitee.com/openharmony-sig/cicd/blob/master/%E8%BF%90%E7%BB%B4%E5%80%BC%E7%8F%AD%E8%B4%A3%E4%BB%BB%E4%BA%BA.md\">流水线值班表</a>联系管理员。</p>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T14:39:30+08:00",
    "body": "代码有更新,重置PR验证状态"
  },
  {
    "user": {
      "id": "67362c9351a83f24b5471083",
      "login": "huangyouhua",
      "object_id": "67362c9351a83f24b5471083",
      "name": "huangyouhua",
      "avatar_url": "https://cdn-img.gitcode.com/cc/fe/c493c4f1e7ebb7d3200ac24589e7e080096d8151c8118187c29e2b853bd1dba1.jpg",
      "html_url": "https://gitcode.com/huangyouhua"
    },
    "created_at": "2026-10-14T14:39:34+08:00",
    "body": "start build"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T14:39:47+08:00",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T14:40:11+08:00",
    "body": "<p>您提交的PR合入后可能会对门禁构建产生阻塞，触发门禁次数已达到上限，您可以去<a href=\"http://dcp.openharmony.cn/workbench/cicd/codecontrol/om-management/access\">Openharmony数字化协作平台</a>申请恢复。如有疑问，请按照<a href=\"https://gitee.com/openharmony-sig/cicd/blob/master/%E8%BF%90%E7%BB%B4%E5%80%BC%E7%8F%AD%E8%B4%A3%E4%BB%BB%E4%BA%BA.md\">流水线值班表</a>联系管理员。</p>"
  },
  {
    "user": {
      "id": "6541ccea82d8f837210e92c3",
      "login": "openharmony_ci",
      "object_id": "6541ccea82d8f837210e92c3",
      "name": "openharmony_ci",
      "avatar_url": "https://cdn-img.gitcode.com/cb/be/5cb10620b4e9195576142df69cd44bb84df15d769c2a04eff5bf7324b903022c.png?time=1723462328974",
      "html_url": "https://gitcode.com/openharmony_ci"
    },
    "created_at": "2026-10-14T15:39:57+08:00",
    "body": "<p>感谢提交 Pull Requests！<br>Thanks for submitting a pull request.</br>"
  }
] as any[];

// 13:57:10 门禁快照（编译失败，comments=29）——此前被误判为抖动重试(need_start_build)。
export const PR2234_COMPILE_FAIL_SNAPSHOT = { labels: ['AI已检视', 'dco检查成功', '冒烟测试失败', '编译失败', '静态检查成功'], comments: PR2234_COMMENTS.slice(0, 29) };

// 14:47:06 门禁快照（DCP 限流拒绝，comments=36）——此前被误判为 running+gateRateLimited。
export const PR2234_RATE_LIMIT_SNAPSHOT = { labels: ['AI已检视', 'dco检查成功'], comments: PR2234_COMMENTS.slice(0, 36) };

// 15:40 终止快照：PR 已关闭未合入，labels 仍为检视/DCO。
export const PR2234_CLOSED_SNAPSHOT = { labels: ['AI已检视', 'dco检查成功'], comments: PR2234_COMMENTS };
