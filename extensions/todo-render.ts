import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoItem } from "./plan-mode-utils.ts";

export function renderTodoStatus(
	ctx: ExtensionContext,
	items: readonly TodoItem[],
	planModeEnabled: boolean,
	executionMode: boolean,
): void {
	if ((executionMode || items.length > 0) && items.length > 0) {
		const completed = items.filter((t) => t.status === "completed").length;
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${items.length}`));
	} else if (planModeEnabled) {
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
	} else {
		ctx.ui.setStatus("plan-mode", undefined);
	}
}

export function renderTodoWidget(ctx: ExtensionContext, items: readonly TodoItem[]): void {
	if (items.length === 0) {
		ctx.ui.setWidget("plan-todos", undefined);
		return;
	}

	const lines = items.map((item, idx) => {
		const num = ctx.ui.theme.fg("dim", `${idx + 1}.`);
		if (item.status === "completed") {
			return `${ctx.ui.theme.fg("success", "☑")} ${num} ${ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.content))}`;
		}
		if (item.status === "in_progress") {
			return `${ctx.ui.theme.fg("warning", "►")} ${num} ${ctx.ui.theme.fg("accent", item.content)}`;
		}
		return `${ctx.ui.theme.fg("muted", "☐")} ${num} ${item.content}`;
	});
	ctx.ui.setWidget("plan-todos", lines);
}
