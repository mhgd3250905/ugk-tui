import test from "node:test";
import assert from "node:assert/strict";
import {
	clearUiLanguage,
	getUiLanguage,
	setUiLanguage,
	uiText,
} from "../extensions/shared/ui-language.ts";
import { resolveSettingsPath } from "../extensions/shared/settings-io.ts";

function memDeps(initial: Record<string, unknown> = {}) {
	const settingsPath = resolveSettingsPath({ agentDir: "/fake/agent" });
	const files = new Map<string, string>([[settingsPath, JSON.stringify(initial)]]);
	return {
		agentDir: "/fake/agent",
		exists: (p: string) => files.has(p),
		readFile: (p: string) => files.get(p) ?? "",
		writeFile: (p: string, c: string) => void files.set(p, c),
		mkdir: () => {},
		readBack: () => JSON.parse(files.get(settingsPath) ?? "{}"),
	};
}

test("getUiLanguage defaults to Simplified Chinese", () => {
	assert.equal(getUiLanguage(memDeps()), "zh-CN");
});

test("setUiLanguage persists supported aliases without touching agent language", () => {
	const deps = memDeps({ language: "English", shellPath: "bash" });

	assert.equal(setUiLanguage("English", deps), "en-US");
	assert.equal(getUiLanguage(deps), "en-US");
	assert.equal(deps.readBack().uiLanguage, "en-US");
	assert.equal(deps.readBack().language, "English");
	assert.equal(deps.readBack().shellPath, "bash");
});

test("clearUiLanguage removes only the UI language key", () => {
	const deps = memDeps({ uiLanguage: "en-US", language: "日本語" });

	clearUiLanguage(deps);

	assert.equal(getUiLanguage(deps), "zh-CN");
	assert.equal("uiLanguage" in deps.readBack(), false);
	assert.equal(deps.readBack().language, "日本語");
});

test("uiText selects text by UI language", () => {
	assert.equal(uiText("中文", "English", "zh-CN"), "中文");
	assert.equal(uiText("中文", "English", "en-US"), "English");
});
