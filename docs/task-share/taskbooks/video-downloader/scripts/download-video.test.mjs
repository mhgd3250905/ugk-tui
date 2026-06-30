import { strict as assert } from "node:assert";
import test from "node:test";

import {
	buildDownloadArgs,
	buildFormatSelector,
	buildMetadataArgs,
	normalizeVideoUrl,
	parseCliArgs,
} from "./download-video.mjs";

test("normalizes generic http and https video urls", () => {
	assert.equal(
		normalizeVideoUrl(" https://www.youtube.com/watch?v=abc123&list=skip "),
		"https://www.youtube.com/watch?v=abc123&list=skip",
	);
	assert.equal(
		normalizeVideoUrl("http://example.com/video"),
		"http://example.com/video",
	);
});

test("rejects non-http urls", () => {
	assert.throws(() => normalizeVideoUrl("file:///C:/video.mp4"), /http or https/);
	assert.throws(() => normalizeVideoUrl("not a url"), /valid video URL/);
});

test("builds max height format selector", () => {
	assert.equal(buildFormatSelector(480), "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b");
	assert.equal(buildFormatSelector("bad"), "bv*+ba/b");
});

test("builds metadata args without playlist by default", () => {
	assert.deepEqual(buildMetadataArgs("https://example.com/v"), [
		"--skip-download",
		"--dump-json",
		"--no-playlist",
		"https://example.com/v",
	]);
});

test("adds browser cookies to metadata and download args when requested", () => {
	assert.deepEqual(buildMetadataArgs("https://example.com/v", { cookiesFromBrowser: "chrome" }), [
		"--cookies-from-browser",
		"chrome",
		"--skip-download",
		"--dump-json",
		"--no-playlist",
		"https://example.com/v",
	]);

	const args = buildDownloadArgs({
		url: "https://example.com/v",
		outputDir: "out",
		maxHeight: 1080,
		subLangs: "all",
		cookiesFromBrowser: "chrome",
	});

	assert.equal(args[0], "--cookies-from-browser");
	assert.equal(args[1], "chrome");
});

test("rejects unsupported browser cookie sources", () => {
	assert.throws(() => parseCliArgs(["--cookies-from-browser", "firefox"]), /cookiesFromBrowser must be none or chrome/);
});

test("builds yt-dlp download args with progress subtitles and mp4 merge", () => {
	const args = buildDownloadArgs({
		url: "https://example.com/v",
		outputDir: "out",
		maxHeight: 720,
		subLangs: "all",
	});

	assert.ok(args.includes("--newline"));
	assert.ok(args.includes("--paths"));
	assert.ok(args.includes("out"));
	assert.ok(args.includes("--merge-output-format"));
	assert.ok(args.includes("mp4"));
	assert.ok(args.includes("--write-subs"));
	assert.ok(args.includes("--write-auto-subs"));
	assert.ok(args.includes("--sub-langs"));
	assert.ok(args.includes("all"));
	assert.ok(args.includes("https://example.com/v"));
});

test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([
		"--url", "https://x.com/u/status/1?s=20",
		"--output-dir", "out",
		"--max-height", "1080",
		"--sub-langs", "en,zh",
		"--cookies-from-browser", "chrome",
	]), {
		url: "https://x.com/u/status/1?s=20",
		outputDir: "out",
		maxHeight: 1080,
		subLangs: "en,zh",
		cookiesFromBrowser: "chrome",
	});
});
