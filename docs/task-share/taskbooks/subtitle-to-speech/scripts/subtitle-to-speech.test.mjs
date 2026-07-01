import { strict as assert } from "node:assert";
import test from "node:test";

import {
	atempoFilters,
	baseUrlForApiKey,
	buildSpeechGroups,
	hasCjk,
	isReusableTtsSegment,
	normalizeMimoVoice,
	parseCliArgs,
	parseSubtitleText,
	segmentFitPlan,
	SUPPORTED_MIMO_VOICE_IDS,
} from "./subtitle-to-speech.mjs";

test("parses srt and vtt subtitles", () => {
	const srt = parseSubtitleText(`1
00:00:01,000 --> 00:00:02,000
你好

2
00:00:03,500 --> 00:00:04,000
世界
`);
	assert.equal(srt.length, 2);
	assert.equal(srt[0].startMs, 1000);
	assert.equal(srt[1].endMs, 4000);

	const vtt = parseSubtitleText(`WEBVTT

00:00:01.000 --> 00:00:02.500 align:start
<c>你好</c>
`);
	assert.deepEqual(vtt, [{ index: 1, startMs: 1000, endMs: 2500, text: "你好" }]);
});

test("groups nearby cues by gap and max chars", () => {
	const groups = buildSpeechGroups([
		{ index: 1, startMs: 0, endMs: 1000, text: "第一句" },
		{ index: 2, startMs: 1200, endMs: 2200, text: "第二句" },
		{ index: 3, startMs: 4000, endMs: 5000, text: "第三句" },
	], { maxChars: 20 });

	assert.equal(groups.length, 2);
	assert.equal(groups[0].text, "第一句 第二句");
	assert.deepEqual(groups[0].cueIndexes, [1, 2]);
	assert.deepEqual(groups[1].cueIndexes, [3]);
});

test("rejects invalid maxChars before grouping", () => {
	const cues = [{ index: 1, startMs: 0, endMs: 1000, text: "第一句" }];
	assert.throws(() => buildSpeechGroups(cues, { maxChars: 0 }), /maxChars must be a positive number/);
	assert.throws(() => buildSpeechGroups(cues, { maxChars: Number.NaN }), /maxChars must be a positive number/);
});

test("maps mimo api keys and detects Chinese", () => {
	assert.equal(baseUrlForApiKey("sk-abc"), "https://api.xiaomimimo.com/v1");
	assert.equal(baseUrlForApiKey("tp-abc"), "https://token-plan-cn.xiaomimimo.com/v1");
	assert.throws(() => baseUrlForApiKey("bad"), /MIMO_API_KEY/);
	assert.equal(hasCjk("中文"), true);
	assert.equal(hasCjk("plain"), false);
});

test("validates mimo preset voices before calling tts", () => {
	assert.deepEqual(SUPPORTED_MIMO_VOICE_IDS, ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]);
	assert.equal(normalizeMimoVoice("苏打"), "苏打");
	assert.throws(() => normalizeMimoVoice("活力男声"), /Unsupported MiMo voice/);
});

test("builds atempo filters for large speedups", () => {
	assert.deepEqual(atempoFilters(1), []);
	assert.deepEqual(atempoFilters(2.5), ["atempo=2.000", "atempo=1.250"]);
});

test("does not slow short speech down to fill a long subtitle window", () => {
	assert.deepEqual(segmentFitPlan(10, 30), { silence: false, speed: 1, outputSeconds: 10 });
	assert.deepEqual(segmentFitPlan(30, 10), { silence: false, speed: 3, outputSeconds: 10 });
});

test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([
		"--preflight",
		"--subtitle", "zh.srt",
		"--output-dir", "out",
		"--voice", "冰糖",
		"--style-prompt", "自然",
		"--max-chars", "80",
	]), {
		preflight: true,
		subtitlePath: "zh.srt",
		outputDir: "out",
		voice: "冰糖",
		stylePrompt: "自然",
		maxChars: 80,
	});
});

test("tts segment cache is reusable only when metadata matches", () => {
	const expected = { text: "你好", voice: "冰糖", stylePrompt: "自然", startMs: 1, endMs: 2 };
	assert.equal(isReusableTtsSegment(JSON.stringify(expected), expected), true);
	assert.equal(isReusableTtsSegment(JSON.stringify({ ...expected, text: "世界" }), expected), false);
	assert.equal(isReusableTtsSegment("", expected), false);
});
