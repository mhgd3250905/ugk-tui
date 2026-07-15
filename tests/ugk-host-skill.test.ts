import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skillUrl = new URL("../integrations/agent-skills/ugk/SKILL.md", import.meta.url);
const codexUrl = new URL("../integrations/agent-skills/ugk/references/codex.md", import.meta.url);
const openaiUrl = new URL("../integrations/agent-skills/ugk/agents/openai.yaml", import.meta.url);

function read(url: URL) {
	try { return readFileSync(url, "utf8"); } catch { return ""; }
}

function frontmatter(markdown: string) {
	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	assert.ok(match, "SKILL.md must have YAML frontmatter");
	return Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
		const separator = line.indexOf(":");
		return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
	}));
}

test("skill metadata triggers only for explicit UGK use and bootstrap", () => {
	const skill = read(skillUrl);
	const metadata = frontmatter(skill);
	assert.deepEqual(Object.keys(metadata).sort(), ["description", "name"]);
	assert.equal(metadata.name, "ugk");
	assert.match(metadata.description, /explicitly asks.*UGK/i);
	assert.match(metadata.description, /install|configure/i);
	assert.match(metadata.description, /runId/i);
	assert.match(metadata.description, /ordinary tasks/i);
});

test("skill preserves the task-only boundary and drives the gateway state machine", () => {
	const skill = read(skillUrl);
	assert.match(skill, /普通任务不自动交给 UGK/);
	assert.match(skill, /当前项目.*绝对 `cwd`/);
	assert.match(skill, /自包含.*request/);
	for (const action of ["doctor", "start", "status", "respond", "cancel"]) assert.match(skill, new RegExp(`\\b${action}\\b`));
	assert.match(skill, /最多自动纠错一次/);
	assert.match(skill, /request.*实质变化/);
});

test("skill keeps API keys out of agent context and command arguments", () => {
	const skill = read(skillUrl);
	assert.match(skill, /不要读取.*API key.*上下文/);
	assert.match(skill, /不要把 API key 放进命令参数/);
	assert.match(skill, /不要回显/);
});

test("Codex reference covers local install, MCP registration, and refresh behavior", () => {
	const codex = read(codexUrl);
	assert.match(codex, /codex mcp list/);
	assert.match(codex, /codex mcp add ugk -- ugk mcp serve/);
	assert.match(codex, /STDIO/i);
	assert.match(codex, /写入配置.*先.*用户.*同意/s);
	assert.match(codex, /重启|新建 Codex 任务/);
});

test("OpenAI metadata is usable before the MCP server is installed", () => {
	const openai = read(openaiUrl);
	assert.match(openai, /display_name:/);
	assert.match(openai, /short_description:/);
	assert.match(openai, /default_prompt:.*\$ugk/);
	assert.doesNotMatch(openai, /^dependencies:/m);
});
