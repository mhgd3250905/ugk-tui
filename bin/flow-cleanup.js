import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getFlowCleanupPaths(homeDir = os.homedir()) {
	return {
		marker: path.join(homeDir, ".ugk-flow-cleaned"),
		masterKey: path.join(homeDir, ".flow-master-key"),
		keysDir: path.join(homeDir, ".flow-keys"),
	};
}

export async function runFlowCleanupOnce(options = {}) {
	const fileSystem = options.fs ?? fs;
	const stderr = options.stderr ?? process.stderr;
	const { marker, masterKey, keysDir } = getFlowCleanupPaths(options.homeDir);

	if (fileSystem.existsSync(marker)) {
		return { cleaned: false, reason: "already" };
	}

	stderr.write("ugk: cleaning up removed Flow module data (~/.flow-master-key, ~/.flow-keys/)...\n");

	try {
		if (fileSystem.existsSync(masterKey)) fileSystem.rmSync(masterKey, { force: true });
		if (fileSystem.existsSync(keysDir)) fileSystem.rmSync(keysDir, { recursive: true, force: true });
		fileSystem.writeFileSync(marker, new Date().toISOString());
		return { cleaned: true };
	} catch (error) {
		stderr.write(`ugk: flow cleanup partial: ${error instanceof Error ? error.message : String(error)}\n`);
		return { cleaned: false, reason: "error", error };
	}
}
