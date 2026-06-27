import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const skillCreatorPath = new URL("../skills/skill-creator/SKILL.md", import.meta.url);
const skillCreatorLicensePath = new URL("../skills/skill-creator/LICENSE.txt", import.meta.url);
const mcpGuidePath = new URL("../skills/mcp-guide/SKILL.md", import.meta.url);
const mcpConfigureScriptPath = new URL("../skills/mcp-guide/scripts/configure_mcp.py", import.meta.url);
const bashGuidePath = new URL("../skills/bash-guide/SKILL.md", import.meta.url);
const chromeCdpGuidePath = new URL("../skills/chrome-cdp-guide/SKILL.md", import.meta.url);

test("bundles Anthropic skill creator as a preinstalled skill", () => {
	const skill = fs.readFileSync(skillCreatorPath, "utf8");
	const license = fs.readFileSync(skillCreatorLicensePath, "utf8");

	assert.match(skill, /^---\s*\nname: skill-creator/m);
	assert.match(skill, /description: Create new skills, modify and improve existing skills/);
	assert.match(license, /Apache License\s+Version 2\.0/);
});

test("bundles MCP guide as a preinstalled skill", () => {
	const skill = fs.readFileSync(mcpGuidePath, "utf8");

	assert.match(skill, /^---\s*\nname: mcp-guide/m);
	assert.match(skill, /description: Use when the user wants to configure or manage MCP servers in UGK/);
	assert.match(skill, /pastes.*mcpServers JSON/i);
	assert.match(skill, /install scope/);
	assert.match(skill, /npm link/);
	assert.match(skill, /\/mcp status/);
	assert.equal(fs.existsSync(mcpConfigureScriptPath), true);
});

test("bundles Bash guide as a preinstalled skill", () => {
	const skill = fs.readFileSync(bashGuidePath, "utf8");

	assert.match(skill, /^---\s*\nname: bash-guide/m);
	assert.match(skill, /settings\.json.*shellPath/i);
	assert.match(skill, /\/doctor/);
	assert.match(skill, /subagent/i);
	assert.match(skill, /不要.*反复.*which bash|avoid repeated .*which bash/i);
});

test("bundles Chrome CDP guide with broad tool-first trigger guidance", () => {
	const skill = fs.readFileSync(chromeCdpGuidePath, "utf8");

	// Run-time frontmatter parse (same parser pi uses to load the skill).
	// Guards against a bare colon in `description` breaking YAML at load time.
	const { frontmatter } = parseFrontmatter(skill);
	assert.equal(frontmatter.name, "chrome-cdp-guide");
	assert.equal(typeof frontmatter.description, "string");
	assert.ok((frontmatter.description as string).length > 0);
	assert.ok((frontmatter.description as string).length < 1024);

	assert.match(skill, /MUST use for almost every CDP-related request/);
	assert.match(skill, /If the request mentions CDP, load this skill before taking action/);
	assert.match(skill, /Prefer the chrome_cdp tool/);
	assert.match(skill, /do not control CDP through bash\/curl\/node scripts/i);
	assert.match(skill, /action=launch/);
	assert.match(skill, /Start with `chrome_cdp` `action=status`/);
});

test("npm package excludes local MCP config files", () => {
	const npmIgnore = fs.readFileSync(new URL("../.npmignore", import.meta.url), "utf8");

	assert.match(npmIgnore, /^mcp\.json$/m);
	assert.match(npmIgnore, /^\.mcp\.local\.json$/m);
});

test("MCP guide configure script merges pasted mcpServers JSON into install config", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-guide-"));
	const input = path.join(cwd, "input.json");
	fs.writeFileSync(
		input,
		JSON.stringify({
			mcpServers: {
				"funasr-transcriber": {
					command: "python",
					args: ["E:/AII/MCP-LOCAL/funasr-transcriber/server.py"],
				},
			},
		}),
	);

	const output = execFileSync(
		"python",
		[
			fileURLToPath(mcpConfigureScriptPath),
			"--scope",
			"install",
			"--package-root",
			cwd,
			"--cwd",
			cwd,
			"--input",
			input,
		],
		{ encoding: "utf8" },
	);
	const summary = JSON.parse(output);
	const configPath = path.join(cwd, "mcp.json");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

	assert.equal(summary.scope, "install");
	assert.equal(summary.server_count, 1);
	assert.equal(summary.config_path, configPath);
	assert.deepEqual(config.mcpServers["funasr-transcriber"], {
		command: "python",
		args: ["E:/AII/MCP-LOCAL/funasr-transcriber/server.py"],
	});
});
