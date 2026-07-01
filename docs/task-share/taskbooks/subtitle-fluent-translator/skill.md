# 流畅字幕翻译

给定一个源字幕文件,生成更适合中文观看和后续中文配音的流畅中文字幕。

## 输入

- `subtitlePath`: 源字幕路径,必填,支持 `.srt`/`.vtt`。
- `targetLanguage`: 可选,默认 `zh-CN`。
- `verbosity`: 可选,只允许 `normal` 或 `talkative`,默认 `normal`。用户说“话痨模式”“更啰嗦”时统一填 `talkative`。
- `stylePrompt`: 可选,默认按“自然、口语化、适合视频字幕和中文配音”处理。
- `glossary`: 可选,dispatcher 从用户自然语言里抽取的人名、主题词、术语或动作名参考,用分号分隔。
- `maxUnitDurationMs`: 可选,默认 `8000`。
- `maxUnitChars`: 可选;不填时 `normal` 默认 `90`,`talkative` 默认 `160`。

## 步骤

1. 从 runtime input 读取字段。这个 task 不需要 API key,不要向用户索要或打印密钥。
2. 确保 `$TASK_OUTPUT_DIR` 存在。
3. 先运行 preflight。失败就立刻停止并把错误原样报告给用户:

```bash
node "$TASK_DIR/scripts/make-fluent-subtitle.mjs" \
  --preflight \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --target-language "<targetLanguage>" \
  --verbosity "<verbosity>" \
  --style-prompt "<stylePrompt>" \
  --glossary "<glossary>" \
  --max-unit-duration-ms "<maxUnitDurationMs>"
```

如果用户显式提供了 `maxUnitChars`,再追加 `--max-unit-chars "<maxUnitChars>"`;否则不要传,让脚本按 `verbosity` 选择默认值。

4. 读取 `$TASK_OUTPUT_DIR/source.cues.json`,做一次阅读理解后翻译并重排为自然中文字幕单元。
   - 输出只能写入 `$TASK_OUTPUT_DIR/fluent.units.json`。
   - JSON 必须是数组,每项形如 `{ "ids": [1, 2], "text": "自然中文正文" }`。
   - `ids` 只能引用相邻源 cue,按顺序覆盖所有源 cue,不能漏号、重号、乱序。
   - 不要输出 SRT、时间码、`startMs`、`endMs`。程序会按 `ids` 自动生成时间轴。
   - 可以合并被英语自动字幕切碎的相邻 cue,但合并后的多 cue 单元不能超过 `maxUnitDurationMs`;单条源 cue 本身超长时保留原时间轴。
   - 每个单元文字不能超过 `maxUnitChars`。
   - 如果 `glossary` 非空,把其中的人名、主题词、术语和动作名作为权威参考;保留并统一这些词,必要时修正 Whisper 误识别。没有给中文译名的英文专名/动作名不要硬翻。
   - `verbosity=talkative` 时,用自然中文补足省略主语、连接词和口播过渡,尽量填满原字幕时间;6 秒以上单元至少约 4 个中文字符/秒(不超过 maxUnitChars);不要添加新事实、不要改变语义。
   - 如果字幕很多,分批处理并在进展里输出 `[translate] batch x/y cues a-b`。
5. 运行构建脚本:

```bash
node "$TASK_DIR/scripts/make-fluent-subtitle.mjs" \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --target-language "<targetLanguage>" \
  --verbosity "<verbosity>" \
  --style-prompt "<stylePrompt>" \
  --glossary "<glossary>" \
  --max-unit-duration-ms "<maxUnitDurationMs>"
```

如果用户显式提供了 `maxUnitChars`,再追加 `--max-unit-chars "<maxUnitChars>"`;否则不要传。
不要手写 `fluent.zh.srt` 或 `fluent-report.json`;必须交给脚本从 `fluent.units.json` 生成,否则时间轴、模式名和 verify 会不一致。

## 产出

- `source.cues.json`: 程序解析出的源字幕结构。
- `fluent.units.json`: worker 生成的流畅字幕单元。
- `fluent.zh.srt`: 可直接传给 `video-zh-dubber` 的中文字幕文件。
- `fluent-report.json`: 统计摘要。

## 注意

- 这个 task 只做字幕优化,不下载视频、不做 TTS、不调用 `video-zh-dubber`。
- 不要把字幕全文贴进最终回复;只回复产物路径和简短统计。
