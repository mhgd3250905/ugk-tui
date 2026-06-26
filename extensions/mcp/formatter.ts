import type { McpConnection } from "./registry.ts";
import type { McpPermissionState } from "./permissions.ts";

// ponytail: formatter 自描述所需 state 形状(structural typing 鸭子兼容 McpCommandState),
// 不再 import commands.ts —— 斩断 commands→formatter→commands 的 import cycle。
// 字段是 formatMcpStatus 实际读到的子集,增删时同步此处。
interface McpStatusStateShape {
	registry: { connections: Iterable<McpConnection> };
	permissionState: Pick<McpPermissionState, "mode">;
	serverTools: Map<string, string[]>;
	failedServers?: Map<string, string>;
	warnings?: string[];
	staleServerTools?: Map<string, string[]>;
}

export function formatMcpStatus(state: McpStatusStateShape): string {
	const connections = Array.from(state.registry.connections.values());
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

function normalizeFailedServers(failedServers: McpStatusStateShape["failedServers"]): Array<[string, string]> {
	if (!failedServers) {
		return [];
	}
	return Array.from(failedServers.entries(), ([name, error]) => [name, String(error)]);
}
