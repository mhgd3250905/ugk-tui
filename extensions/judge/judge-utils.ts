import type { RequirementsSpec } from "./judge-state.ts";
export { isSafeCommand } from "../plan-mode-utils.ts";

export interface TailToolCall {
	toolName: string;
	argsSummary: string;
	resultSummary: string;
	failed: boolean;
}

export interface TranscriptTail {
	toolCalls: TailToolCall[];
	assistantOutput: string;
}

type TailEvent = {
	type?: string;
	role?: string;
	content?: unknown;
	text?: unknown;
	toolName?: string;
	input?: unknown;
	result?: unknown;
	output?: unknown;
	isError?: boolean;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
};

export type JudgeVerdict =
	| { action: "pass"; keepWatching: boolean }
	| { action: "steer"; direction: string; keepWatching: boolean }
	| { action: "abort"; reason: string };

export type JudgeFinalVerdict =
	| { status: "pass"; reason: string; evidence: string[] }
	| { status: "fail"; reason: string; evidence: string[] };

const SUMMARY_KEYS = [
	"url",
	"href",
	"uri",
	"path",
	"file",
	"filePath",
	"outputPath",
	"command",
	"cmd",
	"query",
	"action",
];

const ARTIFACT_PATH_KEYS = ["path", "file", "filePath", "outputPath"];

