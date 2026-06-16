import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	captureChromeScreenshot,
	createChromeCdpClient,
	evaluateChromeExpression,
	getChromeCdpStatus,
	listChromeTabs,
	navigateChromeTab,
	type ChromeTab,
} from "./client.ts";
import {
	checkChromeCdpPolicy,
	createChromeCdpState,
	resolveChromeCdpPort,
	setChromeCdpMode,
	setChromeCdpPort,
	type ChromeCdpAction,
	type ChromeCdpState,
} from "./config.ts";
import { formatChromeCdpStatus, formatChromeTabs } from "./formatter.ts";
import { launchChromeCdp, launchChromeCdpAndWait } from "./launcher.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

export interface ChromeCdpDeps {
	getStatus?: (port: number) => Promise<Awaited<ReturnType<typeof getChromeCdpStatus>>>;
	listTabs?: (port: number) => Promise<ChromeTab[]>;
	navigate?: (port: number, target: string | undefined, url: string) => Promise<unknown>;
	evaluate?: (port: number, target: string | undefined, expression: string) => Promise<unknown>;
	screenshot?: (port: number, target: string | undefined, path: string) => Promise<unknown>;
	launch?: (port: number) => Promise<string>;
}
function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function defaultDeps(): Required<ChromeCdpDeps> {
	return {
		getStatus: async (port) => getChromeCdpStatus(createChromeCdpClient({ port })),
		listTabs: async (port) => listChromeTabs(createChromeCdpClient({ port })),
		navigate: async (port, target, url) => navigateChromeTab(createChromeCdpClient({ port }), target, url),
		evaluate: async (port, target, expression) =>
			evaluateChromeExpression(createChromeCdpClient({ port }), target, expression),
		screenshot: async (port, target, filePath) =>
			captureChromeScreenshot(createChromeCdpClient({ port }), target, filePath),
		launch: async (port) => launchChromeCdpAndWait(port),
	};
}

async function confirmChromeCdpUse(ctx: any, params: any): Promise<boolean> {
	if (!ctx.hasUI || !ctx.ui?.confirm) return false;
	return ctx.ui.confirm(
		"Allow Chrome CDP?",
		[
			"An agent wants to control your local logged-in Chrome session.",
			params.url ? `URL: ${params.url}` : params.target ? `Target: ${params.target}` : "",
			`Reason: ${params.reason}`,
			"Allow this browser operation?",
		]
			.filter(Boolean)
			.join("\n"),
	);
}

