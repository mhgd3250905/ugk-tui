import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildFluentSrt,
	defaultMaxUnitChars,
	formatSrtTimestamp,
	hasCjk,
	parseCliArgs,
	parseSubtitleText,
	validateUnits,
} from "./make-fluent-subtitle.mjs";

function sampleCues() {
	return [
		{ index: 1, startMs: 1000, endMs: 1800, text: "This is" },
		{ index: 2, startMs: 1900, endMs: 3000, text: "one sentence." },
		{ index: 3, startMs: 4500, endMs: 5600, text: "Next idea." },
	];
}

test("parses srt subtitles", () => {
	const cues = parseSubtitleText(`1
00:00:01,200 --> 00:00:03,400
Hello world.

2
00:00:04,000 --> 00:00:05,000
Second line.
`);

	assert.equal(cues.length, 2);
	assert.equal(cues[0].index, 1);
	assert.equal(cues[0].startMs, 1200);
	assert.equal(cues[0].endMs, 3400);
	assert.equal(cues[0].text, "Hello world.");
});

test("parses vtt subtitles", () => {
	const cues = parseSubtitleText(`WEBVTT

00:00:01.000 --> 00:00:02.500 align:start
Hello <c>world</c>.
`);

	assert.deepEqual(cues, [{ index: 1, startMs: 1000, endMs: 2500, text: "Hello world." }]);
});

test("builds fluent srt from merged source cue ids", () => {
	const srt = buildFluentSrt(sampleCues(), [
		{ ids: [1, 2], text: "这是一句完整的话。" },
		{ ids: [3], text: "接下来是另一个观点。" },
	], { targetLanguage: "zh-CN", maxUnitDurationMs: 3000, maxUnitChars: 40 });
	const cues = parseSubtitleText(srt);

	assert.equal(cues.length, 2);
	assert.equal(cues[0].startMs, 1000);
	assert.equal(cues[0].endMs, 3000);
	assert.equal(cues[0].text, "这是一句完整的话。");
	assert.equal(cues[1].startMs, 4500);
	assert.equal(cues[1].endMs, 5600);
});

test("verify accepts the same overlap clamp used by the builder", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "fluent-verify-"));
	try {
		const sourceCues = [
			{ index: 1, startMs: 1000, endMs: 2000, text: "First" },
			{ index: 2, startMs: 1999, endMs: 3000, text: "Second" },
		];
		const units = [
			{ ids: [1], text: "第一句。" },
			{ ids: [2], text: "第二句。" },
		];
		const srtPath = path.join(outputDir, "fluent.zh.srt");
		writeFileSync(path.join(outputDir, "source.cues.json"), JSON.stringify(sourceCues), "utf8");
		writeFileSync(path.join(outputDir, "fluent.units.json"), JSON.stringify(units), "utf8");
		writeFileSync(srtPath, buildFluentSrt(sourceCues, units, { targetLanguage: "zh-CN" }), "utf8");
		writeFileSync(path.join(outputDir, "fluent-report.json"), JSON.stringify({
			sourceCueCount: sourceCues.length,
			unitCount: units.length,
			targetLanguage: "zh-CN",
			verbosity: "normal",
			outputSubtitlePath: srtPath,
		}), "utf8");
		const here = path.dirname(fileURLToPath(import.meta.url));
		const stdout = execFileSync(process.execPath, [path.resolve(here, "../verify.mjs")], {
			encoding: "utf8",
			env: { ...process.env, TASK_OUTPUT_DIR: outputDir, TASK_INPUT: JSON.stringify({ targetLanguage: "zh-CN" }) },
		});
		assert.match(stdout, /PASS/);
	} finally {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
	}
});

test("verify enforces talkative density", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "fluent-verify-"));
	try {
		const sourceCues = [{ index: 1, startMs: 0, endMs: 10000, text: "Long cue." }];
		const units = [{ ids: [1], text: "动作完成。" }];
		const srtPath = path.join(outputDir, "fluent.zh.srt");
		writeFileSync(path.join(outputDir, "source.cues.json"), JSON.stringify(sourceCues), "utf8");
		writeFileSync(path.join(outputDir, "fluent.units.json"), JSON.stringify(units), "utf8");
		writeFileSync(srtPath, buildFluentSrt(sourceCues, units, { targetLanguage: "zh-CN" }), "utf8");
		writeFileSync(path.join(outputDir, "fluent-report.json"), JSON.stringify({
			sourceCueCount: sourceCues.length,
			unitCount: units.length,
			targetLanguage: "zh-CN",
			verbosity: "talkative",
			outputSubtitlePath: srtPath,
		}), "utf8");
		const here = path.dirname(fileURLToPath(import.meta.url));
		assert.throws(() => execFileSync(process.execPath, [path.resolve(here, "../verify.mjs")], {
			encoding: "utf8",
			env: { ...process.env, TASK_OUTPUT_DIR: outputDir, TASK_INPUT: JSON.stringify({ targetLanguage: "zh-CN", verbosity: "talkative" }) },
		}), (error) => {
			assert.match(String(error.stdout), /talkative text too sparse/);
			return true;
		});
	} finally {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
	}
});

test("validateUnits rejects missing duplicate and out-of-order ids", () => {
	assert.throws(() => validateUnits(sampleCues(), [
		{ ids: [1], text: "一" },
		{ ids: [3], text: "三" },
	]), /missing cue ids: 2/);

	assert.throws(() => validateUnits(sampleCues(), [
		{ ids: [1], text: "一" },
		{ ids: [1], text: "重复" },
		{ ids: [2, 3], text: "二三" },
	]), /duplicate cue id 1/);

	assert.throws(() => validateUnits(sampleCues(), [
		{ ids: [2], text: "二" },
		{ ids: [1], text: "一" },
		{ ids: [3], text: "三" },
	]), /out of order/);
});

