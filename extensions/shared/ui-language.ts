import fs from "node:fs";
import path from "node:path";
import { readSettingsJson, resolveSettingsPath, updateSettingsJson, type SettingsIoDeps } from "./settings-io.ts";

export type UiLanguage = "zh-CN" | "en-US";

const UI_LANGUAGE_KEY = "uiLanguage";

function withDefaultExists(deps: SettingsIoDeps): SettingsIoDeps {
	return deps.exists ? deps : { ...deps, exists: fs.existsSync };
}

export function normalizeUiLanguage(value: string | undefined): UiLanguage | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (["zh", "zh-cn", "cn", "chinese", "中文", "简体中文"].includes(normalized)) return "zh-CN";
	if (["en", "en-us", "english", "英文"].includes(normalized)) return "en-US";
	return undefined;
}

export function getUiLanguage(deps: SettingsIoDeps = {}): UiLanguage {
	const settings = readSettingsJson(withDefaultExists(deps));
	const value = settings?.[UI_LANGUAGE_KEY];
	return normalizeUiLanguage(typeof value === "string" ? value : undefined) ?? "zh-CN";
}

export function setUiLanguage(language: string, deps: SettingsIoDeps = {}): UiLanguage | undefined {
	const normalized = normalizeUiLanguage(language);
	if (!normalized) return undefined;
	updateSettingsJson({ [UI_LANGUAGE_KEY]: normalized }, withDefaultExists(deps));
	return normalized;
}

export function clearUiLanguage(deps: SettingsIoDeps = {}): void {
	const settings = readSettingsJson(withDefaultExists(deps));
	if (!settings || !(UI_LANGUAGE_KEY in settings)) return;
	delete settings[UI_LANGUAGE_KEY];
	const settingsPath = resolveSettingsPath(deps);
	const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c));
	const mkdir = deps.mkdir ?? ((p: string, o: { recursive: true }) => fs.mkdirSync(p, o));
	mkdir(path.dirname(settingsPath), { recursive: true });
	writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function formatUiLanguage(language: UiLanguage): string {
	return language === "en-US" ? "English" : "简体中文";
}

export function uiText<T>(zhCN: T, enUS: T, language: UiLanguage = getUiLanguage()): T {
	return language === "en-US" ? enUS : zhCN;
}
