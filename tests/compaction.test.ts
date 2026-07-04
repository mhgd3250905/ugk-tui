import test from "node:test";
import assert from "node:assert/strict";
import { getThreshold, getThresholdTokens } from "../extensions/compaction/thresholds.ts";
import registerCompaction from "../extensions/compaction/index.ts";
import { clearCompactionModel, getCurrentCompactionModel, setCompactionModel } from "../extensions/compaction/model-picker.ts";

test("small context windows use 75%", () => {
	assert.equal(getThreshold(200_000).ratio, 0.75);
	assert.equal(getThreshold(128_000).tier, "small");
	assert.equal(getThresholdTokens(200_000), 150_000);
});

test("medium context windows use 70%", () => {
	assert.equal(getThreshold(256_000).ratio, 0.7);
	assert.equal(getThreshold(500_000).tier, "medium");
});

test("large context windows use 60%", () => {
	assert.equal(getThreshold(500_001).ratio, 0.6);
	assert.equal(getThreshold(1_000_000).tier, "large");
	assert.equal(getThresholdTokens(1_000_000), 600_000);
});

test("invalid context windows fall back to medium", () => {
	assert.equal(getThreshold(undefined).ratio, 0.7);
	assert.equal(getThreshold(0).tier, "medium");
	assert.equal(getThreshold(-1).tier, "medium");
	assert.equal(getThresholdTokens(undefined), 0);
});

function settingsStore(initial: Record<string, unknown> | undefined = undefined) {
	let exists = initial !== undefined;
	let content = initial === undefined ? "" : `${JSON.stringify(initial, null, 2)}\n`;
	const deps = {
		agentDir: "test-agent-dir",
		exists: () => exists,
		readFile: () => {
			if (!exists) throw new Error("missing settings");
			return content;
		},
		writeFile: (_path: string, next: string) => {
			exists = true;
			content = next;
		},
		mkdir: () => {},
	};
	return {
		deps,
		json: () => (content ? JSON.parse(content) : {}),
		setRaw: (raw: string) => {
			exists = true;
			content = raw;
		},
	};
}

test("compaction model setting persists and clears only its own key", () => {
	const store = settingsStore({ uiLanguage: "en-US" });

	setCompactionModel({ provider: "deepseek", id: "deepseek-chat" }, store.deps);
	assert.deepEqual(getCurrentCompactionModel(store.deps), { provider: "deepseek", id: "deepseek-chat" });
	assert.equal(store.json().uiLanguage, "en-US");

	clearCompactionModel(store.deps);
	assert.equal(getCurrentCompactionModel(store.deps), undefined);
	assert.equal(store.json().uiLanguage, "en-US");
	assert.equal("compactionModel" in store.json(), false);
});

test("compaction model setting can create a missing settings file", () => {
	const store = settingsStore();

	setCompactionModel({ provider: "mimo", id: "mimo-v2.5-pro" }, store.deps);

	assert.deepEqual(getCurrentCompactionModel(store.deps), { provider: "mimo", id: "mimo-v2.5-pro" });
});

test("compaction model setting reads BOM-safe settings", () => {
	const store = settingsStore();
	store.setRaw('\uFEFF{"compactionModel":{"provider":"deepseek","id":"deepseek-chat"}}\n');

	assert.deepEqual(getCurrentCompactionModel(store.deps), { provider: "deepseek", id: "deepseek-chat" });
});

test("compaction extension registers commands and hooks", () => {
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerCommand: (name: string) => commands.push(name),
		on: (event: string) => events.push(event),
	};

	registerCompaction(pi as never);

	assert.deepEqual(commands.sort(), ["compaction-model", "trigger-compact"]);
	assert.deepEqual(events.sort(), ["session_before_compact", "turn_end"]);
});
