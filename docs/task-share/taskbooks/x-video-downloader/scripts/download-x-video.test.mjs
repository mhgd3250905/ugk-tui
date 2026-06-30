import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildFormatSelector,
	buildDownloadArgs,
	findSubtitleFiles,
	normalizeTweetUrl,
	parseCliArgs,
} from "./download-x-video.mjs";

test("normalizes x/twitter status URLs and strips query string", () => {
	assert.equal(
		normalizeTweetUrl("https://x.com/huoshan007/status/2071161404997132519?s=20"),
		"https://x.com/huoshan007/status/2071161404997132519",
	);
	assert.equal(
		normalizeTweetUrl("https://twitter.com/u/status/123"),
		"https://twitter.com/u/status/123",
	);
});

test("rejects non-status URLs", () => {
	assert.throws(() => normalizeTweetUrl("https://example.com/nope"), /X\/Twitter status URL/);
});

test("builds a bounded best-video format selector", () => {
	assert.equal(
		buildFormatSelector(720),
		"bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
	);
	assert.equal(buildFormatSelector(undefined), "bv*+ba/b");
});

test("finds subtitle files next to the downloaded video", async () => {
	const dir = await mkdtemp(join(tmpdir(), "x-video-test-"));
	try {
		await writeFile(join(dir, "tweet.zh.vtt"), "WEBVTT\n", "utf8");
		await writeFile(join(dir, "tweet.mp4"), "", "utf8");
		assert.deepEqual(await findSubtitleFiles(dir), ["tweet.zh.vtt"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("parses cli flags used by the task worker", () => {
	assert.deepEqual(
		parseCliArgs([
			"--url", "https://x.com/u/status/123?s=20",
			"--output-dir", "out",
			"--max-height", "720",
			"--sub-langs", "zh,en",
		]),
		{
			url: "https://x.com/u/status/123",
			outputDir: "out",
			maxHeight: 720,
			subLangs: "zh,en",
		},
	);
});

test("download args use newline progress so long downloads do not look stuck", () => {
	const args = buildDownloadArgs({
		url: "https://x.com/u/status/123",
		outputDir: "out",
		maxHeight: 270,
		subLangs: "zh",
	});
	assert.ok(args.includes("--newline"));
	assert.deepEqual(args.slice(args.indexOf("--concurrent-fragments"), args.indexOf("--concurrent-fragments") + 2), ["--concurrent-fragments", "8"]);
	assert.ok(args.includes("--write-subs"));
	assert.ok(args.includes("bv*[height<=270]+ba/b[height<=270]/bv*+ba/b"));
});
