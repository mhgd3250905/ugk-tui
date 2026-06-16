import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export interface DeepSeekStatusDeps {
	env?: Record<string, string | undefined>;
	authPath?: string;
	readFile?: (filePath: string) => string;
}

function getAuthPath(env: Record<string, string | undefined>, authPath?: string): string {
	if (authPath) return authPath;
	const configDir = env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	return path.join(configDir, "auth.json");
}

function hasDeepSeekAuth(rawAuth: string): boolean {
	try {
		const auth = JSON.parse(rawAuth);
		return Boolean(auth?.deepseek);
	} catch {
		return false;
	}
}

export function getDeepSeekStatus(deps: DeepSeekStatusDeps = {}): string {
	const env = deps.env ?? process.env;
	if (env.DEEPSEEK_API_KEY) {
		return "deepseek: 已配置(DEEPSEEK_API_KEY, deepseek-chat/默认模型可用)";
	}

	const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
	try {
		if (hasDeepSeekAuth(readFile(getAuthPath(env, deps.authPath)))) {
			return "deepseek: 已配置(pi login/auth.json, deepseek-chat/默认模型可用)";
		}
	} catch {
		// Missing or unreadable auth.json means DeepSeek is not configured through pi login.
	}

	return "deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)";
}
