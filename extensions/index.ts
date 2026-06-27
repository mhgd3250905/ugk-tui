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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import registerBuiltinToolRenderers from "./builtin-tool-render.ts";
import { checkEnv } from "./device-env.ts";
import { scrcpyTool } from "./scrcpy-tool.ts";
import registerSubagent from "./subagent.ts";
import registerSubagentCommand from "./subagent-command.ts";
import { discoverAgents } from "./subagent-agents.ts";
import registerUiStatusline from "./ui-statusline.ts";
import registerUgkBrandUi from "./ui-brand.ts";
import registerCron from "./cron.ts";
import registerPlanMode from "./plan-mode.ts";
import registerTask from "./task/task.ts";
import registerChromeCdp from "./chrome-cdp/index.ts";
import registerDoctor from "./doctor/index.ts";
import { createCoreDoctorChecks } from "./doctor/checks.ts";
import registerMcp, { createMcpDoctorCheck } from "./mcp/index.ts";
import { registerUgkUpdate } from "./update-check.ts";
import { getDeepSeekStatus } from "./deepseek-status.ts";
import { renderTerminalTable } from "./terminal-table.ts";
import { AUTOPILOT_PROMPT_SNIPPET, isAutopilotOn, setAutopilot } from "./shared/autopilot.ts";
import { buildLanguagePromptSnippet, clearLanguage, getLanguage, setLanguage } from "./shared/language.ts";

