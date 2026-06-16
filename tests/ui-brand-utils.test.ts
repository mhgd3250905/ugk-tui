import test from "node:test";
import assert from "node:assert/strict";
import { buildUgkFooterLines, buildUgkHeaderLines, UGK_BRAND_COLORS } from "../extensions/ui-brand-utils.ts";

test("buildUgkHeaderLines brands startup without pi copy", () => {
	const lines = buildUgkHeaderLines({
		version: "1.0.0",
		cwdName: "ugk-tui",
		modelId: "deepseek-v4-pro",
		width: 96,
	});

	const text = lines.join("\n");
	assert.match(text, /ugk v1\.0\.0/);
	assert.match(text, /terminal coding agent/i);
	assert.match(text, /deepseek-v4-pro/);
	assert.match(text, /\/plan/);
	assert.doesNotMatch(text, /\bpi v/i);
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
		width: 72,
	});

	assert.equal(lines.length, 3);
	for (const line of lines) {
		assert.ok(line.length <= 72, `line exceeded width: ${line}`);
	}
	assert.match(lines[0], /ugk/);
	assert.match(lines[0], /feature\/ui-optimization/);
	assert.match(lines[1], /deepseek-v4-pro/);
	assert.match(lines[1], /high/);
	assert.match(lines[2], /第 3 轮完成/);
});

test("UGK brand palette prefers subdued neon green over blue purple", () => {
	assert.equal(UGK_BRAND_COLORS.accent, "#9be564");
	assert.equal(UGK_BRAND_COLORS.cyan, "#79e6d9");
	assert.notEqual(UGK_BRAND_COLORS.accent, "#6f5cff");
});
