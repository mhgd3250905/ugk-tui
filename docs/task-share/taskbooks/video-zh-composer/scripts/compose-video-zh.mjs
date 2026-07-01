import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUBTITLE_COLOURS = {
	white: "&H00FFFFFF",
	yellow: "&H0000FFFF",
	pink: "&H00B469FF",
};
const BREAK_PUNCTUATION = "，。！？；：、,.!?;:";
const STRONG_BREAK_PUNCTUATION = "。！？!?";
const LINE_START_FORBIDDEN = "，。！？；：、,.!?;:)]）】》」』”’";

function normalizeSubtitleColor(value = "white") {
	const color = String(value || "white").toLowerCase();
	if (SUBTITLE_COLOURS[color]) return color;
	throw new Error("subtitleColor must be white, yellow, or pink");
}

export function subtitleWrapChars(videoWidth) {
	const width = Number(videoWidth) || 1280;
	return Math.max(14, Math.min(24, Math.floor(width / 64)));
}

function subtitleChars(text) {
	return Array.from(String(text || "").replace(/\s+/g, " ").trim());
}

function isLatinWordChar(char) {
	return /^[A-Za-z0-9]$/u.test(char || "");
}

function avoidLatinWordCut(chars, cut) {
	let next = cut;
	while (next > 0 && next < chars.length && isLatinWordChar(chars[next - 1]) && isLatinWordChar(chars[next])) {
		next += 1;
	}
	while (next < chars.length && LINE_START_FORBIDDEN.includes(chars[next])) {
		next += 1;
	}
	return next;
}

function lineBreakIndex(chars, limit) {
	const nearEnd = chars.length <= limit * 2;
	const min = nearEnd ? Math.max(1, chars.length - limit) : Math.max(1, Math.floor(limit * 0.55));
	const max = Math.min(chars.length - 1, nearEnd ? limit + 1 : limit - 1);
	for (let index = max; index >= min; index -= 1) {
		if (STRONG_BREAK_PUNCTUATION.includes(chars[index])) return index + 1;
	}
	for (let index = max; index >= min; index -= 1) {
		if (BREAK_PUNCTUATION.includes(chars[index])) return index + 1;
	}
	const cut = LINE_START_FORBIDDEN.includes(chars[limit]) ? Math.min(chars.length, limit + 1) : Math.min(chars.length, limit);
	return avoidLatinWordCut(chars, cut);
}

function chunkBreakIndex(chars, maxChars) {
	const min = Math.max(1, Math.floor(maxChars * 0.55));
	for (let index = Math.min(maxChars - 1, chars.length - 1); index >= min; index -= 1) {
		if (STRONG_BREAK_PUNCTUATION.includes(chars[index])) return index + 1;
	}
	for (let index = Math.min(maxChars - 1, chars.length - 1); index >= min; index -= 1) {
		if (BREAK_PUNCTUATION.includes(chars[index])) return index + 1;
	}
	const cut = LINE_START_FORBIDDEN.includes(chars[maxChars]) ? Math.min(chars.length, maxChars + 1) : Math.min(chars.length, maxChars);
	return avoidLatinWordCut(chars, cut);
}

export function wrapSubtitleText(text, maxChars = 20) {
	const limit = Math.max(1, Number(maxChars) || 20);
	let chars = subtitleChars(text);
	const lines = [];
	while (chars.length > limit) {
		const cut = lineBreakIndex(chars, limit);
		lines.push(chars.slice(0, cut).join(""));
		chars = chars.slice(cut);
	}
	if (chars.length) lines.push(chars.join(""));
	return lines.join("\n");
}

export function splitSubtitleText(text, maxChars = 20) {
	const limit = Math.max(1, Number(maxChars) || 20);
	const maxChunkChars = limit * 2;
	let chars = subtitleChars(text);
	const chunks = [];
	while (chars.length > maxChunkChars) {
		const cut = chunkBreakIndex(chars, maxChunkChars);
		chunks.push(chars.slice(0, cut).join(""));
		chars = chars.slice(cut);
	}
	if (chars.length) chunks.push(chars.join(""));
	return chunks;
}

function parseSubtitleTime(value) {
	const normalized = String(value || "").trim().replace(",", ".");
	const [clock, fraction = "0"] = normalized.split(".");
	const parts = clock.split(":").map((part) => Number(part));
	const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
	return (((hours * 60 + minutes) * 60 + seconds) * 1000) + Number(fraction.padEnd(3, "0").slice(0, 3));
}

