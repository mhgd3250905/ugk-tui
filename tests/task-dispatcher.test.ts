import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
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

test("task dispatcher uses the current session model", async () => {
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("```json\n{\"text\":\"Hello 世界\"}\n```")]);
	const model = faux.getModel();
	let authModel;
	try {
		const value = await resolveRuntimeInputFromText({
			model,
			modelRegistry: {
				async getApiKeyAndHeaders(candidate: unknown) {
					authModel = candidate;
					return { ok: true, apiKey: "sk-test", headers: { "x-test": "1" } };
				},
			},
		}, "# Skill", contract, "Hello 世界");

		assert.equal(authModel, model);
		assert.deepEqual(value, { text: "Hello 世界" });
		assert.equal(faux.state.callCount, 1);
	} finally {
		faux.unregister();
	}
});

test("task dispatcher uses contract dispatcherModel override when available", async () => {
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("```json\n{\"text\":\"override\"}\n```")]);
	const model = faux.getModel();
	let findArgs: unknown[] | undefined;
	let authModel;
	try {
		const value = await resolveRuntimeInputFromText({
			model: { id: "fallback" },
			modelRegistry: {
				find(provider: string, modelId: string) {
					findArgs = [provider, modelId];
					return model;
				},
				async getApiKeyAndHeaders(candidate: unknown) {
					authModel = candidate;
					return { ok: true, apiKey: "sk-test", headers: {} };
				},
			},
		}, "# Skill", contract, "Hello 世界", "deepseek-v4-flash");

		assert.deepEqual(findArgs, ["deepseek", "deepseek-v4-flash"]);
		assert.equal(authModel, model);
		assert.deepEqual(value, { text: "override" });
	} finally {
		faux.unregister();
	}
});