function isNaturalBareAtPrefix(lines: string[], cursorLine: number, cursorCol: number): boolean {
	const currentLine = lines[cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	return /(?:^|\s)@[^/\s"~.]*$/.test(textBeforeCursor);
}

export function suppressNaturalAtAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		...current,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			if (!options.force && isNaturalBareAtPrefix(lines, cursorLine, cursorCol)) {
				// ponytail: @agent owns bare @ text; file completion still works via Tab or path-like @./.
				return null;
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	};
}

function formatUgkStatusTable(deepseekStatus: string): string {
	const apiIcon = /已配置/.test(deepseekStatus) ? "✅" : "❌";
	const apiSummary = deepseekStatus.replace(/^deepseek:\s*/, "DeepSeek ");
	const rows = [
		["🧰 Tools", "✅ scrcpy  ✅ subagent  ✅ cron  ✅ chrome_cdp  ✅ mcp"],
		["🤖 Agents", "✅ @agent mention  ✅ /implement pipeline  ✅ isolated summaries"],
		["⌨️ Commands", "/ugk  /doctor  /check-env  /update  /plan  /cdp  /mcp  /ugk-ui  /ugk-autopilot  /language"],
		["📡 API", `${apiIcon} ${apiSummary}`],
		["🛡️ Guard", "dangerous bash gate enabled"],
	] as const;

	return [
		"🟢 UGK active",
		"",
		renderTerminalTable(["模块", "状态"], rows),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

	// 0) 内置工具精简渲染(必须最先,覆盖默认 bash/edit)
	registerBuiltinToolRenderers(pi);

	// 1) 自定义工具
	pi.registerTool(scrcpyTool);

	// 1.1) subagent 工具(从官方 subagent 示例搬运 + Windows spawn 适配)
	registerSubagent(pi);
	registerSubagentCommand(pi);

	// 1.2) UI 美化(从官方示例搬运,三处区域互不冲突)
	//   - footer:底栏 token 统计 + git 分支 + 模型名(/footer 开关)
	//   - statusline:底部状态条显示回合进度(●第N轮... / ✓完成)
	//   - titlebar:agent 工作时终端标题栏转盲文 spinner
	registerUgkBrandUi(pi);
	registerUiStatusline(pi);
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider?.(suppressNaturalAtAutocomplete);
	});

	// 1.3) cron 定时任务(代理常驻 cron 服务的 HTTP API)
	registerCron(pi);

	// 1.3b) plan-mode:只读探索模式(/plan 切换,bash 白名单,计划提取+进度跟踪)
	registerPlanMode(pi);

	// 1.3b.3) task:固定任务 taskbook 创造/复用系统
	registerTask(pi);

	// 1.3c) chrome-cdp:受保护的本地登录态 Chrome 控制器(/cdp + chrome_cdp tool)
	registerChromeCdp(pi);

	// 1.3c.1) mcp:外部 MCP stdio tools 集成(/mcp + session lifecycle)
	const mcpState = registerMcp(pi, { packageRoot });

	// 1.3c.2) doctor:只读核心能力体检(bash / api / chrome / mcp)
	registerDoctor(pi, { checks: [...createCoreDoctorChecks(), createMcpDoctorCheck({ registry: mcpState.registry, packageRoot })] });

	// 1.3d) UGK 自管更新:只暴露 UGK 更新,不暴露 pi update
	registerUgkUpdate(pi);

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
			ctx.ui.notify(formatUgkStatusTable(getDeepSeekStatus()), "info");
		},
	});

	// 2.0) /ugk-autopilot:统一工具确认总开关(①②类工具确认受管,危险命令门不受管)。
	//   on  = 普通工具确认(CDP/MCP/未来工具)一律放行 + 注入"别问范围问题"指令(治 ③类)。
	//   off = 恢复默认(工具各自回 ask)。
	//   状态只在会话内存,关 ugk 即忘。危险动作(rm -rf 等)永远走人确认,autopilot 管不到。
	pi.registerCommand("ugk-autopilot", {
		description: "Toggle autopilot: auto-approve reversible tool confirmations",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				setAutopilot(arg === "on");
				ctx.ui.notify(
					`Autopilot: ${arg === "on" ? "ON" : "OFF"}\n` +
						(arg === "on"
							? "可逆的工具确认(CDP/MCP 等)自动放行;危险命令(rm -rf 等)仍归人。"
							: "工具确认回到各工具自己的模式。"),
					"info",
				);
				return;
			}
			if (arg === "status" || arg === "") {
				ctx.ui.notify(`Autopilot: ${isAutopilotOn() ? "ON" : "OFF"}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /ugk-autopilot on|off|status", "warning");
		},
	});

	// 2.0b) before_agent_start 注入动态指令(autopilot 范围问卷 + 用户语言偏好)。
	//   一个钩子处理两段 prompt,比两个钩子少一次 systemPrompt 读写。
	pi.on("before_agent_start", async (event: { systemPrompt?: string } = {}) => {
		const snippets: string[] = [];
		if (isAutopilotOn()) snippets.push(AUTOPILOT_PROMPT_SNIPPET);
		const langSnippet = buildLanguagePromptSnippet(getLanguage());
		if (langSnippet) snippets.push(langSnippet);
		if (snippets.length === 0) return undefined;

		const prompt = event.systemPrompt ?? "";
		const toAdd = snippets.filter((s) => !prompt.includes(s));
		if (toAdd.length === 0) return undefined;
		return { systemPrompt: [prompt, "", ...toAdd].join("\n") };
	});

	// 2.0c) /language:用户语言偏好(跨会话持久,自由字符串)。
	//   /language <语言>  = 设(如 /language English、/language 日本語)
	//   /language status  = 看当前
	//   /language clear   = 清除,回到 AGENTS.md 默认(优先中文)
	//   无参 = 交互输入(支持时)
	pi.registerCommand("language", {
		description: "Set the language the agent speaks (persists across sessions)",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();
			const arg = raw.toLowerCase();

			if (arg === "status" || (arg === "" && !ctx.ui?.input)) {
				const current = getLanguage();
				ctx.ui.notify(
					current
						? `当前语言偏好: ${current}\n(/language <语言> 修改,/language clear 清除回默认)`
						: `当前语言偏好: 默认(优先中文)\n(/language <语言> 设置)`,
					"info",
				);
				return;
			}
			if (arg === "clear") {
				clearLanguage();
				ctx.ui.notify("语言偏好已清除,回到默认(优先中文)。", "info");
				return;
			}
			if (arg === "") {
				// ponytail: 无参且有 input 能力时,交互问一句。避免命令解析对 input 能力的耦合。
				const input = await ctx.ui.input("用什么语言与 agent 交流?", "如:English / 中文 / 日本語");
				if (!input?.trim()) {
					ctx.ui.notify("未设置,保持当前语言偏好。", "info");
					return;
				}
				const set = setLanguage(input);
				ctx.ui.notify(`语言偏好已设为: ${set}\n下个回合起生效。`, "info");
				return;
			}
			const set = setLanguage(raw);
			ctx.ui.notify(`语言偏好已设为: ${set}\n下个回合起生效。`, "info");
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
	//
	//    skills = 系统自带(跟包走,更新覆盖);user-skills = 用户手动安装/创建,
	//    同样在包目录下,跟着 git clone 走(用户在哪运行 ugk 都用同一批)。
	//    两者用同一个 scanSkillPaths,来源统一、加载机制统一。
	pi.on("resources_discover", () => {
		return {
			skillPaths: [
				...scanSkillPaths(path.join(packageRoot, "skills")),
				...scanSkillPaths(path.join(packageRoot, "user-skills")),
			],
			promptPaths: scanFilesByExtension(path.join(packageRoot, "prompts"), ".md"),
			themePaths: scanFilesByExtension(path.join(packageRoot, "themes"), ".json"),
		};
	});
}

/** Scan <dir>/<name>/SKILL.md for each subdirectory; missing dir returns []. */
export function scanSkillPaths(skillsDir: string): string[] {
	const paths: string[] = [];
	try {
		for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
			if (fs.existsSync(skillFile)) paths.push(skillFile);
		}
	} catch {
		// skills 目录不存在则跳过
	}
	return paths;
}

/** Scan <dir> for files ending in ext; missing dir returns []. */
function scanFilesByExtension(dir: string, ext: string): string[] {
	const paths: string[] = [];
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
			paths.push(path.join(dir, entry.name));
		}
	} catch {
		// 目录不存在则跳过
	}
	return paths;
}
