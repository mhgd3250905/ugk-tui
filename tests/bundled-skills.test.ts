import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const skillCreatorPath = new URL("../skills/skill-creator/SKILL.md", import.meta.url);
const skillCreatorLicensePath = new URL("../skills/skill-creator/LICENSE.txt", import.meta.url);
const docxPath = new URL("../skills/docx/SKILL.md", import.meta.url);
const docxLicensePath = new URL("../skills/docx/LICENSE.txt", import.meta.url);
const mcpGuidePath = new URL("../skills/mcp-guide/SKILL.md", import.meta.url);

test("bundles Anthropic skill creator as a preinstalled skill", () => {
	const skill = fs.readFileSync(skillCreatorPath, "utf8");
	const license = fs.readFileSync(skillCreatorLicensePath, "utf8");

	assert.match(skill, /^---\s*\nname: skill-creator/m);
	assert.match(skill, /description: Create new skills, modify and improve existing skills/);
	assert.match(license, /Apache License\s+Version 2\.0/);
});

test("bundles Anthropic docx as a preinstalled skill", () => {
	const skill = fs.readFileSync(docxPath, "utf8");
	const license = fs.readFileSync(docxLicensePath, "utf8");

	assert.match(skill, /^---\s*\nname: docx/m);
	assert.match(skill, /description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents/);
	assert.match(skill, /license: Proprietary\. LICENSE\.txt has complete terms/);
	assert.ok(license.trim().length > 0);
});

test("bundles MCP guide as a preinstalled skill", () => {
	const skill = fs.readFileSync(mcpGuidePath, "utf8");

	assert.match(skill, /^---\s*\nname: mcp-guide/m);
	assert.match(skill, /description: Use when the user wants to configure or manage MCP servers in UGK/);
	assert.match(skill, /\/mcp status/);
});
