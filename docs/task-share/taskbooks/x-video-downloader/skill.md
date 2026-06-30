# X/Twitter 视频下载

给定 X/Twitter status URL,下载帖子里的视频为 MP4,并在存在字幕时下载字幕文件。

## 输入

- `url`: X/Twitter 帖子链接,必填。
- `maxHeight`: 可选最大高度,默认 `480`(通常选 360p 档,更快)。想要更高清可传 `720`/`1080`,想更省流量可传 `270`。
- `subLangs`: 可选字幕语言,默认 `all`。

## 步骤

1. 从 runtime input 读取 `url`、`maxHeight`、`subLangs`。
2. 运行 taskbook 自带脚本:

```bash
node "$TASK_DIR/scripts/download-x-video.mjs" \
  --url "<url>" \
  --output-dir "<outputDir>" \
  --max-height "<maxHeight>" \
  --sub-langs "<subLangs>"
```

`<outputDir>` 必须用本次 task prompt 给出的产出目录。

## 产出

- `metadata.json`: yt-dlp 元数据。
- `download-summary.json`: 下载摘要,含视频文件和字幕文件列表。
- `<id>.mp4`: 下载并合并后的视频。
- `<id>.<lang>.vtt`: 字幕文件,仅在 X/Twitter 提供字幕时出现。

## 注意

- 字幕是有则下载,没有字幕不算失败。
- 不要临时改写下载流程;脚本已经处理 URL 规范化、格式选择、元数据和摘要。
- 不要把视频或字幕内容贴进回复,只回复产物路径和简短统计。
