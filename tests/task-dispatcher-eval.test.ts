// dispatcher eval 框架的离线机制单测。
// 不调真实 LLM —— 只钉两件事:
//   1. 通用评判器(judgeField/judgeCase)对所有原语的判定正确,含 omitted 关键原语
//   2. buildTaskDispatcherPrompt 在真实 taskbook fixture 下正确注入 contract 内容
// 真实 LLM 翻译质量由 scripts/eval-dispatcher.mjs 手动跑,不进 npm test。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgeField, judgeCase } from "../scripts/eval-dispatcher.mjs";
import { buildTaskDispatcherPrompt } from "../extensions/task/task-dispatcher.ts";

// ===== 评判器原语正确性 =====

test("judgeField: equals 匹配字符串", () => {
	assert.deepEqual(judgeField("en", true, "equals:en"), { ok: true, detail: "=en" });
	assert.equal(judgeField("ru", true, "equals:en").ok, false);
});

test("judgeField: equals 匹配数字(实际值 stringify 后比较)", () => {
	// ponytail: dispatcher 解析出的 JSON 数字 720,String(720)==="720",与 rule arg 字符串比较。
	assert.equal(judgeField(720, true, "equals:720").ok, true);
	assert.equal(judgeField(1080, true, "equals:720").ok, false);
});

test("judgeField: path-equals 归一化斜杠后比较(Windows 路径等价)", () => {
	// ponytail: Windows 上 dispatcher 可能把 E:/a/b 翻成 E:\\a\\b(等价路径)。
	// 严格 equals 会误判;path-equals 全转 / 后比,消除这种非确定性假阴性。
	assert.equal(judgeField("E:/subs/x.srt", true, "path-equals:E:/subs/x.srt").ok, true);
	assert.equal(judgeField("E:\\subs\\x.srt", true, "path-equals:E:/subs/x.srt").ok, true);
	assert.equal(judgeField("E:/subs/x.srt", true, "path-equals:E:\\subs\\x.srt").ok, true);
	assert.equal(judgeField("E:/other.srt", true, "path-equals:E:/subs/x.srt").ok, false);
	assert.equal(judgeField(undefined, false, "path-equals:E:/subs/x.srt").ok, false);
});

test("judgeField: omitted 字段不存在 = 通过,存在 = 失败", () => {
	// 核心原语:可选字段省略(走自动策略)vs 显式输出(走用户指定)对下游行为不同。
	assert.equal(judgeField(undefined, false, "omitted").ok, true);
	assert.equal(judgeField(1080, true, "omitted").ok, false);
	assert.equal(judgeField("none", true, "omitted").ok, false);
});

test("judgeField: absent 是 omitted 的别名", () => {
	assert.equal(judgeField(undefined, false, "absent").ok, true);
	assert.equal(judgeField(1080, true, "absent").ok, false);
});

test("judgeField: present 字段存在且有效 = 通过", () => {
	assert.equal(judgeField("en", true, "present").ok, true);
	assert.equal(judgeField(720, true, "present").ok, true);
	// 空值视为无效(与 dispatcher isValidRuntimeValue 一致)
	assert.equal(judgeField("", true, "present").ok, false);
	assert.equal(judgeField("   ", true, "present").ok, false);
	assert.equal(judgeField({}, true, "present").ok, false);
	assert.equal(judgeField(undefined, false, "present").ok, false);
});

test("judgeField: in 枚举匹配", () => {
	assert.equal(judgeField("none", true, "in:none|chrome").ok, true);
	assert.equal(judgeField("chrome", true, "in:none|chrome").ok, true);
	assert.equal(judgeField("firefox", true, "in:none|chrome").ok, false);
	assert.equal(judgeField(undefined, false, "in:none|chrome").ok, false);
});

test("judgeField: in 含 omitted 成员时,字段省略也算通过", () => {
	// ponytail: 有 default 的字段,dispatcher 省略它和显式输出 default 值行为等价。
	// 用 "in:omitted|transcribe" 表示"省略或 transcribe 都算对"。
	assert.equal(judgeField(undefined, false, "in:omitted|transcribe").ok, true);
	assert.equal(judgeField("transcribe", true, "in:omitted|transcribe").ok, true);
	assert.equal(judgeField("translate", true, "in:omitted|transcribe").ok, false);
	// 不含 omitted 成员时,字段省略仍判 FAIL(保持原语义)
	assert.equal(judgeField(undefined, false, "in:none|chrome").ok, false);
});

test("judgeField: 未知原语 = 失败(防拼写错误静默通过)", () => {
	const r = judgeField("x", true, "mathes:x"); // 拼写错误
	assert.equal(r.ok, false);
	assert.match(r.detail, /未知评判原语/);
});

// ===== judgeCase 整体判定 =====

test("judgeCase: 全字段通过 = ok", () => {
	const result = judgeCase({ url: "https://x", subLangs: "en" }, true, {
		url: "equals:https://x",
		maxHeight: "omitted",
		subLangs: "equals:en",
	});
	assert.equal(result.ok, true);
});

