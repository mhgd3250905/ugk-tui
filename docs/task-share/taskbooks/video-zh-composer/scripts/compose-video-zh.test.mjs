import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildFinalMuxArgs,
	buildHardsubArgs,
	parseCliArgs,
	subtitleWrapChars,
	wrapSubtitleFile,
	wrapSubtitleText,
} from "./compose-video-zh.mjs";

function hasCommand(command) {
	try {
		execFileSync(command, ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function mediaDuration(filePath) {
	return Number(execFileSync("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		filePath,
	], { encoding: "utf8" }).trim());
}

test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([
		"--preflight",
		"--video", "video.mp4",
		"--audio", "dub.wav",
		"--subtitle", "zh.srt",
		"--output-dir", "out",
		"--subtitle-color", "pink",
	]), {
		preflight: true,
		videoPath: "video.mp4",
		audioPath: "dub.wav",
		subtitlePath: "zh.srt",
		outputDir: "out",
		subtitleColor: "pink",
	});
});

test("final mux uses video, dub audio, and soft subtitles", () => {
	const args = buildFinalMuxArgs({
		videoPath: "input.mp4",
		audioPath: "dub.zh.wav",
		subtitlePath: "subtitle.zh.srt",
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
		subtitlePath: "subtitle.zh.hardsub.srt",
		outputPath: "final.zh.hardsub.mp4",
		subtitleColor: "yellow",
	});

	assert.ok(args.includes("-vf"));
	assert.equal(args.some((arg) => arg.includes("drawbox=")), false);
	assert.ok(args.some((arg) => arg.includes("subtitles=subtitle.zh.hardsub.srt")));
	assert.ok(args.some((arg) => arg.includes("FontSize=16")));
	assert.ok(args.some((arg) => arg.includes("PrimaryColour=&H0000FFFF")));
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

test("rejects unsupported subtitle colors", () => {
	assert.throws(() => parseCliArgs(["--subtitle-color", "green"]), /subtitleColor must be white, yellow, or pink/);
});

test("cli preserves video duration when dubbed audio is shorter", { timeout: 30000 }, () => {
	if (!hasCommand("ffmpeg") || !hasCommand("ffprobe")) return;
	const workDir = mkdtempSync(path.join(tmpdir(), "video-zh-composer-"));
	const videoPath = path.join(workDir, "input.mp4");
	const audioPath = path.join(workDir, "dub.wav");
	const subtitlePath = path.join(workDir, "subtitle.srt");
	const outputDir = path.join(workDir, "out");
	const scriptPath = fileURLToPath(new URL("./compose-video-zh.mjs", import.meta.url));

	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=duration=2.4:size=320x180:rate=25",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-t", "2.4",
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		videoPath,
	]);
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-t", "1.0",
		"-c:a", "pcm_s16le",
		audioPath,
	]);
	writeFileSync(subtitlePath, "1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n", "utf8");

	execFileSync(process.execPath, [
		scriptPath,
		"--video", videoPath,
		"--audio", audioPath,
		"--subtitle", subtitlePath,
		"--output-dir", outputDir,
	], { encoding: "utf8" });

	assert.ok(mediaDuration(path.join(outputDir, "final.zh.mp4")) >= 2.2);
	assert.ok(mediaDuration(path.join(outputDir, "final.zh.hardsub.mp4")) >= 2.2);
});
