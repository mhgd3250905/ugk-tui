import { execSync } from "node:child_process";

export interface CronAgentBinDeps {
	execSync?: (command: string) => void;
}

export function getCronAgentBin(deps: CronAgentBinDeps = {}): "ugk" | "pi" {
	const run = deps.execSync ?? ((command: string) => execSync(command, { stdio: "ignore", timeout: 5000 }));
	try {
		run("ugk --version");
		return "ugk";
	} catch {
		return "pi";
	}
}
