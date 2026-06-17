import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCoreDoctorChecks } from "./checks.ts";
import { formatDoctorReport } from "./formatter.ts";
import type { DoctorCheck, DoctorCheckRun } from "./types.ts";

export interface DoctorDeps {
	checks?: DoctorCheck[];
}

async function runChecks(checks: DoctorCheck[]): Promise<DoctorCheckRun[]> {
	const runs: DoctorCheckRun[] = [];
	for (const check of checks) {
		try {
			runs.push({ check, result: await check.run() });
		} catch (error) {
			runs.push({
				check,
				result: {
					status: "fail",
					summary: `${check.id} check failed: ${error instanceof Error ? error.message : String(error)}`,
				},
			});
		}
	}
	return runs;
}

export function registerDoctor(pi: ExtensionAPI, deps: DoctorDeps = {}): void {
	pi.registerCommand("doctor", {
		description: "Run read-only core UGK health checks for bash, API, and Chrome",
		handler: async (_args, ctx) => {
			const runs = await runChecks(deps.checks ?? createCoreDoctorChecks());
			ctx.ui.notify(formatDoctorReport(runs), "info");
		},
	});
}

export default registerDoctor;
