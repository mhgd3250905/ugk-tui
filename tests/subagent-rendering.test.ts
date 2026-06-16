import test from "node:test";
import assert from "node:assert/strict";
import { formatToolCall } from "../extensions/subagent-rendering.ts";

const plainTheme = (_color: string, text: string) => text;

test("formats common subagent tool calls for collapsed rendering", () => {
	assert.equal(formatToolCall("bash", { command: "rg registerTool extensions" }, plainTheme), "$ rg registerTool extensions");
	assert.equal(formatToolCall("read", { path: "extensions/subagent.ts", offset: 10, limit: 3 }, plainTheme), "read extensions/subagent.ts:10-12");
	assert.equal(formatToolCall("grep", { pattern: "cron", path: "extensions" }, plainTheme), "grep /cron/ in extensions");
});

test("shortens home paths in rendered tool calls", () => {
	const home = process.env.USERPROFILE || process.env.HOME;
	assert.ok(home);

	const rendered = formatToolCall("ls", { path: `${home}\\AppData\\Local` }, plainTheme);
	assert.match(rendered, /^ls ~/);
});
