# 字幕转中文配音

给定一个中文字幕文件,用 MiMo TTS 生成按字幕时间轴铺好的中文配音音频。

## 输入

- `subtitlePath`: 中文字幕路径,必填,支持 `.srt`/`.vtt`。
- `voice`: 可选 MiMo 预置音色 ID,默认 `冰糖`。必须填精确 ID,不能填自然语言描述。
- `stylePrompt`: 可选 MiMo 风格提示。
- `maxChars`: 可选 TTS 分组字符上限,默认 `120`。

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
3. 先运行 preflight。失败就立刻停止并把错误原样报告给用户:

```bash
node "$TASK_DIR/scripts/subtitle-to-speech.mjs" \
  --preflight \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --voice "<voice>" \
  --style-prompt "<stylePrompt>" \
  --max-chars "<maxChars>"
```

4. 运行生成脚本:

```bash
node "$TASK_DIR/scripts/subtitle-to-speech.mjs" \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --voice "<voice>" \
  --style-prompt "<stylePrompt>" \
  --max-chars "<maxChars>"
```

脚本会输出 `[tts] i/n xx% ...` 进度,不要隐藏它。

## 产出

- `source.cues.json`: 程序解析出的字幕结构。
- `dub.zh.wav`: 中文配音音轨。
- `tts-summary.json`: 运行摘要。
- `audio-concat.txt`: ffmpeg concat 列表。
- `tts-segments/`: MiMo TTS 分段缓存。

## 注意

- 运行时必须有 `MIMO_API_KEY`;缺失时应直接报错,不要继续。
- `voice` 不在预置音色列表内时必须停止,不要 fallback 到默认音色。
- MiMo TTS 会消耗接口配额或产生费用。
- 这个 task 只做配音音频,不下载视频、不翻译字幕、不合成视频。
- 不要把字幕全文、API key 放进最终回复;只回复产物路径和简短统计。
