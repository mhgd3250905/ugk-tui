import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	atempoFilters,
	baseUrlForApiKey,
	buildFinalMuxArgs,
	buildHardsubArgs,
	buildTranslatedSrt,
	buildSpeechGroups,
	formatSrtTimestamp,
	hasCjk,
	isReusableTtsSegment,
	normalizeMimoVoice,
	parseCliArgs,
	parseSubtitleText,
	SUPPORTED_MIMO_VOICE_IDS,
	subtitleWrapChars,
	validateSubtitleAlignment,
	wrapSubtitleFile,
	wrapSubtitleText,
} from "./make-video-zh-dub.mjs";

function hasCommand(command) {
	try {
		execFileSync(command, ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

test("parses srt subtitles and preserves timing", () => {
	const cues = parseSubtitleText(`1
00:00:01,200 --> 00:00:03,400
Hello world.

2
00:00:04,000 --> 00:00:05,000
Second line.
`);

	assert.equal(cues.length, 2);
	assert.equal(cues[0].startMs, 1200);
	assert.equal(cues[0].endMs, 3400);
	assert.equal(cues[0].text, "Hello world.");
});

test("parses vtt subtitles", () => {
	const cues = parseSubtitleText(`WEBVTT

00:00:01.000 --> 00:00:02.500 align:start
你好。
`);

	assert.deepEqual(cues, [{ index: 1, startMs: 1000, endMs: 2500, text: "你好。" }]);
});

test("formats srt timestamps", () => {
	assert.equal(formatSrtTimestamp(3723456), "01:02:03,456");
});

test("detects Chinese text", () => {
	assert.equal(hasCjk("这是一段中文。"), true);
	assert.equal(hasCjk("plain English"), false);
});

test("groups nearby cues without crossing long gaps", () => {
	const groups = buildSpeechGroups([
		{ index: 1, startMs: 0, endMs: 1000, text: "第一句" },
		{ index: 2, startMs: 1200, endMs: 2200, text: "第二句" },
		{ index: 3, startMs: 5000, endMs: 6500, text: "第三句" },
	], { maxChars: 20, maxGapMs: 500, maxDurationMs: 4000 });

	assert.equal(groups.length, 2);
	assert.equal(groups[0].text, "第一句 第二句");
	assert.equal(groups[0].startMs, 0);
	assert.equal(groups[0].endMs, 2200);
	assert.equal(groups[1].text, "第三句");
});

test("splits groups by text length", () => {
	const groups = buildSpeechGroups([
		{ index: 1, startMs: 0, endMs: 1000, text: "一二三四五" },
		{ index: 2, startMs: 1100, endMs: 2200, text: "六七八九十" },
	], { maxChars: 6, maxGapMs: 500, maxDurationMs: 4000 });

	assert.equal(groups.length, 2);
});

test("maps mimo api keys to the right base url", () => {
	assert.equal(baseUrlForApiKey("sk-abc"), "https://api.xiaomimimo.com/v1");
	assert.equal(baseUrlForApiKey("tp-abc"), "https://token-plan-cn.xiaomimimo.com/v1");
	assert.throws(() => baseUrlForApiKey("bad"), /MIMO_API_KEY/);
});

test("validates mimo preset voices before calling tts", () => {
	assert.deepEqual(SUPPORTED_MIMO_VOICE_IDS, ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]);
	assert.equal(normalizeMimoVoice("白桦"), "白桦");
	assert.throws(() => normalizeMimoVoice("男声"), /Unsupported MiMo voice/);
});

test("builds atempo filters for large speedups", () => {
	assert.deepEqual(atempoFilters(1), []);
	assert.deepEqual(atempoFilters(2.5), ["atempo=2.000", "atempo=1.250"]);
});

test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([
		"--preflight",
		"--video", "a.mp4",
		"--subtitle", "en.srt",
		"--zh-subtitle", "zh.srt",
		"--output-dir", "out",
		"--voice", "冰糖",
		"--subtitle-color", "pink",
	]), {
		preflight: true,
		videoPath: "a.mp4",
		subtitlePath: "en.srt",
		zhSubtitlePath: "zh.srt",
		outputDir: "out",
		voice: "冰糖",
		subtitleColor: "pink",
	});
});

