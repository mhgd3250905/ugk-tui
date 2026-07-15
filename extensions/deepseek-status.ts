import { uiText } from "./shared/ui-language.ts";
import { getDeepSeekAuthState as readDeepSeekAuthState } from "../bin/ugk-auth-status.js";

export interface DeepSeekStatusDeps {
	env?: Record<string, string | undefined>;
	authPath?: string;
	readFile?: (filePath: string) => string;
}

export interface DeepSeekAuthState {
	configured: boolean;
	provider: "deepseek";
	source: "env" | "auth_json" | null;
}

export function getDeepSeekAuthState(deps: DeepSeekStatusDeps = {}): DeepSeekAuthState {
	return readDeepSeekAuthState(deps) as DeepSeekAuthState;
}

export function getDeepSeekStatus(deps: DeepSeekStatusDeps = {}): string {
	const status = getDeepSeekAuthState(deps);
	if (status.source === "env") {
		return uiText("deepseek: 已配置(DEEPSEEK_API_KEY, deepseek-chat/默认模型可用)", "deepseek: configured(DEEPSEEK_API_KEY, deepseek-chat/default model available)");
	}
	if (status.source === "auth_json") {
		return uiText("deepseek: 已配置(pi login/auth.json, deepseek-chat/默认模型可用)", "deepseek: configured(pi login/auth.json, deepseek-chat/default model available)");
	}
	return uiText("deepseek: 未配置(设 DEEPSEEK_API_KEY 或运行 /login 启用)", "deepseek: not configured(set DEEPSEEK_API_KEY or run /login)");
}
