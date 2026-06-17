import { visibleWidth } from "@earendil-works/pi-tui";
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

function padEndVisible(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function tableRule(left: string, middle: string, right: string, widths: number[]): string {
	return `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
}

function tableRow(cells: string[], widths: number[]): string {
	return `│ ${cells.map((cell, index) => padEndVisible(cell, widths[index])).join(" │ ")} │`;
}

export function formatDoctorReport(runs: DoctorCheckRun[]): string {
	const lines = ["🧪 UGK Doctor", ""];
	const header = ["状态", "检查", "结果"];
	const rows = runs.flatMap(({ check, result }) => [
		[statusIcon(result.status), check.title, result.summary],
		...(result.details ?? []).map((detail) => ["↳", check.title, detail]),
	]);
	const widths = header.map((heading, index) =>
		Math.max(visibleWidth(heading), ...rows.map((row) => visibleWidth(row[index] ?? ""))),
	);

	lines.push(
		tableRule("┌", "┬", "┐", widths),
		tableRow(header, widths),
		tableRule("├", "┼", "┤", widths),
		...rows.map((row) => tableRow(row, widths)),
		tableRule("└", "┴", "┘", widths),
	);

	const nextSteps = unique(runs.flatMap((run) => run.result.nextSteps ?? []));
	if (nextSteps.length) {
		lines.push("", "👉 Next steps:", ...nextSteps.map((step) => `  ${step}`));
	} else {
		lines.push("", "✨ All core checks passed.");
	}

	return lines.join("\n");
}