function truncate(value: string, maxLength = 240): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 3)}...`;
}

function stringifyCompact(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function summarizeRecord(record: Record<string, unknown>, keys: string[]): string {
	const parts: string[] = [];
	for (const key of keys) {
		const value = record[key];
		if (value === undefined || value === null || value === "") continue;
		parts.push(`${key}=${truncate(stringifyCompact(value), 160)}`);
	}
	return parts.join("; ");
}

export function summarizeToolArgs(input: unknown): string {
	const record = getRecord(input);
	if (record) {
		const focused = summarizeRecord(record, SUMMARY_KEYS);
		if (focused) return focused;
	}
	return truncate(stringifyCompact(input));
}

export function summarizeToolResult(result: unknown): string {
	const record = getRecord(result);
	if (record) {
		const focused = summarizeRecord(record, ["error", "message", "status", "text", "content", "stdout", "stderr", "path"]);
		if (focused) return focused;
	}
	return truncate(stringifyCompact(result));
}

export function extractArtifactsFromToolInput(toolName: string, input: unknown): Array<{ path: string; kind: string }> {
	if (!/^(write|edit|bash)$/i.test(toolName)) return [];
	const record = getRecord(input);
	if (!record) return [];

	const artifacts: Array<{ path: string; kind: string }> = [];
	for (const key of ARTIFACT_PATH_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			artifacts.push({ path: value.trim(), kind: "file" });
		}
	}
	return artifacts;
}

function textFromEvent(event: TailEvent): string {
	if (
		event.type === "message_update" &&
		event.assistantMessageEvent?.type === "text_delta" &&
		typeof event.assistantMessageEvent.delta === "string"
	) {
		return event.assistantMessageEvent.delta;
	}
	if (event.role === "assistant") {
		if (typeof event.text === "string") return event.text;
		if (typeof event.content === "string") return event.content;
		if (Array.isArray(event.content)) {
			return event.content
				.map((block) => {
					const record = getRecord(block);
					return record?.type === "text" && typeof record.text === "string" ? record.text : "";
				})
				.filter(Boolean)
				.join("\n");
		}
	}
	return "";
}

function findOpenToolCall(toolCalls: TailToolCall[], toolName: string): TailToolCall | undefined {
	for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
		const call = toolCalls[index];
		if (call.toolName === toolName && call.resultSummary === "") return call;
	}
	return undefined;
}

export function extractTail(messages: TailEvent[], maxToolCalls = 10): TranscriptTail {
	const toolCalls: TailToolCall[] = [];
	let assistantOutput = "";
	let lastWasAssistant = false;

	for (const event of messages) {
		const assistantText = textFromEvent(event);
		if (assistantText) {
			if (!lastWasAssistant) {
				assistantOutput = "";
			}
			assistantOutput += assistantText;
			lastWasAssistant = true;
			continue;
		}

		lastWasAssistant = false;

		if ((event.type === "tool_execution_start" || event.type === "tool_call") && event.toolName) {
			toolCalls.push({
				toolName: event.toolName,
				argsSummary: summarizeToolArgs(event.input),
				resultSummary: "",
				failed: false,
			});
			continue;
		}

		if ((event.type === "tool_execution_end" || event.type === "tool_result") && event.toolName) {
			const call = findOpenToolCall(toolCalls, event.toolName) ?? {
				toolName: event.toolName,
				argsSummary: "",
				resultSummary: "",
				failed: false,
			};
			if (!toolCalls.includes(call)) {
				toolCalls.push(call);
			}
			call.resultSummary = summarizeToolResult(event.result ?? event.output);
			call.failed = event.isError === true;
		}
	}

	return {
		toolCalls: toolCalls.slice(-maxToolCalls),
		assistantOutput: truncate(assistantOutput, 1200),
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizeSpec(value: unknown): RequirementsSpec | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.goal !== "string" || record.goal.trim().length === 0) return undefined;
	if (!isStringArray(record.hardConstraints) || record.hardConstraints.length === 0) return undefined;
	if (!isStringArray(record.acceptance) || record.acceptance.length === 0) return undefined;
	if (record.forbidden !== undefined && !isStringArray(record.forbidden)) return undefined;
	if (record.context !== undefined && typeof record.context !== "string") return undefined;

	return {
		goal: record.goal.trim(),
		hardConstraints: record.hardConstraints,
		acceptance: record.acceptance,
		forbidden: record.forbidden ?? [],
		context: record.context ?? "",
	};
}

function parseCandidate(candidate: string): RequirementsSpec | undefined {
	try {
		return normalizeSpec(JSON.parse(candidate));
	} catch {
		return undefined;
	}
}

export function extractRequirementsSpec(text: string): RequirementsSpec | undefined {
	const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of text.matchAll(fencedPattern)) {
		const spec = parseCandidate(match[1].trim());
		if (spec) return spec;
	}

	const trimmed = text.trim();
	const direct = parseCandidate(trimmed);
	if (direct) return direct;

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return parseCandidate(trimmed.slice(firstBrace, lastBrace + 1));
	}

	return undefined;
}

export function formatRequirementsSpec(spec: RequirementsSpec): string {
	return JSON.stringify(spec, null, "\t");
}

function normalizeVerdict(value: unknown): JudgeVerdict | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.action === "pass" && typeof record.keepWatching === "boolean") {
		return { action: "pass", keepWatching: record.keepWatching };
	}
	if (
		record.action === "steer" &&
		typeof record.direction === "string" &&
		record.direction.trim().length > 0 &&
		typeof record.keepWatching === "boolean"
	) {
		return { action: "steer", direction: record.direction.trim(), keepWatching: record.keepWatching };
	}
	if (record.action === "abort" && typeof record.reason === "string" && record.reason.trim().length > 0) {
		return { action: "abort", reason: record.reason.trim() };
	}
	return undefined;
}

function parseVerdictCandidate(candidate: string): JudgeVerdict | undefined {
	try {
		return normalizeVerdict(JSON.parse(candidate));
	} catch {
		return undefined;
	}
}

export function parseJudgeVerdict(text: string): JudgeVerdict | undefined {
	const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of text.matchAll(fencedPattern)) {
		const verdict = parseVerdictCandidate(match[1].trim());
		if (verdict) return verdict;
	}

	const trimmed = text.trim();
	const direct = parseVerdictCandidate(trimmed);
	if (direct) return direct;

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return parseVerdictCandidate(trimmed.slice(firstBrace, lastBrace + 1));
	}

	return undefined;
}

function normalizeFinalVerdict(value: unknown): JudgeFinalVerdict | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		(record.status === "pass" || record.status === "fail") &&
		typeof record.reason === "string" &&
		record.reason.trim().length > 0 &&
		isStringArray(record.evidence)
	) {
		return {
			status: record.status,
			reason: record.reason.trim(),
			evidence: record.evidence.map((item) => item.trim()).filter(Boolean),
		};
	}
	return undefined;
}

function parseFinalVerdictCandidate(candidate: string): JudgeFinalVerdict | undefined {
	try {
		return normalizeFinalVerdict(JSON.parse(candidate));
	} catch {
		return undefined;
	}
}

export function parseJudgeFinalVerdict(text: string): JudgeFinalVerdict | undefined {
	const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of text.matchAll(fencedPattern)) {
		const verdict = parseFinalVerdictCandidate(match[1].trim());
		if (verdict) return verdict;
	}

	const trimmed = text.trim();
	const direct = parseFinalVerdictCandidate(trimmed);
	if (direct) return direct;

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return parseFinalVerdictCandidate(trimmed.slice(firstBrace, lastBrace + 1));
	}

	return undefined;
}
