import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createJudgeState,
	enterAligning,
	setRequirementsSpec,
	startDriving,
	type JudgeState,
	type RequirementsSpec,
} from "./judge-state.ts";
import { ALIGN_PROMPT } from "./judge-prompts.ts";
import { extractRequirementsSpec, formatRequirementsSpec, isSafeCommand } from "./judge-utils.ts";
import registerQuestionnaire from "./questionnaire.ts";

const JUDGE_ALIGNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const JUDGE_MENU_OPTIONS = ["委派 driver 执行", "继续澄清", "改需求"];
const JUDGE_PHASES = new Set(["aligning", "driving", "delivering", "aborted", "done"]);

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function persistState(pi: ExtensionAPI, state: JudgeState): void {
	pi.appendEntry("judge-state", {
		phase: state.phase,
		spec: state.spec,
		summary: state.summary,
		steerCount: state.steerCount,
		maxSteer: state.maxSteer,
		keepWatching: state.keepWatching,
	});
}

function notifySpecStub(pi: ExtensionAPI, ctx: ExtensionContext, spec: RequirementsSpec): void {
	pi.sendMessage(
		{
			customType: "judge-driver-stub",
			content: `[JUDGE DRIVER STUB]\n\nDriver delegation is intentionally stubbed in phase 2. No driver session was started.\n\nSpec:\n\n\`\`\`json\n${formatRequirementsSpec(spec)}\n\`\`\``,
			display: true,
		},
		{ triggerTurn: false },
	);
	ctx.ui.notify("Judge driver delegation stubbed. Spec is ready for phase 3.", "info");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRequirementsSpec(value: unknown): value is RequirementsSpec {
	if (value === null) return false;
	if (typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.goal === "string" &&
		isStringArray(record.hardConstraints) &&
		isStringArray(record.acceptance) &&
		isStringArray(record.forbidden) &&
		typeof record.context === "string"
	);
}

function restoreJudgeState(data: unknown): JudgeState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.phase !== "string" || !JUDGE_PHASES.has(record.phase)) return undefined;
	if (record.spec !== null && !isRequirementsSpec(record.spec)) return undefined;
	if (typeof record.summary !== "string") return undefined;
	if (typeof record.steerCount !== "number") return undefined;
	if (typeof record.maxSteer !== "number") return undefined;
	if (typeof record.keepWatching !== "boolean") return undefined;

	return {
		phase: record.phase as JudgeState["phase"],
		spec: record.spec,
		summary: record.summary,
		steerCount: record.steerCount,
		maxSteer: record.maxSteer,
		keepWatching: record.keepWatching,
	};
}

export function registerJudge(pi: ExtensionAPI): void {
	let state = createJudgeState();

	registerQuestionnaire(pi);

	pi.registerCommand("judge", {
		description: "Enter Judge aligning mode",
		handler: async (_args, ctx) => {
			state = enterAligning(state);
			pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
			ctx.ui.notify(`Judge aligning mode enabled. Tools: ${JUDGE_ALIGNING_TOOLS.join(", ")}`, "info");
			persistState(pi, state);
		},
	});

	pi.on("before_agent_start", async () => {
		if (state.phase !== "aligning") return undefined;
		return {
			message: {
				customType: "judge-align-context",
				content: ALIGN_PROMPT,
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event) => {
		if (state.phase !== "aligning" || event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		if (isSafeCommand(command)) return undefined;

		return {
			block: true,
			reason: `Judge aligning: command blocked (not read-only). Command: ${command}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const judgeStateEntry = entries
			.filter((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === "judge-state")
			.pop() as { data?: unknown } | undefined;
		const restored = restoreJudgeState(judgeStateEntry?.data);
		if (!restored) return;

		state = restored;
		if (state.phase === "aligning") {
			pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase !== "aligning" || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		const spec = extractRequirementsSpec(getTextContent(lastAssistant));
		if (!spec) {
			ctx.ui.notify("Judge did not find a complete RequirementsSpec yet.", "warning");
			return;
		}

		state = setRequirementsSpec(state, spec);
		persistState(pi, state);

		const choice = await ctx.ui.select("Judge next step", JUDGE_MENU_OPTIONS);
		if (choice === "委派 driver 执行") {
			state = startDriving(state);
			persistState(pi, state);
			notifySpecStub(pi, ctx, spec);
			return;
		}

		if (choice === "继续澄清") {
			state = enterAligning(state);
			persistState(pi, state);
			pi.sendUserMessage("继续澄清 Judge RequirementsSpec。请优先使用 questionnaire，并重新输出可解析 JSON。");
			return;
		}

		if (choice === "改需求") {
			const edited = await ctx.ui.editor("改需求", formatRequirementsSpec(spec));
			state = enterAligning(state);
			persistState(pi, state);
			if (edited?.trim()) {
				pi.sendUserMessage(`按以下修改后的需求继续 Judge aligning：\n\n${edited.trim()}`);
			}
		}
	});
}

export default registerJudge;
