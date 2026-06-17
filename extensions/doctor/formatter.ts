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
	for (const { check, result } of runs) {
		lines.push(`${statusIcon(result.status)} ${check.title.padEnd(7)} ${result.summary}`);
		for (const detail of result.details ?? []) {
			lines.push(`        ${detail}`);
		}
	}

	const nextSteps = unique(runs.flatMap((run) => run.result.nextSteps ?? []));
	if (nextSteps.length) {
		lines.push("", "👉 Next steps:", ...nextSteps.map((step) => `  ${step}`));
	} else {
		lines.push("", "✨ All core checks passed.");
	}

	return lines.join("\n");
}
