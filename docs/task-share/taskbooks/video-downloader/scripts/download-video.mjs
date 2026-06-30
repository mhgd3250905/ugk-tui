import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeVideoUrl(rawUrl) {
	let url;
	try {
		url = new URL(String(rawUrl || "").trim());
	} catch {
		throw new Error("input.url must be a valid video URL");
	}
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("input.url must be an http or https video URL");
	}
	return url.href;
}

export function buildFormatSelector(maxHeight) {
	const height = Number(maxHeight);
	if (!Number.isFinite(height) || height <= 0) return "bv*+ba/b";
	return `bv*[height<=${Math.floor(height)}]+ba/b[height<=${Math.floor(height)}]/bv*+ba/b`;
}

function normalizeCookiesFromBrowser(value = "none") {
	const browser = String(value || "none").toLowerCase();
	if (browser === "none" || browser === "chrome") return browser;
	throw new Error("cookiesFromBrowser must be none or chrome");
}

function browserCookieArgs(input = {}) {
	const browser = normalizeCookiesFromBrowser(input.cookiesFromBrowser);
	return browser === "chrome" ? ["--cookies-from-browser", "chrome"] : [];
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

export function buildMetadataArgs(url, input = {}) {
	return [
		...browserCookieArgs(input),
		"--skip-download",
		"--dump-json",
		"--no-playlist",
		url,
	];
}

export function buildDownloadArgs(input) {
	return [
		...browserCookieArgs(input),
		"--newline",
		"--concurrent-fragments", "8",
		"--no-playlist",
		"--paths", input.outputDir,
		"--output", "%(extractor_key)s-%(id)s.%(ext)s",
		"--merge-output-format", "mp4",
		"--format", buildFormatSelector(input.maxHeight),
		"--write-subs",
		"--write-auto-subs",
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
		...(values.url ? { url: normalizeVideoUrl(values.url) } : {}),
		...(values.outputDir ? { outputDir: values.outputDir } : {}),
		...(values.maxHeight ? { maxHeight: Number(values.maxHeight) } : {}),
		...(values.subLangs ? { subLangs: values.subLangs } : {}),
		...(values.cookiesFromBrowser ? { cookiesFromBrowser: normalizeCookiesFromBrowser(values.cookiesFromBrowser) } : {}),
	};
}

function parseInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const input = JSON.parse(env.TASK_INPUT || "{}");
	const outputDir = cli.outputDir || env.TASK_OUTPUT_DIR;
	if (!outputDir) throw new Error("TASK_OUTPUT_DIR is required");
	return {
		url: cli.url || normalizeVideoUrl(input.url),
		maxHeight: cli.maxHeight ?? input.maxHeight,
		subLangs: String(cli.subLangs || input.subLangs || "all"),
		cookiesFromBrowser: normalizeCookiesFromBrowser(cli.cookiesFromBrowser || input.cookiesFromBrowser || "none"),
		outputDir,
	};
}

async function main() {
	const input = parseInput();
	await mkdir(input.outputDir, { recursive: true });
	await requireCommand("yt-dlp", ["--version"]);
	await requireCommand("ffmpeg", ["-version"]);
	await requireCommand("ffprobe", ["-version"]);

	const metadataResult = await run("yt-dlp", buildMetadataArgs(input.url, input), { streamStderr: true });
	const metadata = JSON.parse(metadataResult.stdout);
	await writeFile(path.join(input.outputDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

	const format = buildFormatSelector(input.maxHeight);
	await run("yt-dlp", buildDownloadArgs(input), { streamStdout: true, streamStderr: true });

	const videoFiles = await findVideoFiles(input.outputDir);
	const subtitleFiles = await findSubtitleFiles(input.outputDir);
	if (videoFiles.length === 0) throw new Error("yt-dlp finished but no mp4 file was found");
	const subtitleLanguages = [...new Set([
		...Object.keys(metadata.subtitles || {}),
		...Object.keys(metadata.automatic_captions || {}),
	])];

	const summary = {
		url: input.url,
		extractor: metadata.extractor_key,
		id: metadata.id,
		displayId: metadata.display_id,
		title: metadata.title,
		duration: metadata.duration,
		format,
		subLangs: input.subLangs,
		cookiesFromBrowser: input.cookiesFromBrowser,
		subtitleLanguages,
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
