import { spawn, execSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ADB_PATH, findAdb, findScrcpy } from "./device-env.ts";

export function splitExtraArgs(extraArgs?: string): string[] {
	return extraArgs ? extraArgs.trim().split(/\s+/).filter(Boolean) : [];
}

export const scrcpyTool = defineTool({
	name: "scrcpy",
	label: "Scrcpy",
	description:
		"控制 scrcpy 安卓投屏。action=start 后台启动投屏窗口(已内置复用本机 adb);stop 停止;status 查是否在运行;version 查是否已安装。投屏/录屏前先确认 adb 设备在线。未安装时优先用 winget 安装(见 scrcpy-guide skill)。",
	parameters: Type.Object({
		action: Type.Union(
			[Type.Literal("start"), Type.Literal("stop"), Type.Literal("status"), Type.Literal("version")],
			{ description: "start=启动投屏,stop=停止,status=查运行状态,version=查安装版本" },
		),
		extraArgs: Type.Optional(
			Type.String({
				description:
					"透传给 scrcpy 的额外参数(空格分隔),如 --max-size 1280 --max-fps 30 --record E:/out.mp4 --stay-awake",
			}),
		),
	}),

	async execute(_toolCallId, params) {
		const action = params.action as string;
		const scrcpyBin = findScrcpy();

		if (!scrcpyBin && action !== "stop" && action !== "status") {
			return {
				content: [
					{
						type: "text",
						text: "❌ 找不到 scrcpy。用 winget 安装(装完若仍找不到,重启 agent 让 PATH 生效):\n  winget install Genymobile.scrcpy\n详见 scrcpy-guide skill。",
					},
				],
				details: { installed: false },
			};
		}

		if (action === "version") {
			try {
				const out = execSync(`"${scrcpyBin}" --version`, { encoding: "utf8", timeout: 10000 });
				const first = out.split(/\r?\n/)[0] || "scrcpy installed";
				return {
					content: [{ type: "text", text: `✅ ${first}\nADB: ${ADB_PATH}` }],
					details: { installed: true, version: first },
				};
			} catch {
				return {
					content: [
						{
							type: "text",
							text: "❌ scrcpy 调用失败(可能未安装或版本损坏)。用 winget 安装:\n  winget install Genymobile.scrcpy\n详见 scrcpy-guide skill。",
						},
					],
					details: { installed: false },
				};
			}
		}

		if (action === "status") {
			try {
				const out = execSync('tasklist /FI "IMAGENAME eq scrcpy.exe" /NH', {
					encoding: "utf8",
					timeout: 10000,
				});
				const running = /scrcpy\.exe/i.test(out);
				return {
					content: [{ type: "text", text: running ? "scrcpy 正在运行" : "scrcpy 未在运行" }],
					details: { running },
				};
			} catch {
				return {
					content: [{ type: "text", text: "无法查询 scrcpy 进程状态" }],
					details: { running: false, error: true },
				};
			}
		}

		if (action === "stop") {
			try {
				execSync("taskkill /IM scrcpy.exe /F", { encoding: "utf8", timeout: 10000 });
				return {
					content: [{ type: "text", text: "已停止 scrcpy(关闭所有 scrcpy 投屏窗口)" }],
					details: { stopped: true },
				};
			} catch {
				return {
					content: [{ type: "text", text: "没有运行中的 scrcpy,或停止失败" }],
					details: { stopped: false },
				};
			}
		}

		const adbBin = findAdb();
		if (!adbBin) {
			return {
				content: [
					{
						type: "text",
						text: "❌ 找不到 adb。先安装:\n  winget install Google.PlatformTools\n再跑 /check-env 验证,或用 action=version 重新检测 scrcpy。",
					},
				],
				details: { started: false },
			};
		}
		try {
			const dev = execSync(`"${adbBin}" devices`, { encoding: "utf8", timeout: 10000 });
			if (!/\bdevice\b/.test(dev) || (/List of devices attached/.test(dev) && dev.trim().split(/\r?\n/).length < 3)) {
				return {
					content: [
						{ type: "text", text: "⚠️ 没有已授权的在线设备,先连接设备:\n  adb devices  # 确认有 device 状态的设备" },
					],
					details: { started: false, devices: dev.trim() },
				};
			}
		} catch (e) {
			return {
				content: [{ type: "text", text: `⚠️ 查询 adb 设备失败:${e}` }],
				details: { started: false },
			};
		}

		const args = splitExtraArgs(params.extraArgs);
		try {
			const child = spawn(scrcpyBin!, args, {
				env: { ...process.env, ADB: adbBin },
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.unref();
			return {
				content: [
					{
						type: "text",
						text: `🚀 scrcpy 投屏已启动(后台)\nADB: ${adbBin}${args.length ? `\n参数: ${args.join(" ")}` : ""}\n关闭窗口或用 action=stop 停止。`,
					},
				],
				details: { started: true, pid: child.pid, args },
			};
		} catch (e) {
			return {
				content: [{ type: "text", text: `❌ 启动 scrcpy 失败:${e}` }],
				details: { started: false },
			};
		}
	},
});
