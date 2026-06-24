import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ChromeCdpMode = "off" | "ask" | "on";
export type ChromeCdpAction = "status" | "tabs" | "navigate" | "evaluate" | "screenshot";

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
	const settingsPath = resolveUgkSettingsPath(deps);
	const exists = deps.exists ?? fs.existsSync;
	const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
	try {
		if (!exists(settingsPath)) return undefined;
		const settings = JSON.parse(readFile(settingsPath));
		return parsePort(settings?.cdpPort);
	} catch {
		return undefined;
	}
}

export function persistCdpPort(port: number, deps: ChromeCdpPortDeps = {}): void {
	const settingsPath = resolveUgkSettingsPath(deps);
	const exists = deps.exists ?? fs.existsSync;
	const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
	const writeFile = deps.writeFile ?? ((p: string, content: string) => fs.writeFileSync(p, content));
	const mkdir = deps.mkdir ?? ((p: string, opts: { recursive: true }) => fs.mkdirSync(p, opts));
	let settings: Record<string, unknown> = {};
	try {
		if (exists(settingsPath)) settings = JSON.parse(readFile(settingsPath)) ?? {};
	} catch {
		settings = {};
	}
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
	if (settings.cdpPort === port) return;
	settings.cdpPort = port;
	mkdir(path.dirname(settingsPath), { recursive: true });
	writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
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
