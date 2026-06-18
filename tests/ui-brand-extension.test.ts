import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerUgkBrandUi from "../extensions/ui-brand.ts";
import { clearFlowDriverBanner, setFlowDriverBanner } from "../extensions/flow/driver-banner.ts";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-ui-brand-"));
}

test("ugk brand extension installs through safe extension UI hooks", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const flags = new Map<string, unknown>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerFlag(name: string, options: unknown) {
			flags.set(name, options);
		},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};

	registerUgkBrandUi(pi as any);

	assert.ok(handlers.has("session_start"));
	assert.ok(handlers.has("session_shutdown"));
	assert.ok(commands.has("ugk-ui"));
	assert.ok(flags.has("ugk-ui-off"));

	const calls: string[] = [];
	let headerFactory: Function | undefined;
	let footerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "deepseek-v4-pro" },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent: 12.3, contextWindow: 1000000 }),
		ui: {
			setHeader: (factory: unknown) => {
				headerFactory = factory as Function;
				calls.push(`header:${typeof factory}`);
			},
			setFooter: (factory: unknown) => {
				footerFactory = factory as Function;
				calls.push(`footer:${typeof factory}`);
			},
			setTitle: (title: string) => calls.push(`title:${title}`),
			setEditorComponent: () => calls.push("editor"),
			notify: (message: string) => calls.push(`notify:${message}`),
			theme: {},
		},
	};

	await handlers.get("session_start")!({ reason: "startup" }, ctx);

	assert.deepEqual(calls.slice(0, 3), ["header:function", "footer:function", "title:ugk - demo - ugk-tui"]);
	assert.equal(calls.includes("editor"), false);

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const tui = { requestRender() {} };
	const footerData = {
		getGitBranch: () => "feature/ui-optimization",
		getExtensionStatuses: () => new Map([["turn-progress", "✓ 第 1 轮完成"]]),
		onBranchChange: () => () => {},
	};

	const header = headerFactory!(tui, theme);
	const footer = footerFactory!(tui, theme, footerData);
	assert.match(header.render(80).join("\n"), /ugk v1\.0\.0/);
	assert.match(footer.render(80).join("\n"), /feature\/ui-optimization/);
	assert.match(footer.render(80).join("\n"), /第 1 轮完成/);
	header.dispose?.();
});

test("/ugk-ui with no args opens an action menu", async () => {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	const calls: string[] = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
		},
		ui: {
			setHeader: () => calls.push("header"),
			setFooter: () => calls.push("footer"),
			setTitle: () => {},
			select: async (title: string, options: string[]) => {
				selections.push({ title, options });
				return "Turn off";
			},
			notify: (message: string) => calls.push(`notify:${message}`),
		},
	};

	registerUgkBrandUi(pi as any);
	await commands.get("ugk-ui")!.handler("", ctx);

	assert.deepEqual(selections, [
		{
			title: "UGK UI",
			options: ["Show status", "Turn off", "Turn on", "Exit"],
		},
	]);
	assert.ok(calls.includes("header"));
	assert.ok(calls.includes("footer"));
	assert.match(calls.join("\n"), /ugk UI disabled/);
});

test("ugk brand header renders active flow driver banner", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let headerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "deepseek-v4-pro" },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		ui: {
			setHeader: (factory: unknown) => {
				headerFactory = factory as Function;
			},
			setFooter: () => {},
			setTitle: () => {},
		},
	};
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	let header: { render(width: number): string[]; dispose?: () => void } | undefined;

	try {
		registerUgkBrandUi(pi as any);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		setFlowDriverBanner({ taskId: "x-search-post-collector", runId: "run-001", status: "running" });
		header = headerFactory!({ requestRender() {} }, theme);
		const lines = header.render(100);
		const text = lines.join("\n");
		const bannerIndex = lines.findIndex((line) => line.includes("FLOW DRIVER ACTIVE"));

		assert.match(text, /FLOW DRIVER ACTIVE/);
		assert.match(text, /x-search-post-collector\/run-001/);
		assert.equal(lines[bannerIndex + 1], "");
		assert.notEqual(lines[bannerIndex + 2], "");
	} finally {
		header?.dispose?.();
		clearFlowDriverBanner();
	}
});

