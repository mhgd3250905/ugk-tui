import fs from "node:fs";
import path from "node:path";

export interface ChromeTab {
	id: string;
	type: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

export interface ChromeCdpClient {
	port: number;
	fetch: typeof fetch;
	WebSocket: typeof WebSocket;
}

export interface ChromeCdpStatus {
	online: boolean;
	port: number;
	tabs?: ChromeTab[];
	error?: string;
}

export function createChromeCdpClient(options: {
	port: number;
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
}): ChromeCdpClient {
	return {
		port: options.port,
		fetch: options.fetch ?? fetch,
		WebSocket: options.WebSocket ?? WebSocket,
	};
}

function endpoint(client: ChromeCdpClient, route: string): string {
	return `http://127.0.0.1:${client.port}${route}`;
}

export async function listChromeTabs(client: ChromeCdpClient): Promise<ChromeTab[]> {
	const response = await client.fetch(endpoint(client, "/json/list"));
	if (!response.ok) throw new Error(`Chrome CDP returned HTTP ${response.status}`);
	const targets = (await response.json()) as ChromeTab[];
	return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

export async function getChromeCdpStatus(client: ChromeCdpClient): Promise<ChromeCdpStatus> {
	try {
		const tabs = await listChromeTabs(client);
		return { online: true, port: client.port, tabs };
	} catch (error) {
		return {
			online: false,
			port: client.port,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function findTab(client: ChromeCdpClient, target?: string): Promise<ChromeTab> {
	const tabs = await listChromeTabs(client);
	const tab =
		(target
			? tabs.find((item) => item.id === target || item.url?.includes(target) || item.title?.includes(target))
			: tabs[0]) ?? null;
	if (!tab?.webSocketDebuggerUrl) {
		throw new Error(`Chrome tab not found${target ? `: ${target}` : ""}`);
	}
	return tab;
}

function sendCdpCommand(
	WebSocketCtor: typeof WebSocket,
	webSocketUrl: string,
	method: string,
	params: Record<string, unknown>,
): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocketCtor(webSocketUrl);
		const id = 1;
		const timer = setTimeout(() => {
			try {
				socket.close();
			} catch {}
			reject(new Error(`Timed out waiting for CDP response: ${method}`));
		}, 10000);

		socket.onopen = () => {
			socket.send(JSON.stringify({ id, method, params }));
		};
		socket.onerror = (event) => {
			clearTimeout(timer);
			reject(new Error(`CDP WebSocket error: ${String(event)}`));
		};
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data));
			if (message.id !== id) return;
			clearTimeout(timer);
			socket.close();
			if (message.error) {
				reject(new Error(message.error.message || `CDP command failed: ${method}`));
				return;
			}
			resolve(message.result);
		};
	});
}

export async function navigateChromeTab(client: ChromeCdpClient, target: string | undefined, url: string) {
	const tab = await findTab(client, target);
	return sendCdpCommand(client.WebSocket, tab.webSocketDebuggerUrl!, "Page.navigate", { url });
}

export async function evaluateChromeExpression(
	client: ChromeCdpClient,
	target: string | undefined,
	expression: string,
) {
	const tab = await findTab(client, target);
	const result = await sendCdpCommand(client.WebSocket, tab.webSocketDebuggerUrl!, "Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	return result.result;
}

export async function captureChromeScreenshot(client: ChromeCdpClient, target: string | undefined, filePath: string) {
	const tab = await findTab(client, target);
	const result = await sendCdpCommand(client.WebSocket, tab.webSocketDebuggerUrl!, "Page.captureScreenshot", {
		format: "png",
		fromSurface: true,
	});
	const data = Buffer.from(String(result.data || ""), "base64");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, data);
	return { path: filePath, bytes: data.length };
}
