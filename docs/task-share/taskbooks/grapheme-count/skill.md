# Grapheme Count

Read `TASK_INPUT` as JSON and take the `text` field. Count Unicode grapheme clusters with `Intl.Segmenter`.

Write exactly one artifact:

```text
<TASK_OUTPUT_DIR>/result.json
```

The JSON must contain:

```json
{
  "input": "original text",
  "graphemes": 3
}
```

Use Node.js only. Do not call the network and do not write outside `TASK_OUTPUT_DIR`.
