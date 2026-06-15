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

// DeepSeek 原生支持检测(仅供 /ugk 状态显示用)
const DEEPSEEK_CONFIGURED = !!process.env.DEEPSEEK_API_KEY;

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

	// 2) slash 命令
	pi.registerCommand("ugk", {
		description: "Show ugk-pi-agent status",
		handler: async (_args, ctx) => {
			const deepseekStatus = DEEPSEEK_CONFIGURED
				? "deepseek: 已配置(用 --model deepseek-chat 或进 TUI 用 /login)"
				: "deepseek: 未配置(设 DEEPSEEK_API_KEY 启用)";
			ctx.ui.notify(
				`ugk-pi-agent active\n工具: greet · 命令: /ugk · skill: /skill:ugk-guide\n${deepseekStatus}\n危险 bash 有权限门`,
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
