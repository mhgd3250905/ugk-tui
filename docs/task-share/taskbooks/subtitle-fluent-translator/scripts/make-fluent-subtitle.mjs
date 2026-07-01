import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET_LANGUAGE = "zh-CN";
const DEFAULT_MAX_UNIT_DURATION_MS = 8000;
const DEFAULT_MAX_UNIT_CHARS = 90;
const TALKATIVE_MAX_UNIT_CHARS = 160;
const TALKATIVE_MIN_CHARS_PER_SECOND = 4;
const TALKATIVE_MIN_DENSITY_DURATION_MS = 6000;

export function defaultMaxUnitChars(verbosity = "normal") {
	return String(verbosity).toLowerCase() === "talkative" ? TALKATIVE_MAX_UNIT_CHARS : DEFAULT_MAX_UNIT_CHARS;
}

function normalizeVerbosity(value) {
	const verbosity = String(value || "normal").toLowerCase();
	if (verbosity === "normal" || verbosity === "talkative") return verbosity;
	throw new Error("verbosity must be normal or talkative");
}

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

function normalizeUnits(data) {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.units)) return data.units;
	if (Array.isArray(data?.items)) return data.items;
	throw new Error("fluent.units.json must be an array, or an object with units/items array");
}

function unitIds(unit) {
	const ids = unit?.ids ?? unit?.cueIds ?? unit?.sourceIds;
	if (!Array.isArray(ids) || ids.length === 0) throw new Error("unit ids must be a non-empty array");
	return ids.map((id) => {
		const value = Number(id);
		if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid cue id: ${id}`);
		return value;
	});
}

function unitText(unit) {
	return cleanSubtitleText(unit?.text ?? unit?.t ?? unit?.translation);
}

export function validateUnits(sourceCues, rawUnits, options = {}) {
	const units = normalizeUnits(rawUnits);
	const sourceById = new Map(sourceCues.map((cue) => [cue.index, cue]));
	const maxUnitDurationMs = Number(options.maxUnitDurationMs ?? DEFAULT_MAX_UNIT_DURATION_MS);
	const maxUnitChars = Number(options.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS);
	const targetLanguage = String(options.targetLanguage || DEFAULT_TARGET_LANGUAGE);
	const talkative = String(options.verbosity || "normal").toLowerCase() === "talkative";
	const seen = new Set();
	let previousId = 0;
	const normalized = [];

	for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
		const ids = unitIds(units[unitIndex]);
		for (let index = 1; index < ids.length; index += 1) {
			if (ids[index] !== ids[index - 1] + 1) {
				throw new Error(`unit ${unitIndex + 1} ids must be contiguous`);
			}
		}
		for (const id of ids) {
			if (!sourceById.has(id)) throw new Error(`unknown cue id ${id}`);
			if (seen.has(id)) throw new Error(`duplicate cue id ${id}`);
			if (id <= previousId) throw new Error(`cue ids out of order at ${id}`);
			seen.add(id);
			previousId = id;
		}

		const text = unitText(units[unitIndex]);
		if (!text) throw new Error(`empty text for unit ${unitIndex + 1}`);
		if (text.length > maxUnitChars) {
			throw new Error(`unit ${unitIndex + 1} text too long: ${text.length} > ${maxUnitChars}`);
		}
		const firstCue = sourceById.get(ids[0]);
		const lastCue = sourceById.get(ids[ids.length - 1]);
		const durationMs = lastCue.endMs - firstCue.startMs;
		if (ids.length > 1 && durationMs > maxUnitDurationMs) {
			throw new Error(`unit ${unitIndex + 1} duration too long: ${durationMs} > ${maxUnitDurationMs}`);
		}
		if (talkative && durationMs >= TALKATIVE_MIN_DENSITY_DURATION_MS) {
			const minChars = Math.min(maxUnitChars, Math.ceil((durationMs / 1000) * TALKATIVE_MIN_CHARS_PER_SECOND));
			if (text.length < minChars) {
				throw new Error(`unit ${unitIndex + 1} talkative text too sparse: ${text.length} < ${minChars} chars for ${(durationMs / 1000).toFixed(1)}s`);
			}
		}
		normalized.push({
			ids,
			text,
			startMs: firstCue.startMs,
			endMs: lastCue.endMs,
		});
	}

	const missing = sourceCues.filter((cue) => !seen.has(cue.index)).map((cue) => cue.index);
	if (missing.length > 0) throw new Error(`missing cue ids: ${missing.join(", ")}`);
	if (targetLanguage.toLowerCase().startsWith("zh") && !normalized.some((unit) => hasCjk(unit.text))) {
		throw new Error("targetLanguage zh-CN requires CJK text");
	}
	return normalized;
}

export function buildFluentSrt(sourceCues, units, options = {}) {
	const normalized = validateUnits(sourceCues, units, options);
	const lines = [];
	let prevEndMs = 0;
	for (let index = 0; index < normalized.length; index += 1) {
		const unit = normalized[index];
		// Clamp start to at least prevEndMs to enforce monotonicity.
		// Source cues may overlap by 1-2ms; the output must not.
		const startMs = Math.max(unit.startMs, prevEndMs);
		const endMs = Math.max(unit.endMs, startMs);
		prevEndMs = endMs;
		lines.push(
			String(index + 1),
			`${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}`,
			unit.text,
			"",
		);
	}
	return `${lines.join("\n").trim()}\n`;
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
			case "--target-language":
				out.targetLanguage = value;
				break;
			case "--verbosity":
				out.rawVerbosity = String(value).toLowerCase();
				out.verbosity = normalizeVerbosity(value);
				break;
			case "--style-prompt":
				out.stylePrompt = value;
				break;
			case "--glossary":
				out.glossary = value;
				break;
			case "--max-unit-duration-ms":
				out.maxUnitDurationMs = Number(value);
				break;
			case "--max-unit-chars":
				out.maxUnitChars = Number(value);
				break;
			default:
				throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return out;
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

function numericOption(value, fallback, name) {
	const number = value === undefined || value === "" ? fallback : Number(value);
	if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
	return number;
}

function resolveInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const taskInput = parseTaskInput(env);
	const outputDir = path.resolve(cli.outputDir || env.TASK_OUTPUT_DIR || taskInput.outputDir || "");
	if (!outputDir) throw new Error("TASK_OUTPUT_DIR or --output-dir is required");
	const rawVerbosity = cli.rawVerbosity || taskInput.verbosity || "normal";
	const verbosity = normalizeVerbosity(rawVerbosity);
	return {
		preflight: Boolean(cli.preflight),
		subtitlePath: requiredPath(cli.subtitlePath || taskInput.subtitlePath, "subtitlePath"),
		outputDir,
		targetLanguage: String(cli.targetLanguage || taskInput.targetLanguage || DEFAULT_TARGET_LANGUAGE),
		verbosity,
		rawVerbosity: String(rawVerbosity).toLowerCase(),
		stylePrompt: String(cli.stylePrompt || taskInput.stylePrompt || ""),
		glossary: String(cli.glossary || taskInput.glossary || ""),
		maxUnitDurationMs: numericOption(cli.maxUnitDurationMs ?? taskInput.maxUnitDurationMs, DEFAULT_MAX_UNIT_DURATION_MS, "maxUnitDurationMs"),
		maxUnitChars: numericOption(cli.maxUnitChars ?? taskInput.maxUnitChars, defaultMaxUnitChars(verbosity), "maxUnitChars"),
	};
}

async function writeSourceCues(input) {
	const sourceCues = parseSubtitleText(readFileSync(input.subtitlePath, "utf8"));
	await writeFile(path.join(input.outputDir, "source.cues.json"), JSON.stringify(sourceCues, null, 2), "utf8");
	return sourceCues;
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	const sourceCues = await writeSourceCues(input);
	if (input.preflight) {
		console.log(JSON.stringify({
			ok: true,
			subtitlePath: input.subtitlePath,
			targetLanguage: input.targetLanguage,
			verbosity: input.verbosity,
			sourceCueCount: sourceCues.length,
			maxUnitDurationMs: input.maxUnitDurationMs,
			maxUnitChars: input.maxUnitChars,
			glossary: input.glossary,
		}, null, 2));
		return;
	}

	const unitsPath = path.join(input.outputDir, "fluent.units.json");
	if (!existsSync(unitsPath)) {
		throw new Error(`fluent units are missing: ${unitsPath}`);
	}
	const units = JSON.parse(readFileSync(unitsPath, "utf8").replace(/^\uFEFF/, ""));
	const normalized = validateUnits(sourceCues, units, input);
	const outputSubtitlePath = path.join(input.outputDir, "fluent.zh.srt");
	await writeFile(outputSubtitlePath, buildFluentSrt(sourceCues, normalized, input), "utf8");
	const report = {
		sourceSubtitlePath: input.subtitlePath,
		outputSubtitlePath,
		targetLanguage: input.targetLanguage,
		verbosity: input.rawVerbosity,
		sourceCueCount: sourceCues.length,
		unitCount: normalized.length,
		maxUnitDurationMs: input.maxUnitDurationMs,
		maxUnitChars: input.maxUnitChars,
		stylePrompt: input.stylePrompt,
		glossary: input.glossary,
	};
	await writeFile(path.join(input.outputDir, "fluent-report.json"), JSON.stringify(report, null, 2), "utf8");
	console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
