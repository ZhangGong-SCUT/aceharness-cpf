# 看图

截图结论必须来自像素，不能靠 Issue 正文猜，也不能只跑 OCR。OCR 只适合日志/代码截图里的字。下划线不齐、错位、花屏、黑白屏必须看图。

## 先判断当前模型能不能看图

1. **能看图**（例如 grok、GPT-4o、Claude、Gemini）：用 Read 打开本地截图，自己看像素。不要调用 `look_at_image`，也不要再开 Qwen。
2. **不能看图**（例如 GLM-5.2）：必须调用 `look_at_image`（Qwen）。
3. **不确定**：先 Read 原图。能描述出具体像素细节就停；如果空白、报错、或模型明确说看不见图，再调用 `look_at_image`。

工作流会在步骤上下文里写「看图策略」。以那一段为准。

## 子模型怎么调用（仅降级）

优先 MCP 工具 `look_at_image`：

```text
look_at_image(path="outputs/screenshots/screenshot_1.png", question="《》下面的下划线是否对齐？偏左还是偏右？")
```

MCP 不可用时禁止写「工具不可用」后跳过。改用 Bash，或把图片路径和问题交给子代理 `vision-inspector`：

```bash
node "<skill-dir>/scripts/look-at-image.mjs" --image outputs/screenshots/screenshot_1.png --question "《》下面的下划线是否对齐？偏左还是偏右？"
```

截图前先点亮屏幕并确认应用在前台。看图结果是黑屏、锁屏或只有底部横杠时，这张图不能写入证据，点亮后重拍。

## 问法

- 把用户/Issue 的原问题带上，不要只说「描述这张图」。
- 可以连问：先问齐不齐，再问和 Android 截图差在哪，再问线是短了还是偏了。
- 每一问都把原图路径再打开一遍，不要只转述上一句文字。

## 输出怎么记

- 自己看图：`screenshot_analysis: native_vision`
- 调用了 Qwen：`screenshot_analysis: vision`
- 工具失败才降级 OCR / 正文上下文，并如实标注 `ocr` 或 `skipped_no_vision`
- `screenshot_descriptions`：写入你自己看到的，或 Qwen 的原话摘要
