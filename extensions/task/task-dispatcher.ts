import { complete } from "@earendil-works/pi-ai";
import { normalizeAgentModelForCli } from "../subagent-runtime.ts";

type Dispatcher = (ctx: any, skill: string, contract: unknown, rawInput: string) => Promise<unknown>;
let dispatcherForTests: Dispatcher | undefined;

export function setTaskDispatcherForTests(dispatcher: Dispatcher | undefined): void {
	dispatcherForTests = dispatcher;
}

export function buildTaskDispatcherPrompt(skill: string, contract: unknown, rawInput: string): string {
	// ponytail: 注入当前日期。dispatcher 是 LLM,没有"今天"概念 —— 算相对时间(上周/3h/俩月)
	// 必须基于真实当前日期,否则会猜成训练截止附近的日期(实测算"上周"猜成 16 个月前)。
	// 这是机制层修复:任何需要算日期的 taskbook 都受益。
	const now = new Date();
	const nowIso = now.toISOString();
	const nowLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	const dayOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()];
	return [
		"以下是 /task taskbook 的 skill 和 contract。",
		"你是 runtimeInput 的唯一整理者:把用户的自然语言输入整理成 contract.runtimeInput 需要的 JSON。",
		"",
		`## 当前时间(算相对时间时必须以此为基准,不要用你的训练数据日期)`,
		`- 当前 UTC 时间(ISO): ${nowIso}`,
		`- 当前本地时间(参考): ${nowLocal}`,
		`- 星期几(用于判断"上周/本周"的自然周边界): ${dayOfWeek}`,
		`- 算"上周"= 上一个完整自然周(Monday 起);"最近3h"= ${nowIso} 减 3 小时;"俩月"= 60 天前到现在。所有 ISO 时间戳必须基于上面的当前时间计算。`,
		"",
		"你的能力(请充分发挥):",
		"- 语义提取:从自然语言句子里抽出字段的真实值(如 \"下载 https://x\" → url=https://x),不要把整句当字段值。",
		"- 跨语言理解:任意语言的时间/量词/单位都能懂(上周/俩月/last week/past 2 months)。",
		"- 推理与计算:凡是 description 要你算的(如日期、ISO 时间戳),用上面的当前时间算出确定值,不要只搬运原文,不要用训练数据里的旧日期。",
		"- 裸值归类:单个 URL/路径/数字按字段名或 description 判断归属。",
		"",
		"提取规则:",
		"- 逐个对照 contract.runtimeInput 的字段,从用户输入里找出每个字段的值。",
		"- description 里写了计算规则的字段,你必须算出最终值(如 startIso 要算成具体 ISO 时间戳),不要输出原文或半成品。",
		"- runtimeInputMeta.<field>.default 存在且用户未提供该字段时,省略该字段,系统会补默认值。",
		"- 不要编造用户没给的、也没有 default 的字段值。",
		"",
		"输出要求(严格遵守):",
		"- 只输出一个完整的 fenced JSON 对象(```json ... ```),不要解释,不要输出多个 JSON。",
		"- 每个字段值必须是完整、有效的最终值 —— 不要输出截断的、半成品的、占位的值。",
		"- 若某个 required 字段你无法从输入确定值,省略它(系统会判定为解析失败并报错,这比输出错误值好)。",
		"",
		"## skill.md",
		skill,
		"",
		"## contract.json",
		JSON.stringify(contract, null, "\t"),
		"",
		"## 用户输入",
		rawInput,
	].join("\n");
}

