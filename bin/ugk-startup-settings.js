import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "./paths.js";

const DEFAULT_SKILLS = ["!skills/**"];
const DEFAULT_THEME = "ugk-geek";

export function getUgkAgentDir(env = process.env) {
	return resolveAgentDir(env);
}

export function ensureUgkQuietStartupDefault(agentDir = getUgkAgentDir()) {
	const settingsPath = path.join(agentDir, "settings.json");
	let settings = {};

	try {
		if (fs.existsSync(settingsPath)) {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		}
	} catch {
		return;
	}

	const nextSettings = { ...settings };
	let changed = false;

	if (!Object.prototype.hasOwnProperty.call(nextSettings, "quietStartup")) {
		nextSettings.quietStartup = true;
		changed = true;
	}

	if (!Object.prototype.hasOwnProperty.call(nextSettings, "theme")) {
		nextSettings.theme = DEFAULT_THEME;
		changed = true;
	}

	if (!Object.prototype.hasOwnProperty.call(nextSettings, "skills")) {
		nextSettings.skills = DEFAULT_SKILLS;
		changed = true;
	}

	if (!Object.prototype.hasOwnProperty.call(nextSettings, "clearStartupScreen")) {
		nextSettings.clearStartupScreen = true;
		changed = true;
	}

	if (!changed) return;

	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
}
