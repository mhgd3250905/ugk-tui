import { renderTerminalTable } from "../terminal-table.ts";
import type { DoctorCheckRun } from "./types.ts";

function unique(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function statusIcon(status: DoctorCheckRun["result"]["status"]): string {
	if (status === "pass") return "✅";
	if (status === "warn") return "⚠️";
	if (status === "fail") return "❌";
	return "⏭️";
}

export function formatDoctorReport(runs: DoctorCheckRun[]): string {
	const lines = ["🧪 UGK Doctor", ""];
	const rows = runs.flatMap(({ check, result }) => [
		[statusIcon(result.status), check.title, result.summary],
		...(result.details ?? []).map((detail) => ["↳", check.title, detail]),
	]);

	lines.push(renderTerminalTable(["状态", "检查", "结果"], rows));

	const nextSteps = unique(runs.flatMap((run) => run.result.nextSteps ?? []));
	if (nextSteps.length) {
		lines.push("", "👉 Next steps:", ...nextSteps.map((step) => `  ${step}`));
	} else {
		lines.push("", "✨ All core checks passed.");
	}

	return lines.join("\n");
}