function parseCandidate(candidate: string): unknown | undefined {
	try {
		const value = JSON.parse(candidate);
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function extractRuntimeInputFromText(text: string): unknown | undefined {
	const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of text.matchAll(fencedPattern)) {
		const parsed = parseCandidate(match[1].trim());
		if (parsed) return parsed;
	}
	const trimmed = text.trim();
	const direct = parseCandidate(trimmed);
	if (direct) return direct;
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	return firstBrace >= 0 && lastBrace > firstBrace ? parseCandidate(trimmed.slice(firstBrace, lastBrace + 1)) : undefined;
}

function runtimeFields(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const value = (contract as Record<string, unknown>).runtimeInput;
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function runtimeDefaults(contract: unknown): Record<string, unknown> {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return {};
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	const defaults: Record<string, unknown> = {};
	for (const field of runtimeFields(contract)) {
		const value = (meta as Record<string, unknown>)[field];
		if (value && typeof value === "object" && !Array.isArray(value) && "default" in value) {
			defaults[field] = (value as Record<string, unknown>).default;
		}
	}
	return defaults;
}

/**
 * 判定 runtimeInput 字段的值是否"有效"——即 dispatcher 真的算出了有意义的东西,
 * 而不是吐了个残片/空壳。这是 dispatcher 作为"唯一参数入口"的质量底线:
 * required 字段不仅要在,还得有有效值,否则视为 dispatcher 失败(headless 抛错)。
 *
 * ponytail: 不做格式语义校验(那该由 verify 在产物层做),只判"值非空且类型合理":
 *   - string: 非空(空串/纯空白 = 无效)
 *   - number: 有限数(NaN/Infinity = 无效)
 *   - boolean: 恒有效
 *   - object/array: 非空(空对象 {}/空数组 [] = 无效)
 *   - null/undefined: 无效
 * 这样能抓住 dispatcher 输出 timeWindow:"{mode:"(合法 JSON 但值是无意义残片字符串)这类情况。
 */
function isValidRuntimeValue(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
	return false;
}

/**
 * 提取 contract 中显式声明 required:true 的 runtimeInput 字段名。
 * 保守语义:只有显式 required:true 才是门禁字段;未声明或 required:false 都不算。
 * 这保持旧 contract(无 runtimeInputMeta 或无 required 字段)的行为完全不变——
 * 不会把原本能软失败(返回部分结果)的场景变成硬失败(headless 抛错)。
 * required:true 激活了之前死字段的门禁能力,但不改变默认契约语义。
 */
function runtimeRequiredFields(contract: unknown): string[] {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return [];
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
	return fields.filter((field) => {
		const fieldMeta = (meta as Record<string, unknown>)[field];
		if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta)) return false; // 无 meta 不门禁
		return (fieldMeta as Record<string, unknown>).required === true; // 仅显式 true 才门禁
	});
}

function runtimeInputWithDefaults(contract: unknown, input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	return { ...runtimeDefaults(contract), ...input };
}