function createChromeCdpTool(state: ChromeCdpState, deps: Required<ChromeCdpDeps>) {
	return defineTool({
		name: "chrome_cdp",
		label: "Chrome CDP",
		description:
			"Use only when the user explicitly wants to control their local logged-in Chrome session, or when normal network access cannot reach the target because it requires cookies, SSO, CAPTCHA, private workspace state, or an existing browser login. Do not use for public web search, ordinary documentation lookup, normal HTTP requests, or pages accessible through bash/fetch/browser-free methods.",
		promptSnippet:
			"chrome_cdp controls a local logged-in Chrome session through CDP only after ordinary access is insufficient or the user explicitly requests local Chrome.",
		promptGuidelines: [
			"Do not use chrome_cdp for public web search, documentation lookup, or pages accessible through normal network tools.",
			"Use chrome_cdp only for local logged-in Chrome state, SSO, CAPTCHA, cookies, private workspace pages, or explicit user requests.",
			"Before using chrome_cdp, explain why ordinary access is insufficient and pass reason plus normalAccessAttempted.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("status"),
					Type.Literal("tabs"),
					Type.Literal("navigate"),
					Type.Literal("evaluate"),
					Type.Literal("screenshot"),
				],
				{ description: "status, tabs, navigate, evaluate, or screenshot" },
			),
			port: Type.Optional(Type.Number({ description: "Local CDP port. Defaults to /cdp port, UGK_CDP_PORT, then 9222." })),
			target: Type.Optional(Type.String({ description: "Tab id, URL substring, or title substring." })),
			url: Type.Optional(Type.String({ description: "URL for navigate." })),
			expression: Type.Optional(Type.String({ description: "JavaScript expression for evaluate." })),
			path: Type.Optional(Type.String({ description: "Output path for screenshot PNG." })),
			reason: Type.String({ description: "Why CDP is needed for this operation." }),
			normalAccessAttempted: Type.Boolean({
				description: "Whether ordinary network/browser-free access was attempted or reasoned through first.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action as ChromeCdpAction;
			const policy = checkChromeCdpPolicy(state, {
				action,
				url: params.url,
				reason: params.reason,
				normalAccessAttempted: params.normalAccessAttempted,
			});
			if (!policy.allowed) return textResult(policy.reason, { blocked: true });
			if (policy.requiresConfirmation && !(await confirmChromeCdpUse(ctx, params))) {
				return textResult("Chrome CDP request denied by user.", { blocked: true });
			}

			const port = resolveChromeCdpPort(state, { port: params.port });
			if (action === "status") {
				const status = await deps.getStatus(port);
				return textResult(formatChromeCdpStatus(status), status as any);
			}
			if (action === "tabs") {
				const tabs = await deps.listTabs(port);
				return textResult(formatChromeTabs(tabs), { tabs });
			}
			if (action === "navigate") {
				if (!params.url) return textResult("navigate requires url.", { ok: false });
				const result = await deps.navigate(port, params.target, params.url);
				return textResult(`Navigated Chrome tab to ${params.url}`, { ok: true, result });
			}
			if (action === "evaluate") {
				if (!params.expression) return textResult("evaluate requires expression.", { ok: false });
				const result = await deps.evaluate(port, params.target, params.expression);
				return textResult(JSON.stringify(result, null, 2), { ok: true, result });
			}
			if (action === "screenshot") {
				if (!params.path) return textResult("screenshot requires path.", { ok: false });
				const result = await deps.screenshot(port, params.target, params.path);
				return textResult(`Saved Chrome screenshot to ${params.path}`, { ok: true, result });
			}
			return textResult(`Unknown chrome_cdp action: ${String(action)}`, { ok: false });
		},
	});
}

export function registerChromeCdp(pi: ExtensionAPI, overrides: ChromeCdpDeps = {}): void {
	const state = createChromeCdpState();
	const deps = { ...defaultDeps(), ...overrides };

	pi.registerTool(createChromeCdpTool(state, deps));
	pi.registerCommand("cdp", {
		description: "Configure guarded local Chrome CDP access",
		handler: async (args, ctx) => {
			const [action, value] = args.trim().split(/\s+/);
			if (!action || action === "status") {
				const port = resolveChromeCdpPort(state, {});
				const status = await deps.getStatus(port);
				ctx.ui.notify(`CDP mode: ${state.mode}\n${formatChromeCdpStatus(status)}`, "info");
				return;
			}
			if (action === "ask" || action === "on" || action === "off") {
				setChromeCdpMode(state, action);
				ctx.ui.notify(`Chrome CDP mode: ${action}`, "info");
				return;
			}
			if (action === "port") {
				const port = Number(value);
				try {
					setChromeCdpPort(state, port);
				} catch {
					ctx.ui.notify(`Invalid CDP port: ${value || "(missing)"}. Use /cdp port <1-65535>.`, "warning");
					return;
				}
				ctx.ui.notify(`Chrome CDP port: ${port}`, "info");
				return;
			}
			if (action === "tabs") {
				const tabs = await deps.listTabs(resolveChromeCdpPort(state, {}));
				ctx.ui.notify(formatChromeTabs(tabs), "info");
				return;
			}
			if (action === "launch") {
				ctx.ui.notify(await deps.launch(resolveChromeCdpPort(state, {})), "info");
				return;
			}
			ctx.ui.notify("Usage: /cdp status|ask|on|off|port <number>|launch|tabs", "warning");
		},
	});
}

export default function chromeCdpExtension(pi: ExtensionAPI): void {
	registerChromeCdp(pi);
}
