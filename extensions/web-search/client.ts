export interface WebSearchTab {
	id: string;
	type: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

export interface WebSearchClient {
	port: number;
	fetch: typeof fetch;
	WebSocket: typeof WebSocket;
}

export interface WebSearchStatus {
	online: boolean;
	port: number;
	tabs?: WebSearchTab[];
	error?: string;
}

export function createWebSearchClient(options: {
	port: number;
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
}): WebSearchClient {
	return {
		port: options.port,
		fetch: options.fetch ?? fetch,
		WebSocket: options.WebSocket ?? WebSocket,
	};
}

function endpoint(client: WebSearchClient, route: string): string {
	return `http://127.0.0.1:${client.port}${route}`;
}

async function listPageTabs(client: WebSearchClient): Promise<WebSearchTab[]> {
	const response = await client.fetch(endpoint(client, "/json/list"));
	if (!response.ok) throw new Error(`Web search CDP returned HTTP ${response.status}`);
	const targets = (await response.json()) as WebSearchTab[];
	return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

export async function getWebSearchStatus(port: number, fetchImpl: typeof fetch = fetch): Promise<WebSearchStatus> {
	const client = createWebSearchClient({ port, fetch: fetchImpl });
	try {
		const tabs = await listPageTabs(client);
		return { online: true, port, tabs };
	} catch (error) {
		return { online: false, port, error: error instanceof Error ? error.message : String(error) };
	}
}

async function firstPageTab(client: WebSearchClient): Promise<WebSearchTab> {
	const tab = (await listPageTabs(client))[0];
	if (!tab?.webSocketDebuggerUrl) throw new Error("Web search Chrome tab not found");
	return tab;
}

function sendCdpCommand(
	WebSocketCtor: typeof WebSocket,
	webSocketUrl: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMs = 10000,
	signal?: AbortSignal,
): Promise<any> {
	const clampedTimeoutMs = Math.min(Math.max(timeoutMs, 1000), 480000);
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const socket = new WebSocketCtor(webSocketUrl);
		const id = 1;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const timer = setTimeout(() => {
			try { socket.close(); } catch {}
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(`Timed out waiting for CDP response: ${method}`));
		}, clampedTimeoutMs);
		const onAbort = () => {
			clearTimeout(timer);
			try { socket.close(); } catch {}
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		socket.onopen = () => {
			socket.send(JSON.stringify({ id, method, params }));
		};
		socket.onerror = (event) => {
			cleanup();
			reject(new Error(`CDP WebSocket error: ${String(event)}`));
		};
		socket.onmessage = (event) => {
			let message: any;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				cleanup();
				try { socket.close(); } catch {}
				reject(new Error(`CDP returned malformed message: ${String(event.data).slice(0, 200)}`));
				return;
			}
			if (message.id !== id) return;
			cleanup();
			socket.close();
			if (message.error) {
				reject(new Error(message.error.message || `CDP command failed: ${method}`));
				return;
			}
			resolve(message.result);
		};
	});
}

function abortError(): Error {
	const err = new Error("web_search operation aborted");
	err.name = "AbortError";
	return err;
}

export async function navigateToUrl(client: WebSearchClient, url: string, signal?: AbortSignal) {
	const tab = await firstPageTab(client);
	return sendCdpCommand(client.WebSocket, tab.webSocketDebuggerUrl!, "Page.navigate", { url }, 10000, signal);
}

export async function evaluateJs(client: WebSearchClient, expression: string, signal?: AbortSignal, timeoutMs = 10000) {
	const tab = await firstPageTab(client);
	const result = await sendCdpCommand(
		client.WebSocket,
		tab.webSocketDebuggerUrl!,
		"Runtime.evaluate",
		{ expression, returnByValue: true, awaitPromise: true },
		timeoutMs,
		signal,
	);
	return result?.result?.value;
}
