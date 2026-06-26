import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildUgkFooterLines,
	buildUgkHeaderLines,
	buildUgkLogoLines,
	buildUgkStartupScreenLines,
	classifyUgkStatusTone,
	resolveUgkDisplayModelId,
	UGK_BRAND_COLORS,
} from "../extensions/ui-brand-utils.ts";

test("buildUgkHeaderLines brands startup without pi copy", () => {
	const lines = buildUgkHeaderLines({
		version: "1.0.0",
		cwdName: "ugk-tui",
		modelId: "deepseek-v4-pro",
		width: 96,
	});

	const text = lines.join("\n");
	assert.match(text, /█/);
	assert.match(text, /┌─ ugk v1\.0\.0/);
	assert.match(text, /Welcome back/);
	assert.match(text, /◆ Tips for getting started/);
	assert.match(text, /◆ What's new/);
	assert.match(text, /workspace\s+ugk-tui/);
	assert.match(text, /model\s+deepseek-v4-pro/);
	assert.match(text, /› \/plan\s+draft before changing files/);
	assert.doesNotMatch(text, /├─ quick actions/);
	assert.doesNotMatch(text, /\n  deepseek-v4-pro/);
	assert.match(text, /ugk v1\.0\.0/);
	assert.match(text, /deepseek-v4-pro/);
	assert.match(text, /\/plan/);
	assert.doesNotMatch(text, /\bpi v/i);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 96, `line exceeded width: ${line}`);
	}

	const panelLines = lines.filter((line) => /^[┌│├└]/.test(line));
	const panelWidths = new Set(panelLines.map((line) => visibleWidth(line)));
	assert.deepEqual([...panelWidths], [96]);
});

test("buildUgkHeaderLines keeps panel borders aligned for wide workspace names", () => {
	const lines = buildUgkHeaderLines({
		version: "1.0.0",
		cwdName: "TUI专区",
		modelId: "deepseek-v4-pro",
		width: 96,
	});

	const panelLines = lines.filter((line) => /^[┌│├└]/.test(line));
	for (const line of panelLines) {
		assert.equal(visibleWidth(line), 96, line);
	}
	assert.match(panelLines.join("\n"), /workspace\s+TUI专区/);
});

