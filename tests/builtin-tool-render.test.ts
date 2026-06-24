import assert from "node:assert/strict";
import test from "node:test";
import registerBuiltinToolRenderers from "../extensions/builtin-tool-render.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_style: string, text: string) => text,
};

function renderText(component: { render(width: number): string[] }): string {
	return component.render(120).join("\n").trimEnd();
}

test("builtin renderer registers only bash and edit", () => {
	const tools: any[] = [];
	registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);

	assert.deepEqual(tools.map((tool) => tool.name), ["bash", "edit"]);
	assert.equal(tools[1].renderShell, "self");
});

test("bash renderer summarizes success and failure output", () => {
	const tools: any[] = [];
	registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);
	const bash = tools.find((tool) => tool.name === "bash");

	const success = bash.renderResult(
		{ content: [{ type: "text", text: "one\ntwo\n" }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		{},
	);
	assert.equal(renderText(success), "done (2 lines)");

	const failure = bash.renderResult(
		{ content: [{ type: "text", text: "bad\n\nCommand exited with code 2" }], details: {}, isError: true },
		{ expanded: false, isPartial: false },
		theme,
		{},
	);
	assert.equal(renderText(failure), "exit 2 (2 lines)");
});

test("bash renderer falls back to red exit when error output has no code", () => {
	const tools: any[] = [];
	registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);
	const bash = tools.find((tool) => tool.name === "bash");

	const failure = bash.renderResult(
		{ content: [{ type: "text", text: "Command failed before exit code was known" }], details: {}, isError: true },
		{ expanded: false, isPartial: false },
		theme,
		{},
	);

	assert.equal(renderText(failure), "exit 1 (1 lines)");
});

test("edit renderer summarizes diff stats", () => {
	const tools: any[] = [];
	registerBuiltinToolRenderers({ registerTool: (tool: any) => tools.push(tool) } as any);
	const edit = tools.find((tool) => tool.name === "edit");

	const summary = edit.renderResult(
		{
			content: [{ type: "text", text: "Applied" }],
			details: { diff: "--- a/file\n+++ b/file\n-old\n+new\n+extra\n context" },
		},
		{ expanded: false, isPartial: false },
		theme,
		{},
	);

	assert.equal(renderText(summary), "+2 / -1");
});
