import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TodoItem, TodoStatus } from "./plan-mode-utils.ts";
import { renderTodoStatus, renderTodoWidget } from "./todo-render.ts";

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

const TodoWriteParameters = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "The task description" }),
			status: StringEnum(TODO_STATUSES),
		}),
		{ description: "Full todo list. Replaces the current list entirely." },
	),
});

interface TodoState {
	items: TodoItem[];
	owner: "plan-mode" | "todo-tool" | undefined;
}

interface TodoDetails {
	todos: TodoItem[];
	owner: TodoState["owner"];
	error?: string;
}

let todoState: TodoState = { items: [], owner: undefined };

function cloneTodos(items: readonly TodoItem[]): TodoItem[] {
	return items.map((item) => ({ ...item }));
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.includes(value as TodoStatus);
}

export function setTodosFromPlanMode(items: TodoItem[]): void {
	if (todoState.owner === "todo-tool") return;
	todoState = { items: cloneTodos(items), owner: items.length > 0 ? "plan-mode" : undefined };
}

export function markPlanModeDone(index: number, done: boolean): void {
	if (todoState.owner !== "plan-mode") return;
	const item = todoState.items[index];
	if (item) item.status = done ? "completed" : "pending";
}

export function clearPlanModeTodos(): void {
	if (todoState.owner === "plan-mode") {
		todoState = { items: [], owner: undefined };
	}
}

export function getTodos(): readonly TodoItem[] {
	return todoState.items;
}

export function getTodoOwner(): TodoState["owner"] {
	return todoState.owner;
}

function setTodosFromTool(items: TodoItem[]): void {
	todoState = { items: cloneTodos(items), owner: items.length > 0 ? "todo-tool" : undefined };
}

export function migrateLegacyTodos(legacy: any[]): TodoItem[] {
	return legacy.map((t) => ({
		content: String(t.content ?? t.text ?? ""),
		status: isTodoStatus(t.status) ? t.status : t.completed ? "completed" : "pending",
	}));
}

export function reconstructTodosFromSession(ctx: ExtensionContext): void {
	todoState = { items: [], owner: undefined };

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && (entry as any).customType === "plan-mode") {
			const todos = (entry as any).data?.todos;
			if (Array.isArray(todos) && todos.length > 0) {
				todoState = { items: migrateLegacyTodos(todos), owner: "plan-mode" };
			}
			continue;
		}

		if (entry.type !== "message") continue;
		const msg = (entry as any).message;
		if (msg?.role !== "toolResult" || msg?.toolName !== "TodoWrite") continue;
		const details = msg.details as TodoDetails | undefined;
		if (Array.isArray(details?.todos)) {
			todoState = { items: cloneTodos(details.todos), owner: details.owner };
		}
	}
}

function refreshUI(ctx: ExtensionContext, planModeEnabled = false, executionMode = false): void {
	renderTodoStatus(ctx, todoState.items, planModeEnabled, executionMode);
	renderTodoWidget(ctx, todoState.items);
}

export default function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool<typeof TodoWriteParameters, TodoDetails>({
		name: "TodoWrite",
		label: "Todo",
		parameters: TodoWriteParameters,
		description: `Manage a task checklist for complex multi-step work.

Call this tool when work needs several steps, touches multiple files, or needs verification.
Do not call it for simple single-step questions.

Rules:
- Send the full current list each call; it replaces the old list.
- Keep at most one item as "in_progress".
- Mark items "completed" only after they are actually done.`,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const newItems: TodoItem[] = params.todos.map((t) => ({
				content: t.content,
				status: t.status,
			}));

			const inProgressCount = newItems.filter((t) => t.status === "in_progress").length;
			if (inProgressCount > 1) {
				const error = `Error: at most ONE item can be "in_progress" at a time (got ${inProgressCount}). Fix and resend the full list.`;
				return {
					content: [{ type: "text" as const, text: error }],
					details: { todos: cloneTodos(todoState.items), owner: todoState.owner, error },
				};
			}

			setTodosFromTool(newItems);
			refreshUI(ctx);

			const completed = newItems.filter((t) => t.status === "completed").length;
			return {
				content: [
					{
						type: "text" as const,
						text: newItems.length === 0 ? "Todo list cleared" : `${completed}/${newItems.length} completed`,
					},
				],
				details: { todos: cloneTodos(todoState.items), owner: todoState.owner },
			};
		},

		renderCall(args, theme, _context) {
			const todos = args.todos ?? [];
			const done = todos.filter((t) => t.status === "completed").length;
			const active = todos.filter((t) => t.status === "in_progress").length;
			const suffix = active > 0 ? ` ${theme.fg("accent", `(${active} active)`)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("TodoWrite "))}${theme.fg("muted", `${done}/${todos.length} done`)}${suffix}`, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details;
			if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
			if (details.todos.length === 0) return new Text(theme.fg("dim", "Todo list empty"), 0, 0);

			const lines = details.todos.map((t) => {
				// 单字符宽符号(与 todo-render.ts widget 保持一致):▢ pending / ▣ in_progress / ✓ completed
				const mark =
					t.status === "completed"
						? theme.fg("success", "✓")
						: t.status === "in_progress"
							? theme.fg("warning", "▣")
							: theme.fg("dim", "▢");
				const text =
					t.status === "completed"
						? theme.fg("dim", t.content)
						: t.status === "in_progress"
							? theme.fg("accent", t.content)
							: theme.fg("muted", t.content);
				return `${mark} ${text}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		reconstructTodosFromSession(ctx);
		refreshUI(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructTodosFromSession(ctx);
		refreshUI(ctx);
	});
}
