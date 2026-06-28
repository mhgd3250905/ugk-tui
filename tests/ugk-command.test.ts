import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerUgkExtension, { suppressNaturalAtAutocomplete } from "../extensions/index.ts";
import { createAutopilotState, installAutopilotState, isAutopilotOn } from "../extensions/shared/autopilot.ts";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-command-"));
}

function registerCommands() {
	const commands = new Map<string, { handler: Function }>();
	const pi = {
		registerTool() {},
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerFlag() {},
		registerShortcut() {},
		on() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	registerUgkExtension(pi as any);
	return commands;
}

test("/ugk renders a structured status panel", async () => {
	const previousApiKey = process.env.DEEPSEEK_API_KEY;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.DEEPSEEK_API_KEY;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	try {
		const commands = new Map<string, { handler: Function }>();
		const pi = {
			registerTool() {},
			registerCommand(name: string, options: { handler: Function }) {
				commands.set(name, options);
			},
			registerFlag() {},
			registerShortcut() {},
			on() {},
			getFlag() {
				return undefined;
			},
			getSessionName() {
				return "demo";
			},
		};
		const notifications: string[] = [];

		registerUgkExtension(pi as any);
		await commands.get("ugk")!.handler("", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		});

		const text = notifications.join("\n");
		assert.match(text, /^🟢 UGK active/);
		assert.match(text, /┌─+┬─+┐/);
		assert.doesNotMatch(text, /│\s*🧰 Tools\s*│.*✅ greet/);
		assert.match(text, /│\s*🧰 Tools\s*│.*✅ mcp/);
		assert.match(text, /│\s*🤖 Agents\s*│\s*✅ @agent mention/);
		assert.match(text, /│\s*⌨️ Commands\s*│\s*\/ugk/);
		assert.match(text, /│\s*⌨️ Commands\s*│.*\/mcp/);
		assert.doesNotMatch(text, /│\s*⌨️ Commands\s*│.*\/flow/);
		assert.match(text, /│\s*📡 API\s*│\s*❌ DeepSeek 未配置/);
		assert.match(text, /│\s*🛡️ Guard\s*│\s*dangerous bash gate enabled/);
		assert.doesNotMatch(text, /🧰 Tools:/);
	} finally {
		if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousApiKey;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("/ugk-autopilot with no args opens an action menu", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	installAutopilotState(createAutopilotState(false));
	try {
		const commands = registerCommands();
		const selections: Array<{ title: string; options: string[] }> = [];
		const notifications: string[] = [];

		await commands.get("ugk-autopilot")!.handler("", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return "Turn on";
				},
			},
		});

		assert.equal(selections[0].title, "Autopilot");
		assert.deepEqual(selections[0].options, ["Status", "Turn on", "Turn off", "Exit"]);
		assert.equal(isAutopilotOn(), true);
		assert.match(notifications.join("\n"), /Autopilot: ON/);
	} finally {
		installAutopilotState(createAutopilotState(false));
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("/language with no args opens an action menu before input", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir();
	try {
		const commands = registerCommands();
		const selections: Array<{ title: string; options: string[] }> = [];
		const inputs: string[] = [];
		const notifications: string[] = [];

		await commands.get("language")!.handler("", {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return "Set language";
				},
				input(prompt: string) {
					inputs.push(prompt);
					return "English";
				},
			},
		});

		assert.equal(selections[0].title, "Language");
		assert.deepEqual(selections[0].options, ["Status", "Set language", "Clear", "Exit"]);
		assert.equal(inputs[0], "用什么语言与 agent 交流?");
		assert.match(notifications.join("\n"), /语言偏好已设为: English/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("autocomplete wrapper leaves natural @agent text alone", async () => {
	let calls = 0;
	const provider = suppressNaturalAtAutocomplete({
		async getSuggestions() {
			calls += 1;
			return { items: [{ value: "x", label: "x" }], prefix: "@" };
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return { lines, cursorLine, cursorCol };
		},
	});

	assert.equal(await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal }), null);
	assert.equal(await provider.getSuggestions(["@scout"], 0, 6, { signal: new AbortController().signal }), null);
	assert.equal(calls, 0);

	assert.notEqual(await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal, force: true }), null);
	assert.notEqual(await provider.getSuggestions(["@./"], 0, 3, { signal: new AbortController().signal }), null);
	assert.equal(calls, 2);
});

test("autocomplete wrapper preserves prototype applyCompletion", () => {
	class Provider {
		async getSuggestions() {
			return { items: [{ value: "x", label: "x" }], prefix: "@" };
		}

		applyCompletion(lines: string[], _cursorLine: number, _cursorCol: number) {
			return { lines: [...lines, "applied"], cursorLine: 1, cursorCol: 7 };
		}
	}

	const provider = suppressNaturalAtAutocomplete(new Provider() as any);
	assert.deepEqual(
		provider.applyCompletion(["@"], 0, 1, { value: "x", label: "x" }, "@"),
		{ lines: ["@", "applied"], cursorLine: 1, cursorCol: 7 },
	);
});
