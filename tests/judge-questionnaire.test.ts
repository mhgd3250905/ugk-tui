import test from "node:test";
import assert from "node:assert/strict";
import registerQuestionnaire from "../extensions/judge/questionnaire.ts";

function makeQuestionnaireTool() {
	let tool: any;
	registerQuestionnaire({
		registerTool(registered: any) {
			tool = registered;
		},
	} as any);
	return tool;
}

function makeCtx(mode = "tui") {
	const selections: Array<{ title: string; options: string[] }> = [];
	const editorCalls: Array<{ title: string; value: string }> = [];
	return {
		selections,
		editorCalls,
		ctx: {
			mode,
			ui: {
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return options[0];
				},
				editor(title: string, value: string) {
					editorCalls.push({ title, value });
					return "custom answer";
				},
			},
		},
	};
}

test("questionnaire maps duplicate labels by stable display selection", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx, selections } = makeCtx();
	ctx.ui.select = (title: string, options: string[]) => {
		selections.push({ title, options });
		return options[1];
	};

	const result = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "scope",
					prompt: "Pick scope",
					options: [
						{ value: "first", label: "Same" },
						{ value: "second", label: "Same" },
					],
					allowOther: false,
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.deepEqual(result.details.answers[0], {
		id: "scope",
		value: "second",
		label: "Same",
		wasCustom: false,
		index: 2,
	});
});

test("questionnaire does not treat a real Type something. option as custom", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx, editorCalls } = makeCtx();

	const result = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "mode",
					prompt: "Pick mode",
					options: [{ value: "literal-other-label", label: "Type something." }],
					allowOther: true,
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.deepEqual(result.details.answers[0], {
		id: "mode",
		value: "literal-other-label",
		label: "Type something.",
		wasCustom: false,
		index: 1,
	});
	assert.equal(editorCalls.length, 0);
});

test("questionnaire allowOther selection uses editor and returns custom answer", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx, selections, editorCalls } = makeCtx();
	ctx.ui.select = (title: string, options: string[]) => {
		selections.push({ title, options });
		return options.at(-1)!;
	};

	const result = await tool.execute(
		"call-1",
		{
			questions: [
				{
					id: "detail",
					prompt: "Add detail",
					options: [{ value: "preset", label: "Preset" }],
					allowOther: true,
				},
			],
		},
		undefined,
		undefined,
		ctx,
	);

	assert.deepEqual(result.details.answers[0], {
		id: "detail",
		value: "custom answer",
		label: "custom answer",
		wasCustom: true,
	});
	assert.deepEqual(editorCalls, [{ title: "Add detail", value: "" }]);
});

test("questionnaire returns cancelled error outside tui mode", async () => {
	const tool = makeQuestionnaireTool();
	const { ctx } = makeCtx("print");

	const result = await tool.execute(
		"call-1",
		{ questions: [{ id: "x", prompt: "X", options: [{ value: "x", label: "X" }] }] },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(result.details.cancelled, true);
	assert.match(result.content[0].text, /UI not available/);
});
