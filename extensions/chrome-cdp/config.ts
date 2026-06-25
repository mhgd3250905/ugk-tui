import os from "node:os";
import path from "node:path";
import { readSettingsJson, updateSettingsJson } from "../shared/settings-io.ts";

export type ChromeCdpMode = "off" | "ask" | "on";
export type ChromeCdpAction = "status" | "tabs" | "launch" | "navigate" | "evaluate" | "screenshot";

export interface ChromeCdpState {
	mode: ChromeCdpMode;
	sessionAllowed: boolean;
	runtimePort?: number;
	envPort?: number;
}

export interface ChromeCdpPolicyRequest {
	action: ChromeCdpAction;
	url?: string;
	reason: string;
	normalAccessAttempted: boolean;
}

export type ChromeCdpPolicyResult =
	| { allowed: true; requiresConfirmation: boolean; reason?: undefined }
	| { allowed: false; requiresConfirmation: false; reason: string };

const DEFAULT_PORT = 9222;

export interface ChromeCdpPortDeps {
	agentDir?: string;
	exists?: (p: string) => boolean;
	readFile?: (p: string) => string;
	writeFile?: (p: string, content: string) => void;
	mkdir?: (p: string, opts: { recursive: true }) => void;
}

function parsePort(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
	}
	if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) {
		return value;
	}
	return undefined;
}

export function resolveUgkSettingsPath(deps: ChromeCdpPortDeps = {}): string {
	return path.join(deps.agentDir ?? (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")), "settings.json");
}

export function readPersistedCdpPort(deps: ChromeCdpPortDeps = {}): number | undefined {
	// BOM-safe 读取(见 shared/settings-io.ts):旧实现裸 JSON.parse 遇 BOM 会失败,
	// 导致持久化端口读不到、回退默认 9222。
	const settings = readSettingsJson(deps);
	return parsePort(settings?.cdpPort);
}

export function persistCdpPort(port: number, deps: ChromeCdpPortDeps = {}): void {
	// BOM-safe 读-改-写(见 shared/settings-io.ts):值相同则跳过,写回不带 BOM。
	updateSettingsJson({ cdpPort: port }, deps);
}

export function createChromeCdpState(
	env: Record<string, string | undefined> = process.env,
	deps: ChromeCdpPortDeps = {},
): ChromeCdpState {
	const persistedPort = readPersistedCdpPort(deps);
	if (persistedPort && env === process.env) process.env.UGK_CDP_PORT = String(persistedPort);
	return {
		mode: "ask",
		sessionAllowed: env.UGK_TASK_ALLOW_CHROME_CDP === "1",
		runtimePort: persistedPort,
		envPort: parsePort(env.UGK_CDP_PORT),
	};
}

export function setChromeCdpMode(state: ChromeCdpState, mode: ChromeCdpMode): void {
	state.mode = mode;
	clearChromeCdpSessionAllow(state);
}

export function grantChromeCdpSessionAllow(state: ChromeCdpState): void {
	state.sessionAllowed = true;
}

export function clearChromeCdpSessionAllow(state: ChromeCdpState): void {
	state.sessionAllowed = false;
}

export function setChromeCdpPort(state: ChromeCdpState, port: number, deps: ChromeCdpPortDeps = {}): void {
	const parsed = parsePort(port);
	if (!parsed) throw new Error(`Invalid CDP port: ${port}`);
	state.runtimePort = parsed;
	process.env.UGK_CDP_PORT = String(parsed);
	persistCdpPort(parsed, deps);
}

export function resolveChromeCdpPort(state: ChromeCdpState, params: { port?: number }): number {
	return parsePort(params.port) ?? state.runtimePort ?? state.envPort ?? DEFAULT_PORT;
}

export function checkChromeCdpPolicy(
	state: ChromeCdpState,
	request: ChromeCdpPolicyRequest,
): ChromeCdpPolicyResult {
	if (request.action === "status") {
		return { allowed: true, requiresConfirmation: false };
	}

	if (state.mode === "off") {
		return {
			allowed: false,
			requiresConfirmation: false,
			reason: "Chrome CDP is off. Ask the user to run /cdp ask or /cdp on.",
		};
	}

	if (request.action === "launch") {
		return { allowed: true, requiresConfirmation: false };
	}

	if (!request.normalAccessAttempted && !/local chrome|cdp|devtools|logged-in|logged in/i.test(request.reason)) {
		return {
			allowed: false,
			requiresConfirmation: false,
			reason: "Chrome CDP is reserved for logged-in local Chrome access after ordinary access is insufficient.",
		};
	}

	return {
		allowed: true,
		requiresConfirmation: state.mode === "ask" && !state.sessionAllowed,
	};
}
