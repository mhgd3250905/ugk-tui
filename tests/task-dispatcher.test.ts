import test from "node:test";
import assert from "node:assert/strict";
import {
	buildTaskDispatcherPrompt,
	extractRuntimeInputFromText,
	resolveRuntimeInputFromText,
	setTaskDispatcherForTests,
} from "../extensions/task/task-dispatcher.ts";

const contract = { runtimeInput: ["text"], artifacts: [] };

test("task dispatcher prompt includes skill contract and raw input", () => {
	const prompt = buildTaskDispatcherPrompt("# Skill", contract, "Hello 世界");

	assert.match(prompt, /contract\.runtimeInput/);
	assert.match(prompt, /Hello 世界/);
	assert.match(prompt, /# Skill/);
});

test("extractRuntimeInputFromText parses fenced json", () => {
	assert.deepEqual(extractRuntimeInputFromText("```json\n{\"text\":\"Hello 世界\"}\n```"), { text: "Hello 世界" });
	assert.equal(extractRuntimeInputFromText("not json"), undefined);
});

test("resolveRuntimeInputFromText asks fields when dispatcher is unavailable", async () => {
	const asks: Array<{ title: string; value: string }> = [];
	const ctx = {
		ui: {
			input(title: string, value: string) {
				asks.push({ title, value });
				return `asked-${value}`;
			},
		},
	};
	const value = await resolveRuntimeInputFromText(ctx, "# Skill", contract, "Hello 世界");

	assert.deepEqual(value, { text: "asked-text" });
	assert.deepEqual(asks, [{ title: "task input: text", value: "text" }]);
});

test("resolveRuntimeInputFromText uses dispatcher result for natural language input", async () => {
	setTaskDispatcherForTests(async () => ({ url: "https://b23.tv/xxx" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", { runtimeInput: ["url"] }, "把这个下下来 https://b23.tv/xxx");
		assert.deepEqual(value, { url: "https://b23.tv/xxx" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});
