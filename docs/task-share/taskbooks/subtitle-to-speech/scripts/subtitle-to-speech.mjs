import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_STYLE_PROMPT = "用自然、清晰、适合视频解说的中文语气，语速稳定，不要读出字幕序号或时间码。";
export const SUPPORTED_MIMO_VOICE_IDS = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

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
	return { startMs: parseTimecode(startRaw), endMs: parseTimecode(endRaw) };
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
			cues.push({ index: cues.length + 1, startMs: timing.startMs, endMs: timing.endMs, text: cueText });
		}
	}
	if (cues.length === 0) throw new Error("No subtitle cues found");
	return cues;
}

export function hasCjk(text) {
	return /[\u3400-\u9fff]/u.test(String(text || ""));
}

export function normalizeMimoVoice(value = "冰糖") {
	const voice = String(value || "冰糖").trim();
	if (SUPPORTED_MIMO_VOICE_IDS.includes(voice)) return voice;
	throw new Error(`Unsupported MiMo voice: ${voice}. Use one of: ${SUPPORTED_MIMO_VOICE_IDS.join(", ")}. voice must be an exact preset ID; put speaking style in stylePrompt.`);
}

export function buildSpeechGroups(cues, options = {}) {
	const maxChars = numericOption(options.maxChars, 120, "maxChars");
	const groups = [];
	let current = [];
	function flush() {
		if (current.length === 0) return;
		groups.push({
			index: groups.length + 1,
			startMs: current[0].startMs,
			endMs: current[current.length - 1].endMs,
			text: current.map((cue) => cue.text).join(" "),
			cueIndexes: current.map((cue) => cue.index),
		});
		current = [];
	}
	for (const cue of cues) {
		const nextText = [...current, cue].map((item) => item.text).join(" ");
		const gapMs = current.length ? cue.startMs - current[current.length - 1].endMs : 0;
		if (current.length && (nextText.length > maxChars || gapMs > 900)) flush();
		current.push(cue);
	}
	flush();
	return groups;
}

function numericOption(value, fallback, name) {
	const number = value === undefined || value === "" ? fallback : Number(value);
	if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
	return number;
}

export function baseUrlForApiKey(apiKey) {
	const key = String(apiKey || "");
	if (key.startsWith("sk-")) return "https://api.xiaomimimo.com/v1";
	if (key.startsWith("tp-")) return "https://token-plan-cn.xiaomimimo.com/v1";
	throw new Error("MIMO_API_KEY must start with sk- or tp-");
}

export function atempoFilters(factor) {
	const filters = [];
	let value = Number(factor);
	while (value > 2) {
		filters.push("atempo=2.000");
		value /= 2;
	}
	while (value < 0.5) {
		filters.push("atempo=0.500");
		value /= 0.5;
	}
	filters.push(`atempo=${value.toFixed(3)}`);
	return filters.filter((filter) => filter !== "atempo=1.000");
}

export function segmentFitPlan(duration, targetSeconds) {
	if (duration <= 0 || targetSeconds <= 0) return { silence: true, speed: 1, outputSeconds: Math.max(targetSeconds, 0.1) };
	if (duration <= targetSeconds) return { silence: false, speed: 1, outputSeconds: duration };
	return { silence: false, speed: Math.min(duration / targetSeconds, 4), outputSeconds: targetSeconds };
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
			case "--subtitle":
				out.subtitlePath = value;
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
			default:
				throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return out;
}

function ttsSegmentMeta(group, input) {
	return { text: group.text, voice: input.voice, stylePrompt: input.stylePrompt, startMs: group.startMs, endMs: group.endMs };
}

