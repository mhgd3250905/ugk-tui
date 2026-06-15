/**
 * ugk-pi-agent extension
 *
 * 复用官方示例模式(不造轮子):
 *  - 自定义工具:  packages/coding-agent/examples/extensions/hello.ts
 *  - 权限门:      packages/coding-agent/examples/extensions/permission-gate.ts
 *  - slash 命令:  packages/coding-agent/docs/extensions.md (registerCommand)
 *
 * 注:DeepSeek 由 pi 0.79+ 原生支持,设环境变量 DEEPSEEK_API_KEY 即可,
 *     /login 菜单可选 deepseek,模型 deepseek-chat / deepseek-reasoner。
 */

import { spawn, execSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// DeepSeek 原生支持检测(仅供 /ugk 状态显示用)
const DEEPSEEK_CONFIGURED = !!process.env.DEEPSEEK_API_KEY;

// 本机 adb 路径(与 adb-guide / scrcpy-guide skill 保持一致)
// scrcpy 必须复用它,否则自带的 adb 会 kill 掉正在跑的 adb server、断开设备连接
const ADB_PATH = "E:\\platform-tools\\adb.exe";

// 解析 scrcpy 可执行文件路径。
// winget 装完会改 PATH,但本进程环境继承的是旧 PATH,可能解析不到。
// 策略:PATH 能解析就用;否则查 winget 标准安装目录兜底。
const SCRCPY_DIRS = [
	process.env.LOCALAPPDATA &&
		`${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\\scrcpy-win64-v4.0`,
	"E:\\scrcpy", // 手动解压的兜底位置(见 scrcpy-guide skill)
].filter(Boolean) as string[];

function findScrcpy(): string | null {
	// 1) PATH 能否直接解析
	try {
		execSync("scrcpy --version", { encoding: "utf8", stdio: "ignore", timeout: 8000 });
		return "scrcpy"; // 裸命令可用,交给系统 PATH 解析
	} catch {
		// 落到兜底
	}
	// 2) 查已知目录
	for (const dir of SCRCPY_DIRS) {
		const fs = require("node:fs");
		const candidate = `${dir}\\scrcpy.exe`;
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// 忽略,试下一个
		}
	}
	return null;
}

// ---- 自定义工具(照搬 hello.ts 模式)----
const greetTool = defineTool({
	name: "greet",
	label: "Greet",
	description: "A demo greeting tool. Use when the user says hi or asks to be greeted.",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}! (from ugk-pi-agent)` }],
			details: { greeted: params.name },
		};
	},
});

// ---- scrcpy 投屏工具 ----
// 封装两件 skill 解决不了的事:
//  1) ADB 环境变量:让 scrcpy 复用本机 platform-tools 的 adb,避免多 adb 打架断连
//  2) 后台启动:agent 的 bash 工具是同步的,detached spawn + unref 让投屏窗口独立运行、立即返回
const scrcpyTool = defineTool({
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

		// action === "start"
		// 先确认设备在线(快速 fail,避免 scrcpy 卡在等待设备)
		try {
			const dev = execSync(`"${ADB_PATH}" devices`, { encoding: "utf8", timeout: 10000 });
			if (!/\bdevice\b/.test(dev) || /List of devices attached/.test(dev) && dev.trim().split(/\r?\n/).length < 3) {
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

		// 拆分额外参数为 args 数组(简单空格分词,够用)
		const args = params.extraArgs ? params.extraArgs.trim().split(/\s+/) : [];
		try {
			// detached + unref:让 scrcpy 独立于 agent 进程运行,工具立即返回
			const child = spawn(scrcpyBin!, args, {
				env: { ...process.env, ADB: ADB_PATH },
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.unref();
			return {
				content: [
					{
						type: "text",
						text: `🚀 scrcpy 投屏已启动(后台)\nADB: ${ADB_PATH}${args.length ? `\n参数: ${args.join(" ")}` : ""}\n关闭窗口或用 action=stop 停止。`,
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

export default function (pi: ExtensionAPI) {
	// 1) 自定义工具
	pi.registerTool(greetTool);
	pi.registerTool(scrcpyTool);

	// 2) slash 命令
	pi.registerCommand("ugk", {
		description: "Show ugk-pi-agent status",
		handler: async (_args, ctx) => {
			const deepseekStatus = DEEPSEEK_CONFIGURED
				? "deepseek: 已配置(deepseek-chat,默认)"
				: "deepseek: 未配置(设 DEEPSEEK_API_KEY 启用)";
			ctx.ui.notify(
				`ugk-pi-agent active\n工具: greet · scrcpy(投屏) · 命令: /ugk /welcome · skill: ugk-guide · adb-guide · scrcpy-guide\n${deepseekStatus}\n危险 bash(rm -rf/sudo/chmod 777)有权限门`,
				"info",
			);
		},
	});

	// 3) 权限门(照搬 permission-gate.ts 模式)
	//    拦截危险 bash 命令,交互模式弹确认,非交互模式直接拦截(fail-safe)
	const dangerousPatterns = [
		/\brm\s+(-rf?|--recursive)/i,
		/\bsudo\b/i,
		/\b(chmod|chown)\b.*777/i,
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		if (!dangerousPatterns.some((p) => p.test(command))) return undefined;

		if (!ctx.hasUI) {
			// 非交互模式:默认拦截(fail-safe)
			return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
		}

		const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
		if (choice !== "Yes") {
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});
}
