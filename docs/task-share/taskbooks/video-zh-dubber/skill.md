# 英文视频中文配音

给定本地视频和英文字幕,生成中文字幕、中文 MiMo TTS 配音,并合成软字幕版和硬字幕版 MP4。

这是兼容的一体化入口。新项目优先使用拆分链路:

1. `subtitle-fluent-translator`: 源字幕 -> 流畅中文字幕。
2. `subtitle-to-speech`: 中文字幕 -> 中文配音音频。
3. `video-zh-composer`: 视频 + 中文配音 + 中文字幕 -> 最终视频。

只有用户明确要“一步完成”或已在使用旧入口时,才继续使用本 taskbook。

## 输入

- `videoPath`: 本地视频路径,必填。
- `subtitlePath`: 源英文字幕路径,支持 `.srt`/`.vtt`,必填。
- `zhSubtitlePath`: 可选。若用户已经提供中文字幕,用它作为翻译来源。
- `voice`: 可选 MiMo 预置音色 ID,默认 `冰糖`。必须填精确 ID,不能填自然语言描述。
- `stylePrompt`: 可选 MiMo 风格提示。
- `maxChars`: 可选 TTS 分组字符上限,默认 `120`。
- `subtitleColor`: 可选硬字幕文字颜色,只允许 `white`、`yellow`、`pink`,默认 `white`。用户说白色/黄色/粉色时分别填 `white`/`yellow`/`pink`。

## MiMo 预置音色

| ID | 语言 | 性别 | 适用 |
|---|---|---|---|
| `mimo_default` | 依集群而定 | - | 默认音色 |
| `冰糖` | 中文 | 女 | 默认中文女声 |
| `茉莉` | 中文 | 女 | 中文女声 |
| `苏打` | 中文 | 男 | 偏年轻、有活力的中文男声 |
| `白桦` | 中文 | 男 | 偏沉稳的中文男声 |
| `Mia` | 英文 | 女 | 英文女声 |
| `Chloe` | 英文 | 女 | 英文女声 |
| `Milo` | 英文 | 男 | 英文男声 |
| `Dean` | 英文 | 男 | 英文男声 |

dispatcher 根据用户想要的语言、性别和气质选择最接近的预置音色 ID;语气、节奏、感染力等表达方式放进 `stylePrompt`。

## 步骤

1. 从 runtime input 读取字段,不要把 `MIMO_API_KEY` 当作输入字段,不要检查或打印任何 API key 的值、长度、前缀。
2. 确保 `$TASK_OUTPUT_DIR` 存在。
3. 先运行 preflight。失败就立刻停止并把错误原样报告给用户,不要继续翻译字幕:

```bash
node "$TASK_DIR/scripts/make-video-zh-dub.mjs" \
  --preflight \
  --video "<videoPath>" \
  --subtitle "<subtitlePath>" \
  --zh-subtitle "$TASK_OUTPUT_DIR/translated.zh.srt" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --voice "<voice>" \
  --style-prompt "<stylePrompt>" \
  --max-chars "<maxChars>" \
  --subtitle-color "<subtitleColor>"
```

4. 生成 `$TASK_OUTPUT_DIR/zh-text.json`,不要手写 SRT:
   - 如果 `zhSubtitlePath` 指向已有中文字幕文件,先把它复制为 `$TASK_OUTPUT_DIR/translated.zh.srt`,不要改时间码。
   - 否则读取 `$TASK_OUTPUT_DIR/source.cues.json` 或 `subtitlePath`,把每条字幕翻译成中文。
   - 翻译结果只能是 JSON 数组: `[{ "i": 1, "t": "中文正文" }]`。
   - 不要让 LLM 输出 SRT、时间码、`s`、`e` 或序号重排。程序会用源字幕结构生成 `$TASK_OUTPUT_DIR/translated.zh.srt`。
   - `zh-text.json` 必须覆盖每个 cue,每条 `t` 不能为空;长字幕可以按批翻译,但最后合并成一个完整 JSON 数组。
5. 运行合成脚本:

```bash
node "$TASK_DIR/scripts/make-video-zh-dub.mjs" \
  --video "<videoPath>" \
  --subtitle "<subtitlePath>" \
  --zh-subtitle "$TASK_OUTPUT_DIR/translated.zh.srt" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --voice "<voice>" \
  --style-prompt "<stylePrompt>" \
  --max-chars "<maxChars>" \
  --subtitle-color "<subtitleColor>"
```

6. 脚本会先用源字幕时间码生成并校验 `$TASK_OUTPUT_DIR/translated.zh.srt`;校验失败会在 TTS 前停止。脚本会输出 `[tts] i/n xx% ...` 进度,不要隐藏它。
7. 脚本会同时生成:
   - `$TASK_OUTPUT_DIR/final.zh.mp4`: 中文配音 + 可开关的中文字幕软字幕。
   - `$TASK_OUTPUT_DIR/final.zh.hardsub.mp4`: 中文配音 + 指定颜色的烧录中文字幕。

## 产出

- `translated.zh.srt`: 中文字幕。
- `translated.zh.hardsub.srt`: 用于硬字幕的自动换行版中文字幕。
- `source.cues.json`: 程序解析出的源字幕结构。
- `zh-text.json`: 仅正文翻译缓存,数组元素形如 `{ "i": 1, "t": "中文正文" }`。
- `dub.zh.wav`: 中文配音音轨。
- `final.zh.mp4`: 最终视频,中文配音 + 中文字幕软字幕。
- `final.zh.hardsub.mp4`: 最终视频,中文配音 + 自动换行硬字幕,文字颜色由 `subtitleColor` 控制。
- `dub-summary.json`: 运行摘要。
- `tts-segments/`: MiMo TTS 分段缓存。

## 注意

- 运行时必须有 `MIMO_API_KEY`;缺失时应直接报错,不要继续。
- `voice` 不在预置音色列表内时必须停止,不要 fallback 到默认音色。
- MiMo TTS 会消耗接口配额或产生费用。
- TTS 前必须先通过字幕校验;不要为了绕过校验直接调用 MiMo。
- 第一版不做口型同步,不混入原英文人声。
- 硬字幕不加背景条;长字幕会按视频宽度拆成多个短 cue,每屏最多 2 行。
- 不要把字幕全文、视频内容、API key 放进最终回复;只回复产物路径和简短统计。
