import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_STYLE_PROMPT = "用自然、清晰、适合视频解说的中文语气，语速稳定，不要读出字幕序号或时间码。";
export const SUPPORTED_MIMO_VOICE_IDS = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
const SUBTITLE_COLOURS = {
	white: "&H00FFFFFF",
	yellow: "&H0000FFFF",
	pink: "&H00B469FF",
};
const BREAK_PUNCTUATION = "，。！？；：、,.!?;:";
const STRONG_BREAK_PUNCTUATION = "。！？!?";
const LINE_START_FORBIDDEN = "，。！？；：、,.!?;:)]）】》」』”’";

function cleanSubtitleText(text) {
	return String(text || "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

function parseTimecode(value) {
	const normalized = String(value || "").trim().replace(",", ".");
	const [clock, fraction = "0"] = normalized.split(".");
	const parts = clock.split(":").map((part) => Number(part));
	if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
		throw new Error(`Invalid subtitle timecode: ${value}`);
	}
	const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
	return (((hours * 60 + minutes) * 60 + seconds) * 1000) + Number(fraction.padEnd(3, "0").slice(0, 3));
}

function parseTimingLine(line) {
	const match = String(line || "").match(/^\s*(\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}/);
	if (!match) return null;
	const [startRaw, rest] = line.split("-->");
	const endRaw = rest.trim().split(/\s+/)[0];
	return {
		startMs: parseTimecode(startRaw),
		endMs: parseTimecode(endRaw),
	};
}

export function parseSubtitleText(text) {
	const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
	const cues = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line || line === "WEBVTT" || line.startsWith("NOTE")) continue;

		let timing = parseTimingLine(line);
		if (!timing && lines[index + 1]) {
			timing = parseTimingLine(lines[index + 1]);
			if (timing) index += 1;
		}
		if (!timing) continue;

		const textLines = [];
		index += 1;
		while (index < lines.length && lines[index].trim()) {
			textLines.push(lines[index]);
			index += 1;
		}
		const cueText = cleanSubtitleText(textLines.join(" "));
		if (cueText && timing.endMs > timing.startMs) {
			cues.push({
				index: cues.length + 1,
				startMs: timing.startMs,
				endMs: timing.endMs,
				text: cueText,
			});
		}
	}
	if (cues.length === 0) throw new Error("No subtitle cues found");
	return cues;
}