test("buildUgkHeaderLines does not leak ANSI resets when truncating cells", () => {
	const text = buildUgkHeaderLines({
		version: "1.0.0",
		cwdName: "codex-code-audit-main-20260626",
		modelId: "deepseek-v4-pro",
		width: 80,
	}).join("\n");

	assert.doesNotMatch(text, /\x1b\[/);
});

test("buildUgkLogoLines renders a compact block-character logo", () => {
	const lines = buildUgkLogoLines(96);

	assert.deepEqual(lines, [
		"██  ██  █████  ██  ██",
		"██  ██ ██      ██ ██ ",
		"██  ██ ██  ███ ████  ",
		"██  ██ ██   ██ ██ ██ ",
		" ████   █████  ██  ██",
	]);
	assert.doesNotMatch(lines.join("\n"), /[▀▄]/);
	for (const line of lines) {
		assert.match(line, /█/);
		assert.ok(visibleWidth(line) <= 22, `logo line is too wide: ${line}`);
	}
});

test("buildUgkStartupScreenLines fills the terminal viewport with character effects", () => {
	const lines = buildUgkStartupScreenLines({
		version: "1.0.0",
		cwdName: "ugk-tui",
		modelId: "deepseek-v4-pro",
		width: 80,
		rows: 24,
	});

	assert.equal(lines.length, 19);
	assert.match(lines.join("\n"), /Welcome back/);
	assert.match(lines.join("\n"), /◆ Tips for getting started/);
	assert.match(lines.join("\n"), /◆ What's new/);
	assert.match(lines.join("\n"), /█/);
	assert.match(lines.join("\n"), /\/plan/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 80, `line exceeded width: ${line}`);
	}
});

test("buildUgkStartupScreenLines falls back to compact header in cramped terminals", () => {
	const lines = buildUgkStartupScreenLines({
		version: "1.0.0",
		cwdName: "ugk-tui",
		modelId: "deepseek-v4-pro",
		width: 42,
		rows: 12,
	});

	assert.deepEqual(
		lines,
		buildUgkHeaderLines({
			version: "1.0.0",
			cwdName: "ugk-tui",
			modelId: "deepseek-v4-pro",
			width: 42,
		}),
	);
});

test("buildUgkFooterLines keeps useful session status and truncates to width", () => {
	const lines = buildUgkFooterLines({
		cwd: "/Users/shengkai/projects/ugk-tui",
		branch: "feature/ui-optimization",
		modelId: "deepseek-v4-pro",
		thinkingLevel: "high",
		statuses: ["✓ 第 3 轮完成", "plan 2/5"],
		usage: {
			input: 127000,
			output: 24100,
			cacheRead: 9000,
			cacheWrite: 0,
			cost: 0,
			contextPercent: 9.8,
			contextWindow: 1000000,
		},
		width: 96,
	});

	assert.equal(lines.length, 3);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 96, `line exceeded width: ${line}`);
	}
	assert.match(lines[0], /ugk/);
	assert.match(lines[0], /feature\/ui-optimization/);
	assert.match(lines[1], /↑127k/);
	assert.match(lines[1], /↓24k/);
	assert.match(lines[1], /💰 \$0\.000/);
	assert.match(lines[1], /🧠 █▒▒▒▒▒▒▒ 9\.8%\/1\.0M/);
	assert.match(lines[1], /🤖 deepseek-v4-pro/);
	assert.match(lines[1], /deepseek-v4-pro/);
	assert.match(lines[1], /high/);
	assert.match(lines[2], /第 3 轮完成/);
});

test("buildUgkFooterLines renders an empty context progress bar", () => {
	const lines = buildUgkFooterLines({
		cwd: "/Users/shengkai/projects/ugk-tui",
		branch: null,
		modelId: "mimo-v2.5-pro",
		statuses: ["就绪"],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextPercent: 0,
			contextWindow: 1000000,
		},
		width: 96,
	});

	assert.match(lines[1], /🧠 ▒▒▒▒▒▒▒▒ 0\.0%\/1\.0M/);
});

test("resolveUgkDisplayModelId hides DeepSeek model when API credentials are missing", () => {
	assert.equal(resolveUgkDisplayModelId("deepseek-v4-pro", "deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)"), "❌ API not configured");
	assert.equal(resolveUgkDisplayModelId("deepseek-v4-pro", "deepseek: 已配置(DEEPSEEK_API_KEY, deepseek-chat/默认模型可用)"), "deepseek-v4-pro");
	assert.equal(resolveUgkDisplayModelId("gpt-4o", "deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)"), "gpt-4o");
	assert.equal(resolveUgkDisplayModelId(undefined, "deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)"), undefined);
});

test("classifyUgkStatusTone maps stateful text to semantic color tones", () => {
	assert.equal(classifyUgkStatusTone("api not configured"), "error");
	assert.equal(classifyUgkStatusTone("❌ API not configured"), "error");
	assert.equal(classifyUgkStatusTone("bash unavailable"), "error");
	assert.equal(classifyUgkStatusTone("subagent not loaded"), "error");
	assert.equal(classifyUgkStatusTone("Chrome CDP not reachable"), "warning");
	assert.equal(classifyUgkStatusTone("DeepSeek configured"), "success");
	assert.equal(classifyUgkStatusTone("✓ 第 1 轮完成"), "success");
	assert.equal(classifyUgkStatusTone("plan 2/5"), "dim");
});

test("UGK brand palette prefers subdued neon green over blue purple", () => {
	assert.equal(UGK_BRAND_COLORS.accent, "#9be564");
	assert.equal(UGK_BRAND_COLORS.cyan, "#79e6d9");
	assert.notEqual(UGK_BRAND_COLORS.accent, "#6f5cff");
});
