import type { McpConnection } from "./registry.ts";
import type { McpCommandState } from "./commands.ts";

export function formatMcpStatus(state: McpCommandState): string {
	const connections = Array.from(state.registry.connections.values()) as McpConnection[];
	const connected = connections.filter((connection) => connection.status === "connected");
	const failed = normalizeFailedServers(state.failedServers);
	const toolCount = Array.from(state.serverTools.values()).reduce((sum, tools) => sum + tools.length, 0);
	const stale = state.staleServerTools ? Array.from(state.staleServerTools.entries()) : [];
	const warnings = state.warnings ?? [];

	const lines = [
		"MCP status",
		`connected servers: ${connected.length}${connected.length ? ` (${connected.map((c) => c.name).join(", ")})` : ""}`,
		`tools: ${toolCount}`,
		`mode: ${state.permissionState.mode}`,
	];

	if (failed.length > 0) {
		lines.push(`failed servers: ${failed.map(([name, message]) => `${name} (${message})`).join(", ")}`);
	} else {
		lines.push("failed servers: none");
	}

	if (stale.length > 0) {
		lines.push(`stale servers: ${stale.map(([name, tools]) => `${name} (${tools.length} tools)`).join(", ")}`);
	}

	if (warnings.length > 0) {
		lines.push(`warnings: ${warnings.join("; ")}`);
	}

	return lines.join("\n");
}

function normalizeFailedServers(failedServers: McpCommandState["failedServers"]): Array<[string, string]> {
	if (!failedServers) {
		return [];
	}
	if (failedServers instanceof Map) {
		return Array.from(failedServers.entries(), ([name, error]) => [name, String(error)]);
	}
	return Object.entries(failedServers).map(([name, error]) => [name, String(error)]);
}
