#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const terminalStatuses = new Set(["pass", "no_match", "task_failed", "cancelled", "internal_error", "needs_setup"]);

export function parseSmokeArgs(args = process.argv.slice(2)) {
	const cwd = args[args.indexOf("--cwd") + 1];
	const request = args[args.indexOf("--request") + 1];
	if (!cwd || !path.isAbsolute(cwd)) throw new Error("--cwd 必须是绝对路径。");
	if (!request?.trim()) throw new Error("--request 不能为空。");
	return { cwd: path.resolve(cwd), request: request.trim() };
}

export function redactSecrets(text) {
	return text.replace(/\bsk-[^\s"'`]+/g, "[REDACTED]");
}

export function buildSmokeReport(outcome) {
	return `${redactSecrets(JSON.stringify(outcome, null, 2))}\n`;
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function prepareDirs() {
	const runDir = path.join(root, ".tmp", "smoke-mcp", stamp());
	const latestDir = path.join(root, ".tmp", "smoke-mcp", "latest");
	await fs.mkdir(runDir, { recursive: true });
	return { runDir, latestDir };
}

async function record(runDir, direction, value) {
	const line = redactSecrets(JSON.stringify({ time: new Date().toISOString(), direction, value }));
	await fs.appendFile(path.join(runDir, "events.jsonl"), `${line}\n`, "utf8");
}

async function callUgk(client, runDir, args) {
	await record(runDir, "in", args);
	const result = await client.callTool({ name: "ugk", arguments: args });
	if (result.isError) throw new Error(result.content?.map((entry) => entry.text ?? "").join("\n") || "UGK MCP call failed");
	const value = result.structuredContent ?? JSON.parse(result.content[0].text);
	await record(runDir, "out", value);
	return value;
}

async function answerInteraction(rl, interaction) {
	const title = interaction.title ?? interaction.message ?? interaction.type;
	if (interaction.type === "confirm") {
		const answer = await rl.question(`${title} [y/N] `);
		return { confirmed: /^(y|yes|是|确认)$/i.test(answer.trim()) };
	}
	if (interaction.type === "select") {
		const options = interaction.options ?? [];
		process.stdout.write(`${options.map((option, index) => `${index + 1}. ${typeof option === "string" ? option : option.label ?? option.value}`).join("\n")}\n`);
		const selected = Number(await rl.question(`${title} `)) - 1;
		const option = options[selected];
		return option === undefined ? { cancelled: true } : { value: typeof option === "string" ? option : option.value ?? option.label };
	}
	return { value: await rl.question(`${title} `) };
}

async function runGateway(input, runDir) {
	const client = new Client({ name: "ugk-mcp-smoke", version: "1.0.0" });
	const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "bin", "ugk.js"), "mcp", "serve"] });
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		await client.connect(transport);
		const diagnosis = await callUgk(client, runDir, { action: "status", cwd: input.cwd });
		if (diagnosis.status === "needs_setup") return diagnosis;
		let state = await callUgk(client, runDir, { action: "start", cwd: input.cwd, request: input.request });
		if (!state.runId) return state;
		const deadline = Date.now() + 300_000;
		while (!terminalStatuses.has(state.status) && Date.now() < deadline) {
			if (state.status === "needs_input" || state.status === "needs_approval") {
				if (!process.stdin.isTTY) return { ...state, status: "internal_error", code: "INTERACTION_REQUIRED" };
				const answer = await answerInteraction(rl, state.interaction);
				state = await callUgk(client, runDir, { action: "respond", runId: state.runId, interactionId: state.interaction.id, ...answer });
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
			state = await callUgk(client, runDir, { action: "status", runId: state.runId });
		}
		if (!terminalStatuses.has(state.status)) {
			await callUgk(client, runDir, { action: "cancel", runId: state.runId });
			return { ...state, status: "internal_error", code: "SMOKE_TIMEOUT" };
		}
		return state;
	} finally {
		rl.close();
		await client.close();
	}
}

async function main() {
	const input = parseSmokeArgs();
	const { runDir, latestDir } = await prepareDirs();
	let outcome;
	try {
		outcome = await runGateway(input, runDir);
	} catch (error) {
		outcome = { status: "internal_error", code: "SMOKE_FAILED", message: error instanceof Error ? error.message : String(error) };
		await record(runDir, "error", outcome);
	}
	await fs.writeFile(path.join(runDir, "report.json"), buildSmokeReport({ ...outcome, request: input.request }), "utf8");
	await fs.rm(latestDir, { recursive: true, force: true });
	await fs.cp(runDir, latestDir, { recursive: true });
	process.stdout.write(`MCP smoke report: ${path.join(latestDir, "report.json")}\n`);
	process.exitCode = outcome.status === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
		process.exit(1);
	});
}
