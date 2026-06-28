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

// === required 门禁升级:字段值有效性(x-search 试金石踩出的坑)===
// 复现场景:dispatcher 输出的 JSON 合法,但某个 required 字段的值是无意义残片字符串
// (如 timeWindow:"{mode:")。旧 coversRequired 只看 key 存在 → 放行 → worker 拿到残片现编默认。
// 新 coversRequired 要求 required 字段"存在且值有效" → 残片视为解析失败 → headless 抛错。

const timeWindowContract = {
	runtimeInput: ["keyword", "startIso", "endIso"],
	runtimeInputMeta: {
		keyword: { description: "搜索关键词", required: true },
		startIso: { description: "窗口起 ISO", required: true },
		endIso: { description: "窗口止 ISO", required: true },
	},
};

test("required gate: dispatcher returns valid values → passes through", async () => {
	// 基线:三个 required 字段都有有效值,正常返回。
	setTaskDispatcherForTests(async () => ({
		keyword: "medtrum",
		startIso: "2026-06-15T00:00:00.000Z",
		endIso: "2026-06-22T00:00:00.000Z",
	}));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", timeWindowContract, "medtrum 上周", undefined, true);
		assert.deepEqual(value, {
			keyword: "medtrum",
			startIso: "2026-06-15T00:00:00.000Z",
			endIso: "2026-06-22T00:00:00.000Z",
		});
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: dispatcher returns a field with truncated-string value → throws (not passes through)", async () => {
	// ponytail: 机制层能抓的是"空值/缺失"。纯字符串残片(如 "{mode:") 对机制层是合法非空字符串,
	// 无法通用判别 —— 那是 verify 产物层的职责(校验 startIso 能否 parse 成日期)。
	// 这里测机制层能抓的:空对象值(dispatcher 想输出嵌套对象但没填内容)。
	const objectFieldContract = {
		runtimeInput: ["config"],
		runtimeInputMeta: { config: { description: "配置对象", required: true } },
	};
	setTaskDispatcherForTests(async () => ({ config: {} })); // 空对象 = 无效
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", objectFieldContract, "xxx", undefined, true),
			/字段值无效.*config/,
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: dispatcher returns empty-string value → throws", async () => {
	// 空字符串/纯空白也算无效值(dispatcher 没真正算出东西)。
	setTaskDispatcherForTests(async () => ({
		keyword: "medtrum",
		startIso: "   ", // 纯空白
		endIso: "2026-06-22T00:00:00.000Z",
	}));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", timeWindowContract, "medtrum 上周", undefined, true),
			/字段值无效.*startIso/,
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: dispatcher returns empty object value → throws", async () => {
	// 空对象 {} 也算无效(嵌套对象字段 dispatcher 没填内容)。
	const objectFieldContract = {
		runtimeInput: ["config"],
		runtimeInputMeta: { config: { description: "配置对象", required: true } },
	};
	setTaskDispatcherForTests(async () => ({ config: {} }));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", objectFieldContract, "xxx", undefined, true),
			/字段值无效.*config/,
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: error message distinguishes missing vs invalid fields", async () => {
	// ponytail: 报错要精准 —— 缺字段说缺,值无效说无效,不混淆。
	// keyword 缺失,startIso 是空白。报错应同时指出两者,且措辞区分。
	setTaskDispatcherForTests(async () => ({
		startIso: "   ", // 无效(空白)
		endIso: "2026-06-22T00:00:00.000Z",
		// keyword 缺失
	}));
	try {
		await assert.rejects(
			() => resolveRuntimeInputFromText({}, "# Skill", timeWindowContract, "xxx", undefined, true),
			(err: Error) => {
				assert.match(err.message, /缺失字段.*keyword/, "报错应指出缺失的 keyword");
				assert.match(err.message, /字段值无效.*startIso/, "报错应指出无效的 startIso");
				return true;
			},
		);
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("required gate: valid non-required field with empty value does NOT trigger gate", async () => {
	// ponytail: 门禁只管 required 字段。非 required 字段值无效(如空串)不该触发门禁,
	// 它会走 default 补全或原样保留。这是"required 门禁"语义,不是"所有字段都校验"。
	const mixedContract = {
		runtimeInput: ["keyword", "note"],
		runtimeInputMeta: {
			keyword: { required: true },
			note: { required: false, default: "" },
		},
	};
	setTaskDispatcherForTests(async () => ({ keyword: "x", note: "" }));
	try {
		const value = await resolveRuntimeInputFromText({}, "# Skill", mixedContract, "x", undefined, true);
		// note 是空串但非 required → 不门禁,正常返回
		assert.deepEqual(value, { keyword: "x", note: "" });
	} finally {
		setTaskDispatcherForTests(undefined);
	}
});

test("buildTaskDispatcherPrompt emphasizes LLM compute capability and complete output", () => {
	// ponytail: 验证强化后的 prompt 告诉 dispatcher 它能算 + 必须输出完整值。
	// 这是配合机制层门禁的源头治理:让 dispatcher 少产出残片。
	const prompt = buildTaskDispatcherPrompt("# Skill", { runtimeInput: ["startIso"] }, "上周");
	assert.match(prompt, /推理与计算/, "prompt 应说明 dispatcher 能算日期/推理");
	assert.match(prompt, /完整.*有效/, "prompt 应要求输出完整有效值");
	assert.match(prompt, /截断|半成品/, "prompt 应禁止截断/半成品输出");
});

test("buildTaskDispatcherPrompt injects the real current date so dispatcher computes relative times correctly", () => {
	// ponytail: 真实 bug —— dispatcher 算"上周"猜成 16 个月前(用训练数据日期)。
	// 修复:prompt 注入当前 UTC ISO + 本地时间 + 星期几,让相对时间算得准。
	// 这是机制层修复:任何需要算日期的 taskbook 都受益。
	const prompt = buildTaskDispatcherPrompt("# Skill", { runtimeInput: ["startIso"] }, "上周");
	const now = new Date();
	const expectedIsoPrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD
	assert.match(prompt, /当前时间.*算相对时间时必须以此为基准/, "prompt 应明示当前时间作为计算基准");
	assert.ok(prompt.includes(expectedIsoPrefix), "prompt 应含真实当前日期 " + expectedIsoPrefix);
	assert.match(prompt, /星期几|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/, "prompt 应提供星期几(用于判断自然周边界)");
});
