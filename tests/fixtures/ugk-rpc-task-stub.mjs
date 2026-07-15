import readline from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function pass() {
	send({
		type: "tool_execution_end",
		toolCallId: "task-1",
		toolName: "run_task",
		isError: false,
		result: {
			details: {
				mode: "single",
				results: [{
					name: "x-search",
					status: "pass",
					attempts: 1,
					artifacts: ["report.json"],
					outputDir: "output",
					verifyFailures: [],
					workerSummary: "done",
				}],
			},
		},
	});
	send({ type: "agent_end", messages: [] });
}

function fail(end = true) {
	send({
		type: "tool_execution_end",
		toolCallId: "task-1",
		toolName: "run_task",
		isError: false,
		result: {
			details: {
				mode: "single",
				results: [{
					name: "x-search",
					status: "fail",
					attempts: 4,
					artifacts: [],
					outputDir: "output",
					verifyFailures: [{ assertion: "has results", expected: "items", actual: "empty" }],
					workerSummary: "empty",
					failure: { code: "VERIFY_FAILED", stage: "verify", retryable: false, message: "verify failed" },
				}],
			},
		},
	});
	if (end) send({ type: "agent_end", messages: [] });
}

function failThenBlocked() {
	fail(false);
	send({
		type: "tool_execution_end",
		toolCallId: "task-blocked",
		toolName: "run_task",
		isError: true,
		result: { content: [{ type: "text", text: "gateway 每次请求只允许一次 run_task 调用。" }] },
	});
	send({ type: "agent_end", messages: [] });
}

let pendingInteraction;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.type === "abort") return process.exit(0);
	if (message.type === "extension_ui_response") {
		send({ type: "extension_ui_request", id: "seen", method: "notify", message: `seen:${JSON.stringify(message)}` });
		pendingInteraction = undefined;
		return pass();
	}
	if (message.type !== "prompt") return;
	const scenario = message.message;
	if (scenario === "crash") return process.exit(7);
	if (scenario === "hold") return;
	if (scenario === "task-start") {
		return send({
			type: "tool_execution_start",
			toolCallId: "task-1",
			toolName: "run_task",
			args: { name: "x-search", input: "query" },
		});
	}
	if (scenario === "no-match") {
		send({
			type: "tool_execution_end",
			toolCallId: "no-match-1",
			toolName: "task_gateway_result",
			isError: false,
			result: { details: { status: "no_match", reason: "none", consideredTasks: ["x-search"] } },
		});
		return send({ type: "agent_end", messages: [] });
	}
	if (scenario === "fail-then-blocked") return failThenBlocked();
	if (scenario === "fail") return fail();
	if (scenario === "events") {
		for (let index = 0; index < 5; index += 1) {
			send({ type: "extension_ui_request", id: `event-${index}`, method: "notify", message: `event-${index}` });
		}
		return pass();
	}
	if (["select", "input", "editor", "confirm"].includes(scenario)) {
		pendingInteraction = scenario;
		if (scenario === "select") return send({ type: "extension_ui_request", id: "ui-1", method: "select", title: "choose", options: ["a", "b"] });
		if (scenario === "confirm") return send({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "allow", message: "use protected tool" });
		return send({ type: "extension_ui_request", id: "ui-1", method: scenario, title: "answer", prefill: "" });
	}
	pass();
});
