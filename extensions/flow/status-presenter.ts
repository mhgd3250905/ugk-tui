import { isRunnableFlowTaskStatus } from "./task-store.ts";

export interface FlowActivityViewModel {
	taskId: string;
	runId: string;
	status: string;
	step?: string;
	summary?: string;
	validation?: {
		result: string;
		summary: string;
		nextStep: string;
	};
	review?: {
		status: string;
	};
	task?: {
		status?: string;
		nextStep?: string;
	};
	preview?: string[];
}

function statusIcon(status: string): string {
	if (status === "done") return "✓";
	if (status === "failed") return "✕";
	if (status === "needs-human") return "!";
	return "●";
}

function nextStepForItem(item: FlowActivityViewModel): string | undefined {
	if (item.review?.status === "accepted" && isRunnableFlowTaskStatus(item.task?.status)) {
		return `/flow run ${item.taskId}`;
	}
	return item.task?.nextStep ?? item.validation?.nextStep ?? (item.preview?.[0] ? undefined : "waiting for driver result");
}

export function formatFlowActivityCard(items: FlowActivityViewModel[]): string[] {
	const lines = ["╭─ Flow Activity ─────────────────────────────"];
	for (const item of items) {
		lines.push(`│ ${statusIcon(item.status)} ${item.taskId}/${item.runId}`);
		lines.push(`│   status: ${[item.status, item.step].filter(Boolean).join(" / ")}`);
		if (item.validation) {
			lines.push(`│   result: ${item.validation.result} - ${item.validation.summary}`);
		}
		if (item.review) {
			lines.push(`│   review: ${item.review.status}`);
		}
		if (item.task?.status) {
			lines.push(`│   task: ${item.task.status}`);
		}
		const next = nextStepForItem(item);
		if (next) {
			lines.push(`│   next: ${next}`);
		}
		if (!item.validation && item.preview?.length) {
			lines.push(`│   latest: ${item.preview[0]}`);
			lines.push(...item.preview.slice(1).map((line) => `│   ${line}`));
		}
	}
	lines.push("╰─────────────────────────────────────────────");
	return lines;
}