export function formatSrtTimestamp(ms) {
	const value = Math.max(0, Math.floor(ms));
	const hours = Math.floor(value / 3600000);
	const minutes = Math.floor((value % 3600000) / 60000);
	const seconds = Math.floor((value % 60000) / 1000);
	const millis = value % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function hasCjk(text) {
	return /[\u3400-\u9fff]/u.test(String(text || ""));
}

export function normalizeMimoVoice(value = "冰糖") {
	const voice = String(value || "冰糖").trim();
	if (SUPPORTED_MIMO_VOICE_IDS.includes(voice)) return voice;
	throw new Error(`Unsupported MiMo voice: ${voice}. Use one of: ${SUPPORTED_MIMO_VOICE_IDS.join(", ")}. voice must be an exact preset ID; put speaking style in stylePrompt.`);
}

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

function formatSubtitleTime(ms, separator) {
	const srt = formatSrtTimestamp(ms);
	return separator === "." ? srt.replace(",", ".") : srt;
}

function parseSubtitleTimingForWrap(line) {
	const [startRaw, rest] = String(line || "").split("-->");
	if (!rest) return null;
	const endRaw = rest.trim().split(/\s+/)[0];
	return {
		startMs: parseTimecode(startRaw),
		endMs: parseTimecode(endRaw),
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
		const timing = parseSubtitleTimingForWrap(lines[timingIndex]);
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

export function validateSubtitleAlignment(sourceCues, zhCues) {
	if (zhCues.length !== sourceCues.length) {
		throw new Error(`subtitle cue count mismatch: expected ${sourceCues.length}, got ${zhCues.length}`);
	}
	for (let index = 0; index < sourceCues.length; index += 1) {
		const source = sourceCues[index];
		const zh = zhCues[index];
		if (source.startMs !== zh.startMs || source.endMs !== zh.endMs) {
			throw new Error(`cue ${source.index} timing mismatch: expected ${source.startMs}-${source.endMs}, got ${zh.startMs}-${zh.endMs}`);
		}
		if (!cleanSubtitleText(zh.text)) throw new Error(`empty translated text for cue ${source.index}`);
	}
	return true;
}

function translationId(item) {
	const value = Number(item?.id ?? item?.i ?? item?.index);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

function translationText(item) {
	return cleanSubtitleText(item?.text ?? item?.t ?? item?.zh ?? item?.translation);
}

function parseTranslationItems(text) {
	const data = JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.items)) return data.items;
	if (Array.isArray(data?.translations)) return data.translations;
	throw new Error("zh-text.json must be a JSON array, or an object with items/translations array");
}

export function buildTranslatedSrt(sourceCues, translationItems) {
	const byId = new Map();
	for (const item of translationItems) {
		const id = translationId(item);
		if (!id) continue;
		if (byId.has(id)) throw new Error(`duplicate translated text for cue ${id}`);
		byId.set(id, translationText(item));
	}
	const lines = [];
	for (const cue of sourceCues) {
		if (!byId.has(cue.index)) throw new Error(`missing translated text for cue ${cue.index}`);
		const text = byId.get(cue.index);
		if (!text) throw new Error(`empty translated text for cue ${cue.index}`);
		lines.push(
			String(cue.index),
			`${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}`,
			text,
			"",
		);
	}
	return `${lines.join("\n").trim()}\n`;
}

export function buildSpeechGroups(cues, options = {}) {
	const maxChars = Number(options.maxChars ?? 120);
	const maxGapMs = Number(options.maxGapMs ?? 700);
	const maxDurationMs = Number(options.maxDurationMs ?? 8000);
	const groups = [];
	let current = null;

	function flush() {
		if (current) groups.push(current);
		current = null;
	}

	for (const cue of cues) {
		const text = cleanSubtitleText(cue.text);
		if (!text) continue;
		if (!current) {
			current = {
				startMs: cue.startMs,
				endMs: cue.endMs,
				text,
				cueIndexes: [cue.index],
			};
			continue;
		}
		const gapMs = cue.startMs - current.endMs;
		const nextText = `${current.text} ${text}`.trim();
		const nextDurationMs = cue.endMs - current.startMs;
		if (gapMs <= maxGapMs && nextText.length <= maxChars && nextDurationMs <= maxDurationMs) {
			current.endMs = cue.endMs;
			current.text = nextText;
			current.cueIndexes.push(cue.index);
		} else {
			flush();
			current = {
				startMs: cue.startMs,
				endMs: cue.endMs,
				text,
				cueIndexes: [cue.index],
			};
		}
	}
	flush();
	return groups;
}

export function baseUrlForApiKey(apiKey) {
	const key = String(apiKey || "").trim();
	if (key.startsWith("tp-")) return "https://token-plan-cn.xiaomimimo.com/v1";
	if (key.startsWith("sk-")) return "https://api.xiaomimimo.com/v1";
	throw new Error("MIMO_API_KEY must start with sk- or tp-");
}

export function atempoFilters(factor) {
	let remaining = Number(factor);
	if (!Number.isFinite(remaining) || remaining <= 1.03) return [];
	const filters = [];
	while (remaining > 2) {
		filters.push("atempo=2.000");
		remaining /= 2;
	}
	if (remaining > 1.03) filters.push(`atempo=${remaining.toFixed(3)}`);
	return filters;
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
			case "--subtitle":
				out.subtitlePath = value;
				break;
			case "--zh-subtitle":
				out.zhSubtitlePath = value;
				break;
			case "--output-dir":
				out.outputDir = value;
				break;
			case "--voice":
				out.voice = value;
				break;
			case "--style-prompt":
				out.stylePrompt = value;
				break;
			case "--max-chars":
				out.maxChars = Number(value);
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

export function buildFinalMuxArgs({ videoPath, dubPath, subtitlePath, outputPath, durationSeconds, copyVideo = true }) {
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
		"-i", dubPath,
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

function ttsSegmentMeta(group, input) {
	return {
		text: group.text,
		voice: input.voice,
		stylePrompt: input.stylePrompt || DEFAULT_STYLE_PROMPT,
		startMs: group.startMs,
		endMs: group.endMs,
	};
}

export function isReusableTtsSegment(metaText, expected) {
	try {
		const actual = JSON.parse(metaText || "{}");
		return actual.text === expected.text
			&& actual.voice === expected.voice
			&& actual.stylePrompt === expected.stylePrompt
			&& actual.startMs === expected.startMs
			&& actual.endMs === expected.endMs;
	} catch {
		return false;
	}
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, { windowsHide: true, cwd: options.cwd });
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
	if (exitCode !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with exit ${exitCode}:\n${stderr || stdout}`);
	}
	return { stdout, stderr };
}

async function requireCommand(command, args) {
	await run(command, args);
}

async function ffprobeDuration(filePath) {
	const result = await run("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		filePath,
	]);
	const seconds = Number(result.stdout.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe could not read duration: ${filePath}`);
	return seconds;
}

async function ffprobeVideoSize(filePath) {
	const result = await run("ffprobe", [
		"-v", "quiet",
		"-print_format", "json",
		"-show_streams",
		filePath,
	]);
	const data = JSON.parse(result.stdout || "{}");
	const stream = data.streams?.find((item) => item.codec_type === "video");
	return {
		width: Number(stream?.width) || 1280,
		height: Number(stream?.height) || 720,
	};
}

function concatFileLine(filePath) {
	const normalized = path.resolve(filePath).replace(/\\/g, "/").replace(/'/g, "'\\''");
	return `file '${normalized}'`;
}

async function callMimoTts(text, { apiKey, voice, stylePrompt }) {
	const response = await fetch(`${baseUrlForApiKey(apiKey)}/chat/completions`, {
		method: "POST",
		headers: {
			"api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "mimo-v2.5-tts",
			messages: [
				{ role: "user", content: stylePrompt || DEFAULT_STYLE_PROMPT },
				{ role: "assistant", content: text },
			],
			audio: {
				format: "wav",
				voice,
			},
		}),
	});
	const raw = await response.text();
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		body = {};
	}
	if (!response.ok) {
		const message = body?.error?.message || raw.slice(0, 500);
		throw new Error(`MiMo TTS HTTP ${response.status}: ${message}`);
	}
	const audioData = body?.choices?.[0]?.message?.audio?.data;
	if (!audioData) throw new Error("MiMo TTS response did not include audio.data");
	return Buffer.from(audioData, "base64");
}

async function makeSilence(filePath, seconds) {
	await run("ffmpeg", [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-f", "lavfi",
		"-i", "anullsrc=r=24000:cl=mono",
		"-t", seconds.toFixed(3),
		"-ar", "24000",
		"-ac", "1",
		filePath,
	]);
}

async function fitSegment(inputPath, outputPath, targetSeconds) {
	const sourceSeconds = await ffprobeDuration(inputPath);
	const safeTarget = Math.max(0.35, targetSeconds);
	const speedFactor = sourceSeconds > safeTarget * 1.03 ? sourceSeconds / safeTarget : 1;
	const filters = [
		...atempoFilters(speedFactor),
		"apad",
		`atrim=0:${safeTarget.toFixed(3)}`,
		"asetpts=N/SR/TB",
	];
	await run("ffmpeg", [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", inputPath,
		"-af", filters.join(","),
		"-ar", "24000",
		"-ac", "1",
		outputPath,
	]);
}

async function synthesizeDubTrack(groups, input) {
	const segmentDir = path.join(input.outputDir, "tts-segments");
	await mkdir(segmentDir, { recursive: true });
	const parts = [];
	let currentMs = 0;

	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index];
		const rawPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}.wav`);
		const fitPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}.fit.wav`);
		const metaPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}.json`);
		const expectedMeta = ttsSegmentMeta(group, input);
		const percent = Math.round(((index + 1) / groups.length) * 100);
		console.log(`[tts] ${index + 1}/${groups.length} ${percent}% voice=${input.voice} chars=${group.text.length}`);

		const metaText = existsSync(metaPath) ? readFileSync(metaPath, "utf8") : "";
		if (!existsSync(rawPath) || statSync(rawPath).size === 0 || !isReusableTtsSegment(metaText, expectedMeta)) {
			const audio = await callMimoTts(group.text, input);
			await writeFile(rawPath, audio);
			await writeFile(metaPath, JSON.stringify(expectedMeta, null, 2), "utf8");
		}
		await fitSegment(rawPath, fitPath, (group.endMs - group.startMs) / 1000);

		const gapMs = group.startMs - currentMs;
		if (gapMs > 20) {
			const silencePath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}.gap.wav`);
			await makeSilence(silencePath, gapMs / 1000);
			parts.push(silencePath);
		}
		parts.push(fitPath);
		currentMs = group.endMs;
	}

	const videoDurationMs = Math.floor(input.videoDurationSeconds * 1000);
	if (videoDurationMs - currentMs > 20) {
		const tailPath = path.join(segmentDir, "tail.wav");
		await makeSilence(tailPath, (videoDurationMs - currentMs) / 1000);
		parts.push(tailPath);
	}

	const concatPath = path.join(input.outputDir, "audio-concat.txt");
	await writeFile(concatPath, `${parts.map(concatFileLine).join("\n")}\n`, "utf8");

	const dubPath = path.join(input.outputDir, "dub.zh.wav");
	await run("ffmpeg", [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-f", "concat",
		"-safe", "0",
		"-i", concatPath,
		"-ar", "24000",
		"-ac", "1",
		dubPath,
	]);
	return dubPath;
}

