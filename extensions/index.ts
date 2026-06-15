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
import registerSubagent from "./subagent.ts";
import { discoverAgents } from "./subagent-agents.ts";
import registerUiFooter from "./ui-footer.ts";
import registerUiStatusline from "./ui-statusline.ts";
import registerUiTitlebar from "./ui-titlebar.ts";
import registerCron from "./cron.ts";
import registerPlanMode from "./plan-mode.ts";

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
	const fs = require("node:fs");
	for (const dir of SCRCPY_DIRS) {
		const candidate = `${dir}\\scrcpy.exe`;
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// 忽略,试下一个
		}
	}
	return null;
}

// 本机 adb 的候选位置(按优先级)。findAdb 用于环境自检和 scrcpy 工具启动。
const ADB_PATHS = [
	ADB_PATH, // 项目默认位置(E:\platform-tools)
	"E:\\platform-tools\\adb.exe",
	process.env.LOCALAPPDATA &&
		`${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\\platform-tools\\adb.exe`,
	process.env.ANDROID_HOME && `${process.env.ANDROID_HOME}\\platform-tools\\adb.exe`,
	process.env.ANDROID_SDK_ROOT && `${process.env.ANDROID_SDK_ROOT}\\platform-tools\\adb.exe`,
].filter(Boolean) as string[];

// 解析 adb 可执行文件路径。PATH 优先,否则查候选目录。
function findAdb(): string | null {
	// 1) PATH 能否直接解析
	try {
		execSync("adb version", { encoding: "utf8", stdio: "ignore", timeout: 8000 });
		return "adb";
	} catch {
		// 落到候选
	}
	// 2) 查候选路径
	const fs = require("node:fs");
	for (const candidate of ADB_PATHS) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// 忽略
		}
	}
	return null;
}

// 环境自检:检测 adb / scrcpy / 设备连接三件套,返回诊断文本(供 /check-env 命令用)
function checkEnv(): string {
	const lines: string[] = ["🔍 ugk 环境自检", ""];

	// adb
	const adbBin = findAdb();
	if (adbBin) {
		let ver = "?";
		try {
			ver = execSync(`"${adbBin}" version`, { encoding: "utf8", timeout: 8000 }).split(/\r?\n/)[0];
		} catch {
			/* 忽略 */
		}
		lines.push(`✅ adb      ${ver}  [${adbBin}]`);
	} else {
		lines.push("❌ adb      未找到");
	}

	// 设备(只在 adb 可用时查)
	if (adbBin) {
		try {
			const dev = execSync(`"${adbBin}" devices -l`, { encoding: "utf8", timeout: 8000 });
			const devices = dev
				.trim()
				.split(/\r?\n/)
				.slice(1)
				.filter((l) => l.trim());
			if (devices.length === 0) {
				lines.push("⚠️  设备     无设备连接(插线/开 USB 调试/点允许)");
			} else {
				const ok = devices.filter((l) => /\bdevice\b/.test(l));
				const bad = devices.filter((l) => !/\bdevice\b/.test(l));
				lines.push(`✅ 设备     ${ok.length} 台在线` + (bad.length ? `  ·  ${bad.length} 台异常(offline/unauthorized)` : ""));
				for (const d of devices) lines.push(`           ${d.trim()}`);
			}
		} catch {
			lines.push("❌ 设备     查询失败");
		}
	} else {
		lines.push("⏭️  设备     跳过(adb 不可用)");
	}

	// scrcpy
	const scrcpyBin = findScrcpy();
	if (scrcpyBin) {
		let ver = "?";
		try {
			ver = execSync(`"${scrcpyBin}" --version`, { encoding: "utf8", timeout: 8000 }).split(/\r?\n/)[0];
		} catch {
			/* 忽略 */
		}
		lines.push(`✅ scrcpy   ${ver}  [${scrcpyBin === "scrcpy" ? "PATH" : scrcpyBin}]`);
	} else {
		lines.push("❌ scrcpy   未找到");
	}

	// 安装指引(只列缺失项)
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
		// 先解析 adb(支持装在别处),再确认设备在线(快速 fail,避免 scrcpy 卡在等待设备)
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

export default function (pi: ExtensionAPI) {
	// 1) 自定义工具
	pi.registerTool(greetTool);
	pi.registerTool(scrcpyTool);

	// 1.1) subagent 工具(从官方 subagent 示例搬运 + Windows spawn 适配)
	registerSubagent(pi);

	// 1.2) UI 美化(从官方示例搬运,三处区域互不冲突)
	//   - footer:底栏 token 统计 + git 分支 + 模型名(/footer 开关)
	//   - statusline:底部状态条显示回合进度(●第N轮... / ✓完成)
	//   - titlebar:agent 工作时终端标题栏转盲文 spinner
	registerUiFooter(pi);
	registerUiStatusline(pi);
	registerUiTitlebar(pi);

	// 1.3) cron 定时任务(代理常驻 cron 服务的 HTTP API)
	registerCron(pi);

	// 1.3b) plan-mode:只读探索模式(/plan 切换,bash 白名单,计划提取+进度跟踪)
	registerPlanMode(pi);

	// 1.4) @mention 手动触发:输入 @<agent名> <任务> → 改写为指示主 agent 委派的消息
	//      agent 名从 discoverAgents 动态读(不写死),保持可配置。
	//      模式借自 inline-bash.ts:pi.on("input") 返回 { action: "transform", text }
	pi.on("input", async (event, _ctx) => {
		const text = event.text;
		// 匹配行首或空格后的 @agentname,后接任务文本
		const match = text.match(/^\s*@([\w-]+)\s+([\s\S]+)/);
		if (!match) return { action: "continue" };

		const agentName = match[1];
		const task = match[2].trim();

		// 确认是已注册的 agent(避免误吞 @github 用户名等)
		const { agents } = discoverAgents(process.cwd(), "user");
		if (!agents.some((a) => a.name === agentName)) {
			return { action: "continue" };
		}

		// 改写为明确的委派指令,让主 agent 调 subagent 工具
		const transformed = `用 subagent 工具完成以下任务(强制指定 agent="${agentName}",task 内容如下):\n\n${task}`;
		return { action: "transform", text: transformed, images: event.images };
	});

	// 2) slash 命令
	pi.registerCommand("ugk", {
		description: "Show ugk-pi-agent status",
		handler: async (_args, ctx) => {
			const deepseekStatus = DEEPSEEK_CONFIGURED
				? "deepseek: 已配置(deepseek-chat,默认)"
				: "deepseek: 未配置(设 DEEPSEEK_API_KEY 启用)";
			ctx.ui.notify(
				`ugk-pi-agent active\n工具: greet · scrcpy(投屏) · subagent(子代理) · cron(定时) · 命令: /ugk /welcome /check-env /footer /plan /todos · @agent名 手动委派 · UI: footer+状态条+标题栏spinner · skill: ugk-guide · adb-guide · scrcpy-guide · subagent-guide · cron-guide\n${deepseekStatus}\n危险 bash(rm -rf/sudo/chmod 777)有权限门`,
				"info",
			);
		},
	});

	// 2.1) /check-env:一键自检 adb / scrcpy / 设备连接,新环境首次用投屏前跑这个
	pi.registerCommand("check-env", {
		description: "自检 adb/scrcpy/设备连接,缺失项给安装命令",
		handler: async (_args, ctx) => {
			ctx.ui.notify(checkEnv(), "info");
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
