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

test("resolveRuntimeInputFromText throws when dispatcher unavailable, even in interactive mode", async () => {
	// ponytail: dispatcher 配置错误一致性 —— 交互/headless 都抛错,不偷偷退化到逐字段 UI 问。
	// 用户在场也该知道"dispatcher 没配好",要么配好要么用 field=value,不该静默降级。
	const ctx = {
		ui: {
			input() { throw new Error("should not reach UI input — dispatcher error must throw first"); },
		},
	};
	await assert.rejects(
		async () => resolveRuntimeInputFromText(ctx, "# Skill", contract, "Hello 世界"),
		/dispatcher 模型不可用/,
	);
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

test("resolveRuntimeInputFromText keeps explicit local field=value over dispatcher/default", async () => {
	// ponytail: 修 P2a。"https://x, page=2":local 抽 page=2(确定性 field=value),
	// dispatcher 抽 url。合并后 page 必须保留 2,不能被 default=1 覆盖。
	setTaskDispatcherForTests(async () => ({ url: "https://x" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", {
			runtimeInput: ["url", "page"],
			runtimeInputMeta: {
				url: { required: true },
				page: { default: 1, required: false },
			},
		}, "https://x, page=2", undefined, true);
		assert.deepEqual(value, { url: "https://x", page: 2 });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText parses explicit structured topN input locally", async () => {
	const topNContract = { runtimeInput: ["topN"] };

	// JSON 和 field=value 是确定性结构化语法,本地直接出,不调 dispatcher。
	assert.deepEqual(await resolveRuntimeInputFromText({}, "# Skill", topNContract, "{\"topN\":3}", undefined, true), { topN: 3 });
	assert.deepEqual(await resolveRuntimeInputFromText({}, "# Skill", topNContract, "topN: 3", undefined, true), { topN: 3 });
});

test("resolveRuntimeInputFromText routes natural-language topN to dispatcher", async () => {
	// ponytail: 自然语言("帮我查询知乎top3")交给 dispatcher,不在本地用正则抽。
	// 撤掉了 topN 正则捷径 —— 那是对自然语言的字符串比对,治标不治本。
	const topNContract = { runtimeInput: ["topN"] };
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return { topN: 3 }; });
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", topNContract, "帮我查询知乎top3", undefined, true);
		assert.equal(dispatcherCalled, true, "自然语言 topN 必须走 dispatcher");
		assert.deepEqual(value, { topN: 3 });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("resolveRuntimeInputFromText throws when dispatcher model is unavailable and input is natural language", async () => {
	// ponytail: dispatcher 不可用(无 model/auth)是配置错误,显式抛错 —— 不静默退化到本地正则。
	// 自然语言 input 没有 local 结构化解析兜底,必须报错让用户配 dispatcher 或改用 field=value。
	const topNContract = { runtimeInput: ["topN"] };
	// 空 ctx → findModel 返回 undefined → callDispatcher 抛"模型不可用"。
	await assert.rejects(
		() => resolveRuntimeInputFromText({}, "# Skill", topNContract, "帮我查询知乎top3", undefined, true),
		/dispatcher 模型不可用/,
	);
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
	// ponytail: 用多字段 contract 才会走到 dispatcher(单字段现在本地解析,见 single-field 测试组)。
	// 这里专门测模型解析,不测解析路径。
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("```json\n{\"text\":\"Hello 世界\",\"section\":\"技术\"}\n```")]);
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
		}, "# Skill", { runtimeInput: ["text", "section"], runtimeInputMeta: { text: {}, section: {} } }, "Hello 世界");

		assert.equal(authModel, model);
		assert.deepEqual(value, { text: "Hello 世界", section: "技术" });
		assert.equal(faux.state.callCount, 1);
	} finally {
		faux.unregister();
	}
});

test("task dispatcher uses contract dispatcherModel override when available", async () => {
	// ponytail: 多字段,强制走 dispatcher。测的是 dispatcherModel 覆盖解析,不是解析路径本身。
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("```json\n{\"text\":\"override\",\"section\":\"技术\"}\n```")]);
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
		}, "# Skill", { runtimeInput: ["text", "section"], runtimeInputMeta: { text: {}, section: {} } }, "Hello 世界", "deepseek-v4-flash");

		assert.deepEqual(findArgs, ["deepseek", "deepseek-v4-flash"]);
		assert.equal(authModel, model);
		assert.deepEqual(value, { text: "override", section: "技术" });
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

test("dispatcher unavailable (no model/auth) → throws explicitly instead of silent fallback", async () => {
	// ponytail: dispatcher 是唯一自然语言解析路径。模型/auth 不可用是配置错误,显式抛错,
	// 不再静默退化(否则会重新长出字符串比对补丁)。这个 throw 比"缺 required"更早更准。
	await assert.rejects(
		async () => resolveRuntimeInputFromText({}, "# Skill", biliContract, "https://x.com, page=2", undefined, true),
		/dispatcher 模型不可用/,
	);
});

