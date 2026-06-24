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
	if (rawInput.trim()) {
		const dispatched = await callDispatcher(ctx, skill, contract, rawInput, modelOverride).catch(() => undefined);
		if (dispatched) return dispatched;
	}
	if (fields.length === 0) return {};
	if (headless) {
		throw new Error(`dispatcher 未能从输入解析出 runtimeInput(字段: ${fields.join(", ")}）。请用更明确、完整的 input 重试,或确认 taskbook 的 runtimeInput 定义。`);
	}
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const value = await ctx.ui?.input?.(`task input: ${field}`, field);
		entries.push([field, value ?? ""]);
	}
	return Object.fromEntries(entries);
}
