import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerUgkExtension from "../extensions/index.ts";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-command-"));
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
		assert.match(text, /│\s*🧰 Tools\s*│\s*✅ greet/);
		assert.match(text, /│\s*🤖 Agents\s*│\s*✅ @agent mention/);
		assert.match(text, /│\s*⌨️ Commands\s*│\s*\/ugk/);
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
