import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionMode,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	abortJudge,
	completeJudge,
	createJudgeState,
	enterDelivering,
	enterAligning,
	recordJudgeEscalation,
	recordJudgeSteer,
	setRequirementsSpec,
	startDriving,
	type DriverSummary,
	type JudgeState,
	type RequirementsSpec,
} from "./judge-state.ts";
import { ALIGN_PROMPT, buildDecidePrompt, buildFinalizePrompt } from "./judge-prompts.ts";
import {
	extractRequirementsSpec,
	formatRequirementsSpec,
	isSafeCommand,
	parseJudgeFinalVerdict,
	parseJudgeVerdict,
	type JudgeFinalVerdict,
	type JudgeVerdict,
	type TranscriptTail,
} from "./judge-utils.ts";
import {
	createJudgeDriver,
	type JudgeEscalationContext,
	type JudgeDriverHandle,
	type JudgeDriverOptions,
	type JudgeWakeupContext,
} from "./judge-driver.ts";
import {
	createDriverSession,
	defaultDriverSessionFactory,
	type DriverSession,
	type DriverSessionFactory,
} from "../shared/driver-session.ts";
import registerQuestionnaire from "./questionnaire.ts";

const JUDGE_ALIGNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const JUDGE_MENU_OPTIONS = ["委派 driver 执行", "继续澄清", "改需求"];
const JUDGE_PHASES = new Set(["aligning", "driving", "delivering", "aborted", "done"]);
export const JUDGE_AGENT_DEFINITION_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
	"judge.md",
);

let judgeDriverFactoryForTests:
	| ((options: JudgeDriverOptions) => Promise<JudgeDriverHandle>)
	| undefined;
type JudgeVerdictProviderContext = JudgeWakeupContext & {
	spec: string;
};
type JudgeVerdictProvider = (context: JudgeVerdictProviderContext) => Promise<JudgeVerdict> | JudgeVerdict;
type JudgeFinalVerdictProviderContext = JudgeWakeupContext & {
	spec: string;
	finalizePrompt: string;
};
type JudgeFinalVerdictProvider = (context: JudgeFinalVerdictProviderContext) => Promise<JudgeFinalVerdict> | JudgeFinalVerdict;
interface JudgeVerdictProviderHandle {
	decide: JudgeVerdictProvider;
	finalize: JudgeFinalVerdictProvider;
	dispose(): void;
}
let judgeVerdictProviderForTests: JudgeVerdictProvider | undefined;
let judgeDecisionSessionFactoryForTests: DriverSessionFactory | undefined;

export function setJudgeDriverFactoryForTests(factory: typeof judgeDriverFactoryForTests): void {
	judgeDriverFactoryForTests = factory;
}

export function setJudgeVerdictProviderForTests(provider: typeof judgeVerdictProviderForTests): void {
	judgeVerdictProviderForTests = provider;
}

export function setJudgeDecisionSessionFactoryForTests(factory: typeof judgeDecisionSessionFactoryForTests): void {
	judgeDecisionSessionFactoryForTests = factory;
}

