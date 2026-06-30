import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MODEL = "large-v3-turbo";
export const DEFAULT_MODEL_DIR = "E:\\AII\\.cache\\whisper";

const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".wav", ".flac", ".ogg"]);

export function isSupportedAudio(filePath) {
	return AUDIO_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

export function buildExtractAudioArgs(inputPath, outputPath) {
	return [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", inputPath,
		"-vn",
		"-acodec", "pcm_s16le",
		"-ar", "16000",
		"-ac", "1",
		outputPath,
	];
}

export function buildWhisperArgs(input) {
	const args = [
		input.audioPath,
		"--model", input.model || DEFAULT_MODEL,
		"--model_dir", input.modelDir || DEFAULT_MODEL_DIR,
		"--output_dir", input.outputDir,
		"--output_format", "all",
		"--task", input.task || "transcribe",
	];
	if (input.language) args.push("--language", input.language);
	return args;
}

export function buildWhisperEnv(env = process.env) {
	return {
		...env,
		PYTHONUTF8: "1",
		PYTHONIOENCODING: "utf-8",
	};
}

export function transcriptBaseName(audioPath) {
	return path.basename(audioPath, path.extname(audioPath));
}

export function parseCliArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2).replace(/[-_]([a-z])/g, (_, char) => char.toUpperCase());
		values[key] = argv[index + 1];
		index += 1;
	}
	return {
		...(values.filePath ? { filePath: values.filePath } : {}),
		...(values.outputDir ? { outputDir: values.outputDir } : {}),
		...(values.model ? { model: values.model } : {}),
		...(values.modelDir ? { modelDir: values.modelDir } : {}),
		...(values.language ? { language: values.language } : {}),
		...(values.task ? { task: values.task } : {}),
	};
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, { windowsHide: true, env: options.env || process.env });
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

function parseTaskInput(env) {
	try {
		return JSON.parse(env.TASK_INPUT || "{}");
	} catch {
		return {};
	}
}

function requiredPath(value, name) {
	const text = String(value || "").trim();
	const unquoted = /^(['"]).*\1$/.test(text) ? text.slice(1, -1) : text;
	const resolved = unquoted ? path.resolve(unquoted) : "";
	if (!resolved) throw new Error(`${name} is required`);
	if (!existsSync(resolved)) throw new Error(`${name} does not exist: ${resolved}`);
	return resolved;
}

export function resolveInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const taskInput = parseTaskInput(env);
	const outputDirValue = cli.outputDir || env.TASK_OUTPUT_DIR || taskInput.outputDir;
	if (!outputDirValue) throw new Error("TASK_OUTPUT_DIR or --output-dir is required");
	const outputDir = path.resolve(String(outputDirValue));
	const filePath = cli.filePath || taskInput.filePath || taskInput.file_path;
	const model = String(cli.model || taskInput.model || DEFAULT_MODEL);
	const modelDir = path.resolve(cli.modelDir || taskInput.modelDir || DEFAULT_MODEL_DIR);
	return {
		filePath: requiredPath(filePath, "filePath"),
		outputDir,
		model,
		modelDir,
		language: cli.language || taskInput.language,
		task: String(cli.task || taskInput.task || "transcribe"),
	};
}

export async function copyIfExists(from, to) {
	if (!existsSync(from)) return undefined;
	if (path.resolve(from) === path.resolve(to)) return to;
	await copyFile(from, to);
	return to;
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	const modelPath = path.join(input.modelDir, `${input.model}.pt`);
	if (!existsSync(modelPath)) {
		throw new Error(`Whisper model is missing: ${modelPath}. Keep models on E: or pass --model-dir.`);
	}

	let audioPath = input.filePath;
	let extractedAudioPath;
	if (!isSupportedAudio(input.filePath)) {
		extractedAudioPath = path.join(input.outputDir, "extracted_audio.wav");
		await run("ffmpeg", buildExtractAudioArgs(input.filePath, extractedAudioPath), { streamStderr: true });
		audioPath = extractedAudioPath;
	}

	await run("whisper", buildWhisperArgs({ ...input, audioPath }), {
		env: buildWhisperEnv(),
		streamStdout: true,
		streamStderr: true,
	});
	const base = transcriptBaseName(audioPath);
	const generated = {
		txt: path.join(input.outputDir, `${base}.txt`),
		srt: path.join(input.outputDir, `${base}.srt`),
		vtt: path.join(input.outputDir, `${base}.vtt`),
		json: path.join(input.outputDir, `${base}.json`),
		tsv: path.join(input.outputDir, `${base}.tsv`),
	};
	const artifacts = {
		transcriptTextPath: await copyIfExists(generated.txt, path.join(input.outputDir, "transcript.txt")),
		transcriptSrtPath: await copyIfExists(generated.srt, path.join(input.outputDir, "transcript.srt")),
		transcriptVttPath: await copyIfExists(generated.vtt, path.join(input.outputDir, "transcript.vtt")),
		transcriptionJsonPath: await copyIfExists(generated.json, path.join(input.outputDir, "transcription.json")),
		transcriptTsvPath: await copyIfExists(generated.tsv, path.join(input.outputDir, "transcript.tsv")),
	};
	if (!artifacts.transcriptTextPath || !artifacts.transcriptSrtPath || !artifacts.transcriptVttPath) {
		throw new Error("whisper finished but transcript.txt/srt/vtt were not produced");
	}
	const summary = {
		inputFilePath: input.filePath,
		audioPath,
		extractedAudioPath,
		model: input.model,
		modelDir: input.modelDir,
		language: input.language || "auto",
		task: input.task,
		...artifacts,
	};
	await writeFile(path.join(input.outputDir, "whisper-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
