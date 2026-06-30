# 通用视频下载

给定一个公开视频 URL,用 yt-dlp 下载视频为 MP4,并在存在字幕时下载字幕文件。

## 输入

- `url`: 视频页面链接,必填,支持 yt-dlp 能解析的 `http`/`https` URL。
- `maxHeight`: 可选最大高度,默认 `480`。想更高清可传 `720`/`1080`,想更省流量可传 `270`。
- `subLangs`: 可选字幕语言,默认 `all`。
- `cookiesFromBrowser`: 可选,只允许 `none` 或 `chrome`,默认 `none`。用户说用 Chrome 登录态、Chrome cookies、已登录浏览器下载时填 `chrome`。

## 步骤

1. 从 runtime input 读取 `url`、`maxHeight`、`subLangs`、`cookiesFromBrowser`。
2. 运行 taskbook 自带脚本:

```bash
node "$TASK_DIR/scripts/download-video.mjs" \
  --url "<url>" \
  --output-dir "<outputDir>" \
  --max-height "<maxHeight>" \
  --sub-langs "<subLangs>" \
  --cookies-from-browser "<cookiesFromBrowser>"
```

`<outputDir>` 必须用本次 task prompt 给出的产出目录。

## 产出

- `metadata.json`: yt-dlp 元数据。
- `download-summary.json`: 下载摘要,含 extractor、视频文件和字幕文件列表。
- `<extractor>-<id>.mp4`: 下载并合并后的视频。
- `<extractor>-<id>.<lang>.vtt`: 字幕文件,仅在站点提供字幕时出现。

## 注意

- 字幕是有则下载,没有字幕不算失败。
- 这是单视频下载器,默认 `--no-playlist`;不要下载整个播放列表。
- 不要临时改写下载流程;脚本已经处理 URL 校验、格式选择、元数据和摘要。
- 如果遇到 YouTube 429、visitor_data 或 cookies 相关错误,只能改 `cookiesFromBrowser` 后重新运行本脚本;不要直接调用 `yt-dlp`、不要手写 cookies 文件、不要绕过 taskbook 脚本。
- 不要把视频或字幕内容贴进回复,只回复产物路径和简短统计。
