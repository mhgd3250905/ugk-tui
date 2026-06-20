import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadMcpConfig, type McpConfig, type McpConfigEntry } from "./config.ts";
import { registerMcpCommand, type McpCommandState } from "./commands.ts";
import {
	checkMcpSpawnPolicy,
	checkMcpToolPolicy,
	createMcpPermissionState,
	grantMcpSessionAllow,
	type McpPermissionState,
} from "./permissions.ts";
import { McpConnectionError, McpRegistry, type McpConnection } from "./registry.ts";
import {
	registerMcpTools,
	type McpToolPolicyContext,
	type McpToolRegistrationResult,
} from "./tools.ts";
import type { DoctorCheck } from "../doctor/types.ts";

type McpRuntimeContext = {
	cwd?: string;
	hasUI?: boolean;
	ui?: {
		confirm?: (title: string, body?: string) => boolean | Promise<boolean>;
		select?: (title: string, options: string[]) => string | Promise<string>;
		notify?: (message: string, level?: string) => void;
	};
};

type McpExtensionDeps = {
	registry?: McpRegistry;
	permissionState?: McpPermissionState;
	packageRoot?: string;
	loadConfig?: (cwd: string) => McpConfig | Promise<McpConfig>;
};

type McpStartupResult = {
	connections: McpConnection[];
	registered: Map<string, string[]>;
	failed: Map<string, string>;
	warnings: string[];
};

const MCP_ALLOW_ONCE = "Allow once";
const MCP_ALLOW_SESSION = "Allow for this session";
const MCP_DENY = "Deny";
const CLEANUP_REASONS = new Set(["quit", "reload", "new", "resume", "fork"]);
const STARTUP_REASONS = new Set(["startup", "reload"]);

export type McpExtensionState = McpCommandState & {
	registry: McpRegistry;
	permissionState: McpPermissionState;
};

export function registerMcp(pi: ExtensionAPI, deps: McpExtensionDeps = {}): McpExtensionState {
	const registry = deps.registry ?? new McpRegistry();
	const permissionState = deps.permissionState ?? createMcpPermissionState("ask");
	const state: McpExtensionState = {
		registry,
		permissionState,
		serverTools: new Map(),
		failedServers: new Map(),
		warnings: [],
		staleServerTools: new Map(),
	};

	async function startup(ctx: McpRuntimeContext): Promise<McpStartupResult> {
		const previousServerTools = new Map(state.serverTools);
		const result = await connectConfiguredServers(state, ctx, deps);
		applyStartupResult(state, result);
		const registration = registerConnectedTools(pi, state, result.connections, previousServerTools);
		mergeRegistration(state, registration, result);
		return result;
	}

	pi.on("session_start", async (event: { reason?: string } = {}, ctx: McpRuntimeContext = {}) => {
		if (event.reason && !STARTUP_REASONS.has(event.reason)) {
			return;
		}
		await startup(ctx);
	});

	pi.on("session_shutdown", async (event: { reason?: string } = {}, _ctx: McpRuntimeContext = {}) => {
		if (!event.reason || CLEANUP_REASONS.has(event.reason)) {
			await registry.disconnectAll();
		}
	});

	pi.on("before_agent_start", async (event: { systemPrompt?: string } = {}) => {
		const prompt = appendServerInstructions(event.systemPrompt ?? "", registry);
		return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
	});

	registerMcpCommand(pi, state, {
		reload: (ctx) => startup(ctx as McpRuntimeContext),
		registerMcpTools: () => ({ registered: [], registeredByServer: new Map(), skipped: [], warnings: [] }),
	});

	registerProcessCleanup(registry);
	return state;
}

export function createMcpDoctorCheck(deps: {
	registry: Pick<McpRegistry, "connections">;
	packageRoot?: string;
	loadConfig?: (cwd: string) => McpConfig | Promise<McpConfig>;
	cwd?: () => string;
}): DoctorCheck {
	return {
		id: "mcp.config",
		title: "MCP",
		category: "mcp",
		async run() {
			const cwd = deps.cwd?.() ?? process.cwd();
			const config = deps.loadConfig ? await deps.loadConfig(cwd) : loadMcpConfig(cwd, { packageRoot: deps.packageRoot });
			const connected = Array.from(deps.registry.connections.values()).filter(
				(connection) => connection.status === "connected",
			).length;
			const failed = Array.from(deps.registry.connections.values()).filter(
				(connection) => connection.status === "failed",
			).length;
			const details = formatMcpDoctorDetails(config);
			const status = config.errors.length > 0 || failed > 0 ? "warn" : "pass";
			return {
				status,
				summary: `MCP configured: ${config.servers.size}, connected: ${connected}, failed: ${failed}`,
				details,
				nextSteps: config.errors.length ? ["/mcp status"] : undefined,
			};
		},
	};
}