function formatSubtitleTime(ms, separator) {
	const value = Math.max(0, Math.floor(ms));
	const hours = Math.floor(value / 3600000);
	const minutes = Math.floor((value % 3600000) / 60000);
	const seconds = Math.floor((value % 60000) / 1000);
	const millis = value % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function parseSubtitleTiming(line) {
	const [startRaw, rest] = String(line || "").split("-->");
	if (!rest) return null;
	const endRaw = rest.trim().split(/\s+/)[0];
	return {
		startMs: parseSubtitleTime(startRaw),
		endMs: parseSubtitleTime(endRaw),
		separator: startRaw.includes(",") || endRaw.includes(",") ? "," : ".",
	};
}

export function wrapSubtitleFile(text, maxChars) {
	const normalized = String(text || "").replace(/\r/g, "");
	const endsWithNewline = normalized.endsWith("\n");
	let nextIndex = 1;
	const blocks = normalized.split(/\n{2,}/).map((block) => {
		const lines = block.split("\n");
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex < 0) return block;
		const timing = parseSubtitleTiming(lines[timingIndex]);
		if (!timing || timing.endMs <= timing.startMs) return block;
		const hasIndex = timingIndex > 0 && /^\d+$/.test(lines[timingIndex - 1].trim());
		const chunks = splitSubtitleText(lines.slice(timingIndex + 1).join(" "), maxChars);
		const duration = timing.endMs - timing.startMs;
		return chunks.map((chunk, chunkIndex) => {
			const startMs = Math.floor(timing.startMs + (duration * chunkIndex) / chunks.length);
			const endMs = chunkIndex === chunks.length - 1
				? timing.endMs
				: Math.floor(timing.startMs + (duration * (chunkIndex + 1)) / chunks.length);
			const out = [];
			if (hasIndex) out.push(String(nextIndex));
			nextIndex += 1;
			out.push(`${formatSubtitleTime(startMs, timing.separator)} --> ${formatSubtitleTime(Math.max(startMs + 1, endMs), timing.separator)}`);
			out.push(...wrapSubtitleText(chunk, maxChars).split("\n"));
			return out.join("\n");
		}).join("\n\n");
	});
	return `${blocks.join("\n\n")}${endsWithNewline ? "\n" : ""}`;
}

export function parseCliArgs(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		if (arg === "--preflight") {
			out.preflight = true;
			continue;
		}
		const value = argv[index + 1];
		index += 1;
		switch (arg) {
			case "--video":
				out.videoPath = value;
				break;
			case "--audio":
				out.audioPath = value;
				break;
			case "--subtitle":
				out.subtitlePath = value;
				break;
			case "--output-dir":
				out.outputDir = value;
				break;
			case "--subtitle-color":
				out.subtitleColor = normalizeSubtitleColor(value);
				break;
			default:
				throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return out;
}

export function buildFinalMuxArgs({ videoPath, audioPath, subtitlePath, outputPath, durationSeconds, copyVideo = true }) {
	const videoCodecArgs = copyVideo
		? ["-c:v", "copy"]
		: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
	const durationArgs = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
		? ["-t", Number(durationSeconds).toFixed(3)]
		: ["-shortest"];
	return [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", videoPath,
		"-i", audioPath,
		"-i", subtitlePath,
		"-map", "0:v:0",
		"-map", "1:a:0",
		"-map", "2:0",
		...videoCodecArgs,
		"-c:a", "aac",
		"-b:a", "192k",
		"-af", "apad",
		"-c:s", "mov_text",
		"-metadata:s:a:0", "language=zho",
		"-metadata:s:s:0", "language=zho",
		...durationArgs,
		outputPath,
	];
}

export function buildHardsubArgs({ inputPath, subtitlePath, outputPath, subtitleColor = "white" }) {
	const primaryColour = SUBTITLE_COLOURS[normalizeSubtitleColor(subtitleColor)];
	const subtitleStyle = `FontName=Microsoft YaHei,FontSize=16,Alignment=2,MarginV=24,BorderStyle=1,Outline=2,Shadow=0,PrimaryColour=${primaryColour}`;
	return [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", inputPath,
		"-vf", `subtitles=${subtitlePath}:force_style='${subtitleStyle}'`,
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-crf", "20",
		"-c:a", "copy",
		outputPath,
	];
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, { cwd: options.cwd, windowsHide: true });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		if (options.streamStdout) process.stdout.write(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		if (options.streamStderr) process.stderr.write(chunk);
	});
	const exitCode = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${exitCode}:\n${stderr || stdout}`);
	return { stdout, stderr };
}

async function requireCommand(command, args) {
	await run(command, args);
}

function ffprobeInfo(filePath) {
	const probe = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath], { encoding: "utf8" });
	return JSON.parse(probe);
}

function durationSeconds(filePath) {
	const duration = Number(ffprobeInfo(filePath).format?.duration);
	if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid media duration for ${filePath}`);
	return duration;
}

function videoSize(filePath) {
	const stream = ffprobeInfo(filePath).streams?.find((item) => item.codec_type === "video");
	return {
		width: Number(stream?.width) || 1280,
		height: Number(stream?.height) || 720,
	};
}