function getCwd(ctx: ExtensionContext): string {
	const cwd = (ctx as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : process.cwd();
}

function sliceNewTranscript(before: string, after: string): string {
	return after.startsWith(before) ? after.slice(before.length) : after;
}

function formatJudgeEscalation(context: JudgeEscalationContext): string {
	return [
		"[JUDGE ESCALATION]",
		"",
		`Reason: ${context.reason}`,
		"",
		"DriverSummary:",
		JSON.stringify(context.summary, null, "\t"),
		"",
		"TranscriptTail:",
		JSON.stringify(context.tail, null, "\t"),
		"",
		"Transcript:",
		context.transcript || "(empty)",
	].join("\n");
}

function createJudgeVerdictProviderHandle(options: {
	cwd: string;
	runId: string;
	runDir: string;
	specText: string;
	uiContext: ExtensionUIContext;
	extensionMode: ExtensionMode;
}): JudgeVerdictProviderHandle {
	let session: DriverSession | undefined;

	async function getSession(): Promise<DriverSession> {
		if (session) return session;
		session = await createDriverSession(
			{
				cwd: options.cwd,
				taskId: "judge-decider",
				runId: `${options.runId}-judge`,
				runDir: path.join(options.runDir, "judge"),
				initialPrompt: "",
				label: "Judge decider",
				uiContext: options.uiContext,
				extensionMode: options.extensionMode,
				agentDefinitionPath: JUDGE_AGENT_DEFINITION_PATH,
			},
			judgeDecisionSessionFactoryForTests ?? defaultDriverSessionFactory,
		);
		return session;
	}

	return {
		async decide(context) {
			const judgeSession = await getSession();
			const decidePrompt = context.decidePrompt || buildDecidePrompt(options.specText, context.summary, context.tail);
			const before = judgeSession.getTranscriptText();
			await judgeSession.sendUserInput(decidePrompt);
			const after = judgeSession.getTranscriptText();
			const currentTurn = sliceNewTranscript(before, after);
			const verdict = parseJudgeVerdict(currentTurn);
			return verdict ?? {
				action: "abort",
				reason: "Judge verdict parse failed",
			};
		},
		async finalize(context) {
			const judgeSession = await getSession();
			const finalizePrompt = context.finalizePrompt || buildFinalizePrompt(options.specText, context.summary, context.tail);
			const before = judgeSession.getTranscriptText();
			await judgeSession.sendUserInput(finalizePrompt);
			const after = judgeSession.getTranscriptText();
			const currentTurn = sliceNewTranscript(before, after);
			const verdict = parseJudgeFinalVerdict(currentTurn);
			return verdict ?? {
				status: "fail",
				reason: "Judge final verdict parse failed",
				evidence: [],
			};
		},
		dispose() {
			session?.dispose();
			session = undefined;
		},
	};
}

function formatDeliveryReport(options: {
	status: "PASS" | "FAIL";
	finalVerdict: JudgeFinalVerdict;
	summary: DriverSummary;
	tail: TranscriptTail;
}): string {
	const artifactLines = options.summary.artifacts.length > 0
		? options.summary.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.path}`)
		: ["(none)"];
	const pathLines = options.summary.pathsTried.length > 0
		? options.summary.pathsTried.map((path, index) => {
			const state = path.failed ? "failed" : "ok";
			return `${index + 1}. ${path.toolName} ${state}; args=${path.argsSummary || "(none)"}; result=${path.resultSummary || "(none)"}`;
		})
		: ["(none)"];
	const evidenceLines = options.finalVerdict.evidence.length > 0
		? options.finalVerdict.evidence.map((item) => `- ${item}`)
		: ["(none)"];

	return [
		`Judge final verdict: ${options.status}`,
		`Reason: ${options.finalVerdict.reason}`,
		"",
		"artifacts:",
		...artifactLines,
		"",
		"pathsTried:",
		...pathLines,
		"",
		"evidence:",
		...evidenceLines,
		"",
		"DriverSummary:",
		JSON.stringify(options.summary, null, "\t"),
		"",
		"TranscriptTail:",
		JSON.stringify(options.tail, null, "\t"),
	].join("\n");
}

function createJudgeWakeupHandler(
	specText: string,
	provider: JudgeVerdictProvider,
	hooks: {
		onSteer?: () => void;
		onAbort?: (reason: string) => void;
		onFinalize?: (context: JudgeWakeupContext) => Promise<JudgeVerdict> | JudgeVerdict;
	} = {},
): JudgeDriverOptions["onWakeup"] {
	return async (context) => {
		if (context.reason === "judge_complete" && context.summary.completed && hooks.onFinalize) {
			const finalVerdict = await hooks.onFinalize(context);
			if (finalVerdict.action === "steer") {
				hooks.onSteer?.();
			}
			if (finalVerdict.action === "abort") {
				hooks.onAbort?.(finalVerdict.reason);
			}
			return finalVerdict;
		}
		const summary = context.summary;
		const decidePrompt = context.decidePrompt || buildDecidePrompt(specText, summary, context.tail);
		const verdict = await provider({
			...context,
			spec: specText,
			summary,
			decidePrompt,
		});
		if (verdict.action === "steer") {
			hooks.onSteer?.();
		}
		if (verdict.action === "abort") {
			hooks.onAbort?.(verdict.reason);
		}
		return verdict;
	};
}

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

const judgeCompleteTool = defineTool({
	name: "judge_complete",
	label: "Judge Complete",
	description: "Signal to the Judge that the driver believes the delegated task is complete.",
	parameters: Type.Object({
		summary: Type.Optional(Type.String({ description: "Short completion summary from the driver" })),
	}),

	async execute(_toolCallId, params) {
		const summary = typeof params.summary === "string" ? params.summary : "";
		return {
			content: [
				{
					type: "text",
					text: summary
						? `judge_complete received. Summary: ${summary}`
						: "judge_complete received.",
				},
			],
			details: { completed: true, summary },
		};
	},
});

export function registerJudge(pi: ExtensionAPI): void {
	let state = createJudgeState();
	let activeDriver: JudgeDriverHandle | undefined;
	let activeJudgeVerdictProvider: JudgeVerdictProviderHandle | undefined;

	registerQuestionnaire(pi);
	pi.registerTool(judgeCompleteTool);

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

	pi.on("session_shutdown", async () => {
		activeDriver?.dispose();
		activeDriver = undefined;
		activeJudgeVerdictProvider?.dispose();
		activeJudgeVerdictProvider = undefined;
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
			activeDriver?.dispose();
			const runId = `judge-${Date.now()}`;
			const specText = formatRequirementsSpec(spec);
			const initialPrompt = [
				"[JUDGE DRIVER TASK]",
				"Execute the following RequirementsSpec. When complete, call the judge_complete tool.",
				"",
				specText,
			].join("\n");
			const createDriver = judgeDriverFactoryForTests ?? createJudgeDriver;
			const cwd = getCwd(ctx);
			const runDir = path.join(cwd, ".judge", runId);
			activeJudgeVerdictProvider?.dispose();
			const defaultJudgeVerdictProvider = createJudgeVerdictProviderHandle({
				cwd,
				runId,
				runDir,
				specText,
				uiContext: ctx.ui,
				extensionMode: ctx.mode,
			});
			activeJudgeVerdictProvider = judgeVerdictProviderForTests
				? {
					decide: judgeVerdictProviderForTests,
					finalize: defaultJudgeVerdictProvider.finalize,
					dispose: defaultJudgeVerdictProvider.dispose,
				}
				: defaultJudgeVerdictProvider;
			activeDriver = await createDriver({
				cwd,
				runDir,
				runId,
				spec: specText,
				initialPrompt,
				onWakeup: createJudgeWakeupHandler(specText, activeJudgeVerdictProvider.decide, {
					onSteer() {
						state = recordJudgeSteer(state);
						persistState(pi, state);
					},
					onAbort(reason) {
						state = abortJudge(state);
						persistState(pi, state);
						ctx.ui.notify(`Judge aborted driver: ${reason}`, "error");
					},
					async onFinalize(context) {
						const canContinueAfterFail = state.keepWatching && context.summary.steerCount < state.maxSteer;
						state = enterDelivering(state);
						persistState(pi, state);
						const finalizePrompt = buildFinalizePrompt(specText, context.summary, context.tail);
						const finalVerdict = await activeJudgeVerdictProvider!.finalize({
							...context,
							spec: specText,
							finalizePrompt,
						});
						const status = finalVerdict.status === "pass" ? "PASS" : "FAIL";
						const deliveryReport = formatDeliveryReport({
							status,
							finalVerdict,
							summary: context.summary,
							tail: context.tail,
						});
						state = { ...state, summary: deliveryReport };
						persistState(pi, state);
						pi.sendMessage(
							{
								customType: "judge-delivery",
								content: deliveryReport,
								display: true,
							},
							{ triggerTurn: false },
						);

						if (finalVerdict.status === "pass") {
							const confirm = (ctx.ui as { confirm?: (message: string) => Promise<boolean> | boolean }).confirm;
							const acknowledged = typeof confirm === "function"
								? await confirm.call(ctx.ui, "Judge PASS. Accept this delivery?")
								: false;
							if (acknowledged) {
								state = completeJudge({ ...state, summary: deliveryReport });
								persistState(pi, state);
								ctx.ui.notify("Judge delivery accepted.", "info");
								return { action: "pass", keepWatching: false };
							}
							state = enterDelivering({ ...state, summary: deliveryReport });
							persistState(pi, state);
							ctx.ui.notify("Judge delivery is waiting for user acknowledgement.", "warning");
							return { action: "pass", keepWatching: false };
						}

						if (!canContinueAfterFail) {
							state = enterDelivering({ ...state, summary: deliveryReport });
							persistState(pi, state);
							ctx.ui.notify(`Judge final delivery failed and cannot continue automatically: ${finalVerdict.reason}`, "warning");
							return { action: "pass", keepWatching: false };
						}

						state = startDriving({ ...state, summary: deliveryReport });
						persistState(pi, state);
						return {
							action: "steer",
							direction: [
								"Final delivery review failed.",
								`Reason: ${finalVerdict.reason}`,
								"Evidence:",
								...finalVerdict.evidence.map((item) => `- ${item}`),
								"Revise the work to satisfy the RequirementsSpec acceptance items, then call judge_complete again.",
							].join("\n"),
							keepWatching: true,
						};
					},
				}),
				maxSteer: state.maxSteer,
				onEscalate: async (context) => {
					const escalationSummary = formatJudgeEscalation(context);
					state = recordJudgeEscalation(state, escalationSummary);
					persistState(pi, state);
					pi.sendMessage(
						{
							customType: "judge-escalation",
							content: escalationSummary,
							display: true,
						},
						{ triggerTurn: false },
					);
					ctx.ui.notify(`Judge needs user intervention: ${context.reason}`, "warning");
				},
				uiContext: ctx.ui,
				extensionMode: ctx.mode,
			});
			await activeDriver.start();
			ctx.ui.notify("Judge driver started.", "info");
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
