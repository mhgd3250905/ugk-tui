import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAgentDir, trustWorkspace } from "../bin/workspace-trust.js";
import { diagnoseUgk } from "./doctor.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTIVE_STATUSES = new Set(["running", "needs_input", "needs_approval"]);
const PASS_STATUSES = new Set(["pass", "passed"]);

function runId() {
	return `ugk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function publicJob(job) {
	if (!job) return { status: "internal_error", code: "RUN_NOT_FOUND", message: "找不到这次运行。" };
	const { child, request, taskResult, noMatch, pendingOutcome, ...result } = job;
	return { ...result, events: [...job.events] };
}

function taskOutcome(result) {
	const details = result?.details ?? {};
	const results = Array.isArray(details.results) ? details.results : [];
	const task = results[0]?.name;
	if (results.length > 0 && results.every((entry) => PASS_STATUSES.has(entry.status))) {
		return { status: "pass", task, results };
	}

	const failed = results.find((entry) => !PASS_STATUSES.has(entry.status)) ?? {};
	const failure = failed.failure ?? details.failure ?? {
		code: "TASK_FAILED",
		stage: "runtime",
		retryable: false,
		message: "task 执行失败。",
	};
	return {
		status: "task_failed",
		task,
		results,
		code: failure.code,
		stage: failure.stage,
		retryable: failure.retryable,
		message: failure.message,
		attempts: failed.attempts,
		workerSummary: failed.workerSummary,
		verifyFailures: failed.verifyFailures,
		artifacts: failed.artifacts,
		outputDir: failed.outputDir,
		suggestedAction: failure.suggestedAction,
	};
}

export function createRpcJobManager(options = {}) {
	const root = options.packageRoot ?? packageRoot;
	const doctor = options.doctor ?? diagnoseUgk;
	const spawnImpl = options.spawnImpl ?? spawn;
	const trustWorkspaceImpl = options.trustWorkspaceImpl ?? trustWorkspace;
	const agentDir = options.agentDir ?? defaultAgentDir();
	const maxEvents = options.maxEvents ?? 50;
	let current;

	function addEvent(job, event) {
		job.events.push(event);
		if (job.events.length > maxEvents) job.events.splice(0, job.events.length - maxEvents);
	}

	function finish(job, outcome) {
		if (!ACTIVE_STATUSES.has(job.status)) return;
		Object.assign(job, outcome, { interaction: undefined });
		if (job.child?.stdin?.writable) job.child.stdin.end();
	}

	function completeAfterExit(job, outcome) {
		job.pendingOutcome = outcome;
		job.interaction = undefined;
		if (job.child?.stdin?.writable) job.child.stdin.end();
	}

	function handleMessage(job, message) {
		if (message.type === "extension_ui_request") {
			if (["select", "input", "editor", "confirm"].includes(message.method)) {
				job.status = message.method === "confirm" ? "needs_approval" : "needs_input";
				job.interaction = {
					id: message.id,
					type: message.method,
					title: message.title,
					message: message.message,
					options: message.options,
					prefill: message.prefill,
					placeholder: message.placeholder,
				};
				return;
			}
			addEvent(job, message);
			return;
		}
		if (message.type === "tool_execution_end" && message.toolName === "run_task") {
			if (!job.taskResult) job.taskResult = message.result;
			return;
		}
		if (message.type === "tool_execution_end" && message.toolName === "task_gateway_result") {
			job.noMatch = message.result?.details;
			return;
		}
		if (message.type === "agent_end") {
			if (job.noMatch?.status === "no_match") completeAfterExit(job, { ...job.noMatch, status: "no_match" });
			else if (job.taskResult) completeAfterExit(job, taskOutcome(job.taskResult));
			else completeAfterExit(job, { status: "internal_error", code: "NO_RESULT", message: "UGK 未返回 task 结果。" });
		}
	}

	function startChild(job) {
		job.status = "running";
		job.interaction = undefined;
		const child = spawnImpl(process.execPath, [path.join(root, "bin", "ugk.js"), "--mode", "rpc", "--no-session"], {
			cwd: job.cwd,
			env: { ...process.env, UGK_TASK_GATEWAY: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		job.child = child;
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
			const lines = stdout.split(/\r?\n/);
			stdout = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					handleMessage(job, JSON.parse(line));
				} catch {
					addEvent(job, { type: "rpc_parse_error", message: line });
				}
			}
		});
		child.on("error", (error) => {
			finish(job, { status: "internal_error", code: "RPC_CRASHED", message: error.message });
		});
		child.on("exit", (code) => {
			if (ACTIVE_STATUSES.has(job.status) && job.pendingOutcome && code === 0) {
				Object.assign(job, job.pendingOutcome, { interaction: undefined, pendingOutcome: undefined });
			} else if (ACTIVE_STATUSES.has(job.status)) {
				finish(job, { status: "internal_error", code: "RPC_CRASHED", message: `UGK RPC 进程异常退出 (${code ?? "unknown"})。` });
			}
		});
		child.stdin.write(`${JSON.stringify({ id: "gateway-prompt", type: "prompt", message: job.request })}\n`);
	}

	function stopChild(child) {
		if (!child) return;
		if (child.stdin?.writable) {
			child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
			child.stdin.end();
			setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill();
			}, 250).unref();
		} else {
			child.kill();
		}
	}

	async function start(input) {
		if (current && ACTIVE_STATUSES.has(current.status)) {
			return { runId: current.runId, status: "busy", workspaceRoot: current.workspaceRoot };
		}
		const diagnosis = await doctor({ cwd: input.cwd, agentDir });
		if (diagnosis.status === "needs_setup") return diagnosis;
		current = {
			runId: runId(),
			cwd: input.cwd,
			workspaceRoot: diagnosis.workspaceRoot,
			request: input.request,
			status: diagnosis.status,
			events: [],
		};
		if (diagnosis.status === "needs_approval") {
			current.interaction = {
				id: "workspace-trust",
				type: "confirm",
				title: "信任当前项目？",
				message: `UGK 将在 ${diagnosis.workspaceRoot} 中读取、编辑和执行文件。`,
			};
		} else {
			startChild(current);
		}
		return publicJob(current);
	}

	function status(id) {
		if (!current || current.runId !== id) {
			return { status: "internal_error", code: "RUN_NOT_FOUND", message: "找不到这次运行。" };
		}
		return publicJob(current);
	}

	async function respond(input) {
		if (!current || current.runId !== input.runId || current.interaction?.id !== input.interactionId) {
			return { status: "internal_error", code: "INTERACTION_NOT_FOUND", message: "找不到待回答的问题。" };
		}
		if (current.interaction.id === "workspace-trust") {
			if (input.cancelled || !input.confirmed) {
				finish(current, { status: "cancelled" });
				return publicJob(current);
			}
			await trustWorkspaceImpl(current.workspaceRoot, agentDir);
			const diagnosis = await doctor({ cwd: current.cwd, agentDir });
			if (diagnosis.status !== "ready") {
				Object.assign(current, diagnosis, { interaction: undefined });
				return publicJob(current);
			}
			startChild(current);
			return publicJob(current);
		}

		const interaction = current.interaction;
		const response = { type: "extension_ui_response", id: interaction.id };
		if (input.cancelled) response.cancelled = true;
		else if (interaction.type === "confirm") response.confirmed = Boolean(input.confirmed);
		else response.value = String(input.value ?? "");
		current.status = "running";
		current.interaction = undefined;
		addEvent(current, response);
		current.child.stdin.write(`${JSON.stringify(response)}\n`);
		return publicJob(current);
	}

	async function cancel(id) {
		if (!current || current.runId !== id) return status(id);
		stopChild(current.child);
		Object.assign(current, { status: "cancelled", interaction: undefined });
		return publicJob(current);
	}

	function dispose() {
		if (!current || !ACTIVE_STATUSES.has(current.status)) return;
		stopChild(current.child);
		Object.assign(current, { status: "cancelled", interaction: undefined });
	}

	return { start, status, respond, cancel, dispose };
}
