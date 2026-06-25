#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taskbookName = "e2e_smoke";

export function hasJudgePass(events) {
	return events.some((event) =>
		event?.msg?.type === "message_end" &&
		event.msg.message?.customType === "judge-delivery" &&
		/Judge PASS/.test(event.msg.message.content ?? ""));
}

export function buildJudgeReport(run) {
	const taskbookPass = run.taskbookRuns?.some((entry) => entry.status === "pass") ?? false;
	const passed = !run.timedOut && run.exitCode === 0 && !run.stderr && hasJudgePass(run.events ?? []) && taskbookPass;
	return [
		"# UGK Judge Smoke Report",
		"",
		`Exit code: ${run.exitCode ?? "none"}`,
		`Timed out: ${run.timedOut ? "yes" : "no"}`,
		`Stderr: ${run.stderr ? "present" : "empty"}`,
		`Judge PASS: ${hasJudgePass(run.events ?? []) ? "detected" : "missing"}`,
		`Taskbook PASS run: ${taskbookPass ? "detected" : "missing"}`,
		"",
		passed ? "Result: pass" : "Result: fail",
		"",
	].join("\n");
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function prepareDirs() {
	const runDir = path.join(root, ".tmp", "smoke-judge", stamp());
	const latestDir = path.join(root, ".tmp", "smoke-judge", "latest");
	const workspace = path.join(runDir, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	return { runDir, latestDir, workspace };
}

async function writeJson(file, value) {
	await fs.writeFile(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

async function prepareWorkspace(workspace) {
	await writeJson(path.join(workspace, "package.json"), { name: "judge-e2e", version: "0.0.1" });
	const taskbookDir = path.join(workspace, ".judge", "taskbooks", taskbookName);
	await fs.mkdir(taskbookDir, { recursive: true });
	const now = new Date().toISOString();
	await writeJson(path.join(taskbookDir, "taskbook.json"), {
		name: taskbookName,
		description: "Judge e2e smoke task",
		createdAt: now,
		updatedAt: now,
		runs: [],
	});
	await writeJson(path.join(taskbookDir, "spec.json"), {
		goal: "Verify the temporary package metadata and complete through judge_complete.",
		hardConstraints: [
			"Only inspect files in the current working directory.",
			"Do not modify, create, delete, install, or format project files.",
			"Use tool evidence rather than guessing.",
		],
		acceptance: [
			"package.json name is exactly judge-e2e.",
			"package.json version is exactly 0.0.1.",
			"Driver calls judge_complete with evidence that mentions package.json.",
		],
		forbidden: [
			"Do not run npm install or any package manager command.",
			"Do not write files except runtime logs created by UGK itself.",
		],
		context: "This is an automated Judge e2e smoke task in a temporary workspace. The only user artifact is package.json.",
	});
	await fs.writeFile(path.join(taskbookDir, "experience.md"), "# e2e_smoke experience\n", "utf8");
}

function smokeEnv(runDir) {
	return addDeepSeekEnvFallback({
		...process.env,
		PI_CODING_AGENT_DIR: path.join(runDir, "agent"),
		UGK_SKIP_UPDATE_CHECK: "1",
		UGK_SKIP_WORKSPACE_TRUST: "1",
		UGK_SKIP_JUDGE_LIVE_LOG_TERMINAL: "1",
		UGK_CLEAR_STARTUP: "0",
	}, readUserDeepSeekApiKey());
}

export function addDeepSeekEnvFallback(env, userValue) {
	const existing = normalizeDeepSeekApiKey(env.DEEPSEEK_API_KEY ?? "");
	if (existing) return existing === env.DEEPSEEK_API_KEY ? env : { ...env, DEEPSEEK_API_KEY: existing };
	const key = normalizeDeepSeekApiKey(userValue);
	return key ? { ...env, DEEPSEEK_API_KEY: key } : env;
}

export function normalizeDeepSeekApiKey(value = "") {
	const match = value.match(/\bsk-[^\s"'`]+/);
	return match?.[0] ?? "";
}

function readUserDeepSeekApiKey() {
	if (process.platform !== "win32") return "";
	const result = spawnSync("powershell.exe", [
		"-NoProfile",
		"-Command",
		"[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')",
	], { encoding: "utf8", windowsHide: true });
	return result.status === 0 ? result.stdout : "";
}

function writeEvent(stream, event) {
	stream.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
}

function endStream(stream) {
	return new Promise((resolve) => stream.end(resolve));
}

function respondToUi(child, request) {
	if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)) return;
	if (request.method === "select" && request.title === "Judge PASS") {
		child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, value: "接受交付" })}\n`);
		return;
	}
	if (request.method === "confirm") {
		child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, confirmed: false })}\n`);
		return;
	}
	child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, cancelled: true })}\n`);
}

async function readTaskbookRuns(workspace) {
	try {
		const data = JSON.parse(await fs.readFile(path.join(workspace, ".judge", "taskbooks", taskbookName, "taskbook.json"), "utf8"));
		return Array.isArray(data.runs) ? data.runs : [];
	} catch {
		return [];
	}
}

async function runJudgeSmoke(runDir, workspace) {
	const eventsFile = createWriteStream(path.join(runDir, "rpc-events.jsonl"), { flags: "a" });
	const stdout = createWriteStream(path.join(runDir, "stdout.log"), { flags: "a" });
	const stderr = createWriteStream(path.join(runDir, "stderr.log"), { flags: "a" });
	const events = [];
	const child = spawn(process.execPath, [
		path.join(root, "bin", "ugk.js"),
		"--mode", "rpc",
		"--no-session",
		"--model", process.env.UGK_SMOKE_MODEL ?? "deepseek/deepseek-v4-pro",
	], {
		cwd: workspace,
		env: smokeEnv(runDir),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const responses = new Map();
	let stdoutBuffer = "";
	let stderrText = "";
	let exitCode;
	let timedOut = false;

	child.stdout.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		stdout.write(text);
		stdoutBuffer += text;
		let index;
		while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
			const line = stdoutBuffer.slice(0, index).trim();
			stdoutBuffer = stdoutBuffer.slice(index + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				msg = { type: "output_text", line };
			}
			const event = { direction: "out", msg };
			events.push(event);
			writeEvent(eventsFile, event);
			if (msg.type === "response" && msg.id) responses.set(msg.id, msg);
			if (msg.type === "extension_ui_request") respondToUi(child, msg);
		}
	});
	child.stderr.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		stderrText += text;
		stderr.write(text);
	});

	const exited = new Promise((resolve) => child.on("exit", (code) => {
		exitCode = code;
		resolve();
	}));
	const send = (message) => {
		const event = { direction: "in", msg: message };
		events.push(event);
		writeEvent(eventsFile, event);
		child.stdin.write(`${JSON.stringify(message)}\n`);
	};
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitForResponse = async (id, timeoutMs) => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (responses.has(id)) return responses.get(id);
			if (exitCode !== undefined) return undefined;
			await wait(100);
		}
		return undefined;
	};
	const waitForPass = async (timeoutMs) => {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (hasJudgePass(events) && (await readTaskbookRuns(workspace)).some((run) => run.status === "pass")) return true;
			if (exitCode !== undefined) return false;
			await wait(250);
		}
		return false;
	};
	const killTimer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, 120000);

	send({ id: "startup", type: "get_commands" });
	await waitForResponse("startup", 10000);
	send({ id: "run", type: "prompt", message: `/judge run ${taskbookName}` });
	await waitForResponse("run", 10000);
	await waitForPass(90000);
	child.stdin.end();
	await Promise.race([exited, wait(5000)]);
	if (exitCode === undefined) {
		timedOut = true;
		child.kill();
		await exited;
	}
	clearTimeout(killTimer);
	await Promise.all([endStream(eventsFile), endStream(stdout), endStream(stderr)]);
	return { exitCode, timedOut, stderr: stderrText, events, taskbookRuns: await readTaskbookRuns(workspace) };
}

async function main() {
	const { runDir, latestDir, workspace } = await prepareDirs();
	await prepareWorkspace(workspace);
	const run = await runJudgeSmoke(runDir, workspace);
	const report = buildJudgeReport(run);
	await fs.writeFile(path.join(runDir, "report.md"), report, "utf8");
	await fs.rm(latestDir, { recursive: true, force: true });
	await fs.cp(runDir, latestDir, { recursive: true });
	process.stdout.write(`Judge smoke report: ${path.join(latestDir, "report.md")}\n`);
	process.exitCode = report.includes("Result: pass") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