function parseTaskInput(env) {
	try {
		return JSON.parse(env.TASK_INPUT || "{}");
	} catch {
		return {};
	}
}

function requiredPath(value, name) {
	const resolved = value ? path.resolve(String(value)) : "";
	if (!resolved) throw new Error(`${name} is required`);
	if (!existsSync(resolved)) throw new Error(`${name} does not exist: ${resolved}`);
	return resolved;
}

function resolveInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const taskInput = parseTaskInput(env);
	const outputDir = path.resolve(cli.outputDir || env.TASK_OUTPUT_DIR || taskInput.outputDir || "");
	if (!outputDir) throw new Error("TASK_OUTPUT_DIR or --output-dir is required");
	return {
		preflight: Boolean(cli.preflight),
		videoPath: requiredPath(cli.videoPath || taskInput.videoPath, "videoPath"),
		audioPath: requiredPath(cli.audioPath || taskInput.audioPath, "audioPath"),
		subtitlePath: requiredPath(cli.subtitlePath || taskInput.subtitlePath, "subtitlePath"),
		outputDir,
		subtitleColor: normalizeSubtitleColor(cli.subtitleColor || taskInput.subtitleColor || "white"),
	};
}

function localSubtitleName(subtitlePath) {
	const ext = path.extname(subtitlePath).toLowerCase();
	return ext === ".vtt" ? "subtitle.zh.vtt" : "subtitle.zh.srt";
}

function hardsubSubtitleName(subtitleName) {
	const ext = path.extname(subtitleName);
	return `${path.basename(subtitleName, ext)}.hardsub${ext || ".srt"}`;
}

async function compose(input) {
	await mkdir(input.outputDir, { recursive: true });
	const subtitleName = localSubtitleName(input.subtitlePath);
	const localSubtitlePath = path.join(input.outputDir, subtitleName);
	await copyFile(input.subtitlePath, localSubtitlePath);
	const hardsubName = hardsubSubtitleName(subtitleName);
	const size = videoSize(input.videoPath);
	await writeFile(
		path.join(input.outputDir, hardsubName),
		wrapSubtitleFile(await readFile(localSubtitlePath, "utf8"), subtitleWrapChars(size.width)),
		"utf8",
	);
	const finalVideoPath = path.join(input.outputDir, "final.zh.mp4");
	try {
		await run("ffmpeg", buildFinalMuxArgs({
			videoPath: input.videoPath,
			audioPath: input.audioPath,
			subtitlePath: subtitleName,
			outputPath: "final.zh.mp4",
			durationSeconds: input.videoDurationSeconds,
			copyVideo: true,
		}), { cwd: input.outputDir });
	} catch (error) {
		console.error(`[mux] video stream copy failed, retrying with h264 transcode: ${error.message}`);
		await run("ffmpeg", buildFinalMuxArgs({
			videoPath: input.videoPath,
			audioPath: input.audioPath,
			subtitlePath: subtitleName,
			outputPath: "final.zh.mp4",
			durationSeconds: input.videoDurationSeconds,
			copyVideo: false,
		}), { cwd: input.outputDir, streamStderr: true });
	}
	const hardsubVideoPath = path.join(input.outputDir, "final.zh.hardsub.mp4");
	await run("ffmpeg", buildHardsubArgs({
		inputPath: "final.zh.mp4",
		subtitlePath: hardsubName,
		outputPath: "final.zh.hardsub.mp4",
		subtitleColor: input.subtitleColor,
	}), { cwd: input.outputDir });
	return { finalVideoPath, hardsubVideoPath, subtitleName, hardsubName };
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	await requireCommand("ffmpeg", ["-version"]);
	await requireCommand("ffprobe", ["-version"]);
	const videoDurationSeconds = durationSeconds(input.videoPath);
	const audioDurationSeconds = durationSeconds(input.audioPath);
	if (input.preflight) {
		console.log(JSON.stringify({
			ok: true,
			videoPath: input.videoPath,
			audioPath: input.audioPath,
			subtitlePath: input.subtitlePath,
			subtitleColor: input.subtitleColor,
			videoDurationSeconds,
			audioDurationSeconds,
		}, null, 2));
		return;
	}
	input.videoDurationSeconds = videoDurationSeconds;
	input.audioDurationSeconds = audioDurationSeconds;
	const result = await compose(input);
	const summary = {
		videoPath: input.videoPath,
		audioPath: input.audioPath,
		subtitlePath: input.subtitlePath,
		localSubtitlePath: path.join(input.outputDir, result.subtitleName),
		hardsubSubtitlePath: path.join(input.outputDir, result.hardsubName),
		finalVideoPath: result.finalVideoPath,
		hardsubVideoPath: result.hardsubVideoPath,
		subtitleColor: input.subtitleColor,
		videoDurationSeconds,
		audioDurationSeconds,
	};
	await writeFile(path.join(input.outputDir, "compose-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
