import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpPermissionState } from "./permissions.ts";
import { setMcpPermissionMode, type McpPermissionMode } from "./permissions.ts";
import type { McpConnection, McpRegistry } from "./registry.ts";
import {
	buildToolName,
	normalizeToolName,
	registerMcpTools,
	resolveNormalizedServerNames,
	type McpToolRegistrationOptions,
	type McpToolRegistrationResult,
} from "./tools.ts";
import { formatMcpStatus } from "./formatter.ts";

export type McpCommandState = {
	registry: Pick<McpRegistry, "connections" | "disconnectAll">;
	permissionState: McpPermissionState;
	serverTools: Map<string, string[]>;
	failedServers?: Map<string, string> | Record<string, string>;
	warnings?: string[];
	staleServerTools?: Map<string, string[]>;
};

export type McpReloadResult = {
	connections?: McpConnection[];
	registered?: Map<string, string[]> | Record<string, string[]>;
	failed?: Map<string, string> | Record<string, string>;
	warnings?: string[];
};

export type McpCommandDeps = {
	reload?: (context?: CommandContext) => Promise<McpReloadResult>;
	registerMcpTools?: (
		pi: ExtensionAPI,
		connections: McpConnection[],
		opts?: McpToolRegistrationOptions,
	) => McpToolRegistrationResult;
};

type CommandContext = {
	cwd?: string;
	hasUI?: boolean;
	ui?: {
		notify?: (message: string) => void;
		confirm?: (title: string, body?: string) => boolean | Promise<boolean>;
		select?: (title: string, options: string[]) => string | Promise<string>;
	};
};

export function registerMcpCommand(pi: ExtensionAPI, state: McpCommandState, deps: McpCommandDeps = {}): void {
	pi.registerCommand("mcp", {
		description: "Manage MCP servers and tools",
		async handler(input: string = "", context: CommandContext = {}) {
			const [command = "status", serverName] = input.trim().split(/\s+/).filter(Boolean);
			const action = command.toLowerCase();

			if (action === "status") {
				notify(context, formatMcpStatus(state));
				return;
			}

			if (isPermissionMode(action)) {
				setMcpPermissionMode(state.permissionState, action);
				notify(context, `MCP mode: ${state.permissionState.mode}`);
				return;
			}

			if (action === "disable") {
				notify(context, disableServer(pi, state, serverName));
				return;
			}

			if (action === "enable") {
				notify(context, enableServer(pi, state, serverName));
				return;
			}

			if (action === "reload") {
				notify(context, await reloadMcp(pi, state, deps, context));
				return;
			}

			notify(context, `Unknown /mcp command "${command}". Usage: /mcp status|on|off|ask|reload|enable <server>|disable <server>`);
		},
	});
}

function disableServer(pi: ExtensionAPI, state: McpCommandState, serverName?: string): string {
	if (!serverName) {
		return "Missing server. Usage: /mcp disable <server>";
	}

	const tools = state.serverTools.get(serverName);
	if (!tools) {
		return `MCP server "${serverName}" not found.`;
	}

	removeActiveTools(pi, tools);
	return `MCP server "${serverName}" disabled (${tools.length} tools removed from active tools).`;
}

function enableServer(pi: ExtensionAPI, state: McpCommandState, serverName?: string): string {
	if (!serverName) {
		return "Missing server. Usage: /mcp enable <server>";
	}

	if (state.staleServerTools?.has(serverName)) {
		return `MCP server "${serverName}" is stale (disconnected during reload). Run /mcp reload to reconnect, or fix its config first.`;
	}

	const tools = state.serverTools.get(serverName);
	if (!tools) {
		return `MCP server "${serverName}" not found.`;
	}

	const active = new Set(getActiveTools(pi));
	for (const tool of tools) {
		active.add(tool);
	}
	pi.setActiveTools(Array.from(active));
	return `MCP server "${serverName}" enabled (${tools.length} tools active).`;
}

async function reloadMcp(
	pi: ExtensionAPI,
	state: McpCommandState,
	deps: McpCommandDeps,
	context: CommandContext,
): Promise<string> {
	const previousTools = new Map(state.serverTools);
	await state.registry.disconnectAll();

	const result = deps.reload ? await deps.reload(context) : {};
	const connections = result.connections ?? [];
	let registration: McpToolRegistrationResult | undefined;
	if (connections.length > 0 && !result.registered) {
		registration = (deps.registerMcpTools ?? registerMcpTools)(pi, connections);
	}

	const nextServerTools = result.registered
		? normalizeServerTools(result.registered)
		: registration
			? new Map(registration.registeredByServer)
		: serverToolsFromConnections(connections);

	state.serverTools.clear();
	for (const [serverName, tools] of nextServerTools) {
		state.serverTools.set(serverName, tools);
	}

	state.failedServers = result.failed ?? new Map();
	state.warnings = result.warnings ?? [];
	state.staleServerTools ??= new Map();
	for (const serverName of nextServerTools.keys()) {
		state.staleServerTools.delete(serverName);
	}

	const nextTools = new Set(Array.from(nextServerTools.values()).flat());
	const staleTools: string[] = [];
	for (const [serverName, tools] of previousTools) {
		const removedTools = tools.filter((tool) => !nextTools.has(tool));
		if (nextServerTools.has(serverName) && removedTools.length === 0) {
			state.staleServerTools.delete(serverName);
			continue;
		}

		state.staleServerTools.set(serverName, removedTools.length > 0 ? removedTools : tools);
		staleTools.push(...removedTools.length > 0 ? removedTools : tools);
	}

	removeActiveTools(pi, staleTools);
	return `MCP reload complete. connected: ${connections.length}, tools: ${countTools(nextServerTools)}, failed: ${countFailed(state.failedServers)}, stale: ${state.staleServerTools.size}`;
}

function serverToolsFromConnections(connections: McpConnection[]): Map<string, string[]> {
	const normalizedServers = resolveNormalizedServerNames(connections.map((connection) => connection.name));
	const serverTools = new Map<string, string[]>();

	for (const connection of connections) {
		const serverName = normalizedServers.names.get(connection.name) ?? connection.name;
		serverTools.set(
			connection.name,
			connection.tools.map((tool) => buildToolName(serverName, normalizeToolName(tool.name))),
		);
	}

	return serverTools;
}

function normalizeServerTools(registered: NonNullable<McpReloadResult["registered"]>): Map<string, string[]> {
	if (registered instanceof Map) {
		return new Map(registered);
	}
	return new Map(Object.entries(registered));
}

function removeActiveTools(pi: ExtensionAPI, tools: string[]): void {
	if (tools.length === 0) {
		return;
	}

	const disabled = new Set(tools);
	pi.setActiveTools(getActiveTools(pi).filter((tool) => !disabled.has(tool)));
}

function getActiveTools(pi: ExtensionAPI): string[] {
	return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
}

function isPermissionMode(value: string): value is McpPermissionMode {
	return value === "on" || value === "off" || value === "ask";
}

function countTools(serverTools: Map<string, string[]>): number {
	return Array.from(serverTools.values()).reduce((sum, tools) => sum + tools.length, 0);
}

function countFailed(failedServers: McpCommandState["failedServers"]): number {
	if (!failedServers) {
		return 0;
	}
	if (failedServers instanceof Map) {
		return failedServers.size;
	}
	return Object.keys(failedServers).length;
}

function notify(context: CommandContext, message: string): void {
	context.ui?.notify?.(message);
}
