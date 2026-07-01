import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
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
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		fail(`${name} is valid JSON`, "parseable JSON", error.message);
		return undefined;
	}
}

if (!outputDir || !existsSync(outputDir)) {
	fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
	const metadata = readJson("metadata.json");
	const summary = readJson("download-summary.json");
	const entries = await readdir(outputDir);
	const videos = entries.filter((name) => name.toLowerCase().endsWith(".mp4"));
	const subtitles = entries.filter((name) => /\.(vtt|srt|ass)$/i.test(name));

	if (videos.length === 0) {
		fail("mp4 video exists", "at least one .mp4 file", "none");
	}
	for (const video of videos) {
		const videoPath = join(outputDir, video);
		const size = statSync(videoPath).size;
		if (size <= 1024 * 1024) fail(`${video} size`, "> 1 MiB", `${size} bytes`, "download likely incomplete");
		try {
			const probe = execFileSync("ffprobe", [
				"-v", "quiet",
				"-print_format", "json",
				"-show_format",
				"-show_streams",
				videoPath,
			], { encoding: "utf8" });
			const info = JSON.parse(probe);
			if (!Array.isArray(info.streams) || info.streams.length === 0) {
				fail(`${video} has media streams`, "one or more streams", "0 streams");
			}
			const duration = Number(info.format?.duration);
			if (!Number.isFinite(duration) || duration <= 0) {
				fail(`${video} duration`, "duration > 0", String(info.format?.duration));
			}
		} catch (error) {
			fail(`${video} ffprobe`, "ffprobe parses video", error.message);
		}
	}

	const subtitleLanguages = Object.keys(metadata?.subtitles || {});
	if (subtitleLanguages.length > 0 && subtitles.length === 0) {
		fail("subtitles downloaded when available", subtitleLanguages.join(", "), "no subtitle files");
	}
	if (summary) {
		if (!Array.isArray(summary.videoFiles) || summary.videoFiles.length === 0) {
			fail("download-summary.videoFiles", "non-empty array", JSON.stringify(summary.videoFiles));
		}
		if (subtitleLanguages.length > 0 && (!Array.isArray(summary.subtitleFiles) || summary.subtitleFiles.length === 0)) {
			fail("download-summary.subtitleFiles", "non-empty array when subtitles exist", JSON.stringify(summary.subtitleFiles));
		}
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
process.exit(0);
