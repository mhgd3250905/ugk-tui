import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { renderTerminalTable } from "./terminal-table.ts";

export const ADB_PATH = "E:\\platform-tools\\adb.exe";

export interface DeviceEnvDeps {
	env?: Record<string, string | undefined>;
	exec?: (command: string) => string;
	exists?: (path: string) => boolean;
}

function getEnv(deps?: DeviceEnvDeps): Record<string, string | undefined> {
	return deps?.env ?? process.env;
}

function getExec(deps?: DeviceEnvDeps): (command: string) => string {
	return deps?.exec ?? ((command) => execSync(command, { encoding: "utf8", stdio: "ignore", timeout: 8000 }) as string);
}

function getExists(deps?: DeviceEnvDeps): (path: string) => boolean {
	return deps?.exists ?? ((path) => fs.existsSync(path));
}

export function getScrcpyDirs(env: Record<string, string | undefined> = process.env): string[] {
	return [
		env.LOCALAPPDATA &&
			`${env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\\scrcpy-win64-v4.0`,
		"E:\\scrcpy",
	].filter(Boolean) as string[];
}

export function getAdbPaths(env: Record<string, string | undefined> = process.env): string[] {
	return Array.from(new Set([
		ADB_PATH,
		"E:\\platform-tools\\adb.exe",
		env.LOCALAPPDATA &&
			`${env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\\platform-tools\\adb.exe`,
		env.ANDROID_HOME && `${env.ANDROID_HOME}\\platform-tools\\adb.exe`,
		env.ANDROID_SDK_ROOT && `${env.ANDROID_SDK_ROOT}\\platform-tools\\adb.exe`,
	].filter(Boolean) as string[]));
}

export function findScrcpy(deps?: DeviceEnvDeps): string | null {
	const exec = getExec(deps);
	const exists = getExists(deps);

	try {
		exec("scrcpy --version");
		return "scrcpy";
	} catch {
		// fall back to known install directories
	}

	for (const dir of getScrcpyDirs(getEnv(deps))) {
		const candidate = `${dir}\\scrcpy.exe`;
		try {
			if (exists(candidate)) return candidate;
		} catch {
			// try next candidate
		}
	}
	return null;
}

export function findAdb(deps?: DeviceEnvDeps): string | null {
	const exec = getExec(deps);
	const exists = getExists(deps);

	try {
		exec("adb version");
		return "adb";
	} catch {
		// fall back to known install paths
	}

	for (const candidate of getAdbPaths(getEnv(deps))) {
		try {
			if (exists(candidate)) return candidate;
		} catch {
			// try next candidate
		}
	}
	return null;
}

export function checkEnv(deps?: DeviceEnvDeps): string {
	const exec = getExec(deps);
	const lines: string[] = ["🔍 ugk 环境自检", ""];
	const rows: string[][] = [];

	const adbBin = findAdb(deps);
	if (adbBin) {
		let ver = "?";
		try {
			ver = exec(`"${adbBin}" version`).split(/\r?\n/)[0];
		} catch {
			// keep unknown version
		}
		rows.push(["✅", "adb", `${ver}  [${adbBin}]`]);
	} else {
		rows.push(["❌", "adb", "未找到"]);
	}

	if (adbBin) {
		try {
			const dev = exec(`"${adbBin}" devices -l`);
			const devices = dev
				.trim()
				.split(/\r?\n/)
				.slice(1)
				.filter((l) => l.trim());
			if (devices.length === 0) {
				rows.push(["⚠️", "设备", "无设备连接(插线/开 USB 调试/点允许)"]);
			} else {
				const ok = devices.filter((l) => /\bdevice\b/.test(l));
				const bad = devices.filter((l) => !/\bdevice\b/.test(l));
				rows.push(["✅", "设备", `${ok.length} 台在线` + (bad.length ? `  ·  ${bad.length} 台异常(offline/unauthorized)` : "")]);
				for (const d of devices) rows.push(["↳", "设备", d.trim()]);
			}
		} catch {
			rows.push(["❌", "设备", "查询失败"]);
		}
	} else {
		rows.push(["⏭️", "设备", "跳过(adb 不可用)"]);
	}

	const scrcpyBin = findScrcpy(deps);
	if (scrcpyBin) {
		let ver = "?";
		try {
			ver = exec(`"${scrcpyBin}" --version`).split(/\r?\n/)[0];
		} catch {
			// keep unknown version
		}
		rows.push(["✅", "scrcpy", `${ver}  [${scrcpyBin === "scrcpy" ? "PATH" : scrcpyBin}]`]);
	} else {
		rows.push(["❌", "scrcpy", "未找到"]);
	}
	lines.push(renderTerminalTable(["状态", "项目", "结果"], rows));

	const missing: string[] = [];
	if (!adbBin) missing.push("  winget install Google.PlatformTools  # adb");
	if (!scrcpyBin) missing.push("  winget install Genymobile.scrcpy      # scrcpy");
	if (missing.length) {
		lines.push("", "缺失项安装命令(winget):", ...missing);
	} else {
		lines.push("", "✅ 全部就绪,可直接投屏。");
	}
	return lines.join("\n");
}

/**
 * 解析用于 spawn 子进程的 ugk/pi 命令名。
 * 优先 ugk(我们自己的 bin,npm i -g ugk-agent 后在 PATH),没有则回退 pi(开发环境/老用户)。
 * 用于 subagent 委派和 cron 触发——它们都要起一个 agent 子进程。
 */
export function getUgkBin(deps?: DeviceEnvDeps): string {
	const exec = getExec(deps);
	// 优先 ugk:它是我们的命令,npm i -g 后在 PATH
	try {
		exec("ugk --version");
		return "ugk";
	} catch {
		// ugk 不在 PATH(开发环境或未全局安装),回退 pi
	}
	return "pi";
}