function parseScalar(value: string): string | number {
	const trimmed = value.trim();
	return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function localRuntimeInput(contract: unknown, rawInput: string): unknown | undefined {
	const direct = extractRuntimeInputFromText(rawInput);
	if (direct) return direct;
	// ponytail: 本地只接确定性结构化语法 —— field=value / field:value / JSON。
	// 这是显式语法(用户手写的结构化输入),不是对自然语言的猜测。自然语言、裸值一律
	// 交给 dispatcher(reasoningEffort=medium + 映射 prompt)。dispatcher 是唯一语义解析路径;
	// 不在本地下任何自然语言/裸值捷径 —— 那是治标不治本的老土补丁,撤掉。
	const fields = runtimeFields(contract);
	const entries: Record<string, string | number> = {};
	for (const field of fields) {
		const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = rawInput.match(new RegExp(`(?:^|[\\s,;，；])${escaped}\\s*[:=：]\\s*([^\\s,;，；]+)`, "i"));
		if (match) entries[field] = parseScalar(match[1]);
	}
	if (Object.keys(entries).length > 0) return entries;
	return undefined;
}

function inputTitle(contract: unknown, field: string): string {
	const defaults = runtimeDefaults(contract);
	return Object.hasOwn(defaults, field) ? `task input: ${field} (default: ${String(defaults[field])})` : `task input: ${field}`;
}

function inputDefault(contract: unknown, field: string): string {
	const defaults = runtimeDefaults(contract);
	return Object.hasOwn(defaults, field) ? String(defaults[field]) : field;
}

function findModel(ctx: any, modelOverride?: string): any {
	if (!modelOverride) return ctx.model;
	const normalized = normalizeAgentModelForCli(modelOverride);
	const slash = normalized?.indexOf("/") ?? -1;
	if (!normalized || slash < 0) return ctx.model;
	return ctx.modelRegistry?.find?.(normalized.slice(0, slash), normalized.slice(slash + 1)) ?? ctx.model;
}

async function callDispatcher(ctx: any, skill: string, contract: unknown, rawInput: string, modelOverride?: string): Promise<unknown | undefined> {
	if (dispatcherForTests) return await dispatcherForTests(ctx, skill, contract, rawInput);
	const model = findModel(ctx, modelOverride);
	const auth = model ? await ctx.modelRegistry?.getApiKeyAndHeaders?.(model) : undefined;
	// ponytail: dispatcher 是唯一自然语言解析路径。模型/auth 不可用是配置错误,
	// 显式抛错透传 —— 不静默退化到本地正则兜底(那会治标不治本重新长出字符串比对补丁)。
	// 这个 throw 在调用方的 .catch 之外(见 resolveRuntimeInputFromText),配置错误不会被吞。
	if (!model || !auth?.ok || !auth.apiKey) {
		throw new Error(
			"dispatcher 模型不可用,无法解析自然语言 input。请配置有效的 dispatcher model(或 contract.dispatcherModel),或改用结构化输入(field=value / JSON)。",
		);
	}
	// complete() 的运行时错误(网络/限流/超时)是临时的,catch 成 undefined 让调用方 fallback。
	let response;
	try {
		response = await complete(model, {
			messages: [{
				role: "user",
				content: [{ type: "text", text: buildTaskDispatcherPrompt(skill, contract, rawInput) }],
				timestamp: Date.now(),
			}],
		}, { apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "medium" });
	} catch {
		return undefined;
	}
	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return extractRuntimeInputFromText(text);
}

export async function resolveRuntimeInputFromText(ctx: any, skill: string, contract: unknown, rawInput: string, modelOverride?: string, headless = false): Promise<unknown> {
	const fields = runtimeFields(contract);
	const required = runtimeRequiredFields(contract);
	// ponytail: required 门禁从"字段 key 存在"升级到"字段有有效值"。dispatcher 作为唯一参数入口,
	// 它吐出 required 字段但值是残片(如 timeWindow:"{mode:" 这种合法 JSON 但无意义字符串残片)
	// 视为解析失败,走"未能解析必填字段"分支(headless 抛错)。这把无效值的拦截点从 verify
	// (产物层)前移到 dispatcher(输入层),worker 拿不到残片就没机会现编默认值。
	const coversRequired = (input: unknown): boolean =>
		!!input && typeof input === "object" && !Array.isArray(input) &&
		required.every((field) =>
			Object.prototype.hasOwnProperty.call(input, field) &&
			isValidRuntimeValue((input as Record<string, unknown>)[field]),
		);

	if (rawInput.trim()) {
		const local = localRuntimeInput(contract, rawInput);
		// local 必须覆盖所有 required 字段才直接返回;否则缺 required 时不 short-circuit,
		// 让 dispatcher 兜底补全(它更擅长理解自然语言里的裸 URL 等)。
		// 修复:之前 local 抽到任意字段就返回,导致 "URL, page=1" 只抽到 page 就丢失 url。
		if (local && coversRequired(local)) return runtimeInputWithDefaults(contract, local);
		// 不 .catch:dispatcher 配置错误(模型/auth 不可用)要透传给用户;complete() 的运行时
		// 错误已在 callDispatcher 内部 catch 成 undefined,不会到这里。
		const dispatched = await callDispatcher(ctx, skill, contract, rawInput, modelOverride);
		if (dispatched && coversRequired(dispatched)) {
			// ponytail: dispatcher 补全 required 后,显式 local(field=value/JSON,用户手写)优先于
			// dispatcher 的语义推断。修 "https://x, page=2":local 抽 page=2,dispatcher 抽 url,
			// 不合的话 page 被 default=1 覆盖。
			const merged = local ? { ...dispatched, ...local } : dispatched;
			return runtimeInputWithDefaults(contract, merged);
		}
		// dispatcher 也没抽全 required,或抽到的 required 字段值无效(残片/空值)。
		// partial 不覆盖 required 则不返回,否则下游 worker 拿到不完整/无效的 input
		// 会 hardcode 或猜值,绕开 contract 约束。headless 时直接抛错让调用方补 input;
		// 交互式时落到后面的 UI prompt。
		const partial = dispatched ?? local;
		if (partial && coversRequired(partial)) return runtimeInputWithDefaults(contract, partial);
		if (partial && headless) {
			// ponytail: 区分"缺字段"和"字段值无效",给用户精准反馈。
			// 无效值(如 dispatcher 输出残片)和缺失一样视为解析失败 —— dispatcher 是唯一入口。
			const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(partial, field));
			const invalid = required.filter((field) =>
				Object.prototype.hasOwnProperty.call(partial, field) &&
				!isValidRuntimeValue((partial as Record<string, unknown>)[field]),
			);
			const detail = [
				missing.length ? `缺失字段: ${missing.join(", ")}` : "",
				invalid.length ? `字段值无效(空值/残片): ${invalid.join(", ")}` : "",
			].filter(Boolean).join("; ");
			throw new Error(`dispatcher 未能从输入解析出有效的必填字段 —— ${detail}。请用更明确、完整的 input 重试,或确认 taskbook 的 runtimeInput 定义。`);
		}
	}
	if (fields.length === 0) return {};
	const defaults = runtimeDefaults(contract);
	if (headless) {
		if (fields.every((field) => Object.hasOwn(defaults, field))) return defaults;
		throw new Error(`dispatcher 未能从输入解析出 runtimeInput(字段: ${fields.join(", ")}）。请用更明确、完整的 input 重试,或确认 taskbook 的 runtimeInput 定义。`);
	}
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const value = await ctx.ui?.input?.(inputTitle(contract, field), inputDefault(contract, field));
		entries.push([field, value ?? inputDefault(contract, field)]);
	}
	return Object.fromEntries(entries);
}
