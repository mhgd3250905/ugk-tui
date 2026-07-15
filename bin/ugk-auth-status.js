import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "./paths.js";

export function resolveAuthPath(deps = {}) {
	return deps.authPath ?? path.join(resolveAgentDir(deps.env ?? process.env), "auth.json");
}

export function getDeepSeekAuthState(deps = {}) {
	const env = deps.env ?? process.env;
	if (env.DEEPSEEK_API_KEY) return { configured: true, provider: "deepseek", source: "env" };
	const readFile = deps.readFile ?? ((filePath) => fs.readFileSync(filePath, "utf8"));
	try {
		const auth = JSON.parse(readFile(resolveAuthPath({ ...deps, env })).replace(/^\uFEFF/, ""));
		if (auth?.deepseek) return { configured: true, provider: "deepseek", source: "auth_json" };
	} catch {
		// Missing or invalid auth means unconfigured.
	}
	return { configured: false, provider: "deepseek", source: null };
}