async function muxFinalVideo(input, dubPath) {
	const outputPath = path.join(input.outputDir, "final.zh.mp4");
	try {
		await run("ffmpeg", buildFinalMuxArgs({
			videoPath: input.videoPath,
			dubPath,
			subtitlePath: input.zhSubtitlePath,
			outputPath,
			durationSeconds: input.videoDurationSeconds,
			copyVideo: true,
		}));
	} catch (error) {
		console.error(`[mux] video stream copy failed, retrying with h264 transcode: ${error.message}`);
		await run("ffmpeg", buildFinalMuxArgs({
			videoPath: input.videoPath,
			dubPath,
			subtitlePath: input.zhSubtitlePath,
			outputPath,
			durationSeconds: input.videoDurationSeconds,
			copyVideo: false,
		}), { streamStderr: true });
	}
	return outputPath;
}

async function renderHardsubVideo(input) {
	const outputPath = path.join(input.outputDir, "final.zh.hardsub.mp4");
	const hardsubSubtitleName = "translated.zh.hardsub.srt";
	const size = await ffprobeVideoSize(path.join(input.outputDir, "final.zh.mp4"));
	await writeFile(
		path.join(input.outputDir, hardsubSubtitleName),
		wrapSubtitleFile(readFileSync(input.zhSubtitlePath, "utf8"), subtitleWrapChars(size.width)),
		"utf8",
	);
	await run("ffmpeg", buildHardsubArgs({
		inputPath: "final.zh.mp4",
		subtitlePath: hardsubSubtitleName,
		outputPath: "final.zh.hardsub.mp4",
		subtitleColor: input.subtitleColor,
	}), { cwd: input.outputDir });
	return outputPath;
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
	const zhSubtitlePath = path.resolve(cli.zhSubtitlePath || taskInput.zhSubtitlePath || path.join(outputDir, "translated.zh.srt"));
	const apiKey = env.MIMO_API_KEY;
	if (!apiKey) {
		throw new Error("MIMO_API_KEY is missing. Set it before starting UGK. PowerShell current session: $env:MIMO_API_KEY='sk-...' ; persistent user env: setx MIMO_API_KEY \"sk-...\" then restart UGK. Do not put the key in task input.");
	}
	return {
		preflight: Boolean(cli.preflight),
		videoPath: requiredPath(cli.videoPath || taskInput.videoPath, "videoPath"),
		subtitlePath: requiredPath(cli.subtitlePath || taskInput.subtitlePath, "subtitlePath"),
		zhSubtitlePath,
		outputDir,
		apiKey,
		voice: normalizeMimoVoice(cli.voice || taskInput.voice || "冰糖"),
		stylePrompt: String(cli.stylePrompt || taskInput.stylePrompt || DEFAULT_STYLE_PROMPT),
		maxChars: Number(cli.maxChars || taskInput.maxChars || 120),
		subtitleColor: normalizeSubtitleColor(cli.subtitleColor || taskInput.subtitleColor || "white"),
	};
}

