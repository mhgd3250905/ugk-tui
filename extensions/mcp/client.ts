import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

type ClientInfo = {
	name: string;
	version: string;
};

type StdioConfig = {
	command: string;
	args?: string[];
	env?: Record<string, string>;
};

type OperationOptions = {
	timeoutMs?: number;
	signal?: AbortSignal;
};

const transports = new WeakMap<Client, StdioClientTransport>();
const closingClients = new WeakMap<Client, Promise<void>>();

export function createMcpClient({ name, version }: ClientInfo): Client {
	return new Client({ name, version });
}

export async function connectStdio(
	client: Client,
	{ command, args, env }: StdioConfig,
	opts: OperationOptions = {},
): Promise<void> {
	const transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
	transports.set(client, transport);

	try {
		await client.connect(transport, toRequestOptions(opts, DEFAULT_CONNECT_TIMEOUT_MS));
	} catch (error) {
		await closeTransport(client, transport);
		throw error;
	}
}

export async function listTools(client: Client, opts: OperationOptions = {}): Promise<Tool[]> {
	const result = await client.listTools(undefined, toRequestOptions(opts, DEFAULT_LIST_TIMEOUT_MS));
	return result.tools;
}

export async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown> = {},
	opts: OperationOptions = {},
): Promise<CallToolResult> {
	return (await client.callTool(
		{ name, arguments: args },
		undefined,
		toRequestOptions(opts, DEFAULT_CALL_TIMEOUT_MS),
	)) as CallToolResult;
}

export async function closeClient(client: Client): Promise<void> {
	const existingClose = closingClients.get(client);
	if (existingClose) {
		return existingClose;
	}

	const closePromise = closeClientOnce(client).finally(() => {
		closingClients.delete(client);
	});
	closingClients.set(client, closePromise);
	return closePromise;
}

function toRequestOptions(opts: OperationOptions, defaultTimeoutMs: number) {
	return {
		timeout: opts.timeoutMs ?? defaultTimeoutMs,
		signal: opts.signal,
	};
}

async function closeClientOnce(client: Client): Promise<void> {
	const transport = transports.get(client);
	transports.delete(client);

	await Promise.allSettled([client.close(), transport?.close()]);
}

async function closeTransport(client: Client, transport: StdioClientTransport): Promise<void> {
	if (transports.get(client) === transport) {
		transports.delete(client);
	}

	await Promise.allSettled([client.close(), transport.close()]);
}
