# 本机 Linux 构建环境约定（OHOS + Android 复现验证）

> **MANDATORY - READ ENTIRE FILE** 在本机执行 `flutter build hap` / `flutter run` / 安装真机 / Android 对照验证之前。
> 本文件记录 2026-09-15 配置完成的本机真实环境。通用流程见 SKILL.md §3；本文件是 **本机覆盖项**，两者冲突时以本文件为准。

---

## A. 环境总览（已注入，直接可用）

引擎已通过 `~/.aceharness/data/env-vars.yaml` 把以下变量注入每个 agent 会话，**无需 export**：

| 变量 | 值 |
|---|---|
| `DEVECO_SDK_HOME` / `HOS_SDK_HOME` | `/home/flutter/harmony-tools/command-line-tools/sdk` |
| `OHOS_SDK_HOME` | `/home/flutter/harmony-tools/ohos-sdk`（结构：`26/{ets,js,native,previewer,toolchains}`） |
| `NODE_HOME` | `/home/flutter/harmony-tools/command-line-tools/tool/node` |
| `JAVA_HOME` / `ANDROID_HOME` / `ANDROID_SDK_ROOT` | `/home/flutter/Android/jdk-17` / `/home/flutter/Android` |
| `PATH` 前缀 | `command-line-tools/bin`、`ohos-sdk/26/toolchains`（hdc）、`Android/jdk-17/bin`、`platform-tools`（adb）、`emulator` |

**设备清单**：

| 平台 | 设备 | 序列号 | 说明 |
|---|---|---|---|
| OHOS 真机 | HUAWEI Pura X Max（HarmonyOS 7.0.0.34 log 版，**API 26**） | `6HK0125B07000225` | 常驻 USB 连接；log 版**不校验 Profile 设备绑定**，非绑定设备也能装 |
| Android 模拟器 | AVD `cpf_android35`（Android 15 / API 35） | `emulator-5554` | 常驻后台运行；若掉线先 `adb devices` 确认，再按 device-emulator-setup.md 启动 |

flutter SDK 用工作流注入的 `ohos-flutter-sdk.json` 里 `flutterBin`（本机清单见 `configs/ohos-flutter-sdks.yaml`）。

---

## B. OHOS demo 工程「必改清单」（模板生成后立刻做，缺一不可）

`flutter create --platforms=ohos` 生成的工程是 HarmonyOS 商用模板，本机工具链跑不通。**五个必改项**：

### B.1 `ohos/build-profile.json5`（app 段）

```json5
{
  "app": {
    "signingConfigs": [ /* 见 B.4 完整签名块 */ ],
    "products": [
      {
        "name": "default",
        "signingConfig": "default",
        "compatibleSdkVersion": 26,      // 改：整数，不是 "5.1.0(18)"
        "compileSdkVersion": 26,         // 加：OpenHarmony 模式必填
        "runtimeOS": "OpenHarmony"       // 改：不是 "HarmonyOS"（否则要求 hms 组件，本机没有）
      }
    ],
    "buildModeSet": [ /* 保留 */ ]
  },
  /* modules 段保留 */
}
```

### B.2 `ohos/entry/build-profile.json5`（targets 的 default）

```json5
{
  "apiType": 'stageMode',
  "buildOption": {},
  "targets": [
    { "name": "default", "runtimeOS": "OpenHarmony" },   // 改：不是 "HarmonyOS"
    { "name": "ohosTest" }
  ]
}
```

### B.3 `ohos/local.properties` 追加一行

```properties
sdk.dir=/home/flutter/harmony-tools/ohos-sdk
```

（`hwsdk.dir` / `nodejs.dir` / `flutter.sdk` 由 flutter_tools 自动写，勿删。）

### B.4 签名块（直接粘贴进 B.1 的 signingConfigs）

材料：`/home/flutter/harmony-signing/config/default_FlutterAbilityDemo_*.{cer,p12,p7b}`，密文已用本机 material 加密（只能本机解，勿改格式）：

```json5
"signingConfigs": [
  {
    "name": "default",
    "type": "OpenHarmony",
    "material": {
      "certpath": "/home/flutter/harmony-signing/config/default_FlutterAbilityDemo_IrhoHuyTCy-TnSznsljK2lYb22HLklWm8aUpZ3ohb_U=.cer",
      "storePassword": "0000001BB40E9F38FE1E0464F936AFBB3D058A5D432BF45DFFF77C06A180FFE4F734281E076E1EA35D60BC",
      "keyAlias": "debugkey",
      "keyPassword": "0000001BB40E9F38FE1E0464F936AFBB3D058A5D432BF45DFFF77C06A180FFE4F734281E076E1EA35D60BC",
      "profile": "/home/flutter/harmony-signing/config/default_FlutterAbilityDemo_IrhoHuyTCy-TnSznsljK2lYb22HLklWm8aUpZ3ohb_U=.p7b",
      "signAlg": "SHA256withECDSA",
      "storeFile": "/home/flutter/harmony-signing/config/default_FlutterAbilityDemo_IrhoHuyTCy-TnSznsljK2lYb22HLklWm8aUpZ3ohb_U=.p12"
    }
  }
]
```

**约束**：
- 密文 `0000001B...` 是 AES-128-GCM 密文（配合 `/home/flutter/harmony-signing/config/material/` 解密），**不是明文**；hvigor 要求 ≥32 字符密文，写明文会报 `less than 32`。
- material 目录必须与 p12 同级（已就位），**移动 p12 时 material 要跟着**。
- Profile 有效期至 **2027-07-23**；过期报 `certificate has expired`。

### B.5 bundleName 必须改成 Profile 绑定的

