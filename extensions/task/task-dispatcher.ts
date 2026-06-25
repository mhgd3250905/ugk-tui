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
		"如果 contract.runtimeInputMeta.<field>.default 存在且用户未提供该字段,可以省略该字段,系统会补默认值。",
		"只输出 fenced JSON。",
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
 * 提取 contract 中声明为 required 的 runtimeInput 字段名。
 * required 默认为 true(未声明 meta 或未写 required 都视为必填),
 * 显式 required:false 才视为可选。这让 required 从死字段变成运行时门禁。
 */
function runtimeRequiredFields(contract: unknown): string[] {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return [];
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return fields;
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return fields;
	return fields.filter((field) => {
		const fieldMeta = (meta as Record<string, unknown>)[field];
		if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta)) return true; // 无 meta 视为必填
		const required = (fieldMeta as Record<string, unknown>).required;
		return required !== false; // 显式 false 才可选,其余(含 undefined/true)必填
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
	const fields = runtimeFields(contract);
	const entries: Record<string, string | number> = {};
	for (const field of fields) {
		const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = rawInput.match(new RegExp(`(?:^|[\\s,;，；])${escaped}\\s*[:=：]\\s*([^\\s,;，；]+)`, "i"));
		if (match) entries[field] = parseScalar(match[1]);
	}
	if (Object.keys(entries).length > 0) return entries;
	if (fields.length === 1 && /^topN$/i.test(fields[0])) {
		const match = rawInput.match(/(?:top|前)\s*(\d+)/i) ?? rawInput.trim().match(/^(\d+)$/);
		if (match) return { [fields[0]]: Number(match[1]) };
	}
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
	if (!model || !auth?.ok || !auth.apiKey) return undefined;
	const response = await complete(model, {
		messages: [{
			role: "user",
			content: [{ type: "text", text: buildTaskDispatcherPrompt(skill, contract, rawInput) }],
			timestamp: Date.now(),
		}],
	}, { apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "minimal" });
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
		const dispatched = await callDispatcher(ctx, skill, contract, rawInput, modelOverride).catch(() => undefined);
		if (dispatched && coversRequired(dispatched)) return runtimeInputWithDefaults(contract, dispatched);
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