test("judgeCase: 任一字段失败 = 不 ok,且 fieldResults 标出失败字段", () => {
	const result = judgeCase({ url: "https://x", maxHeight: 1080 }, true, {
		url: "equals:https://x",
		maxHeight: "omitted", // 失败:存在 1080
		subLangs: "omitted",
	});
	assert.equal(result.ok, false);
	const failed = result.fieldResults.filter((f) => !f.ok);
	assert.equal(failed.length, 1);
	assert.equal(failed[0].field, "maxHeight");
});

test("judgeCase: dispatcher 无有效输出(parsedOk=false)= 整体失败", () => {
	const result = judgeCase(undefined, false, { url: "equals:https://x" });
	assert.equal(result.ok, false);
});

test("judgeCase: __outcome fails-required-gate — 解析失败时通过,解析成功时失败", () => {
	// 用例 13:required url 缺失,期望 dispatcher 解析失败
	const failOk = judgeCase(undefined, false, { __outcome: "fails-required-gate" });
	assert.equal(failOk.ok, true);
	const unexpectedPass = judgeCase({ url: "https://x" }, true, { __outcome: "fails-required-gate" });
	assert.equal(unexpectedPass.ok, false);
});

test("judgeCase: omitted 在多字段 contract 里精准定位(回归保护)", () => {
	// 模拟 dispatcher 把"高清"错误映射成 1080 —— omitted 断言必须抓住这个翻译错误
	const result = judgeCase({ url: "https://x", maxHeight: 1080 }, true, {
		url: "equals:https://x",
		maxHeight: "omitted",
		subLangs: "omitted",
		cookiesFromBrowser: "omitted",
	});
	assert.equal(result.ok, false);
	const failed = result.fieldResults.find((f) => f.field === "maxHeight");
	assert.ok(failed);
	assert.equal(failed.ok, false);
	assert.match(failed.detail, /期望 omitted.*实际存在 1080/);
});

// ===== prompt 注入回归(video-downloader fixture)=====

const fixtureDir = fileURLToPath(new URL("./fixtures/taskbooks/video-downloader/", import.meta.url));

test("buildTaskDispatcherPrompt 注入 video-downloader contract 的字段名和 allowedValues", async () => {
	const contract = JSON.parse(await readFile(path.join(fixtureDir, "contract.json"), "utf8"));
	const prompt = buildTaskDispatcherPrompt("# skill", contract, "下载 https://x 高清");

	// 字段名注入(dispatcher 据此抽取)
	assert.match(prompt, /url/);
	assert.match(prompt, /maxHeight/);
	assert.match(prompt, /subLangs/);
	assert.match(prompt, /cookiesFromBrowser/);
	// allowedValues 注入(dispatcher 据此约束 cookiesFromBrowser)
	assert.match(prompt, /chrome/);
	// description 注入(dispatcher 据此判断"高清"该怎么处理)
	assert.match(prompt, /分辨率|height/i);
});

test("buildTaskDispatcherPrompt 把用户原始输入带进 prompt", async () => {
	const contract = JSON.parse(await readFile(path.join(fixtureDir, "contract.json"), "utf8"));
	const prompt = buildTaskDispatcherPrompt("# skill", contract, "下载 https://youtu.be/xxx 高清");
	assert.match(prompt, /下载 https:\/\/youtu\.be\/xxx 高清/);
});

// ===== cases fixture 结构完整性 =====

test("video-downloader.cases.json 结构完整且用例 id 唯一", async () => {
	const casesFile = JSON.parse(await readFile(new URL("./fixtures/dispatcher-evals/video-downloader.cases.json", import.meta.url), "utf8"));
	const cases = casesFile.cases;
	assert.ok(Array.isArray(cases) && cases.length > 0, "cases 应非空数组");
	const ids = cases.map((c) => c.id);
	assert.equal(new Set(ids).size, ids.length, "用例 id 必须唯一");
	for (const c of cases) {
		assert.ok(c.id, "每条用例必须有 id");
		assert.ok(typeof c.input === "string" && c.input.length > 0, `${c.id} 必须有 input`);
		assert.ok(c.group, `${c.id} 必须有 group`);
		// judged 用例必须有 assert;open 用例必须有 expected:"open"
		if (c.expected === "open") continue;
		assert.ok(c.assert && typeof c.assert === "object", `${c.id} 必须有 assert`);
	}
});

test("video-downloader cases 的 open 用例不计入 judged(标记正确)", async () => {
	const casesFile = JSON.parse(await readFile(new URL("./fixtures/dispatcher-evals/video-downloader.cases.json", import.meta.url), "utf8"));
	const openCases = casesFile.cases.filter((c) => c.expected === "open");
	const judgedCases = casesFile.cases.filter((c) => c.expected !== "open");
	// open 用例不该有 assert(它是观察用,断言未知)
	for (const c of openCases) {
		assert.equal(c.assert, undefined, `open 用例 ${c.id} 不应有 assert`);
	}
	// judged 用例必须有 assert
	for (const c of judgedCases) {
		assert.ok(c.assert, `judged 用例 ${c.id} 必须有 assert`);
	}
});