`ohos/AppScope/app.json5`：

```json5
"bundleName": "com.example.flutterabilitydemo"
```

调试 p7b 绑定此 bundleName；不一致构建报 `no signature file` / 安装失败。多个 demo 并存时，装新的前先卸旧的（同 bundleName 覆盖装用 `hdc install -r` 亦可）。

---

## C. ArkTS 代码写法约束（坑过的，勿再踩）

1. **handler 禁止 lambda**。`setMethodCallHandler` 参数是 interface，ArkTS 严格模式不接受箭头函数：

   ```typescript
   // ❌ new MethodChannel(...).setMethodCallHandler((call, result) => {...})
   // ✅
   class MyHandler implements MethodCallHandler {
     onMethodCall(call: MethodCall, result: MethodResult): void { ... }
   }
   new MethodChannel(dartExecutor, NAME).setMethodCallHandler(new MyHandler());
   ```

2. **`invokeMethod` 返回 void，没有 `.then`**。用第三参 callback（对象字面量 `as MethodResult`）：

   ```typescript
   mc.invokeMethod('ping', null, {
     success: (v: ESObject) => { ... },
     error: (code: string, message: string, details: ESObject) => { ... },
     notImplemented: () => { ... },
   } as MethodResult);
   ```

3. **Dart 侧禁用 dot-shorthands**（`.center`）。本机 flutter 3.41.9 未开实验开关，写 `MainAxisAlignment.center` 全称。

4. flutter 3.41.9 embedding 用到 API 26 的 `autoFillManager.AutoFillType`、`KeyEvent.isCapsLockOn` 等——本机 SDK d.ts 已是 API 26（`ohos-sdk/26`），这些成员都有，正常 import 即可，不要自己造类型桩。

---

## D. 构建与安装命令（本机实测可用）

```bash
# OHOS hap（含签名，产物 entry-default-signed.hap；首次约 60-90s，增量 <15s）
$FLUTTER_BIN build hap --debug

# 装真机并启动
hdc install -r build/ohos/hap/entry-default-signed.hap   # 或 ohos/entry/build/default/outputs/default/
hdc shell aa start -b com.example.flutterabilitydemo -a EntryAbility

# flutter run 全链路（热重载可用；测试时记得 timeout 或 detach，避免长挂）
hdc shell hilog -x | grep -iE 'flutter|issue'            # 看日志

# Android apk（Gradle 8.14 + maven 缓存已就绪；首次约 3-5 分钟，增量 <90s）
timeout 600 $FLUTTER_BIN build apk --debug
adb -s emulator-5554 install -r build/app/outputs/flutter-apk/app-debug.apk
adb -s emulator-5554 shell monkey -p <applicationId> -c android.intent.category.LAUNCHER 1
adb -s emulator-5554 exec-out screencap -p > outputs/android_baseline.png
```

iOS 本机是 Linux，无 mac，跨平台对照用 Android（技能允许）。

---

## E. 常见报错 → 根因对照

| 报错 | 根因 | 解法 |
|---|---|---|
| `No Hmos SDK found. Try setting the HOS_SDK_HOME` | 环境变量没进会话 | 确认跑在引擎 spawn 的会话里；手动补 §A 的 export |
| `SDK component missing (00303168)` | build-profile 还是 HarmonyOS 模板（runtimeOS/compatibleSdkVersion 没改） | 完成 §B.1/B.2/B.3 |
| `Schema validate failed: compatibleSdkVersion type integer` | 写成了 `"5.1.0(18)"` 字符串 | 改整数 26 |
| `Please configure compileSdkVersion` | OpenHarmony 模式必填 | §B.1 加 `compileSdkVersion: 26` |
| `The intersection of the system capability sets ... is empty` | `device-define/phone.json` 缺失 | 本机 SDK 已补，报错说明 SDK 路径不对（确认 `OHOS_SDK_HOME`） |
| `Namespace 'autoFillManager' has no exported member 'AutoFillType'` 等 | SDK d.ts 版本老（API 18） | 确认用的 `ohos-sdk/26`，不是 command-line-tools 里旧的 5.1.0 |
| `less than 32`（storePassword） | 签名写明文 | 用 §B.4 密文 |
| `no signature file (9568320)` 安装失败 | bundleName 与 Profile 不一致 / 未签名 | §B.4 + §B.5 |
| Gradle 卡 `Downloading gradle-x.x-all.zip` | wrapper 走国外慢源 | 本机 8.14 已装（`~/.gradle/wrapper/dists/`）；新版本卡住时用腾讯镜像 `https://mirrors.cloud.tencent.com/gradle/` 手动放 zip |
| `requires the experimental 'dot-shorthands'` | Dart 写了 `.center` 简写 | 写全称 |

---

## F. 环境维护备忘（管理员项，agent 无需操作）

- hvigor 版本映射注入：`command-line-tools/hvigor/hvigor-ohos-plugin/node_modules/@ohos/hos-sdkmanager-common/build/res/hos-config.json` 加了 `"7.0.0": "26"`（原表最高 5.1.0→18）
- SDK 结构：`/home/flutter/harmony-tools/ohos-sdk/26/toolchains/syscap_tool` 从 5.1.0 补入；`ets/api/device-define/phone.json` 为 default.json 副本
- 组件清单 `oh-uni-package.json` 统一 metaVersion 3.0.0（绕过 hvigor 白名单）
- 密文生成方式：见 `decipher-util.js`（AES-128-GCM，material 三件套派生 key）
- udev 规则 `/etc/udev/rules.d/51-hdc.rules`（华为 VID 12d1 → 0666）
