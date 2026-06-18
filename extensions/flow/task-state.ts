import { readFlowTask, updateFlowTaskStatus, type FlowTaskMetadata } from "./task-store.ts";

/**
 * Flow Task 的中心状态机。
 *
 * 设计原则:
 * 1. 状态机是 task 生命周期的单一真相。task.json 的 status 字段只有本模块能改。
 * 2. 旧实现把状态转换散落在 5+ 处(index.ts、review-actions、driver 编排、prompts),
 *    且 verified/active/approved 三个状态在可运行判定上完全等价。本模块把它们收敛为
 *    一个显式状态机 + 单一 "ready" 可复用状态,来源用 origin 字段表达而非用状态名。
 * 3. transition() 独占写权:任何状态变更都是一次"事件触发的合法转换",附带证据字段。
 *    非法转换在源头被拒,而不是靠各调用点自律。
 *
 * 状态机(5 个状态 + needs-work):
 *
 *   draft ──prove-start──▶ proving ──prove-pass──▶ proved
 *     ▲                        │                       │
 *     │ prove-fail             │                  review-start
 *     │                        ▼                       ▼
 *     └──                (回 draft)              reviewing
 *                                                      │
 *                              ┌──────────────────────┤
 *                              ▼                       ▼
 *                        needs-work  ◀──review-reject   ready  ◀──review-accept
 *                              │                       ▲
 *                              │ prove-start           │ prove-start(再次 run/演进)
 *                              ▼                       │
 *                          proving ────────────────────┘
 *
 * 注:needs-work 修复后必须重新 prove(不能直接跳回 proved),因为信任需要重新验证。
 * ready 可被 prove-start 再次触发(演进 task 后重新证明);
 * ready 也可被 review-start 触发(再次 run 完成后复盘这次执行)。
 *
 * 信号分层(不串联):
 * - structural pass(prove 的结构 gate 通过)→ 只证明"能跑通",不等于可复用。
 * - business accepted(review 用户确认)→ 才进 ready,代表"可复用"。
 * 两者是独立信号,transition 的 evidence 字段记录是哪一类信号触发的转换。
 */

/** 产品层可见的 5 个状态。verified/active/approved 已废弃,统一为 ready。 */
export type FlowTaskState = "draft" | "proving" | "proved" | "reviewing" | "ready" | "needs-work";

/** ready 的来源——用字段而非状态名表达"这个 ready 怎么来的"。 */
export type ReadyOrigin = "local-proved" | "remote-sync" | "manual";

/** 触发状态转换的事件。这是状态机的唯一输入。 */
export type FlowTaskEvent =
	| { kind: "prove-start"; runId: string }
	| { kind: "prove-pass"; runId: string; validatedAt: string; nextStep: string }
	| { kind: "prove-fail"; runId: string; nextStep: string }
	| { kind: "review-start"; runId: string; nextStep: string }
	| { kind: "review-accept"; runId: string; origin: ReadyOrigin; nextStep: string }
	| { kind: "review-reject"; runId: string; nextStep: string }
	| { kind: "remote-mark-ready"; origin: ReadyOrigin; runId?: string };

/** transition 结果:成功带新状态 + 落盘后的元数据;失败带原因。 */
export type TransitionResult =
	| { ok: true; state: FlowTaskState; task: FlowTaskMetadata }
	| { ok: false; reason: string };

/** 旧状态(verified/active/approved)→ ready 的归一映射,供读取旧数据时用。 */
export function normalizeLegacyState(raw: string | undefined): FlowTaskState {
	if (raw === undefined) return "draft";
	if (raw === "verified" || raw === "active" || raw === "approved") return "ready";
	if (isFlowTaskState(raw)) return raw;
	// 未知旧值保守归为 needs-work,避免错误地当作可复用
	return "needs-work";
}

export function isFlowTaskState(value: string): value is FlowTaskState {
	return ["draft", "proving", "proved", "reviewing", "ready", "needs-work"].includes(value);
}

/** 哪些状态允许启动 run/再次 run。只有 ready。 */
export function isRunnable(state: FlowTaskState): boolean {
	return state === "ready";
}

/**
 * 合法转换表。key 是 from 状态,value 是该状态接受的 { event → to } 映射。
 * 不在表里的 (from, event) 组合即非法转换,transition() 会拒绝。
 *
 * 这张表就是状态机的完整定义——所有状态语义集中在此。
 */
const TRANSITIONS: Record<FlowTaskState, Partial<Record<FlowTaskEvent["kind"], FlowTaskState>>> = {
	draft: {
		"prove-start": "proving",
		"remote-mark-ready": "ready",
	},
	proving: {
		"prove-pass": "proved",
		"prove-fail": "draft",
	},
	proved: {
		"review-start": "reviewing",
		"prove-start": "proving", // 重新证明
	},
	reviewing: {
		"review-accept": "ready",
		"review-reject": "needs-work",
	},
	ready: {
		"prove-start": "proving", // 再次 run(以 prove 形式重新执行/演进)
		"review-start": "reviewing", // 再次 run 完成后复盘
	},
	"needs-work": {
		"prove-start": "proving", // 修复后重新证明
	},
};

function targetFor(from: FlowTaskState, eventKind: FlowTaskEvent["kind"]): FlowTaskState | undefined {
	return TRANSITIONS[from]?.[eventKind];
}

function eventKind(event: FlowTaskEvent): FlowTaskEvent["kind"] {
	return event.kind;
}

/**
 * 请求一次状态转换。本模块独占 status 写权。
 *
 * @param cwd 工作目录
 * @param taskId task id
 * @param event 触发事件(含证据字段)
 * @returns 成功则带新状态与落盘元数据;失败(状态不合法/转换非法)则带 reason
 */
export function transition(cwd: string, taskId: string, event: FlowTaskEvent): TransitionResult {
	const existing = readFlowTask(cwd, taskId);
	if (!existing) {
		return { ok: false, reason: `Flow task not found: ${taskId}` };
	}

	const from = normalizeLegacyState(existing.status);
	const to = targetFor(from, eventKind(event));
	if (!to) {
		return { ok: false, reason: `Illegal transition: ${from} ──${event.kind}──▶ (not allowed)` };
	}

	const fields = buildTransitionFields(taskId, event);
	const updated = updateFlowTaskStatus(cwd, taskId, to, fields);
	return { ok: true, state: to, task: updated };
}

/** 把事件携带的证据字段映射成 task.json 要落盘的字段。 */
function buildTransitionFields(taskId: string, event: FlowTaskEvent): Record<string, unknown> {
	switch (event.kind) {
		case "prove-start":
			return { latest_prove_run: event.runId, next_step: `waiting for ${taskId}/${event.runId}`, ready_origin: undefined };
		case "prove-pass":
			return {
				proven_at: event.validatedAt,
				latest_prove_run: event.runId,
				latest_validation: "structural-pass",
				next_step: event.nextStep,
			};
		case "prove-fail":
			return { latest_prove_run: event.runId, latest_validation: "structural-fail", next_step: event.nextStep };
		case "review-start":
			return { latest_review_run: event.runId, next_step: event.nextStep };
		case "review-accept":
			return {
				latest_review_run: event.runId,
				latest_review_status: "accepted",
				ready_origin: event.origin,
				next_step: event.nextStep,
			};
		case "review-reject":
			return {
				latest_review_run: event.runId,
				latest_review_status: "rejected",
				ready_origin: undefined,
				next_step: event.nextStep,
			};
		case "remote-mark-ready":
			return { ready_origin: event.origin, latest_review_run: event.runId };
	}
}
