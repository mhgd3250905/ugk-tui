/**
 * S1 fix regression test: entering and exiting plan mode must preserve
 * dynamically registered tools (e.g. MCP tools), not clobber them with
 * a hardcoded NORMAL_MODE_TOOLS list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planModeExtension from "../extensions/plan-mode.ts";

type MockPi = {
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
	activeTools: string[];
} & ExtensionAPI;

function createMockPi(initialTools: string[]): MockPi {
	let activeTools = [...initialTools];
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	return {
		commands,
		activeTools,
		on() {},
		registerFlag() {},
		getFlag: () => false,
		registerShortcut() {},
		registerCommand(name, options) {
			commands.set(name, { handler: options.handler as any });
		},
		registerTool() {},
		getActiveTools: () => [...activeTools],
		setActiveTools(names) {
			activeTools = [...names];
		},
	} as any;
}

test("plan mode toggle preserves MCP/dynamic tools on exit", async () => {
	// Simulate a session where MCP tools are already active.
	const initialTools = ["read", "bash", "edit", "write", "mcp__github__search", "mcp__fs__read_file"];
	const pi = createMockPi(initialTools);
	planModeExtension(pi);

	const planCommand = (pi as any).commands.get("plan");
	assert.ok(planCommand, "/plan command should be registered");

	// Minimal ctx stub: ui.notify + setStatus + setWidget + theme + sessionManager + appendEntry
	const noop = () => {};
	const ctx: any = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			notify: noop,
			setStatus: noop,
			setWidget: noop,
			theme: { fg: (s: string) => s, strikethrough: (s: string) => s },
		},
		sessionManager: { getEntries: () => [] },
	};

	// Enter plan mode: tools become PLAN_MODE_TOOLS.
	await planCommand.handler("", ctx);
	assert.deepEqual(
		pi.getActiveTools().sort(),
		["read", "bash", "grep", "find", "ls", "questionnaire"].sort(),
		"entering plan mode should restrict tools",
	);

	// Exit plan mode: MCP tools must be restored, not just NORMAL_MODE_TOOLS.
	await planCommand.handler("", ctx);
	assert.deepEqual(
		pi.getActiveTools().sort(),
		initialTools.sort(),
		"exiting plan mode must restore the original tool set incl. MCP/dynamic tools",
	);
});

test("plan mode toggle without getActiveTools falls back to normal tools", async () => {
	// Edge case: if getActiveTools is unavailable, exit should use NORMAL_MODE_TOOLS fallback.
	const pi = createMockPi(["read", "bash"]);
	// Simulate missing getActiveTools on the live pi (togglePlanMode captures snapshot first).
	const liveActiveTools: string[] = [...(pi as any).activeTools];
	(pi as any).getActiveTools = undefined;
	// Redirect setActiveTools into a readable sink for assertion (no getActiveTools available).
	(pi as any).setActiveTools = (names: string[]) => {
		liveActiveTools.length = 0;
		liveActiveTools.push(...names);
	};

	planModeExtension(pi);
	const planCommand = (pi as any).commands.get("plan");
	const noop = () => {};
	const ctx: any = {
		hasUI: true,
		cwd: process.cwd(),
		ui: { notify: noop, setStatus: noop, setWidget: noop, theme: { fg: (s: string) => s } },
		sessionManager: { getEntries: () => [] },
	};

	// Enter then exit.
	await planCommand.handler("", ctx);
	await planCommand.handler("", ctx);
	// With no snapshot captured, fallback should be the normal 4 tools.
	assert.deepEqual(
		liveActiveTools.sort(),
		["read", "bash", "edit", "write"].sort(),
		"without snapshot, exit should fall back to NORMAL_MODE_TOOLS",
	);
});
