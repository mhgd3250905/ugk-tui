import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureUgkQuietStartupDefault } from "../bin/ugk-startup-settings.js";

function makeTempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-agent-settings-"));
}

test("ensureUgkQuietStartupDefault enables quiet startup when unset", () => {
	const agentDir = makeTempAgentDir();

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.quietStartup, true);
});

test("ensureUgkQuietStartupDefault preserves explicit quiet startup preference", () => {
	const agentDir = makeTempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ quietStartup: false }, null, 2));

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.quietStartup, false);
});

test("ensureUgkQuietStartupDefault keeps existing settings", () => {
	const agentDir = makeTempAgentDir();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "ugk-geek" }, null, 2));

	ensureUgkQuietStartupDefault(agentDir);

	const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.theme, "ugk-geek");
	assert.equal(settings.quietStartup, true);
});
