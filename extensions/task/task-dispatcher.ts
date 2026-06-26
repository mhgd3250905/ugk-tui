import { complete } from "@earendil-works/pi-ai";
import { normalizeAgentModelForCli } from "../subagent-runtime.ts";

type Dispatcher = (ctx: any, skill: string, contract: unknown, rawInput: string) => Promise<unknown>;
let dispatcherForTests: Dispatcher | undefined;

export function setTaskDispatcherForTests(dispatcher: Dispatcher | undefined): void {
	dispatcherForTests = dispatcher;
}

export function buildTaskDispatcherPrompt(skill: string, contract: unknown, rawInput: string): string {
	return [
		"以下是 /task taskbook 的 skill 和 contract。",
		"请按 contract.runtimeInput 的字段定义,从用户输入中提取 runtimeInput JSON。",
		"",
		"提取规则:",
		"- 逐个对照 contract.runtimeInput 的字段,从用户输入里找出每个字段的值。",
		"- 用户输入若是裸值(单个 URL/路径/数字),按字段名或 description 判断它属于哪个字段。",
		"- 用户输入若是自然语言句子,从句子里抽出字段的真实值(如 \"下载 https://x\" → url 字段取 https://x),不要把整句当字段值。",
		"- runtimeInputMeta.<field>.default 存在且用户未提供该字段时,省略该字段,系统会补默认值。",
		"- 不要编造用户没给的、也没有 default 的字段值。",
		"",
		"只输出 fenced JSON,不要解释。",
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
	const coversRequired = (input: unknown): boolean =>
		!!input && typeof input === "object" && !Array.isArray(input) &&
		required.every((field) => Object.prototype.hasOwnProperty.call(input, field));

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
		// dispatcher 也没抽全 required。partial 不覆盖 required 则不返回,
		// 否则下游 worker 拿到不完整的 input 会 hardcode 或猜值,绕开 contract 约束。
		// headless 时直接抛错让调用方补 input;交互式时落到后面的 UI prompt。
		const partial = dispatched ?? local;
		if (partial && coversRequired(partial)) return runtimeInputWithDefaults(contract, partial);
		if (partial && headless) {
			const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(partial, field));
			throw new Error(`dispatcher 未能从输入解析出必填字段: ${missing.join(", ")}。请用更明确、完整的 input 重试,或确认 taskbook 的 runtimeInput 定义。`);
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