test("ugk brand header requests render while subscribed to flow driver banner changes", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let headerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "deepseek-v4-pro" },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		ui: {
			setHeader: (factory: unknown) => {
				headerFactory = factory as Function;
			},
			setFooter: () => {},
			setTitle: () => {},
		},
	};
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	let header: { dispose?: () => void } | undefined;

	try {
		registerUgkBrandUi(pi as any);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		let renderRequests = 0;
		header = headerFactory!(
			{
				requestRender() {
					renderRequests += 1;
				},
			},
			theme,
		);

		setFlowDriverBanner({ taskId: "task-a", runId: "run-001", status: "running" });
		assert.equal(renderRequests, 1);

		header.dispose();
		clearFlowDriverBanner();
		assert.equal(renderRequests, 1);
	} finally {
		header?.dispose?.();
		clearFlowDriverBanner();
	}
});

test("ugk brand footer hides DeepSeek model when API credentials are missing", async () => {
	const previousApiKey = process.env.DEEPSEEK_API_KEY;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.DEEPSEEK_API_KEY;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	try {
		const handlers = new Map<string, Function>();
		const pi = {
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			getSessionName() {
				return "demo";
			},
		};
		let footerFactory: Function | undefined;
		const ctx = {
			cwd: "/Users/shengkai/projects/ugk-tui",
			model: { id: "deepseek-v4-pro" },
			sessionManager: {
				getCwd: () => "/Users/shengkai/projects/ugk-tui",
				getEntries: () => [],
				getBranch: () => [],
			},
			getContextUsage: () => ({ percent: 0, contextWindow: 1000000 }),
			ui: {
				setHeader: () => {},
				setFooter: (factory: unknown) => {
					footerFactory = factory as Function;
				},
				setTitle: () => {},
			},
		};

		registerUgkBrandUi(pi as any);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		const footer = footerFactory!({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			onBranchChange: () => () => {},
		});
		const text = footer.render(100).join("\n");

		assert.doesNotMatch(text, /deepseek-v4-pro/);
		assert.match(text, /❌ API not configured/);
	} finally {
		if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousApiKey;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("ugk brand footer colors stateful fields by severity", async () => {
	const previousApiKey = process.env.DEEPSEEK_API_KEY;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.DEEPSEEK_API_KEY;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	try {
		const handlers = new Map<string, Function>();
		const pi = {
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			getSessionName() {
				return "demo";
			},
		};
		let footerFactory: Function | undefined;
		const ctx = {
			cwd: "/Users/shengkai/projects/ugk-tui",
			model: { id: "deepseek-v4-pro" },
			sessionManager: {
				getCwd: () => "/Users/shengkai/projects/ugk-tui",
				getEntries: () => [],
				getBranch: () => [],
			},
			getContextUsage: () => ({ percent: 0, contextWindow: 1000000 }),
			ui: {
				setHeader: () => {},
				setFooter: (factory: unknown) => {
					footerFactory = factory as Function;
				},
				setTitle: () => {},
			},
		};

		registerUgkBrandUi(pi as any);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		const footer = footerFactory!({ requestRender() {} }, theme, {
			getGitBranch: () => null,
			getExtensionStatuses: () =>
				new Map([
					["bash", "bash unavailable"],
					["subagent", "subagent not loaded"],
					["turn-progress", "✓ 第 1 轮完成"],
				]),
			onBranchChange: () => () => {},
		});
		const text = footer.render(140).join("\n");

		assert.match(text, /<error>❌ API not configured<\/error>/);
		assert.doesNotMatch(text, /<success>configured<\/success>/);
		assert.match(text, /<error>bash unavailable<\/error>/);
		assert.match(text, /<error>subagent not loaded<\/error>/);
		assert.match(text, /<success>✓ 第 1 轮完成<\/success>/);
	} finally {
		if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousApiKey;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
