# OHOS 应用签名配置参考

> 用于 diagnosis-reproducer Agent 的签名配置指导。本文件提供领域经验，不定义执行步骤。

## 1. 签名配置文件格式

签名信息使用 JSON 格式配置，参考 `signing.conf.example`：

```json
{
  "bundleName": "com.example.flutterproject",
  "compatibleSdkVersion": "5.0.0(12)",
  "signingConfigs": [
    {
      "name": "default",
      "type": "HarmonyOS",
      "material": {
        "certpath": "/Users/hyh/.ohos/config/default_ohos_TlQjvtNFBTpT6cGOrt3Dq1SFmzfvZjhqRq4lwxLMAz0=.cer",
        "keyAlias": "debugKey",
        "keyPassword": "0000001A1EF733779ECF3BEE553F752C5D2ADA16070BBE1FC9B0F718BDBE6910BFA3F511F48EFE2E5A29",
        "profile": "/Users/hyh/.ohos/config/default_ohos_TlQjvtNFBTpT6cGOrt3Dq1SFmzfvZjhqRq4lwxLMAz0=.p7b",
        "signAlg": "SHA256withECDSA",
        "storeFile": "/Users/hyh/.ohos/config/default_ohos_TlQjvtNFBTpT6cGOrt3Dq1SFmzfvZjhqRq4lwxLMAz0=.p12",
        "storePassword": "0000001A5953FB639CF00A9B9BF9EB90370D509FC6D3B47D94387438EF4DD075FD6D727154744C55BDD1"
      }
    }
  ]
}

```

### 配置字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `bundleName` | 是 | 签名对应的 bundleName（必须与 p7b 中的 bundle-name 一致） |
| `compatibleSdkVersion` | 否 | 默认 `5.0.0(12)`，大多数 Demo 的默认值 |
| `signingConfigs` | 是 | 完整的签名配置片段（直接从 DevEco Studio 的 build-profile.json5 中复制） |
| `signingConfigs[].material.certpath` | 是 | .cer 证书文件路径 |
| `signingConfigs[].material.keyAlias` | 是 | 密钥别名（通常为 `debugKey`） |
| `signingConfigs[].material.keyPassword` | 是 | 密钥密码 |
| `signingConfigs[].material.profile` | 是 | .p7b profile 文件路径 |
| `signingConfigs[].material.signAlg` | 是 | 签名算法（通常为 `SHA256withECDSA`） |
| `signingConfigs[].material.storeFile` | 是 | .p12 keystore 文件路径 |
| `signingConfigs[].material.storePassword` | 是 | keystore 密码 |

## 2. 查找可用签名文件

签名文件通常位于 `~/.ohos/config/` 目录下，包含三个文件：
- `.cer` — 证书文件
- `.p12` — keystore 文件
- `.p7b` — profile 文件

### 查找命令

```bash
for p7b in ~/.ohos/config/default_*.p7b; do
  basename=$(basename "$p7b" .p7b)
  bundle=$(strings "$p7b" 2>/dev/null | grep -o '"bundle-name":"[^"]*"' | head -1 | sed 's/"bundle-name":"//;s/"//')
  notafter=$(strings "$p7b" 2>/dev/null | grep -o '"not-after":[0-9]*' | head -1 | sed 's/"not-after"://')
  [ -n "$notafter" ] && echo "$basename | bundle=$bundle | 过期=$(date -r $notafter '+%Y-%m-%d')"
done
```

### 签名选择标准

1. **bundleName 匹配**：p7b 中的 bundle-name 必须与 Demo 的 bundleName 一致（或统一修改 Demo 的 bundleName）
2. **未过期**：`not-after` 时间戳必须大于当前时间
3. **三文件齐全**：.cer、.p12、.p7b 三个文件都存在

## 3. 配置签名到 Demo

### 修改 build-profile.json5

将签名配置嵌入 Demo 的 `ohos/build-profile.json5`：

```json
{
  "app": {
    "signingConfigs": [
      {
        "name": "default",
        "type": "HarmonyOS",
        "material": {
          "certpath": "/Users/.../.cer",
          "keyAlias": "debugKey",
          "keyPassword": "...",
          "profile": "/Users/.../.p7b",
          "signAlg": "SHA256withECDSA",
          "storeFile": "/Users/.../.p12",
          "storePassword": "..."
        }
      }
    ],
    "products": [
      {
        "name": "default",
        "signingConfig": "default"
      }
    ]
  }
}
```

### 统一修改 bundleName

调试签名绑定 bundleName，必须将 Demo 的 bundleName 改为签名对应的 bundleName：

- 修改 `ohos/app.json5` 中的 `"bundleName"` 字段
- 修改 `ohos/build-profile.json5` 中的 `"bundleName"` 字段
- bundleName 必须与 p7b 中的 bundle-name 一致

### 设置 compatibleSdkVersion

- 大多数 Demo 默认 `5.0.0(12)`，不要硬编码高版本
- 在 `ohos/build-profile.json5` 中设置 `"compatibleSdkVersion": "5.0.0(12)"`

## 4. 常见签名错误

| 错误信息 | 根因 | 解决方案 |
|----------|------|----------|
| `The certificate has expired! NotAfter: ...` | 签名证书过期 | 查找未过期的签名文件 |
| `The bundleName in app.json does not match...SigningConfigs` | Demo bundleName 与签名 bundleName 不一致 | 统一改 bundleName 为签名对应的值 |
| `00617202 Fetch Local Package Failed` | 签名文件路径错误 | 检查 .cer/.p12/.p7b 路径是否正确 |
| 安装失败无明确原因 | hap 签名与设备不兼容或 bundleName 冲突 | 先卸载旧应用，检查签名配置 |

## 5. 签名配置注意事项

1. **备份→修改→测试→恢复**：修改 Demo 文件前先备份（`cp .bak`），测试后恢复，保持仓库干净
2. **统一 bundleName**：复用一套签名，逐个卸载避免冲突
3. **证书有效期**：过期的证书会导致安装失败，必须检查 `not-after`
4. **不要硬编码高版本**：`compatibleSdkVersion` 默认 `5.0.0(12)`，用高版本会不兼容
5. **找不到签名文件时降级**：如果找不到签名文件，标记 `device_available=false`，降级为理论分析
