import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	DEFAULT_MODEL,
	DEFAULT_MODEL_DIR,
	buildExtractAudioArgs,
	buildWhisperArgs,
	buildWhisperEnv,
	copyIfExists,
	isSupportedAudio,
	parseCliArgs,
	resolveInput,
	transcriptBaseName,
} from "./whisper-audio-to-text.mjs";

test("detects supported audio extensions", () => {
	assert.equal(isSupportedAudio("a.wav"), true);
	assert.equal(isSupportedAudio("a.MP3"), true);
	assert.equal(isSupportedAudio("a.flac"), true);
	assert.equal(isSupportedAudio("a.mp4"), false);
});

test("builds ffmpeg audio extraction args", () => {
	assert.deepEqual(buildExtractAudioArgs("input.mp4", "out.wav"), [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", "input.mp4",
		"-vn",
		"-acodec", "pcm_s16le",
		"-ar", "16000",
		"-ac", "1",
		"out.wav",
	]);
});

test("builds whisper turbo args using E drive model cache", () => {
	const args = buildWhisperArgs({
		audioPath: "audio.wav",
		outputDir: "out",
		model: DEFAULT_MODEL,
		modelDir: DEFAULT_MODEL_DIR,
		language: "ru",
		task: "transcribe",
	});

	assert.deepEqual(args, [
		"audio.wav",
		"--model", "large-v3-turbo",
		"--model_dir", "E:\\AII\\.cache\\whisper",
		"--output_dir", "out",
		"--output_format", "all",
		"--task", "transcribe",
		"--language", "ru",
	]);
});

test("omits language for auto detection", () => {
	const args = buildWhisperArgs({
		audioPath: "audio.wav",
		outputDir: "out",
		model: DEFAULT_MODEL,
		modelDir: DEFAULT_MODEL_DIR,
		task: "transcribe",
	});

	assert.equal(args.includes("--language"), false);
});

test("forces utf-8 for whisper subprocess on Windows", () => {
	const env = buildWhisperEnv({ PATH: "x" });
	assert.equal(env.PYTHONUTF8, "1");
	assert.equal(env.PYTHONIOENCODING, "utf-8");
	assert.equal(env.PATH, "x");
});

test("parses both new and legacy input names", () => {
	assert.deepEqual(parseCliArgs([
		"--file-path", "video.mp4",
		"--output-dir", "out",
		"--language", "ru",
		"--model", "small",
	]), {
		filePath: "video.mp4",
		outputDir: "out",
		language: "ru",
		model: "small",
	});

	assert.deepEqual(parseCliArgs(["--file_path", "audio.wav"]), {
		filePath: "audio.wav",
	});
});

test("derives whisper output base name from audio path", () => {
	assert.equal(transcriptBaseName("E:\\tmp\\extracted_audio.wav"), "extracted_audio");
	assert.equal(transcriptBaseName("E:\\tmp\\voice.mp3"), "voice");
});

test("requires an explicit task output directory", () => {
	assert.throws(
		() => resolveInput(["--file-path", process.execPath], {}),
		/TASK_OUTPUT_DIR or --output-dir is required/,
	);

	const input = resolveInput(["--file-path", process.execPath], { TASK_OUTPUT_DIR: "out" });
	assert.equal(input.outputDir.endsWith("out"), true);
});

test("accepts quoted file path strings", () => {
	const input = resolveInput(["--file-path", `"${process.execPath}"`], { TASK_OUTPUT_DIR: "out" });
	assert.equal(input.filePath, path.resolve(process.execPath));
});

test("copyIfExists accepts already-normalized transcript output names", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "whisper-task-"));
	const transcriptPath = path.join(dir, "transcript.txt");
	await writeFile(transcriptPath, "ok", "utf8");

	assert.equal(await copyIfExists(transcriptPath, transcriptPath), transcriptPath);
	assert.equal(await readFile(transcriptPath, "utf8"), "ok");
});