async function ensureChineseSubtitle(input) {
	const sourceText = readFileSync(input.subtitlePath, "utf8");
	const sourceCues = parseSubtitleText(sourceText);
	await writeFile(path.join(input.outputDir, "source.cues.json"), JSON.stringify(sourceCues, null, 2), "utf8");

	const zhTextJsonPath = path.join(input.outputDir, "zh-text.json");
	if (existsSync(zhTextJsonPath)) {
		const srt = buildTranslatedSrt(sourceCues, parseTranslationItems(readFileSync(zhTextJsonPath, "utf8")));
		await writeFile(input.zhSubtitlePath, srt, "utf8");
	} else if (!existsSync(input.zhSubtitlePath) && hasCjk(sourceText)) {
		const srt = buildTranslatedSrt(sourceCues, sourceCues.map((cue) => ({ i: cue.index, t: cue.text })));
		await writeFile(input.zhSubtitlePath, srt, "utf8");
	}
	if (!existsSync(input.zhSubtitlePath)) {
		throw new Error(`Chinese subtitle is missing: ${input.zhSubtitlePath}. Create ${zhTextJsonPath} as a JSON array of {"i": cue number, "t": "中文正文"} before running TTS.`);
	}
	const zhText = readFileSync(input.zhSubtitlePath, "utf8");
	if (!hasCjk(zhText)) throw new Error(`Chinese subtitle has no CJK text: ${input.zhSubtitlePath}`);
	const zhCues = parseSubtitleText(zhText);
	validateSubtitleAlignment(sourceCues, zhCues);
	return {
		sourceCueCount: sourceCues.length,
		zhCues,
	};
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	await requireCommand("ffmpeg", ["-version"]);
	await requireCommand("ffprobe", ["-version"]);
	baseUrlForApiKey(input.apiKey);
	const sourceCues = parseSubtitleText(readFileSync(input.subtitlePath, "utf8"));
	await writeFile(path.join(input.outputDir, "source.cues.json"), JSON.stringify(sourceCues, null, 2), "utf8");
	const sourceCueCount = sourceCues.length;
	input.videoDurationSeconds = await ffprobeDuration(input.videoPath);
	if (input.preflight) {
		console.log(JSON.stringify({
			ok: true,
			videoPath: input.videoPath,
			subtitlePath: input.subtitlePath,
			voice: input.voice,
			supportedVoices: SUPPORTED_MIMO_VOICE_IDS,
			subtitleColor: input.subtitleColor,
			sourceCueCount,
			videoDurationSeconds: input.videoDurationSeconds,
		}, null, 2));
		return;
	}

	const subtitles = await ensureChineseSubtitle(input);
	const groups = buildSpeechGroups(subtitles.zhCues, { maxChars: input.maxChars });
	if (groups.length === 0) throw new Error("No speech groups were produced from Chinese subtitles");

	const dubPath = await synthesizeDubTrack(groups, input);
	const finalVideoPath = await muxFinalVideo(input, dubPath);
	const hardsubVideoPath = await renderHardsubVideo(input);
	const summary = {
		videoPath: input.videoPath,
		sourceSubtitlePath: input.subtitlePath,
		zhSubtitlePath: input.zhSubtitlePath,
		dubAudioPath: dubPath,
		finalVideoPath,
		hardsubVideoPath,
		voice: input.voice,
		subtitleColor: input.subtitleColor,
		sourceCueCount: subtitles.sourceCueCount,
		zhCueCount: subtitles.zhCues.length,
		speechGroupCount: groups.length,
		videoDurationSeconds: input.videoDurationSeconds,
	};
	await writeFile(path.join(input.outputDir, "dub-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