test("final mux uses video, dub audio, and soft subtitles", () => {
	const args = buildFinalMuxArgs({
		videoPath: "input.mp4",
		dubPath: "dub.zh.wav",
		subtitlePath: "translated.zh.srt",
		outputPath: "final.zh.mp4",
		durationSeconds: 169.141,
		copyVideo: true,
	});

	assert.ok(args.includes("-map"));
	assert.ok(args.includes("0:v:0"));
	assert.ok(args.includes("1:a:0"));
	assert.ok(args.includes("2:0"));
	assert.ok(args.includes("mov_text"));
	assert.ok(args.includes("-af"));
	assert.ok(args.includes("apad"));
	assert.ok(args.includes("-t"));
	assert.ok(args.includes("169.141"));
	assert.equal(args.includes("-shortest"), false);
	assert.ok(args.includes("final.zh.mp4"));
});

test("hardsub render burns wrapped subtitles without a dark bottom band", () => {
	const args = buildHardsubArgs({
		inputPath: "final.zh.mp4",
		subtitlePath: "translated.zh.hardsub.srt",
		outputPath: "final.zh.hardsub.mp4",
	});

	assert.ok(args.includes("-vf"));
	assert.equal(args.some((arg) => arg.includes("drawbox=")), false);
	assert.ok(args.some((arg) => arg.includes("subtitles=translated.zh.hardsub.srt")));
	assert.ok(args.some((arg) => arg.includes("Alignment=2")));
	assert.ok(args.some((arg) => arg.includes("FontSize=16")));
	assert.ok(args.some((arg) => arg.includes("BorderStyle=1")));
	assert.ok(args.includes("-c:a"));
	assert.ok(args.includes("copy"));
	assert.ok(args.includes("final.zh.hardsub.mp4"));
});

test("wraps long subtitle text to fit the video width", () => {
	const wrapped = wrapSubtitleText("我先简单讲讲这是什么。当我们开始编排动作的时候，从零开始其实是非常困难的。", 12);
	const lines = wrapped.split("\n");

	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => Array.from(line).length <= 13));
	assert.equal(lines.some((line) => /^[，。！？；：、]/u.test(line)), false);
	assert.equal(subtitleWrapChars(1920), 24);
	assert.equal(subtitleWrapChars(1280), 20);
	assert.equal(subtitleWrapChars(640), 14);
});

test("prefers punctuation boundaries when wrapping subtitle text", () => {
	const wrapped = wrapSubtitleText("这就是我们编排动作的方式。今天这节课，我就会把这些定位点教给你。", 20);

	assert.ok(wrapped.includes("方式。\n今天"));
	assert.equal(wrapped.includes("今\n天"), false);
});

test("does not split latin words while wrapping subtitle text", () => {
	const wrapped = wrapSubtitleText("一般做两三个穿插就够了，然后接上 baby freeze。", 14);

	assert.equal(wrapped.includes("free\nze"), false);
	assert.equal(wrapped.includes("\n。"), false);
});

test("splits very long hard subtitles into cues with at most two lines", () => {
	const wrapped = wrapSubtitleFile(`1
00:00:00,000 --> 00:00:08,000
这就是我们编排动作的方式。今天这节课，我就会把这些定位点教给你。回去之后你自己练习这些定位点，然后把视频发给我。
`, 20);
	const blocks = wrapped.trim().split(/\n{2,}/);

	assert.ok(blocks.length > 1);
	assert.ok(wrapped.includes("定位点"));
	assert.ok(wrapped.includes("发给我。"));
	for (const block of blocks) {
		const lines = block.split("\n");
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		assert.ok(lines.slice(timingIndex + 1).length <= 2);
	}
});

test("hardsub render supports subtitle text colors", () => {
	const yellowArgs = buildHardsubArgs({
		inputPath: "final.zh.mp4",
		subtitlePath: "translated.zh.srt",
		outputPath: "final.zh.hardsub.mp4",
		subtitleColor: "yellow",
	});
	const pinkArgs = buildHardsubArgs({
		inputPath: "final.zh.mp4",
		subtitlePath: "translated.zh.srt",
		outputPath: "final.zh.hardsub.mp4",
		subtitleColor: "pink",
	});

	assert.ok(yellowArgs.some((arg) => arg.includes("PrimaryColour=&H0000FFFF")));
	assert.ok(pinkArgs.some((arg) => arg.includes("PrimaryColour=&H00B469FF")));
	assert.throws(() => buildHardsubArgs({
		inputPath: "final.zh.mp4",
		subtitlePath: "translated.zh.srt",
		outputPath: "final.zh.hardsub.mp4",
		subtitleColor: "green",
	}), /subtitleColor must be white, yellow, or pink/);
});