test("validateUnits rejects non-contiguous ids empty text long text and long duration", () => {
	assert.throws(() => validateUnits(sampleCues(), [
		{ ids: [1, 3], text: "跳号" },
		{ ids: [2], text: "二" },
	]), /contiguous/);

	assert.throws(() => validateUnits(sampleCues(), [
		{ ids: [1], text: "" },
		{ ids: [2], text: "二" },
		{ ids: [3], text: "三" },
	]), /empty text/);

	assert.throws(() => validateUnits(sampleCues(), [
		{ ids: [1], text: "一二三四" },
		{ ids: [2], text: "二" },
		{ ids: [3], text: "三" },
	], { maxUnitChars: 3 }), /too long/);

	assert.throws(() => validateUnits(sampleCues(), [
		{ ids: [1, 2], text: "一二" },
		{ ids: [3], text: "三" },
	], { maxUnitDurationMs: 1000 }), /duration/);
});

test("validateUnits allows a single source cue longer than the merge duration limit", () => {
	const sourceCues = [
		{ index: 1, startMs: 1000, endMs: 12000, text: "A long source cue." },
		{ index: 2, startMs: 13000, endMs: 14000, text: "Next." },
	];

	const units = validateUnits(sourceCues, [
		{ ids: [1], text: "这条原字幕本身很长。" },
		{ ids: [2], text: "下一条。" },
	], { targetLanguage: "zh-CN", maxUnitDurationMs: 8000 });

	assert.equal(units.length, 2);
	assert.equal(units[0].endMs, 12000);
});

test("talkative mode rejects sparse text for long subtitle windows", () => {
	const sourceCues = [{ index: 1, startMs: 0, endMs: 10000, text: "Long cue." }];
	assert.throws(() => validateUnits(sourceCues, [
		{ ids: [1], text: "动作完成。" },
	], { targetLanguage: "zh-CN", verbosity: "talkative", maxUnitChars: 160 }), /talkative text too sparse/);

	const units = validateUnits(sourceCues, [
		{ ids: [1], text: "这个动作到这里就算完成了，大家可以注意身体重心的移动，以及落地时手脚之间的衔接。" },
	], { targetLanguage: "zh-CN", verbosity: "talkative", maxUnitChars: 160 });
	assert.equal(units.length, 1);
});

test("normal mode does not enforce talkative text density", () => {
	const sourceCues = [{ index: 1, startMs: 0, endMs: 10000, text: "Long cue." }];
	const units = validateUnits(sourceCues, [
		{ ids: [1], text: "动作完成。" },
	], { targetLanguage: "zh-CN", verbosity: "normal", maxUnitChars: 90 });
	assert.equal(units.length, 1);
});

test("formats timestamps and detects cjk", () => {
	assert.equal(formatSrtTimestamp(3723456), "01:02:03,456");
	assert.equal(hasCjk("自然中文"), true);
	assert.equal(hasCjk("plain English"), false);
});

test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([
		"--preflight",
		"--subtitle", "source.vtt",
		"--output-dir", "out",
		"--target-language", "zh-CN",
		"--verbosity", "talkative",
		"--glossary", "bboy lunatic; breaking",
		"--max-unit-duration-ms", "8000",
		"--max-unit-chars", "80",
	]), {
		preflight: true,
		subtitlePath: "source.vtt",
		outputDir: "out",
		targetLanguage: "zh-CN",
		verbosity: "talkative",
		rawVerbosity: "talkative",
		glossary: "bboy lunatic; breaking",
		maxUnitDurationMs: 8000,
		maxUnitChars: 80,
	});
});

test("verify requires report to preserve provided glossary", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "fluent-verify-"));
	try {
		const sourceCues = [{ index: 1, startMs: 0, endMs: 1000, text: "Lunatic teaches breaking." }];
		const units = [{ ids: [1], text: "Lunatic 在教 breaking。" }];
		const srtPath = path.join(outputDir, "fluent.zh.srt");
		writeFileSync(path.join(outputDir, "source.cues.json"), JSON.stringify(sourceCues), "utf8");
		writeFileSync(path.join(outputDir, "fluent.units.json"), JSON.stringify(units), "utf8");
		writeFileSync(srtPath, buildFluentSrt(sourceCues, units, { targetLanguage: "zh-CN" }), "utf8");
		writeFileSync(path.join(outputDir, "fluent-report.json"), JSON.stringify({
			sourceCueCount: sourceCues.length,
			unitCount: units.length,
			targetLanguage: "zh-CN",
			verbosity: "normal",
			outputSubtitlePath: srtPath,
		}), "utf8");
		const here = path.dirname(fileURLToPath(import.meta.url));
		assert.throws(() => execFileSync(process.execPath, [path.resolve(here, "../verify.mjs")], {
			encoding: "utf8",
			env: { ...process.env, TASK_OUTPUT_DIR: outputDir, TASK_INPUT: JSON.stringify({ targetLanguage: "zh-CN", glossary: "bboy lunatic; breaking" }) },
		}), (error) => {
			assert.match(String(error.stdout), /fluent-report.glossary/);
			return true;
		});
	} finally {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
	}
});

test("rejects unsupported verbosity values", () => {
	assert.throws(() => parseCliArgs(["--verbosity", "verbose"]), /verbosity must be normal or talkative/);
});

test("talkative mode uses a larger default unit length", () => {
	assert.equal(defaultMaxUnitChars("normal"), 90);
	assert.equal(defaultMaxUnitChars("talkative"), 160);
});
