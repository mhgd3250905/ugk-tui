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
	assert.match(text, /欢迎回来/);
	assert.match(text, /◆ 入门提示/);
	assert.match(text, /◆ 最近更新/);
	assert.match(text, /工作区\s+ugk-tui/);
	assert.match(text, /模型\s+deepseek-v4-pro/);
	assert.match(text, /› \/plan\s+修改前先拟计划/);
	assert.doesNotMatch(text, /├─ 快捷操作/);
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

test("buildUgkHeaderLines can render English UI copy", () => {
	const lines = buildUgkHeaderLines({
		version: "1.0.0",
		cwdName: "ugk-tui",
		modelId: "deepseek-v4-pro",
		width: 96,
		uiLanguage: "en-US",
	});

	const text = lines.join("\n");
	assert.match(text, /Welcome back/);
	assert.match(text, /◆ Getting Started/);
	assert.match(text, /◆ Recent Updates/);
	assert.match(text, /Workspace\s+ugk-tui/);
	assert.match(text, /Model\s+deepseek-v4-pro/);
	assert.match(text, /› \/plan\s+Plan before editing/);
	assert.doesNotMatch(text, /欢迎回来|入门提示|最近更新/);
});

test("buildUgkHeaderLines can render Japanese UI copy", () => {
	const text = buildUgkHeaderLines({
		version: "1.0.0",
		cwdName: "ugk-tui",
		modelId: "deepseek-v4-pro",
		width: 96,
		uiLanguage: "ja-JP",
	}).join("\n");

	assert.match(text, /おかえりなさい/);
	assert.match(text, /◆ はじめに/);
	assert.match(text, /ワークスペース\s+ugk-tui/);
	assert.match(text, /モデル\s+deepseek-v4-pro/);
	assert.doesNotMatch(text, /Welcome back|欢迎回来/);
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
	assert.match(panelLines.join("\n"), /工作区\s+TUI专区/);
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
		"██╗   ██╗ ██████╗ ██╗  ██╗",
		"██║   ██║██╔════╝ ██║ ██╔╝",
		"██║   ██║██║  ███╗█████╔╝ ",
		"██║   ██║██║   ██║██╔═██╗ ",
		"╚██████╔╝╚██████╔╝██║  ██╗",
		" ╚═════╝  ╚═════╝ ╚═╝  ╚═╝",
	]);
	assert.doesNotMatch(lines.join("\n"), /[▀▄]/);
	for (const line of lines) {
		assert.match(line, /[█═]/);
		assert.ok(visibleWidth(line) <= 28, `logo line is too wide: ${line}`);
	}
});

test("buildUgkStartupScreenLines reserves room for TUI chrome", () => {
	const lines = buildUgkStartupScreenLines({
		version: "1.0.0",
		cwdName: "ugk-tui",
		modelId: "deepseek-v4-pro",
		width: 80,
		rows: 24,
	});

	assert.equal(lines.length, 13);
	assert.match(lines.join("\n"), /欢迎回来/);
	assert.match(lines.join("\n"), /◆ 入门提示/);
	assert.match(lines.join("\n"), /◆ 最近更新/);
	assert.match(lines.join("\n"), /█/);
	assert.match(lines.join("\n"), /\/plan/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 80, `line exceeded width: ${line}`);
	}
});

test("buildUgkStartupScreenLines anchors content near the top in tall terminals", () => {
	const lines = buildUgkStartupScreenLines({
		version: "1.0.0",
		cwdName: "ugk-tui",
		modelId: "deepseek-v4-pro",
		width: 120,
		rows: 60,
	});

	assert.equal(lines.length, 49);
	assert.equal(lines.findIndex((line) => line.includes("ugk v1.0.0")), 0);
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

test("buildUgkFooterLines renders api model token totals in M tokens", () => {
	const lines = buildUgkFooterLines({
		cwd: "/Users/shengkai/projects/ugk-tui",
		branch: "feature/api-usage",
		modelId: "deepseek-v4-pro",
		statuses: ["就绪"],
		usage: {
			input: 127000,
			output: 24100,
			cacheRead: 9000,
			cacheWrite: 0,
			cost: 0,
			contextPercent: 9.8,
			contextWindow: 1000000,
		},
		apiUsage: [
			{ model: "deepseek-v4-pro", input: 1100000, output: 320000, cacheRead: 0, cacheWrite: 0, cost: 0.08 },
			{ model: "deepseek-v4-flash", input: 31000, output: 7000, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
		],
		width: 120,
	});

	assert.equal(lines.length, 4);
	assert.match(lines[2], /API deepseek-v4-pro Σ1\.42M ↑1\.10M ↓0\.32M/);
	assert.match(lines[2], /deepseek-v4-flash Σ0\.04M ↑0\.03M ↓0\.01M/);
	assert.doesNotMatch(lines[2], /\$/);
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
	assert.equal(resolveUgkDisplayModelId("deepseek-v4-pro", "deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)"), "❌ API 未配置");
	assert.equal(resolveUgkDisplayModelId("deepseek-v4-pro", "deepseek: 已配置(DEEPSEEK_API_KEY, deepseek-chat/默认模型可用)"), "deepseek-v4-pro");
	assert.equal(resolveUgkDisplayModelId("gpt-4o", "deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)"), "gpt-4o");
	assert.equal(resolveUgkDisplayModelId(undefined, "deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)"), undefined);
});

test("classifyUgkStatusTone maps stateful text to semantic color tones", () => {
	assert.equal(classifyUgkStatusTone("api not configured"), "error");
	assert.equal(classifyUgkStatusTone("❌ API 未配置"), "error");
	assert.equal(classifyUgkStatusTone("bash 不可用"), "error");
	assert.equal(classifyUgkStatusTone("subagent 未加载"), "error");
	assert.equal(classifyUgkStatusTone("Chrome CDP 无法连接"), "warning");
	assert.equal(classifyUgkStatusTone("DeepSeek 已配置"), "success");
	assert.equal(classifyUgkStatusTone("✓ 第 1 轮完成"), "success");
	assert.equal(classifyUgkStatusTone("plan 2/5"), "dim");
});

test("UGK brand palette prefers subdued neon green over blue purple", () => {
	assert.equal(UGK_BRAND_COLORS.accent, "#9be564");
	assert.equal(UGK_BRAND_COLORS.cyan, "#79e6d9");
	assert.notEqual(UGK_BRAND_COLORS.accent, "#6f5cff");
});