async function connectConfiguredServers(
	state: McpExtensionState,
	ctx: McpRuntimeContext,
	deps: McpExtensionDeps,
): Promise<McpStartupResult> {
	const cwd = resolveCwd(ctx);
	const config = deps.loadConfig ? await deps.loadConfig(cwd) : loadMcpConfig(cwd, { packageRoot: deps.packageRoot });
	const failed = configErrorsToFailedServers(config);
	const warnings: string[] = [];
	const connections: McpConnection[] = [];

	for (const entry of config.servers.values()) {
		const policy = checkMcpSpawnPolicy(
			state.permissionState,
			{ serverName: entry.name, scope: entry.scope, command: entry.config.command },
			hasInteractiveUi(ctx),
		);
		if (!policy.allowed) {
			failed.set(entry.name, policy.reason);
			continue;
		}

		if (policy.requiresConfirmation) {
			const allowed = await confirmSpawn(ctx, entry);
			if (!allowed) {
				failed.set(entry.name, `MCP server "${entry.name}" blocked by spawn policy`);
				continue;
			}
		}

		try {
			connections.push(await state.registry.connect(entry.name, entry.config));
		} catch (error) {
			failed.set(entry.name, connectionErrorMessage(error));
		}
	}

	return {
		connections,
		registered: new Map(),
		failed,
		warnings,
	};
}

function registerConnectedTools(
	pi: ExtensionAPI,
	state: McpExtensionState,
	connections: McpConnection[],
	previousServerTools: Map<string, string[]> = new Map(),
): McpToolRegistrationResult {
	if (connections.length === 0) {
		return { registered: [], registeredByServer: new Map(), skipped: [], warnings: [] };
	}

	return registerMcpTools(pi, connections, {
		existingToolNames: nonMcpActiveToolNames(pi, previousServerTools),
		warn: (message) => state.warnings?.push(message),
		checkToolPolicy: (context) => resolveToolPolicy(state, context),
	});
}

function nonMcpActiveToolNames(pi: ExtensionAPI, previousServerTools: Map<string, string[]>): string[] {
	const previousMcpTools = new Set(Array.from(previousServerTools.values()).flat());
	return getActiveTools(pi).filter((toolName) => !previousMcpTools.has(toolName));
}

async function resolveToolPolicy(state: McpExtensionState, context: McpToolPolicyContext) {
	const ctx = context.ctx as McpRuntimeContext | undefined;
	const policy = checkMcpToolPolicy(
		state.permissionState,
		{ serverName: context.rawServerName, toolName: context.rawToolName, reason: context.reason },
		hasInteractiveUi(ctx),
	);
	if (!policy.allowed) {
		return { allowed: false, reason: policy.reason };
	}
	if (!policy.requiresConfirmation) {
		return { allowed: true };
	}

	const confirmation = await confirmTool(ctx, context);
	if (confirmation === "deny") {
		return { allowed: false, reason: `MCP tool "${context.registeredName}" denied by user.` };
	}
	if (confirmation === "allow-session") {
		grantMcpSessionAllow(state.permissionState, context.rawServerName);
	}
	return { allowed: true };
}

function applyStartupResult(state: McpExtensionState, result: McpStartupResult): void {
	state.failedServers = result.failed;
	state.warnings = result.warnings;
	state.serverTools.clear();
}

function mergeRegistration(
	state: McpExtensionState,
	registration: McpToolRegistrationResult,
	result: McpStartupResult,
): void {
	for (const warning of registration.warnings) {
		if (!result.warnings.includes(warning)) {
			result.warnings.push(warning);
		}
	}

	const registered = new Map(registration.registeredByServer);
	result.registered = registered;
	state.serverTools.clear();
	for (const [serverName, tools] of registered) {
		state.serverTools.set(serverName, tools);
	}
}

