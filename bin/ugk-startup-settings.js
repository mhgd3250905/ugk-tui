import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

function expandHome(input) {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

export function getUgkAgentDir(env = process.env) {
	return expandHome(env.PI_CODING_AGENT_DIR || DEFAULT_AGENT_DIR);
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

	if (Object.prototype.hasOwnProperty.call(settings, "quietStartup")) return;

	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(settingsPath, `${JSON.stringify({ ...settings, quietStartup: true }, null, 2)}\n`);
}