test("required gate: contract without required:true declarations does NOT gate (legacy compat)", async () => {
	// 保守语义:只有显式 required:true 才门禁。旧式 contract(无 required 字段)不门禁,
	// 保持旧行为不变——部分输入不会被拦截,不会从软失败变成硬失败。
	// 这是回归保护:防止"激活 required"误伤所有旧 taskbook。
	const legacyContract = { runtimeInput: ["text", "section"] };
	setTaskDispatcherForTests(async () => ({ text: "from-dispatcher", section: "x" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", legacyContract, "some natural language");
		assert.deepEqual(value, { text: "from-dispatcher", section: "x" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: legacy contract with partial input does NOT throw in headless (no required field gated)", async () => {
	// 关键回归保护:旧式 contract(runtimeInput 有多个字段,但都没声明 required:true),
	// 输入只抽到部分字段。改之前(bf0ed04^):静默返回部分结果。
	// 改之后(bf0ed04):误判成必填 → headless 抛错(破坏旧行为)。
	// 本修复:保守语义,无 required:true 不门禁 → 不抛错,返回部分结果(补 default)。
	const legacyMultiContract = {
		runtimeInput: ["a", "b"],
		// 无 runtimeInputMeta,或 meta 里没有 required:true
	};
	// dispatcher 不可用,local 只抽到 a(URL 不是 field=value,但 a=... 能抽)
	// 这模拟"用户输入不完整 + dispatcher 也补不全"的真实场景
	const value = await resolveRuntimeInputFromText({}, "# Skill", legacyMultiContract, "a=hello", undefined, true);
	// 不抛错,返回部分结果 {a:hello}(无 default 可补,b 缺失但不是门禁字段)
	assert.deepEqual(value, { a: "hello" });
});

// === dispatcher 是唯一参数解析路径 ===
// 设计:裸值、自然语言、结构化输入一律交给 dispatcher(reasoningEffort=medium + 明确映射 prompt)。
// 本地只接明确的 "field=value" 和 JSON(确定性解析,不是猜)。撤掉了之前的单字段裸值捷径
// —— 那是针对特定 contract 形态打补丁,强化 dispatcher 后不需要。
// 下面这组用 dispatcher mock 验证:这些输入确实路由到 dispatcher,且 prompt 把映射规则讲清楚了。

test("bare URL routes to dispatcher (no local shortcut)", async () => {
	// 报告场景:bilibili_url = 裸 URL。强化前 local 解析失败 + dispatcher(minimal)抽不出 → 报错。
	// 现在:裸 URL 交给 dispatcher,它按字段名/描述判断裸值归属。
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return { bilibili_url: "https://www.bilibili.com/video/BV1g87a69Ere/" }; });
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill",
			{ runtimeInput: ["bilibili_url"], runtimeInputMeta: { bilibili_url: { required: true } } },
			"https://www.bilibili.com/video/BV1g87a69Ere/",
			undefined, true);
		assert.equal(dispatcherCalled, true, "裸 URL 必须走 dispatcher");
		assert.deepEqual(value, { bilibili_url: "https://www.bilibili.com/video/BV1g87a69Ere/" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("multi-field bare URL routes to dispatcher (spider: url + page default)", async () => {
	// 报告场景:bili-up-homepage-spider 双字段 url(required) + page(default=1)。
	// dispatcher 拿 contract 说明书,裸 URL 映射到 url,page 补 default。
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return { url: "https://space.bilibili.com/12890453/upload/video" }; });
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill",
			{
				runtimeInput: ["url", "page"],
				runtimeInputMeta: {
					url: { description: "B站UP主主页视频链接", required: true },
					page: { description: "页码,从1开始", required: false, default: 1 },
				},
			},
			"https://space.bilibili.com/12890453/upload/video",
			undefined, true);
		assert.equal(dispatcherCalled, true);
		assert.deepEqual(value, {
			url: "https://space.bilibili.com/12890453/upload/video",
			page: 1, // default 补上
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("natural language with embedded URL routes to dispatcher", async () => {
	// "下载这个 https://x" → dispatcher 从句子里抽 url,不把整句当字段值。
	let dispatcherCalled = false;
	setTaskDispatcherForTests(async () => { dispatcherCalled = true; return { url: "https://x" }; });
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill",
			{ runtimeInput: ["url"] },
			"下载这个 https://x",
			undefined, true);
		assert.equal(dispatcherCalled, true);
		assert.deepEqual(value, { url: "https://x" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("buildTaskDispatcherPrompt instructs bare-value mapping and natural-language extraction", () => {
	// 验证强化后的 prompt 把映射规则讲清楚:裸值归字段、自然语言抽真值、别编造。
	const prompt = buildTaskDispatcherPrompt("# Skill", { runtimeInput: ["url", "page"] }, "https://x");
	assert.match(prompt, /裸值.*按字段名或 description.*判断/);
	assert.match(prompt, /自然语言句子.*抽出字段的真实值/);
	assert.match(prompt, /不要.*当字段值/);
	assert.match(prompt, /不要编造/);
});
