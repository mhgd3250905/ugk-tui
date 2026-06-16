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

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkEnv } from "./device-env.ts";
import { scrcpyTool } from "./scrcpy-tool.ts";
import registerSubagent from "./subagent.ts";
import { discoverAgents } from "./subagent-agents.ts";
import registerUiFooter from "./ui-footer.ts";
import registerUiStatusline from "./ui-statusline.ts";
import registerUiTitlebar from "./ui-titlebar.ts";
import registerUgkBrandUi from "./ui-brand.ts";
import registerCron from "./cron.ts";
import registerPlanMode from "./plan-mode.ts";
import registerChromeCdp from "./chrome-cdp/index.ts";
import { getDeepSeekStatus } from "./deepseek-status.ts";

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
	registerUgkBrandUi(pi);
	registerUiFooter(pi);
	registerUiStatusline(pi);
	registerUiTitlebar(pi);

	// 1.3) cron 定时任务(代理常驻 cron 服务的 HTTP API)
	registerCron(pi);

	// 1.3b) plan-mode:只读探索模式(/plan 切换,bash 白名单,计划提取+进度跟踪)
	registerPlanMode(pi);

	// 1.3c) chrome-cdp:受保护的本地登录态 Chrome 控制器(/cdp + chrome_cdp tool)
	registerChromeCdp(pi);

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
			const deepseekStatus = getDeepSeekStatus();
			ctx.ui.notify(
				`ugk-pi-agent active\n工具: greet · scrcpy(投屏) · subagent(子代理) · cron(定时) · chrome_cdp(本地登录态 Chrome,ask-gated) · 命令: /ugk /welcome /check-env /ugk-ui /footer /plan /todos /cdp · @agent名 手动委派 · UI: ugk品牌层+footer+状态条+标题栏spinner · skill: ugk-guide · adb-guide · scrcpy-guide · subagent-guide · cron-guide · chrome-cdp-guide\n${deepseekStatus}\n危险 bash(rm -rf/sudo/chmod 777)有权限门`,
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

	// 4) resources_discover:让 skills/prompts 随包走
	//    bin/ugk.js 用 -e 加载本扩展(只管扩展文件),skills/prompts 靠这个事件带上。
	//    扫描包内的 skills/<name>/SKILL.md 和 prompts/*.md,返回绝对路径。
	//    模式借自官方 examples/extensions/dynamic-resources。
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	pi.on("resources_discover", () => {
		const skillPaths: string[] = [];
		const skillsDir = path.join(packageRoot, "skills");
		try {
			for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
				if (fs.existsSync(skillFile)) skillPaths.push(skillFile);
			}
		} catch {
			// skills 目录不存在则跳过
		}

		const promptPaths: string[] = [];
		const promptsDir = path.join(packageRoot, "prompts");
		try {
			for (const entry of fs.readdirSync(promptsDir, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				promptPaths.push(path.join(promptsDir, entry.name));
			}
		} catch {
			// prompts 目录不存在则跳过
		}

		const themePaths: string[] = [];
		const themesDir = path.join(packageRoot, "themes");
		try {
			for (const entry of fs.readdirSync(themesDir, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				themePaths.push(path.join(themesDir, entry.name));
			}
		} catch {
			// themes 目录不存在则跳过
		}

		return { skillPaths, promptPaths, themePaths };
	});
}
