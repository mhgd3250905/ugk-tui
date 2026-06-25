import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import {
	buildTaskDispatcherPrompt,
	extractRuntimeInputFromText,
	resolveRuntimeInputFromText,
	setTaskDispatcherForTests,
} from "../extensions/task/task-dispatcher.ts";

const contract = {
	runtimeInput: ["text"],
	runtimeInputMeta: { text: { type: "string", default: "text" } },
	artifacts: [],
};

test("task dispatcher prompt includes skill contract and raw input", () => {
	const prompt = buildTaskDispatcherPrompt("# Skill", contract, "Hello 世界");

	assert.match(prompt, /contract\.runtimeInput/);
	assert.match(prompt, /runtimeInputMeta/);
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
	assert.deepEqual(asks, [{ title: "task input: text (default: text)", value: "text" }]);
});

test("resolveRuntimeInputFromText merges dispatcher output with defaults", async () => {
	setTaskDispatcherForTests(async () => ({ text: "Hello 世界" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", {
			runtimeInput: ["text", "section"],
			runtimeInputMeta: {
				text: { type: "string" },
				section: { type: "string", default: "技术", required: false },
			},
		}, "Hello 世界");

		assert.deepEqual(value, { text: "Hello 世界", section: "技术" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText parses explicit topN input before dispatcher", async () => {
	const topNContract = { runtimeInput: ["topN"] };

	assert.deepEqual(await resolveRuntimeInputFromText({}, "# Skill", topNContract, "{\"topN\":3}", undefined, true), { topN: 3 });
	assert.deepEqual(await resolveRuntimeInputFromText({}, "# Skill", topNContract, "topN: 3", undefined, true), { topN: 3 });
	assert.deepEqual(await resolveRuntimeInputFromText({}, "# Skill", topNContract, "帮我查询知乎top3", undefined, true), { topN: 3 });
});

test("resolveRuntimeInputFromText uses complete defaults for empty headless input", async () => {
	const value = await resolveRuntimeInputFromText({}, "# Skill", {
		runtimeInput: ["answerCount"],
		runtimeInputMeta: { answerCount: { default: 20 } },
	}, "", undefined, true);

	assert.deepEqual(value, { answerCount: 20 });
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

// === required 门禁测试 ===
// 复现报告场景:contract 有 url(required) + page(optional, default:1)。
// 验证 local 部分命中(只抽到 page)时不再 short-circuit,会让 dispatcher 补全 required 的 url。
const biliContract = {
	runtimeInput: ["url", "page"],
	runtimeInputMeta: {
		url: { description: "B站UP主主页视频链接", required: true },
		page: { description: "页码,从1开始", required: false, default: 1 },
	},
};

test("required gate: local partial hit (page only) falls through to dispatcher to fill url", async () => {
	// 模拟 dispatcher 能从 "URL, page=1" 里抽出 url
	setTaskDispatcherForTests(async () => ({ url: "https://space.bilibili.com/12890453/upload/video" }));
	try {
		// 输入 "URL, page=1":local 只抽到 page,缺 required 的 url → 走 dispatcher 补全
		const value = await resolveRuntimeInputFromText({}, "# Skill", biliContract, "https://space.bilibili.com/12890453/upload/video, page=1");

		// 结果必须同时含 url(dispatcher 补) 和 page(local 抽),且 page 补 default 后仍是 1
		assert.deepEqual(value, {
			url: "https://space.bilibili.com/12890453/upload/video",
			page: 1,
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: full local hit (url + page) skips dispatcher entirely", async () => {
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return {}; });
	try {
		// 输入 "url=... page=1":local 抽全 required → 直接返回,dispatcher 不该被调用
		const value = await resolveRuntimeInputFromText({}, "# Skill", biliContract, "url=https://space.bilibili.com/12890453/upload/video page=1");

		assert.equal(dispatcherCalled, false);
		assert.deepEqual(value, {
			url: "https://space.bilibili.com/12890453/upload/video",
			page: 1,
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: bare URL (local undefined) still routes to dispatcher", async () => {
	setTaskDispatcherForTests(async () => ({ url: "https://space.bilibili.com/12890453/upload/video" }));
	try {
		// 裸 URL:local 抽不出任何 field=value → undefined → 走 dispatcher
		const value = await resolveRuntimeInputFromText({}, "# Skill", biliContract, "https://space.bilibili.com/12890453/upload/video");

		assert.deepEqual(value, {
			url: "https://space.bilibili.com/12890453/upload/video",
			page: 1,
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: dispatcher unavailable and partial missing required → throws in headless mode", async () => {
	// dispatcher 不可用、local 只抽到 page 但缺 required 的 url → headless 抛错
	// 修复前会静默返回 {page:2} 导致下游 worker 拿不到 url 而 hardcode/猜值
	await assert.rejects(
		async () => resolveRuntimeInputFromText({}, "# Skill", biliContract, "https://x.com, page=2", undefined, true),
		/未能从输入解析出必填字段: url/,
	);
});

test("required gate: contract without required declarations keeps legacy behavior", async () => {
	// 旧式 contract(无 required 字段):所有字段视为必填(default required:true)
	// local 抽到部分仍会走 dispatcher 补全 —— 但这里测无 runtimeInputMeta 的情况
	const legacyContract = { runtimeInput: ["text"] };
	setTaskDispatcherForTests(async () => ({ text: "from-dispatcher" }));
	try {
		// 无 field=value 格式 → local undefined → dispatcher
		const value = await resolveRuntimeInputFromText({}, "# Skill", legacyContract, "some natural language");
		assert.deepEqual(value, { text: "from-dispatcher" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});
