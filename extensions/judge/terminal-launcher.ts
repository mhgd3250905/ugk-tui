/**
 * Judge live-log terminal launcher.
 *
 * Extracted from judge.ts. Spawns an independent terminal window running
 * `tail -f` on the judge live.log, cross-platform (Win/Mac/Linux). Contains
 * PowerShell/bash quoting helpers and the test-injection slot.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveBashCommand } from "../doctor/checks.ts";

function quotePowerShellLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function quoteBashLiteral(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildBashLiveLogCommand(liveLogPath: string): string {
	const bashPath = liveLogPath.replace(/\\/g, "/");
	const quotedDir = quoteBashLiteral(path.posix.dirname(bashPath));
	const quotedPath = quoteBashLiteral(bashPath);
	return `mkdir -p ${quotedDir}; touch ${quotedPath}; tail -n +1 -f ${quotedPath}; printf '\\n[Judge live log exited]\\n'; read -r -p 'Press Enter to close...' _`;
}

export type WindowsLiveLogLaunchPlan = {
	command: string;
	args: string[];
};

export function buildWindowsLiveLogLaunchPlan(
	liveLogPath: string,
	bashExecutable = resolveBashCommand().command,
): WindowsLiveLogLaunchPlan {
	const bashCommand = buildBashLiveLogCommand(liveLogPath);
	return {
		command: "cmd.exe",
		args: ["/d", "/s", "/c", "start", "\"\"", bashExecutable, "--noprofile", "--norc", "-lc", bashCommand],
	};
}

function spawnDetached(command: string, args: string[], options: { windowsHide?: boolean } = {}): { ok: boolean; error?: string } {
	try {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			...options,
		});
		child.once("error", () => {
			// 防止辅助终端启动失败变成未处理错误;同步可捕获失败由返回值表达。
		});
		child.unref();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function ensureLiveLogFile(liveLogPath: string): { ok: boolean; error?: string } {
	try {
		mkdirSync(path.dirname(liveLogPath), { recursive: true });
		appendFileSync(liveLogPath, "", "utf8");
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function openPreparedLiveLogTerminal(liveLogPath: string): { ok: boolean; error?: string } {
	const prepared = ensureLiveLogFile(liveLogPath);
	if (!prepared.ok) return prepared;
	return (openLiveLogTerminalForTests ?? openLiveLogTerminal)(liveLogPath);
}

/**
 * 在新终端窗口打开 live.log 的实时跟踪。
 * 零污染主 agent context:过程数据只写文件、只在新终端显示。
 * 跨平台兼容(macOS / Linux / Windows):
 *   - Windows:用 cmd start 打开承载 bash tail 的可见过程终端窗口。
 *   - macOS:osascript 让 Terminal.app 跑 tail(路径转义处理空格)。
 *   - Linux:which 检测可用终端(gnome-terminal -- / konsole -e / xterm -e / x-terminal-emulator),用各自正确的参数语法。
 * 开窗失败不抛错(只返回 error),因为这只是辅助查看,不影响 Judge 主流程。
 */
function openLiveLogTerminal(liveLogPath: string): { ok: boolean; error?: string } {
	try {
		if (process.platform === "win32") {
			// Windows 不写 launcher 文件,通过 cmd start 让系统打开一个可见的独立 bash tail 过程终端。
			const plan = buildWindowsLiveLogLaunchPlan(liveLogPath);
			return spawnDetached(plan.command, plan.args, {
				windowsHide: false,
			});
		}

		if (process.platform === "darwin") {
			// macOS:osascript 指挥 Terminal.app。路径里的双引号和反斜杠转义。
			const escapedPath = liveLogPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const script = `tell application "Terminal"
  activate
  do script "tail -f \\"${escapedPath}\\""
end tell`;
			return spawnDetached("osascript", ["-e", script]);
		}

		// Linux:同步检测可用终端(预检避免 spawn 异步 ENOENT 无法捕获的问题)。
		const term = detectLinuxTerminal();
		if (!term) {
			return { ok: false, error: "no supported terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)" };
		}
		// 各终端的"执行命令"参数语法不同:
		//   gnome-terminal: -- <cmd> <args>
		//   konsole: -e <cmd> <args>
		//   xterm: -e <cmd> <args>
		//   x-terminal-emulator: -e <cmd> <args>(Debian 系别名,语法同 -e)
		const sep = term.bin === "gnome-terminal" ? "--" : "-e";
		return spawnDetached(term.bin, [sep, "tail", "-f", liveLogPath]);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

let openLiveLogTerminalForTests:
	| ((liveLogPath: string) => { ok: boolean; error?: string })
	| undefined;

export function setOpenLiveLogTerminalForTests(opener: typeof openLiveLogTerminalForTests): void {
	openLiveLogTerminalForTests = opener;
}

/** 同步检测 Linux 上可用的终端模拟器(预检,避免 spawn 异步错误无法捕获)。 */
function detectLinuxTerminal(): { bin: string } | null {
	const candidates = [
		{ bin: "x-terminal-emulator" }, // Debian 系默认别名
		{ bin: "gnome-terminal" }, // GNOME
		{ bin: "konsole" }, // KDE
		{ bin: "xterm" }, // 兜底,大多装了
	];
	const which = process.platform === "win32" ? "where" : "which";
	for (const c of candidates) {
		try {
			execFileSync(which, [c.bin], { stdio: "ignore" });
			return c;
		} catch {
			// 这个终端没装,试下一个
		}
	}
	return null;
}