function appendServerInstructions(systemPrompt: string, registry: Pick<McpRegistry, "connections">): string {
	const lines = Array.from(registry.connections.values())
		.filter((connection) => connection.status === "connected")
		.map((connection) => {
			const instructions = readInstructions(connection);
			return instructions ? `- ${connection.name}: ${instructions}` : undefined;
		})
		.filter((line): line is string => Boolean(line));

	if (lines.length === 0) {
		return systemPrompt;
	}

	return [systemPrompt, "", "MCP server instructions:", ...lines].join("\n");
}

function readInstructions(connection: McpConnection): string | undefined {
	const client = connection.client as unknown as { getInstructions?: () => string | undefined };
	return client.getInstructions?.();
}

function configErrorsToFailedServers(config: McpConfig): Map<string, string> {
	const failed = new Map<string, string>();
	for (const error of config.errors) {
		failed.set(error.serverName ?? `${error.scope}:${error.filePath}`, error.message);
	}
	return failed;
}

function formatMcpDoctorDetails(config: McpConfig): string[] {
	const byScope = new Map<string, string[]>();
	for (const entry of config.servers.values()) {
		const names = byScope.get(entry.scope) ?? [];
		names.push(entry.name);
		byScope.set(entry.scope, names);
	}

	const details = Array.from(byScope, ([scope, names]) => `${scope}: ${names.join(", ")}`);
	for (const error of config.errors) {
		details.push(`${error.scope}: ${error.serverName ?? error.filePath}: ${error.message}`);
	}
	return details;
}

async function confirmSpawn(ctx: McpRuntimeContext, entry: McpConfigEntry): Promise<boolean> {
	if (!hasInteractiveUi(ctx)) {
		return false;
	}
	if (ctx.ui?.select && !ctx.ui?.confirm) {
		const choice = await ctx.ui.select(
			`Allow MCP server?\n\nServer "${entry.name}" from ${entry.scope} config wants to spawn:\n${entry.config.command}`,
			["Allow", "Deny"],
		);
		return choice === "Allow";
	}
	return Boolean(
		await ctx.ui?.confirm?.(
			"Allow MCP server?",
			`Server "${entry.name}" from ${entry.scope} config wants to spawn:\n${entry.config.command}`,
		),
	);
}

async function confirmTool(ctx: McpRuntimeContext | undefined, context: McpToolPolicyContext) {
	if (!hasInteractiveUi(ctx)) {
		return "deny" as const;
	}

	const prompt = `Allow MCP tool?\n\n${context.registeredName}\nReason: ${context.reason}`;
	if (ctx?.ui?.select) {
		const choice = await ctx.ui.select(prompt, [MCP_ALLOW_ONCE, MCP_ALLOW_SESSION, MCP_DENY]);
		if (choice === MCP_ALLOW_SESSION) {
			return "allow-session" as const;
		}
		if (choice === MCP_ALLOW_ONCE) {
			return "allow-once" as const;
		}
		return "deny" as const;
	}

	return (await ctx?.ui?.confirm?.("Allow MCP tool?", prompt)) ? ("allow-once" as const) : ("deny" as const);
}

function resolveCwd(ctx: McpRuntimeContext): string {
	return ctx.cwd ?? process.cwd();
}

function hasInteractiveUi(ctx: McpRuntimeContext | undefined): boolean {
	return Boolean(ctx?.ui?.confirm || ctx?.ui?.select);
}

function connectionErrorMessage(error: unknown): string {
	if (error instanceof McpConnectionError) {
		return error.connection.message ?? error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

function getActiveTools(pi: ExtensionAPI): string[] {
	return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
}

let processCleanupRegistered = false;
const cleanupRegistries = new Set<McpRegistry>();

export async function disconnectMcpCleanupRegistries(): Promise<void> {
	await Promise.all(Array.from(cleanupRegistries, (item) => item.disconnectAll()));
}

export function killMcpCleanupRegistryProcesses(): void {
	for (const registry of cleanupRegistries) {
		registry.killAllProcesses?.();
	}
}

function registerProcessCleanup(registry: McpRegistry): void {
	cleanupRegistries.add(registry);
	if (processCleanupRegistered) {
		return;
	}
	processCleanupRegistered = true;
	process.once("beforeExit", async () => {
		await disconnectMcpCleanupRegistries();
	});
	process.once("exit", killMcpCleanupRegistryProcesses);
	process.once("SIGINT", () => {
		killMcpCleanupRegistryProcesses();
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		killMcpCleanupRegistryProcesses();
		process.exit(143);
	});
}

export default registerMcp;
