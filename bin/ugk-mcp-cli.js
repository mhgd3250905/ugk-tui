import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { diagnoseUgk } from "../mcp/doctor.js";
import { createRpcJobManager } from "../mcp/rpc-job.js";
import { createUgkMcpServer } from "../mcp/server.js";

export function isMcpCliCommand(args) {
	return args[0] === "mcp";
}

export function waitForMcpInputClose(input = process.stdin) {
	if (input.readableEnded || input.destroyed) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			input.off("end", done);
			input.off("close", done);
			resolve();
		};
		input.once("end", done);
		input.once("close", done);
	});
}

export async function runMcpCli(args, deps = {}) {
	const stdout = deps.stdout ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	if (args[1] === "doctor" && args[2] === "--json" && args.length === 3) {
		const result = await (deps.doctor ?? diagnoseUgk)({ cwd: deps.cwd ?? process.cwd(), agentDir: deps.agentDir });
		stdout.write(`${JSON.stringify(result)}\n`);
		return 0;
	}
	if (args[1] === "serve" && args.length === 2) {
		try {
			const manager = (deps.createJobManager ?? createRpcJobManager)({ packageRoot: deps.packageRoot, agentDir: deps.agentDir });
			const server = (deps.createServer ?? createUgkMcpServer)({ jobManager: manager });
			await server.connect((deps.createTransport ?? (() => new StdioServerTransport()))());
			return 0;
		} catch (error) {
			stderr.write(`${JSON.stringify({ ok: false, code: "MCP_START_FAILED", message: error instanceof Error ? error.message : String(error) })}\n`);
			return 1;
		}
	}
	stderr.write("用法: ugk mcp doctor --json | ugk mcp serve\n");
	return 2;
}
