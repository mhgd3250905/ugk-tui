import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { hasCjk, parseSubtitleText, SUPPORTED_MIMO_VOICE_IDS, validateSubtitleAlignment } from "./scripts/make-video-zh-dub.mjs";

const outputDir = process.env.TASK_OUTPUT_DIR;
const taskInput = JSON.parse(process.env.TASK_INPUT || "{}");
const failures = [];

function fail(assertion, expected, actual, hint) {
	failures.push({ assertion, expected, actual, ...(hint ? { hint } : {}) });
}

function readText(name) {
	const filePath = join(outputDir, name);
	if (!existsSync(filePath)) {
		fail(`${name} exists`, "file exists", "missing", filePath);
		return "";
	}
	return readFileSync(filePath, "utf8");
}

function readJson(name) {
	const text = readText(name);
	if (!text) return undefined;
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`${name} is valid JSON`, "parseable JSON", error.message);
		return undefined;
	}
}

function probe(filePath) {
	try {
		return JSON.parse(execFileSync("ffprobe", [
			"-v", "quiet",
			"-print_format", "json",
			"-show_format",
			"-show_streams",
			filePath,
		], { encoding: "utf8" }));
	} catch (error) {
		fail(`${filePath} ffprobe`, "ffprobe parses media", error.message);
		return undefined;
	}
}

function checkMedia(name, requiredStreams) {
	const filePath = join(outputDir, name);
	if (!existsSync(filePath)) {
		fail(`${name} exists`, "file exists", "missing", filePath);
		return undefined;
	}
	const size = statSync(filePath).size;
	if (size <= 1024) fail(`${name} size`, "> 1024 bytes", `${size} bytes`);
	const info = probe(filePath);
	if (!info) return undefined;
	const duration = Number(info.format?.duration);
	if (!Number.isFinite(duration) || duration <= 0) {
		fail(`${name} duration`, "duration > 0", String(info.format?.duration));
	}
	for (const streamType of requiredStreams) {
		if (!info.streams?.some((stream) => stream.codec_type === streamType)) {
			fail(`${name} has ${streamType} stream`, `${streamType} stream`, "missing");
		}
	}
	return duration;
}

function embeddedSubtitleCueCount(filePath) {
	try {
		const srt = execFileSync("ffmpeg", [
			"-v", "error",
			"-i", filePath,
			"-map", "0:s:0",
			"-f", "srt",
			"-",
		], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
		return parseSubtitleText(srt).length;
	} catch (error) {
		fail(`${filePath} embedded subtitle parses`, "extractable SRT subtitles", error.message);
		return undefined;
	}
}

if (!outputDir || !existsSync(outputDir)) {
	fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
	let sourceCues;
	let zhCues;
	const zhText = readText("translated.zh.srt");
	if (zhText) {
		if (!hasCjk(zhText)) fail("translated.zh.srt contains Chinese", "CJK text", "no CJK text");
		try {
			zhCues = parseSubtitleText(zhText);
			if (taskInput.subtitlePath && existsSync(taskInput.subtitlePath)) {
				sourceCues = parseSubtitleText(readFileSync(taskInput.subtitlePath, "utf8"));
				validateSubtitleAlignment(sourceCues, zhCues);
			}
		} catch (error) {
			fail("translated.zh.srt aligns with source", "same cue count and exact timecodes", error.message);
		}
	}

	checkMedia("dub.zh.wav", ["audio"]);
	const finalDuration = checkMedia("final.zh.mp4", ["video", "audio", "subtitle"]);
	const hardsubDuration = checkMedia("final.zh.hardsub.mp4", ["video", "audio"]);
	if (zhCues && existsSync(join(outputDir, "final.zh.mp4"))) {
		const embeddedCount = embeddedSubtitleCueCount(join(outputDir, "final.zh.mp4"));
		if (embeddedCount !== undefined && embeddedCount !== zhCues.length) {
			fail("final.zh.mp4 embedded subtitle cue count", `${zhCues.length}`, `${embeddedCount}`, "final video should contain the current translated.zh.srt");
		}
	}

	const summary = readJson("dub-summary.json");
	if (summary) {
		if (!summary.voice) fail("dub-summary.voice", "non-empty voice", JSON.stringify(summary.voice));
		if (summary.voice && !SUPPORTED_MIMO_VOICE_IDS.includes(summary.voice)) fail("dub-summary.voice supported", SUPPORTED_MIMO_VOICE_IDS.join("|"), JSON.stringify(summary.voice));
		if (taskInput.voice && summary.voice !== taskInput.voice) fail("dub-summary.voice matches input", taskInput.voice, JSON.stringify(summary.voice));
		if (!Number.isFinite(Number(summary.speechGroupCount)) || Number(summary.speechGroupCount) <= 0) {
			fail("dub-summary.speechGroupCount", "> 0", String(summary.speechGroupCount));
		}
		const videoDuration = Number(summary.videoDurationSeconds);
		if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
			fail("dub-summary.videoDurationSeconds", "duration > 0", String(summary.videoDurationSeconds));
		} else {
			if (finalDuration !== undefined && finalDuration < videoDuration - 0.75) {
				fail("final.zh.mp4 preserves video duration", `>= ${videoDuration - 0.75}s`, `${finalDuration}s`);
			}
			if (hardsubDuration !== undefined && hardsubDuration < videoDuration - 0.75) {
				fail("final.zh.hardsub.mp4 preserves video duration", `>= ${videoDuration - 0.75}s`, `${hardsubDuration}s`);
			}
		}
		if (sourceCues && Number(summary.sourceCueCount) !== sourceCues.length) {
			fail("dub-summary.sourceCueCount", `${sourceCues.length}`, String(summary.sourceCueCount));
		}
		if (zhCues && Number(summary.zhCueCount) !== zhCues.length) {
			fail("dub-summary.zhCueCount", `${zhCues.length}`, String(summary.zhCueCount));
		}
		for (const [field, name] of [["dubAudioPath", "dub.zh.wav"], ["finalVideoPath", "final.zh.mp4"], ["zhSubtitlePath", "translated.zh.srt"]]) {
			if (!summary[field]) {
				fail(`dub-summary.${field}`, "non-empty path", JSON.stringify(summary[field]));
			} else if (!existsSync(summary[field])) {
				fail(`dub-summary.${field} exists`, "existing file", summary[field], name);
			}
		}
		if (!summary.hardsubVideoPath) {
			fail("dub-summary.hardsubVideoPath", "non-empty path", JSON.stringify(summary.hardsubVideoPath));
		} else if (!existsSync(summary.hardsubVideoPath)) {
			fail("dub-summary.hardsubVideoPath exists", "existing file", summary.hardsubVideoPath, "final.zh.hardsub.mp4");
		}
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
process.exit(0);
