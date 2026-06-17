import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildUgkCliArgs } from "../bin/ugk-cli-args.js";

test("buildUgkCliArgs preloads the UGK theme before loading extensions", () => {
	const packageRoot = path.resolve("D:\\AII\\ugk-tui");
	const args = buildUgkCliArgs(["--model", "deepseek-v4-pro"], packageRoot);

	assert.deepEqual(args, [
		"--model",
		"deepseek-v4-pro",
		"--theme",
		path.join(packageRoot, "themes", "ugk-geek.json"),
		"-e",
		path.join(packageRoot, "extensions", "index.ts"),
	]);
});

test("buildUgkCliArgs preserves an explicit user theme", () => {
	const packageRoot = path.resolve("D:\\AII\\ugk-tui");
	const customTheme = path.join(packageRoot, "themes", "custom.json");
	const args = buildUgkCliArgs(["--theme", customTheme], packageRoot);

	assert.deepEqual(args, [
		"--theme",
		customTheme,
		"-e",
		path.join(packageRoot, "extensions", "index.ts"),
	]);
});
