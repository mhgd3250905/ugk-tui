import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const outputDir = process.env.TASK_OUTPUT_DIR;
const failures = [];

function fail(assertion, expected, actual, hint) {
	failures.push({ assertion, expected, actual, ...(hint ? { hint } : {}) });
}

function readJson(name) {
	const filePath = join(outputDir, name);
	if (!existsSync(filePath)) {
		fail(`${name} exists`, "file exists", "missing", filePath);
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`${name} is valid JSON`, "parseable JSON", error.message);
		return undefined;
	}
}

function probeMedia(name, requiredStreams) {
	const filePath = join(outputDir, name);
	if (!existsSync(filePath)) {
		fail(`${name} exists`, "file exists", "missing", filePath);
		return undefined;
	}
	const size = statSync(filePath).size;
	if (size <= 1024 * 1024) fail(`${name} size`, "> 1 MiB", `${size} bytes`);
	try {
		const probe = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath], { encoding: "utf8" });
		const info = JSON.parse(probe);
		const streams = Array.isArray(info.streams) ? info.streams : [];
		const duration = Number(info.format?.duration);
		if (!Number.isFinite(duration) || duration <= 0) fail(`${name} duration`, "duration > 0", String(info.format?.duration));
		for (const type of requiredStreams) {
			if (!streams.some((stream) => stream.codec_type === type)) fail(`${name} ${type} stream`, `${type} stream exists`, "missing");
		}
		return duration;
	} catch (error) {
		fail(`${name} ffprobe`, "ffprobe parses media", error.message);
		return undefined;
	}
}

if (!outputDir || !existsSync(outputDir)) {
	fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
	const summary = readJson("compose-summary.json");
	const finalDuration = probeMedia("final.zh.mp4", ["video", "audio", "subtitle"]);
	const hardsubDuration = probeMedia("final.zh.hardsub.mp4", ["video", "audio"]);
	if (summary) {
		for (const key of ["videoPath", "audioPath", "subtitlePath", "finalVideoPath", "hardsubVideoPath", "subtitleColor"]) {
			if (!summary[key]) fail(`compose-summary.${key}`, "non-empty value", JSON.stringify(summary[key]));
		}
		if (summary.finalVideoPath && !existsSync(summary.finalVideoPath)) fail("compose-summary.finalVideoPath exists", "existing file", JSON.stringify(summary.finalVideoPath));
		if (summary.hardsubVideoPath && !existsSync(summary.hardsubVideoPath)) fail("compose-summary.hardsubVideoPath exists", "existing file", JSON.stringify(summary.hardsubVideoPath));
		if (!["white", "yellow", "pink"].includes(String(summary.subtitleColor))) fail("compose-summary.subtitleColor", "white|yellow|pink", JSON.stringify(summary.subtitleColor));
		const videoDuration = Number(summary.videoDurationSeconds);
		if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
			fail("compose-summary.videoDurationSeconds", "duration > 0", String(summary.videoDurationSeconds));
		} else {
			if (finalDuration !== undefined && finalDuration < videoDuration - 0.75) {
				fail("final.zh.mp4 preserves video duration", `>= ${videoDuration - 0.75}s`, `${finalDuration}s`);
			}
			if (hardsubDuration !== undefined && hardsubDuration < videoDuration - 0.75) {
				fail("final.zh.hardsub.mp4 preserves video duration", `>= ${videoDuration - 0.75}s`, `${hardsubDuration}s`);
			}
		}
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
process.exit(0);
