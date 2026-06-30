import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeTweetUrl(rawUrl) {
	const url = new URL(String(rawUrl || "").trim());
	const host = url.hostname.toLowerCase();
	if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
		throw new Error("input.url must be an X/Twitter status URL");
	}
	const match = url.pathname.match(/^\/[^/]+\/status\/\d+/);
	if (!match) throw new Error("input.url must be an X/Twitter status URL");
	return `${url.protocol}//${host}${match[0]}`;
}

export function buildFormatSelector(maxHeight) {
	const height = Number(maxHeight);
	if (!Number.isFinite(height) || height <= 0) return "bv*+ba/b";
	return `bv*[height<=${Math.floor(height)}]+ba/b[height<=${Math.floor(height)}]/bv*+ba/b`;
}

export async function findSubtitleFiles(outputDir) {
	const entries = await readdir(outputDir).catch(() => []);
	return entries.filter((name) => /\.(vtt|srt|ass)$/i.test(name)).sort();
}

async function findVideoFiles(outputDir) {
	const entries = await readdir(outputDir).catch(() => []);
	return entries.filter((name) => /\.mp4$/i.test(name)).sort();
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, { windowsHide: true });
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

export function buildMetadataArgs(url) {
	return [
		"--skip-download",
		"--dump-json",
		"--no-playlist",
		url,
	];
}

export function buildDownloadArgs(input) {
	return [
		"--newline",
		"--concurrent-fragments", "8",
		"--no-playlist",
		"--paths", input.outputDir,
		"--output", "%(id)s.%(ext)s",
		"--merge-output-format", "mp4",
		"--format", buildFormatSelector(input.maxHeight),
		"--write-subs",
		"--sub-langs", input.subLangs,
		"--sub-format", "vtt",
		input.url,
	];
}

export function parseCliArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
		values[key] = argv[index + 1];
		index += 1;
	}
	return {
		...(values.url ? { url: normalizeTweetUrl(values.url) } : {}),
		...(values.outputDir ? { outputDir: values.outputDir } : {}),
		...(values.maxHeight ? { maxHeight: Number(values.maxHeight) } : {}),
		...(values.subLangs ? { subLangs: values.subLangs } : {}),
	};
}

function parseInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const input = JSON.parse(env.TASK_INPUT || "{}");
	const outputDir = cli.outputDir || env.TASK_OUTPUT_DIR;
	if (!outputDir) throw new Error("TASK_OUTPUT_DIR is required");
	return {
		url: cli.url || normalizeTweetUrl(input.url),
		maxHeight: cli.maxHeight ?? input.maxHeight,
		subLangs: String(cli.subLangs || input.subLangs || "all"),
		outputDir,
	};
}

async function main() {
	const input = parseInput();
	await mkdir(input.outputDir, { recursive: true });
	await requireCommand("yt-dlp", ["--version"]);
	await requireCommand("ffmpeg", ["-version"]);
	await requireCommand("ffprobe", ["-version"]);

	const metadataResult = await run("yt-dlp", buildMetadataArgs(input.url), { streamStderr: true });
	const metadata = JSON.parse(metadataResult.stdout);
	await writeFile(path.join(input.outputDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

	const format = buildFormatSelector(input.maxHeight);
	await run("yt-dlp", buildDownloadArgs(input), { streamStdout: true, streamStderr: true });

	const videoFiles = await findVideoFiles(input.outputDir);
	const subtitleFiles = await findSubtitleFiles(input.outputDir);
	if (videoFiles.length === 0) throw new Error("yt-dlp finished but no mp4 file was found");

	const summary = {
		url: input.url,
		id: metadata.id,
		displayId: metadata.display_id,
		title: metadata.title,
		duration: metadata.duration,
		format,
		subtitleLanguages: Object.keys(metadata.subtitles || {}),
		videoFiles,
		subtitleFiles,
	};
	await writeFile(path.join(input.outputDir, "download-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