test("builds translated srt from text-only translations and preserves source timing", () => {
	const sourceCues = [
		{ index: 1, startMs: 1000, endMs: 2000, text: "Hello" },
		{ index: 2, startMs: 2500, endMs: 4000, text: "world" },
	];
	const srt = buildTranslatedSrt(sourceCues, [
		{ i: 1, s: 9999, e: 9999, t: "你好" },
		{ id: 2, startMs: 1, endMs: 2, text: "世界" },
	]);
	const zhCues = parseSubtitleText(srt);

	assert.equal(zhCues.length, 2);
	assert.equal(zhCues[0].startMs, 1000);
	assert.equal(zhCues[0].endMs, 2000);
	assert.equal(zhCues[0].text, "你好");
	assert.equal(zhCues[1].startMs, 2500);
	assert.equal(zhCues[1].endMs, 4000);
	assert.equal(zhCues[1].text, "世界");
});

test("buildTranslatedSrt rejects missing or empty translated text before tts", () => {
	const sourceCues = [
		{ index: 1, startMs: 1000, endMs: 2000, text: "Hello" },
		{ index: 2, startMs: 2500, endMs: 4000, text: "world" },
	];

	assert.throws(() => buildTranslatedSrt(sourceCues, [
		{ i: 1, t: "你好" },
		{ i: 2, t: "" },
	]), /empty translated text for cue 2/);
	assert.throws(() => buildTranslatedSrt(sourceCues, [
		{ i: 1, t: "你好" },
	]), /missing translated text for cue 2/);
});

test("validateSubtitleAlignment rejects changed timecodes even when cue count matches", () => {
	const sourceCues = [
		{ index: 1, startMs: 1000, endMs: 2000, text: "Hello" },
	];
	const zhCues = [
		{ index: 1, startMs: 999, endMs: 2000, text: "你好" },
	];

	assert.throws(() => validateSubtitleAlignment(sourceCues, zhCues), /cue 1 timing mismatch/);
});

test("tts segment cache is reusable only when metadata matches", () => {
	const expected = {
		text: "你好",
		voice: "冰糖",
		stylePrompt: "自然",
		startMs: 1000,
		endMs: 2000,
	};

	assert.equal(isReusableTtsSegment(JSON.stringify(expected), expected), true);
	assert.equal(isReusableTtsSegment(JSON.stringify({ ...expected, text: "世界" }), expected), false);
	assert.equal(isReusableTtsSegment("", expected), false);
});

test("verify rejects final videos shorter than source duration", { timeout: 30000 }, () => {
	if (!hasCommand("ffmpeg") || !hasCommand("ffprobe")) return;
	const workDir = mkdtempSync(path.join(tmpdir(), "video-zh-dubber-verify-"));
	const sourceSubtitlePath = path.join(workDir, "source.srt");
	const translatedPath = path.join(workDir, "translated.zh.srt");
	const dubPath = path.join(workDir, "dub.zh.wav");
	const finalPath = path.join(workDir, "final.zh.mp4");
	const hardsubPath = path.join(workDir, "final.zh.hardsub.mp4");
	const cue = "1\n00:00:00,000 --> 00:00:01,000\n";
	writeFileSync(sourceSubtitlePath, `${cue}Hello\n`, "utf8");
	writeFileSync(translatedPath, `${cue}你好\n`, "utf8");
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-t", "1.0",
		"-c:a", "pcm_s16le",
		dubPath,
	]);
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=duration=1:size=320x180:rate=25",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-i", translatedPath,
		"-t", "1.0",
		"-map", "0:v:0",
		"-map", "1:a:0",
		"-map", "2:0",
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		"-c:s", "mov_text",
		finalPath,
	]);
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=duration=1:size=320x180:rate=25",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-t", "1.0",
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		hardsubPath,
	]);
	writeFileSync(path.join(workDir, "dub-summary.json"), JSON.stringify({
		voice: "冰糖",
		subtitleColor: "white",
		sourceCueCount: 1,
		zhCueCount: 1,
		speechGroupCount: 1,
		videoDurationSeconds: 2.4,
		dubAudioPath: dubPath,
		finalVideoPath: finalPath,
		hardsubVideoPath: hardsubPath,
		zhSubtitlePath: translatedPath,
	}, null, 2), "utf8");

	try {
		execFileSync(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../verify.mjs")], {
			encoding: "utf8",
			env: {
				...process.env,
				TASK_OUTPUT_DIR: workDir,
				TASK_INPUT: JSON.stringify({ subtitlePath: sourceSubtitlePath, voice: "冰糖" }),
			},
		});
		assert.fail("verify should fail for truncated final videos");
	} catch (error) {
		assert.match(String(error.stdout), /preserves video duration/);
	}
});
