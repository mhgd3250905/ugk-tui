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

export function createChromeCdpState(env: Record<string, string | undefined> = process.env): ChromeCdpState {
	return {
		mode: "ask",
		sessionAllowed: false,
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

export function setChromeCdpPort(state: ChromeCdpState, port: number): void {
	const parsed = parsePort(port);
	if (!parsed) throw new Error(`Invalid CDP port: ${port}`);
	state.runtimePort = parsed;
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