export function isReusableTtsSegment(metaText, expected) {
	try {
		const meta = JSON.parse(metaText || "{}");
		return meta.text === expected.text
			&& meta.voice === expected.voice
			&& meta.stylePrompt === expected.stylePrompt
			&& meta.startMs === expected.startMs
			&& meta.endMs === expected.endMs;
	} catch {
		return false;
	}
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

async function ffprobeDuration(filePath) {
	const result = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", filePath]);
	const duration = Number(result.stdout.trim());
	if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid audio duration for ${filePath}`);
	return duration;
}

function concatFileLine(filePath) {
	return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

async function callMimoTts(text, { apiKey, voice, stylePrompt }) {
	const response = await fetch(`${baseUrlForApiKey(apiKey)}/chat/completions`, {
		method: "POST",
		headers: { "api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "mimo-v2.5-tts",
			messages: [
				{ role: "user", content: stylePrompt || DEFAULT_STYLE_PROMPT },
				{ role: "assistant", content: text },
			],
			audio: { format: "wav", voice },
		}),
	});
	const raw = await response.text();
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		body = {};
	}
	if (!response.ok) throw new Error(`MiMo TTS HTTP ${response.status}: ${body?.error?.message || raw.slice(0, 500)}`);
	const audioData = body?.choices?.[0]?.message?.audio?.data;
	if (!audioData) throw new Error("MiMo TTS response did not include audio.data");
	return Buffer.from(audioData, "base64");
}

async function makeSilence(filePath, seconds) {
	await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", seconds.toFixed(3), "-ar", "24000", "-ac", "1", filePath]);
}

async function fitSegment(inputPath, outputPath, targetSeconds) {
	const duration = await ffprobeDuration(inputPath);
	const plan = segmentFitPlan(duration, targetSeconds);
	if (plan.silence) {
		await makeSilence(outputPath, plan.outputSeconds);
		return plan.outputSeconds;
	}
	const filters = atempoFilters(plan.speed).join(",");
	const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath];
	if (filters) args.push("-filter:a", filters);
	if (duration > targetSeconds) args.push("-t", targetSeconds.toFixed(3));
	args.push("-ar", "24000", "-ac", "1", outputPath);
	await run("ffmpeg", args);
	return plan.outputSeconds;
}

async function synthesizeDubTrack(groups, input) {
	const segmentDir = path.join(input.outputDir, "tts-segments");
	await mkdir(segmentDir, { recursive: true });
	const concatLines = [];
	let cursorMs = 0;
	async function addSilence(filePath, seconds) {
		const safeSeconds = Math.max(seconds, 0);
		if (safeSeconds <= 0) return;
		await makeSilence(filePath, safeSeconds);
		concatLines.push(concatFileLine(filePath));
	}
	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index];
		if (group.startMs > cursorMs) {
			const silencePath = path.join(segmentDir, `${String(index).padStart(4, "0")}-gap.wav`);
			await addSilence(silencePath, (group.startMs - cursorMs) / 1000);
		}
		const percent = Math.round(((index + 1) / groups.length) * 100);
		console.log(`[tts] ${index + 1}/${groups.length} ${percent}% voice=${input.voice} chars=${group.text.length}`);
		const rawPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}-raw.wav`);
		const fitPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}-fit.wav`);
		const metaPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}.json`);
		const expectedMeta = ttsSegmentMeta(group, input);
		if (!existsSync(rawPath) || !existsSync(metaPath) || !isReusableTtsSegment(readFileSync(metaPath, "utf8"), expectedMeta)) {
			await writeFile(rawPath, await callMimoTts(group.text, input));
			await writeFile(metaPath, JSON.stringify(expectedMeta, null, 2), "utf8");
		}
		const segmentSeconds = await fitSegment(rawPath, fitPath, Math.max((group.endMs - group.startMs) / 1000, 0.1));
		concatLines.push(concatFileLine(fitPath));
		cursorMs = Math.min(group.endMs, group.startMs + Math.round(segmentSeconds * 1000));
	}
	if (groups.length > 0 && groups[groups.length - 1].endMs > cursorMs) {
		await addSilence(path.join(segmentDir, "tail-gap.wav"), (groups[groups.length - 1].endMs - cursorMs) / 1000);
	}
	const concatPath = path.join(input.outputDir, "audio-concat.txt");
	await writeFile(concatPath, `${concatLines.join("\n")}\n`, "utf8");
	const dubPath = path.join(input.outputDir, "dub.zh.wav");
	await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatPath, "-ar", "24000", "-ac", "1", dubPath]);
	return dubPath;
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
	const apiKey = env.MIMO_API_KEY;
	if (!apiKey) throw new Error("MIMO_API_KEY is missing. Set it before starting UGK. Do not put the key in task input.");
	return {
		preflight: Boolean(cli.preflight),
		subtitlePath: requiredPath(cli.subtitlePath || taskInput.subtitlePath, "subtitlePath"),
		outputDir,
		apiKey,
		voice: normalizeMimoVoice(cli.voice || taskInput.voice || "冰糖"),
		stylePrompt: String(cli.stylePrompt || taskInput.stylePrompt || DEFAULT_STYLE_PROMPT),
		maxChars: numericOption(cli.maxChars ?? taskInput.maxChars, 120, "maxChars"),
	};
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	await requireCommand("ffmpeg", ["-version"]);
	await requireCommand("ffprobe", ["-version"]);
	baseUrlForApiKey(input.apiKey);
	const cues = parseSubtitleText(readFileSync(input.subtitlePath, "utf8"));
	if (!hasCjk(cues.map((cue) => cue.text).join("\n"))) throw new Error("subtitlePath must contain Chinese text for Chinese TTS");
	await writeFile(path.join(input.outputDir, "source.cues.json"), JSON.stringify(cues, null, 2), "utf8");
	const groups = buildSpeechGroups(cues, { maxChars: input.maxChars });
	if (input.preflight) {
		console.log(JSON.stringify({ ok: true, subtitlePath: input.subtitlePath, voice: input.voice, supportedVoices: SUPPORTED_MIMO_VOICE_IDS, cueCount: cues.length, speechGroupCount: groups.length }, null, 2));
		return;
	}
	const dubPath = await synthesizeDubTrack(groups, input);
	const summary = {
		subtitlePath: input.subtitlePath,
		dubAudioPath: dubPath,
		voice: input.voice,
		maxChars: input.maxChars,
		cueCount: cues.length,
		speechGroupCount: groups.length,
	};
	await writeFile(path.join(input.outputDir, "tts-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
