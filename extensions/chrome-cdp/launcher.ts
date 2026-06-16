import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface ChromeLaunchCommand {
	command: string;
	args: string[];
	profilePath: string;
}

export function getDefaultChromeProfilePath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".ugk", "chrome-cdp-profile");
}

export function getChromeLaunchCommand(options: {
	port: number;
	homeDir?: string;
	platform?: NodeJS.Platform;
}): ChromeLaunchCommand {
	const profilePath = getDefaultChromeProfilePath(options.homeDir);
	const platform = options.platform ?? process.platform;
	const command =
		platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome";
	return {
		command,
		profilePath,
		args: [`--remote-debugging-port=${options.port}`, `--user-data-dir=${profilePath}`],
	};
}

export function launchChromeCdp(port: number): string {
	const { command, args, profilePath } = getChromeLaunchCommand({ port });
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return `Started Chrome CDP on 127.0.0.1:${port}\nProfile: ${profilePath}`;
}
