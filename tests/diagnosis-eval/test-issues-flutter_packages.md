# 鸿蒙跨平台框架 AI 诊断工作流 — 测试 Issue 集

> **筛选标准**:
> - 来源：仅 `openharmony-tpc/flutter_packages`
> - Issue 已关闭 + 有对应已合并 PR（通过 GitCode API `/issues/{number}/pull_requests` 正向查询获取关联）
> - PR 合并状态已通过 GitCode API 逐一验证（`state=merged` 且 `merged_at` 非空）
> - PR 合入时间在近 6 个月内（2026-01-07 之后）
> - Issue 质量评分 ≥ 5（body长度 + 复现步骤 + 代码 + 错误信息 + 环境信息 + 截图 + 评论）
>
> **收集日期**: 2026-07-06
> **数据规模**: 扫描 1474 个已关闭 Issue，质量评分达标 244 个，最终匹配已合入 PR（近 6 个月内）73 个

---

## 测试 Issue 总览（73 个，全部来自 openharmony-tpc/flutter_packages，PR 近 6 个月内合并）

| # | Issue | 标题 | PR | PR创建人 | PR合并日期 | 类型 | 评分 | Body | 评论 |
|---|--------|------|-----|---------|-----------|------|------|------|------|
| 1 | [#1014](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1014) | [shared_preferences_ohos] SharedPreferencesAsync 的 getStringList 和 setStringList方法失效，始终返回 null | [#860](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/860) | huangyouhua | 2026-05-14 | functional | 12 | 2043 | 1 |
| 2 | [#1196](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1196) | [Bug]: 【pigeon】生成的ArkTs 数据类中toList 会因为undefined导致Dart读取数组异常，导致属性无法对应 | [#1203](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1203) | zhong_ning | 2026-06-12 | functional | 11 | 1126 | 1 |
| 3 | [#1103](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1103) | [Bug]:  shared_preferences 插件在写入值时触发： Valid value range is empty: 0 | [#1332](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1332) | zhong_ning | 2026-06-25 | functional | 11 | 1456 | 4 |
| 4 | [#1422](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1422) | pigeon-v21.2.0_dev分支AI质量加固优化 | [#1301](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1301) | zhaichenyang | 2026-06-29 | performance | 10 | 1992 | 1 |
| 5 | [#1328](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1328) | shared_preferences 插件在写入值时触发：Valid value range is empty: 0 | [#1214](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1214) | zhong_ning | 2026-06-15 | functional | 10 | 838 | 0 |
| 6 | [#1144](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1144) | [Bug]: shared_preferences setEncodedStringList 通道未注册及回复空数组问题 | [#1241](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1241) | zhong_ning | 2026-06-17 | functional | 8 | 1020 | 2 |
| 7 | [#1118](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1118) | [Bug]: pigeon生成的模板内部类型错误 | [#1207](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1207) | zhong_ning | 2026-06-11 | functional | 8 | 977 | 1 |
| 8 | [#1220](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1220) | camera_ohos修改README文件 | [#1096](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1096) | zhangcongcong_zzzcc | 2026-05-27 | functional | 7 | 86 | 0 |
| 9 | [#1218](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1218) | camera_ohos中捕获fps设置失败时发生的异常，防止程序奔溃 | [#1094](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1094) | zhangcongcong_zzzcc | 2026-05-27 | performance | 7 | 233 | 0 |
| 10 | [#1132](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1132) | br_image_picker-v1.2.1_ohos分支新增单元测试 | [#1003](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1003) | qq_77777 | 2026-05-20 | functional | 7 | 69 | 0 |
| 11 | [#1128](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1128) | br_image_picker-v1.1.2_ohos_dev分支新增单元测试 | [#998](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/998) | qq_77777 | 2026-05-21 | functional | 7 | 73 | 0 |
| 12 | [#1127](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1127) | br_image_picker-v1.1.2_ohos分支新增单元测试 | [#996](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/996) | qq_77777 | 2026-05-20 | functional | 7 | 69 | 0 |
| 13 | [#919](https://gitcode.com/openharmony-tpc/flutter_packages/issues/919) | 【br_image_picker-v1.2.1_ohos_dev】修复image_picker选取同一照片，后续设置宽高未生效问题 | [#748](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/748) | lx123546879 | 2026-03-10 | functional | 7 | 32 | 0 |
| 14 | [#1424](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1424) | br_pigeon-v26.1.5_ohos_dev分支AI质量加固优化 | [#1299](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1299) | zhaichenyang | 2026-06-29 | performance | 6 | 1692 | 1 |
| 15 | [#1423](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1423) | br_pigeon-v25.3.2_ohos_dev分支AI质量加固优化 | [#1300](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1300) | zhaichenyang | 2026-06-29 | performance | 6 | 1422 | 1 |
| 16 | [#1369](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1369) | br_file_selector-v1.1.0_ohos 分支中 packages/file_selector/file_selector/pubspec.yaml 存在 Tab 缩进，导致 flutter pub get 失败 | [#983](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/983) | zhong_ning | 2026-06-15 | functional | 6 | 248 | 1 |
| 17 | [#1316](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1316) | 修改yaml文件的分支为br_webview_flutter-v4.13.1_ohos_dev | [#1198](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1198) | qq_77777 | 2026-06-05 | functional | 6 | 86 | 0 |
| 18 | [#1314](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1314) | br_camera-v0.12.0+1_ohos_dev修改分支信息 | [#1196](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1196) | qq_77777 | 2026-06-05 | functional | 6 | 80 | 0 |
| 19 | [#1243](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1243) | br_url_launcher-v6.3.2_ohos分支去除电话号码多余空格 | [#1123](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1123) | qq_77777 | 2026-05-29 | functional | 6 | 63 | 0 |
| 20 | [#1242](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1242) | br_url_launcher-v6.3.0_ohos分支去除电话号码多余空格 | [#1122](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1122) | qq_77777 | 2026-05-29 | functional | 6 | 68 | 0 |
| 21 | [#1235](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1235) | yaml文件指定依赖分支为br_url_launcher-v6.3.2_ohos_dev | [#1113](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1113) | qq_77777 | 2026-05-29 | functional | 6 | 73 | 0 |
| 22 | [#1234](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1234) | yaml文件修改依赖指定分支为br_url_launcher-v6.3.0_ohos_dev | [#1112](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1112) | qq_77777 | 2026-05-29 | functional | 6 | 73 | 0 |
| 23 | [#1233](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1233) | yaml文件指定依赖分支为br_url_launcher_v6.3.1_ohos_dev | [#1111](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1111) | qq_77777 | 2026-05-29 | functional | 6 | 72 | 0 |
| 24 | [#1232](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1232) | yaml文件指定依赖分支为br_url_launcher_v6.3.1_ohos | [#1110](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1110) | qq_77777 | 2026-05-29 | functional | 6 | 74 | 0 |
| 25 | [#1209](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1209) | 默认分支修复鸿蒙端webview通知用户加载资源时发生SSL错误回调现象 | [#1084](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1084) | zhong_ning | 2026-05-27 | functional | 6 | 32 | 0 |
| 26 | [#1195](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1195) | bugfix:br_local_auth_v3.0.0_ohos readme描述与实际不符修改 | [#1031](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1031) | com1250405878 | 2026-05-28 | functional | 6 | 32 | 0 |
| 27 | [#1154](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1154) | br_webview_flutter-v4.8.0_ohos_dev分支新增单元测试 | [#1023](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1023) | qq_77777 | 2026-05-21 | functional | 6 | 76 | 0 |
| 28 | [#1153](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1153) | br_webview_flutter-v4.13.0_ohos分支新增单元测试 | [#1022](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1022) | qq_77777 | 2026-05-20 | functional | 6 | 73 | 0 |
| 29 | [#1152](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1152) | br_video_player-v2.9.2_ohos_dev分支新增单元测试 | [#1021](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1021) | qq_77777 | 2026-05-20 | functional | 6 | 73 | 0 |
| 30 | [#1151](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1151) | br_video_player-v2.10.1_ohos_dev分支新增单元测试 | [#1020](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1020) | qq_77777 | 2026-05-19 | functional | 6 | 74 | 0 |
| 31 | [#1150](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1150) | br_video_player-v2.10.1_ohos分支新增单元测试 | [#1019](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1019) | qq_77777 | 2026-05-20 | functional | 6 | 70 | 0 |
| 32 | [#1149](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1149) | br_video_player-v2.10.0_ohos_dev分支新增单元测试 | [#1017](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1017) | qq_77777 | 2026-05-19 | functional | 6 | 74 | 0 |
| 33 | [#1148](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1148) | br_url_launcher_v6.3.1_ohos_dev分支新增单元测试 | [#1016](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1016) | qq_77777 | 2026-05-20 | functional | 6 | 73 | 0 |
| 34 | [#1147](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1147) | br_url_launcher_v6.3.1_ohos分支新增单元测试 | [#1015](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1015) | qq_77777 | 2026-05-20 | functional | 6 | 69 | 0 |
| 35 | [#1146](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1146) | br_url_launcher-v6.3.2_ohos_dev分支新增单元测试 | [#1014](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1014) | qq_77777 | 2026-05-20 | functional | 6 | 73 | 0 |
| 36 | [#1145](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1145) | br_url_launcher-v6.3.2_ohos分支新增单元测试 | [#1013](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1013) | qq_77777 | 2026-05-20 | functional | 6 | 69 | 0 |
| 37 | [#1142](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1142) | br_url_launcher-v6.3.0_ohos分支新增单元测试 | [#1011](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1011) | qq_77777 | 2026-05-22 | functional | 6 | 70 | 0 |
| 38 | [#1141](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1141) | br_shared_preferences-v2.5.4_ohos_dev分支新增单元测试 | [#1010](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1010) | qq_77777 | 2026-05-20 | functional | 6 | 80 | 0 |
| 39 | [#1140](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1140) | br_shared_preferences-v2.5.4_ohos分支新增单元测试 | [#1009](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1009) | qq_77777 | 2026-05-20 | functional | 6 | 76 | 0 |
| 40 | [#1139](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1139) | br_shared_preferences-v2.5.3_ohos分支新增单元测试 | [#1008](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1008) | qq_77777 | 2026-05-20 | functional | 6 | 76 | 0 |
| 41 | [#1138](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1138) | br_shared_preferences-v2.3.2_ohos_dev分支新增单元测试 | [#1007](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1007) | qq_77777 | 2026-05-20 | functional | 6 | 80 | 0 |
| 42 | [#1136](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1136) | br_shared_preferences-v2.3.2_ohos分支新增单元测试 | [#1006](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1006) | qq_77777 | 2026-05-20 | functional | 6 | 76 | 0 |
| 43 | [#1135](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1135) | br_pigeon-v26.1.5_ohos_dev分支新增单元测试 | [#1005](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1005) | qq_77777 | 2026-05-20 | functional | 6 | 69 | 0 |
| 44 | [#1134](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1134) | br_path_provider-v2.1.5_ohos_dev分支新增单元测试 | [#1004](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1004) | qq_77777 | 2026-05-19 | functional | 6 | 73 | 0 |
| 45 | [#1126](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1126) | br_file_selector-v1.1.0_ohos_dev分支新增单元测试 | [#995](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/995) | qq_77777 | 2026-05-20 | functional | 6 | 74 | 0 |
| 46 | [#1125](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1125) | br_camera-v0.11.3_ohos分支新增单元测试 | [#994](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/994) | qq_77777 | 2026-05-19 | functional | 6 | 64 | 0 |
| 47 | [#1124](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1124) | br_camera-v0.11.1_ohos_dev分支新增单元测试 | [#993](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/993) | qq_77777 | 2026-05-19 | functional | 6 | 68 | 0 |
| 48 | [#1122](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1122) | br_camera-v0.11.0_2_ohos_dev分支新增单元测试 | [#991](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/991) | qq_77777 | 2026-05-20 | functional | 6 | 70 | 0 |
| 49 | [#1121](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1121) | br_camera-v0.11.0_2_ohos分支增加单元测试 | [#990](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/990) | qq_77777 | 2026-05-20 | functional | 6 | 68 | 0 |
| 50 | [#1120](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1120) | br_camera-v0.11.0+2_ohos分支增加单元测试 | [#988](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/988) | qq_77777 | 2026-05-20 | functional | 6 | 47 | 0 |
| 51 | [#1109](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1109) | 【3.22】shared_preferences添加集成测试OHOS工程 | [#978](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/978) | huangyouhua | 2026-05-18 | functional | 6 | 32 | 0 |
| 52 | [#1042](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1042) | br_url_launcher_v6.3.2_ohos_dev：去除电话号码的空格 | [#887](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/887) | qq_77777 | 2026-04-23 | functional | 6 | 32 | 0 |
| 53 | [#1041](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1041) | br_url_launcher_v6.3.1_ohos_dev：去除电话号码的空格 | [#886](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/886) | qq_77777 | 2026-04-23 | functional | 6 | 32 | 0 |
| 54 | [#1040](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1040) | br_url_launcher-v6.3.0_ohos_dev分支去除电话号码中的空格 | [#885](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/885) | qq_77777 | 2026-04-23 | functional | 6 | 32 | 0 |
| 55 | [#1009](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1009) | 【video_player_ohos】视频结束后会自动关闭屏幕常亮 | [#851](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/851) | gtbluesky | 2026-04-17 | functional | 6 | 32 | 0 |
| 56 | [#994](https://gitcode.com/openharmony-tpc/flutter_packages/issues/994) | 指定依赖分支br_url_launcher-v6.3.0_ohos | [#833](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/833) | qq_77777 | 2026-04-10 | functional | 6 | 32 | 0 |
| 57 | [#976](https://gitcode.com/openharmony-tpc/flutter_packages/issues/976) | 稳定性遍历8小时出现9次jscrash | [#793](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/793) | guanxia | 2026-04-02 | stability | 6 | 1204 | 0 |
| 58 | [#969](https://gitcode.com/openharmony-tpc/flutter_packages/issues/969) | 添加url_laucher插件库的ohos依赖 | [#800](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/800) | qq_77777 | 2026-04-02 | functional | 6 | 78 | 0 |
| 59 | [#903](https://gitcode.com/openharmony-tpc/flutter_packages/issues/903) | br_path_provider-v2.1.5_ohos, The root directory configuration of path_provider does not include the OHOS platform. | [#731](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/731) | getmoon | 2026-03-04 | functional | 6 | 297 | 0 |
| 60 | [#901](https://gitcode.com/openharmony-tpc/flutter_packages/issues/901) | [Bug]: br_camera-v0.11.3_ohos ，when calling stopRecordingVideo, there may be no return result. | [#730](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/730) | getmoon | 2026-03-17 | functional | 6 | 325 | 0 |
| 61 | [#900](https://gitcode.com/openharmony-tpc/flutter_packages/issues/900) | [Bug]:br_camera-v0.11.0+2_ohos ，when calling stopRecordingVideo, there may be no return result. | [#729](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/729) | getmoon | 2026-03-17 | functional | 6 | 325 | 0 |
| 62 | [#899](https://gitcode.com/openharmony-tpc/flutter_packages/issues/899) | [Bug]: br_camera-v0.11.1_ohos ，when calling stopRecordingVideo, there may be no return result. | [#728](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/728) | getmoon | 2026-03-17 | functional | 6 | 325 | 0 |
| 63 | [#844](https://gitcode.com/openharmony-tpc/flutter_packages/issues/844) | br_camera-v0.11.0+2_ohos分支，camera仓库点击请求焦点无法正确对焦 | [#687](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/687) | getmoon | 2026-01-26 | functional | 6 | 101 | 0 |
| 64 | [#838](https://gitcode.com/openharmony-tpc/flutter_packages/issues/838) | In packages/camera/camera_ohos/exampl, if you turn on the constant flash and then click record, the constant icon will still be displayed even if the flash is turned off. | [#676](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/676) | getmoon | 2026-01-26 | functional | 6 | 434 | 0 |
| 65 | [#835](https://gitcode.com/openharmony-tpc/flutter_packages/issues/835) | br_camera-v0.11.1_ohos分支，camera仓库点击请求焦点无法正确对焦 | [#673](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/673) | getmoon | 2026-01-26 | functional | 6 | 303 | 0 |
| 66 | [#1444](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1444) | fix：dev分支 image_picker_ohos运行test报错 | [#1340](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1340) | wtocctvqwe | 2026-07-02 | functional | 5 | 54 | 0 |
| 67 | [#1183](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1183) | 【dev】image_picker库fix:ImagePickerCache.getCacheMap IMAGE_QUALITY 设置错误 | [#1058](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1058) | lx123546879 | 2026-05-22 | functional | 5 | 32 | 0 |
| 68 | [#1180](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1180) | 【dev】ImagePickerApiCodec 序列化 type tag 错误 | [#1055](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1055) | lx123546879 | 2026-05-22 | functional | 5 | 32 | 0 |
| 69 | [#1178](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1178) | 【dev】image_picker库fix:FileUtils.getPathFromUri 空 context 返回值置为null | [#1053](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1053) | lx123546879 | 2026-05-22 | functional | 5 | 32 | 0 |
| 70 | [#1097](https://gitcode.com/openharmony-tpc/flutter_packages/issues/1097) | image_picker库yaml文件格式错误修复 | [#957](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/957) | lx123546879 | 2026-05-20 | functional | 5 | 32 | 0 |
| 71 | [#874](https://gitcode.com/openharmony-tpc/flutter_packages/issues/874) | 【3.22/3.27】修复image_picker选取同一照片，后续设置宽高未生效问题 | [#716](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/716) | lx123546879 | 2026-03-16 | functional | 5 | 32 | 0 |
| 72 | [#827](https://gitcode.com/openharmony-tpc/flutter_packages/issues/827) | fix：image_picker修改chooseMedia调用参数 | [#666](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/666) | lx123546879 | 2026-01-20 | functional | 5 | 32 | 0 |
| 73 | [#820](https://gitcode.com/openharmony-tpc/flutter_packages/issues/820) | image_picker-v1.2.1升级适配Flutter3.35 | [#661](https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/661) | lx123546879 | 2026-01-16 | functional | 5 | 32 | 0 |

---

## 详细信息

### 1. #1014 — [shared_preferences_ohos] SharedPreferencesAsync 的 getStringList 和 setStringList方法失效，始终返回 null（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1014
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/860 (merged 2026-05-14)
- **PR Title**: fix:The getStringList and setStringList methods of SharedPreferencesAsync are not working.
- **PR 创建人**: huangyouhua
- **质量评分**: 12 | Body: 2043 chars | Comments: 1
- **评分明细**: body>500, body>1500, 复现步骤, 代码, 错误信息, 环境信息
- **问题描述**: ## 问题描述 分支：br_shared_preferences-v2.5.4_ohos，在 `shared_preferences_ohos` 包中，使用**新版异步 API**（`SharedPreferencesAsync`）调用 `getStringList` 时，始终返回 `null`，无法正确读取已存储的 String List 数据。 ## 影响范围

### 2. #1196 — [Bug]: 【pigeon】生成的ArkTs 数据类中toList 会因为undefined导致Dart读取数组异常，导致属性无法对应（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1196
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1203 (merged 2026-06-12)
- **PR Title**: 修复pigeon的toList可以使用undefined做占位符
- **PR 创建人**: zhong_ning
- **质量评分**: 11 | Body: 1126 chars | Comments: 1
- **评分明细**: body>500, 复现步骤, 代码, 错误信息, 环境信息, 截图
- **问题描述**: 感谢对OpenHarmony社区的支持与关注，欢迎反馈缺陷。 ### 发生了什么问题？ 在br_pigeon-v26.1.5_ohos版本上，使用pigeon生成ArkTs代码后，在原生侧发送MessageData时，如果有属性为undefined，在toList序列化的时候，不会push到Array中，导致发送时，数组的长度就变短了，在Dart侧接收到后进行解析时，由于数组长度对应不上，所以按照

### 3. #1103 — [Bug]:  shared_preferences 插件在写入值时触发： Valid value range is empty: 0（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1103
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1332 (merged 2026-06-25)
- **PR Title**: Fix the issue where the plugin takes incorrect values when writing data
- **PR 创建人**: zhong_ning
- **质量评分**: 11 | Body: 1456 chars | Comments: 4
- **评分明细**: body>500, 复现步骤, 代码, 错误信息, 环境信息, 3+评论
- **问题描述**: 感谢对OpenHarmony社区的支持与关注，欢迎反馈缺陷。 ### 发生了什么问题？ 插件在 [messages.g.dart](https://gitcode.com/openharmony-tpc/flutter_packages/blob/br_shared_preferences-v2.5.4_ohos/packages/shared_preferences/shared_prefere

### 4. #1422 — pigeon-v21.2.0_dev分支AI质量加固优化（performance）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1422
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1301 (merged 2026-06-29)
- **PR Title**: pigeon-v21.2.0_dev分支AI质量加固优化
- **PR 创建人**: zhaichenyang
- **质量评分**: 10 | Body: 1992 chars | Comments: 1
- **评分明细**: body>500, body>1500, 代码, 错误信息, 环境信息
- **问题描述**: 基线概况： 约 1020 行 lib/arkts_generator.dart，有 pigeonTest.dart（ConfigurePigeon 注释掉未启用）和 PigeonOhos.ets 旧 demo，但无完整 OHOS 移植与 EventChannel 端到端示例。 缺少完整的 demo 真机测试用例。

### 5. #1328 — shared_preferences 插件在写入值时触发：Valid value range is empty: 0（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1328
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1214 (merged 2026-06-15)
- **PR Title**: Fix the issue where the plugin takes incorrect values when writing data
- **PR 创建人**: zhong_ning
- **质量评分**: 10 | Body: 838 chars | Comments: 0
- **评分明细**: body>500, 复现步骤, 代码, 错误信息, 环境信息
- **问题描述**: ### 发生了什么问题？ shared_preferences 插件在写入值时触发：Valid value range is empty: 0 ### 该问题是怎么引起的？

### 6. #1144 — [Bug]: shared_preferences setEncodedStringList 通道未注册及回复空数组问题（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1144
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1241 (merged 2026-06-17)
- **PR Title**: fix setEncodedStringList
- **PR 创建人**: zhong_ning
- **质量评分**: 8 | Body: 1020 chars | Comments: 2
- **评分明细**: body>500, 复现步骤, 错误信息, 环境信息
- **问题描述**: 感谢对OpenHarmony社区的支持与关注，欢迎反馈缺陷。 ### 发生了什么问题？ flutter 3.27.5版本下的shared_preferences-v2.5.3插件在运行时候报错

### 7. #1118 — [Bug]: pigeon生成的模板内部类型错误（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1118
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1207 (merged 2026-06-11)
- **PR Title**: 修复当使用FlutterApi时类型不匹配导致编译报错
- **PR 创建人**: zhong_ning
- **质量评分**: 8 | Body: 977 chars | Comments: 1
- **评分明细**: body>500, 复现步骤, 代码, 错误信息
- **问题描述**: 感谢对OpenHarmony社区的支持与关注，欢迎反馈缺陷。 ### 发生了什么问题？ 使用社区的Pigeon库来实现FlutterApi时，自动生成的代码中包含类型错误。查看源码中writeFlutterApi方法内的部分实现

### 8. #1220 — camera_ohos修改README文件（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1220
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1096 (merged 2026-05-27)
- **PR Title**: 修改README文件
- **PR 创建人**: zhangcongcong_zzzcc
- **质量评分**: 7 | Body: 86 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ README文件中API表格中少了一个注册插件的接口说明，多了一个设置拍照图片格式的接口说明（暂未支持）。 ### 重现步骤

### 9. #1218 — camera_ohos中捕获fps设置失败时发生的异常，防止程序奔溃（performance）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1218
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1094 (merged 2026-05-27)
- **PR Title**: 修改帧率设置代码
- **PR 创建人**: zhangcongcong_zzzcc
- **质量评分**: 7 | Body: 233 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ 设置fps时，系统接口支持{60，60}，但实际设置在这个范围内时发生错误。 ### 重现步骤

### 10. #1132 — br_image_picker-v1.2.1_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1132
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1003 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 7 | Body: 69 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ br_image_picker-v1.2.1_ohos缺少相应的单元测试 ### 重现步骤

### 11. #1128 — br_image_picker-v1.1.2_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1128
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/998 (merged 2026-05-21)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 7 | Body: 73 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ br_image_picker-v1.1.2_ohos_dev缺少相应的单元测试 ### 重现步骤

### 12. #1127 — br_image_picker-v1.1.2_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1127
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/996 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 7 | Body: 69 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ br_image_picker-v1.1.2_ohos缺少相应的单元测试 ### 重现步骤

### 13. #919 — 【br_image_picker-v1.2.1_ohos_dev】修复image_picker选取同一照片，后续设置宽高未生效问题（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/919
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/748 (merged 2026-03-10)
- **PR Title**: 修复image_picker选取同一照片，后续设置宽高未生效问题
- **PR 创建人**: lx123546879
- **质量评分**: 7 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 14. #1424 — br_pigeon-v26.1.5_ohos_dev分支AI质量加固优化（performance）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1424
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1299 (merged 2026-06-29)
- **PR Title**: br_pigeon-v26.1.5_ohos_dev分支AI质量加固优化
- **PR 创建人**: zhaichenyang
- **质量评分**: 6 | Body: 1692 chars | Comments: 1
- **评分明细**: body>500, body>1500, 环境信息
- **问题描述**: 基线概况： 约 1033 行 lib/src/arkts/arkts_generator.dart，已有 EventChannel 示例骨架与 test/arkts_generator_test.dart（内容过时），但 ProxyApi 生成、harness、ArkTS ProxyApi 测试均缺失。 缺少完整的 demo 真机测试用例。

### 15. #1423 — br_pigeon-v25.3.2_ohos_dev分支AI质量加固优化（performance）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1423
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1300 (merged 2026-06-29)
- **PR Title**: br_pigeon-v25.3.2_ohos_dev分支AI质量加固优化
- **PR 创建人**: zhaichenyang
- **质量评分**: 6 | Body: 1422 chars | Comments: 1
- **评分明细**: body>500, 代码, 环境信息
- **问题描述**: 基线概况： 约 1042 行 lib/src/arkts/arkts_generator.dart，已有 EventChannelMessages.ets 与带 StreamHandler 的 MessagePlugin.ets，但 ProxyApi/完整 harness/测试与 26.3.4 差距大。 缺少完整的 demo 真机测试用例。

### 16. #1369 — br_file_selector-v1.1.0_ohos 分支中 packages/file_selector/file_selector/pubspec.yaml 存在 Tab 缩进，导致 flutter pub get 失败（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1369
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/983 (merged 2026-06-15)
- **PR Title**: 修复flie_selector的pubspec.yaml文件中有tab空格问题
- **PR 创建人**: zhong_ning
- **质量评分**: 6 | Body: 248 chars | Comments: 1
- **评分明细**: 代码, 错误信息, 环境信息
- **问题描述**: ## 问题描述 项目在执行 `flutter pub get` 时失败，报错如下： Resolving dependencies...

### 17. #1316 — 修改yaml文件的分支为br_webview_flutter-v4.13.1_ohos_dev（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1316
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1198 (merged 2026-06-05)
- **PR Title**: 修改yaml文件的分支为br_webview_flutter-v4.13.1_ohos_dev
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 86 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ yaml的分支与分支名不同，需修改为br_webview_flutter-v4.13.1_ohos_dev ### 重现步骤

### 18. #1314 — br_camera-v0.12.0+1_ohos_dev修改分支信息（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1314
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1196 (merged 2026-06-05)
- **PR Title**: 修改br_camera-v0.12.0+1_ohos_dev的yaml文件分支信息
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 80 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ yaml文件的分支信息错误，需要修改为br_camera-v0.12.0+1_ohos_dev ### 重现步骤

### 19. #1243 — br_url_launcher-v6.3.2_ohos分支去除电话号码多余空格（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1243
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1123 (merged 2026-05-29)
- **PR Title**: 去除br_url_launcher-v6.3.2_ohos分支电话号码的空格
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 63 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ 没有增加去除电话号码的逻辑，导致输入电话号码的时候会解析错误 ### 重现步骤

### 20. #1242 — br_url_launcher-v6.3.0_ohos分支去除电话号码多余空格（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1242
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1122 (merged 2026-05-29)
- **PR Title**: 去除多余空格
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 68 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ 没有增加去除电话号码中空格的逻辑，导致输入电话号码在解析的时候会有空格 ### 重现步骤

### 21. #1235 — yaml文件指定依赖分支为br_url_launcher-v6.3.2_ohos_dev（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1235
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1113 (merged 2026-05-29)
- **PR Title**: 修改依赖指定分支br_url_launcher-v6.3.2_ohos_dev
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 73 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ 没有指定依赖分支为br_url_launcher-v6.3.2_ohos_dev ### 重现步骤

### 22. #1234 — yaml文件修改依赖指定分支为br_url_launcher-v6.3.0_ohos_dev（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1234
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1112 (merged 2026-05-29)
- **PR Title**: 修改赖依指定分支br_url_launcher-v6.3.0_ohos_dev
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 73 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ 没有指定依赖分支为br_url_launcher-v6.3.0_ohos_dev ### 重现步骤

### 23. #1233 — yaml文件指定依赖分支为br_url_launcher_v6.3.1_ohos_dev（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1233
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1111 (merged 2026-05-29)
- **PR Title**: 指定依赖分支为br_url_launcher_v6.3.1_ohos_dev
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 72 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ 未指定依赖分支为br_url_launcher_v6.3.1_ohos_dev ### 重现步骤

### 24. #1232 — yaml文件指定依赖分支为br_url_launcher_v6.3.1_ohos（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1232
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1110 (merged 2026-05-29)
- **PR Title**: 指定依赖分支为br_url_launcher_v6.3.1_ohos
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 74 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_url_launcher_v6.3.1_ohos分支没有在ymal文件中指定 ### 重现步骤

### 25. #1209 — 默认分支修复鸿蒙端webview通知用户加载资源时发生SSL错误回调现象（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1209
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1084 (merged 2026-05-27)
- **PR Title**: 默认分支修复鸿蒙端webview通知用户加载资源时发生SSL错误回调现象
- **PR 创建人**: zhong_ning
- **质量评分**: 6 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 26. #1195 — bugfix:br_local_auth_v3.0.0_ohos readme描述与实际不符修改（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1195
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1031 (merged 2026-05-28)
- **PR Title**: bugfix:br_local_auth_v3.0.0_ohos readme描述与实际不符修改
- **PR 创建人**: com1250405878
- **质量评分**: 6 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 27. #1154 — br_webview_flutter-v4.8.0_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1154
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1023 (merged 2026-05-21)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 76 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_webview_flutter-v4.8.0_ohos_dev缺少相应的单元测试 ### 重现步骤

### 28. #1153 — br_webview_flutter-v4.13.0_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1153
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1022 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 73 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_webview_flutter-v4.13.0_ohos缺少相应的单元测试 ### 重现步骤

### 29. #1152 — br_video_player-v2.9.2_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1152
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1021 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 73 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_video_player-v2.9.2_ohos_dev缺少相应的单元测试 ### 重现步骤

### 30. #1151 — br_video_player-v2.10.1_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1151
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1020 (merged 2026-05-19)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 74 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_video_player-v2.10.1_ohos_dev缺少相应的单元测试 ### 重现步骤

### 31. #1150 — br_video_player-v2.10.1_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1150
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1019 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 70 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_video_player-v2.10.1_ohos缺少相应的单元测试 ### 重现步骤

### 32. #1149 — br_video_player-v2.10.0_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1149
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1017 (merged 2026-05-19)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 74 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_video_player-v2.10.0_ohos_dev缺少相应的单元测试 ### 重现步骤

### 33. #1148 — br_url_launcher_v6.3.1_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1148
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1016 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 73 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_url_launcher_v6.3.1_ohos_dev缺少相应的单元测试 ### 重现步骤

### 34. #1147 — br_url_launcher_v6.3.1_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1147
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1015 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 69 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_url_launcher_v6.3.1_ohos缺少相应的单元测试 ### 重现步骤

### 35. #1146 — br_url_launcher-v6.3.2_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1146
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1014 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 73 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_url_launcher-v6.3.2_ohos_dev缺少相应的单元测试 ### 重现步骤

### 36. #1145 — br_url_launcher-v6.3.2_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1145
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1013 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 69 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_url_launcher-v6.3.2_ohos缺少相应的单元测试 ### 重现步骤

### 37. #1142 — br_url_launcher-v6.3.0_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1142
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1011 (merged 2026-05-22)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 70 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_url_launcher-v6.3.0_ohos 缺少相应的单元测试 ### 重现步骤

### 38. #1141 — br_shared_preferences-v2.5.4_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1141
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1010 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 80 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_shared_preferences-v2.5.4_ohos_dev 缺少相应的单元测试 ### 重现步骤

### 39. #1140 — br_shared_preferences-v2.5.4_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1140
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1009 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 76 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_shared_preferences-v2.5.4_ohos 缺少相应的单元测试 ### 重现步骤

### 40. #1139 — br_shared_preferences-v2.5.3_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1139
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1008 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 76 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_shared_preferences-v2.5.3_ohos 缺少相应的单元测试 ### 重现步骤

### 41. #1138 — br_shared_preferences-v2.3.2_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1138
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1007 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 80 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_shared_preferences-v2.3.2_ohos_dev 缺少相应的单元测试 ### 重现步骤

### 42. #1136 — br_shared_preferences-v2.3.2_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1136
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1006 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 76 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_shared_preferences-v2.3.2_ohos 缺少相应的单元测试 ### 重现步骤

### 43. #1135 — br_pigeon-v26.1.5_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1135
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1005 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 69 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_pigeon-v26.1.5_ohos_dev 缺少相应的单元测试 ### 重现步骤

### 44. #1134 — br_path_provider-v2.1.5_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1134
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1004 (merged 2026-05-19)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 73 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_path_provider-v2.1.5_ohos_dev分支缺少单元测试 ### 重现步骤

### 45. #1126 — br_file_selector-v1.1.0_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1126
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/995 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 74 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_file_selector-v1.1.0_ohos_dev缺少相应的单元测试 ### 重现步骤

### 46. #1125 — br_camera-v0.11.3_ohos分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1125
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/994 (merged 2026-05-19)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 64 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_camera-v0.11.3_ohos缺少相应的单元测试 ### 重现步骤

### 47. #1124 — br_camera-v0.11.1_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1124
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/993 (merged 2026-05-19)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 68 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_camera-v0.11.1_ohos_dev缺少相应的单元测试 ### 重现步骤

### 48. #1122 — br_camera-v0.11.0_2_ohos_dev分支新增单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1122
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/991 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 70 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_camera-v0.11.0_2_ohos_dev缺少相应的单元测试 ### 重现步骤

### 49. #1121 — br_camera-v0.11.0_2_ohos分支增加单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1121
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/990 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 68 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ br_camera-v0.11.0_2_ohos没有配置相应的单元测试 ### 重现步骤

### 50. #1120 — br_camera-v0.11.0+2_ohos分支增加单元测试（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1120
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/988 (merged 2026-05-20)
- **PR Title**: chore: Add unit test checks.
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 47 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ 该分支没有配置相应的单元测试 ### 重现步骤

### 51. #1109 — 【3.22】shared_preferences添加集成测试OHOS工程（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1109
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/978 (merged 2026-05-18)
- **PR Title**: chore: add ohos integration test and uint test
- **PR 创建人**: huangyouhua
- **质量评分**: 6 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 52. #1042 — br_url_launcher_v6.3.2_ohos_dev：去除电话号码的空格（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1042
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/887 (merged 2026-04-23)
- **PR Title**: [CP] br_url_launcher_v6.3.2_ohos_dev:去除电话号码空格
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 53. #1041 — br_url_launcher_v6.3.1_ohos_dev：去除电话号码的空格（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1041
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/886 (merged 2026-04-23)
- **PR Title**: [CP] br_url_launcher_v6.3.1_ohos_dev：去除电话号码的空格
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 54. #1040 — br_url_launcher-v6.3.0_ohos_dev分支去除电话号码中的空格（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1040
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/885 (merged 2026-04-23)
- **PR Title**: [CP] br_url_launcher-v6.3.0_ohos_dev:去除电话号码的空格
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 55. #1009 — 【video_player_ohos】视频结束后会自动关闭屏幕常亮（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1009
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/851 (merged 2026-04-17)
- **PR Title**: 视频结束后不改变原有常亮状态
- **PR 创建人**: gtbluesky
- **质量评分**: 6 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 56. #994 — 指定依赖分支br_url_launcher-v6.3.0_ohos（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/994
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/833 (merged 2026-04-10)
- **PR Title**: 指定依赖分支br_url_launcher-v6.3.0_ohos
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 57. #976 — 稳定性遍历8小时出现9次jscrash（stability）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/976
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/793 (merged 2026-04-02)
- **PR Title**: fix: 解决onHttpErrorReceive回调导致jscrash的BUG
- **PR 创建人**: guanxia
- **质量评分**: 6 | Body: 1204 chars | Comments: 0
- **评分明细**: body>500, 错误信息, 环境信息
- **问题描述**: 使用br_webview_flutter-v4.13.0_ohos，偶现jscrash，根据堆栈分析，发现是webview4.13特有问题。webview4.13是flutter3.27适配的配套库，在OhosWebView文件的web组件中新增了onHttpErrorReceive回调，该回调会触发createWebResourceErrorData方法，向createWebResourceEr

### 58. #969 — 添加url_laucher插件库的ohos依赖（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/969
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/800 (merged 2026-04-02)
- **PR Title**: 添加url_laucher_ohos的依赖
- **PR 创建人**: qq_77777
- **质量评分**: 6 | Body: 78 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ 缺少url_laucher_ohos依赖，导致flutter pub get的时候依赖缺失 ### 重现步骤

### 59. #903 — br_path_provider-v2.1.5_ohos, The root directory configuration of path_provider does not include the OHOS platform.（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/903
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/731 (merged 2026-03-04)
- **PR Title**: bugfix: Add OHOS platform configuration to supplement the path_provider base library.
- **PR 创建人**: getmoon
- **质量评分**: 6 | Body: 297 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### What caused this problem? The root directory configuration of path_provider does not include the OHOS platform. ### Steps to reproduce:

### 60. #901 — [Bug]: br_camera-v0.11.3_ohos ，when calling stopRecordingVideo, there may be no return result.（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/901
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/730 (merged 2026-03-17)
- **PR Title**: bugfix: #901, fix stopVideoRecording(), adaptation processing logic to ensure a return.
- **PR 创建人**: getmoon
- **质量评分**: 6 | Body: 325 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### What caused this problem? When the state of the recording object is incorrect, no exception is thrown or returned. ### Steps to reproduce:

### 61. #900 — [Bug]:br_camera-v0.11.0+2_ohos ，when calling stopRecordingVideo, there may be no return result.（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/900
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/729 (merged 2026-03-17)
- **PR Title**: bugfix: #900, fix stopVideoRecording(), adaptation processing logic to ensure a return.
- **PR 创建人**: getmoon
- **质量评分**: 6 | Body: 325 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### What caused this problem? When the state of the recording object is incorrect, no exception is thrown or returned. ### Steps to reproduce:

### 62. #899 — [Bug]: br_camera-v0.11.1_ohos ，when calling stopRecordingVideo, there may be no return result.（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/899
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/728 (merged 2026-03-17)
- **PR Title**: bugfix: #899, fix stopVideoRecording(), adaptation processing logic to ensure a return.
- **PR 创建人**: getmoon
- **质量评分**: 6 | Body: 325 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### What caused this problem? When the state of the recording object is incorrect, no exception is thrown or returned. ### Steps to reproduce:

### 63. #844 — br_camera-v0.11.0+2_ohos分支，camera仓库点击请求焦点无法正确对焦（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/844
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/687 (merged 2026-01-26)
- **PR Title**: bugfix: #844,resolves an issue in the br_camera-v0.11.0+2_ohos branch where clicking to request focus in the camera repository would not result in proper focus.
- **PR 创建人**: getmoon
- **质量评分**: 6 | Body: 101 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ setFocusPoint传参未按照文档正确转换 ### 重现步骤

### 64. #838 — In packages/camera/camera_ohos/exampl, if you turn on the constant flash and then click record, the constant icon will still be displayed even if the flash is turned off.（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/838
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/676 (merged 2026-01-26)
- **PR Title**: bugfix: #838  1.fix the wrong type in FlashFeature.ets; 2.set cache flash mode when switch the session.
- **PR 创建人**: getmoon
- **质量评分**: 6 | Body: 434 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### What caused this problem? 1. When switching from photo preview to video recording, the session also switches, but the flash state is not reset. ### Steps to reproduce:

### 65. #835 — br_camera-v0.11.1_ohos分支，camera仓库点击请求焦点无法正确对焦（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/835
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/673 (merged 2026-01-26)
- **PR Title**: Bugfix: #835, resolves an issue in the br_camera-v0.11.1_ohos branch where clicking to request focus in the camera repository would not result in proper focus.
- **PR 创建人**: getmoon
- **质量评分**: 6 | Body: 303 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 环境信息
- **问题描述**: ### 该问题是怎么引起的？ 1、MessageChannel数据解析不正确； 2、坐标未按照文档正确转化，参考https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-camera-focus#setfocuspoint11

### 66. #1444 — fix：dev分支 image_picker_ohos运行test报错（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1444
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1340 (merged 2026-07-02)
- **PR Title**: fix:修复运行测试报错问题
- **PR 创建人**: wtocctvqwe
- **质量评分**: 5 | Body: 54 chars | Comments: 0
- **评分明细**: 错误信息, 环境信息, 截图
- **问题描述**: Error: No named parameter with the name 'limit'.

### 67. #1183 — 【dev】image_picker库fix:ImagePickerCache.getCacheMap IMAGE_QUALITY 设置错误（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1183
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1058 (merged 2026-05-22)
- **PR Title**: image_picker库fix:ImagePickerCache.getCacheMap IMAGE_QUALITY 设置错误
- **PR 创建人**: lx123546879
- **质量评分**: 5 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 68. #1180 — 【dev】ImagePickerApiCodec 序列化 type tag 错误（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1180
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1055 (merged 2026-05-22)
- **PR Title**: imagepicker库fix:ImagePickerApiCodec 序列化 type tag 错误
- **PR 创建人**: lx123546879
- **质量评分**: 5 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 69. #1178 — 【dev】image_picker库fix:FileUtils.getPathFromUri 空 context 返回值置为null（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1178
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/1053 (merged 2026-05-22)
- **PR Title**: image_picker库fix:FileUtils.getPathFromUri 空 context 返回值置为null
- **PR 创建人**: lx123546879
- **质量评分**: 5 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 70. #1097 — image_picker库yaml文件格式错误修复（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/1097
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/957 (merged 2026-05-20)
- **PR Title**: image_picker库fix:yaml文件格式错误修复
- **PR 创建人**: lx123546879
- **质量评分**: 5 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 71. #874 — 【3.22/3.27】修复image_picker选取同一照片，后续设置宽高未生效问题（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/874
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/716 (merged 2026-03-16)
- **PR Title**: 修复image_picker选取同一照片，后续设置宽高未生效问题
- **PR 创建人**: lx123546879
- **质量评分**: 5 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 72. #827 — fix：image_picker修改chooseMedia调用参数（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/827
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/666 (merged 2026-01-20)
- **PR Title**: fix：image_picker-v1.2.1修改chooseMedia调用参数
- **PR 创建人**: lx123546879
- **质量评分**: 5 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

### 73. #820 — image_picker-v1.2.1升级适配Flutter3.35（functional）

- **Issue**: https://gitcode.com/openharmony-tpc/flutter_packages/issues/820
- **PR**: https://gitcode.com/openharmony-tpc/flutter_packages/merge_requests/661 (merged 2026-01-16)
- **PR Title**: image_picker-v1.2.1升级适配Flutter3.35
- **PR 创建人**: lx123546879
- **质量评分**: 5 | Body: 32 chars | Comments: 0
- **评分明细**: 复现步骤, 错误信息, 截图
- **问题描述**: ### 该问题是怎么引起的？ ### 重现步骤 ### 报错信息

---

## 统计

| 类型 | 数量 | 质量评分范围 |
|------|------|-------------|
| 稳定性 (stability) | 1 | 6-6 |
| 内存泄漏 (memory-leak) | 0 | — |
| 渲染 (rendering) | 0 | — |
| 性能 (performance) | 4 | 6-10 |
| 功能 (functional) | 68 | 5-12 |
| **总计** | **73** | **5-12** |

## 质量保证

每个 Issue 均满足以下全部条件：
- ✅ 来源：`openharmony-tpc/flutter_packages`
- ✅ Issue 已关闭（state=closed）
- ✅ 有对应的已合并 PR（通过 GitCode API `/issues/{number}/pull_requests` 正向查询获取关联）
- ✅ PR 合入时间在近 6 个月内（2026-01-07 之后）
- ✅ PR 合并时间已确认（merged_at 字段非空）
- ✅ PR 合并状态已验证（state=merged）
- ✅ 质量评分 ≥ 5（body长度 + 复现步骤 + 代码 + 错误信息 + 环境信息 + 截图 + 评论）

## 数据收集方法

1. **获取已关闭 Issue**: 通过 GitCode API v5 `GET /repos/openharmony-tpc/flutter_packages/issues?state=closed` 分页获取所有已关闭 Issue（共扫描 1474 条）
2. **时间范围过滤**: 按 `updated_at` 过滤近 6 个月内的 Issue（2026-01-07 之后，共 1362 条）
3. **质量评分**: 对每个 Issue 按 body长度、复现步骤、代码示例、错误信息、环境信息、截图、评论数进行评分，筛选 score ≥ 5（共 244 条）
4. **查询 Issue-PR 关联**: 通过 `GET /repos/openharmony-tpc/flutter_packages/issues/{number}/pull_requests` 正向查询每个高质量 Issue 关联的 PR
5. **验证 PR 合并状态**: 逐一通过 `GET /repos/openharmony-tpc/flutter_packages/pulls/{pr_number}` 获取 PR 详情，确认 `state=merged` 且 `merged_at` 非空，且合入时间在近 6 个月内
6. **最终匹配**: 同时满足「质量评分达标」和「关联了已合入 PR」的 Issue 纳入测试集（共 73 条）
