import test from "node:test";
import assert from "node:assert/strict";
import registerTodoTool, {
	getTodoOwner,
	getTodos,
	markPlanModeDone,
	migrateLegacyTodos,
	reconstructTodosFromSession,
	setTodosFromPlanMode,
} from "../extensions/todo-tool.ts";

function makeCtx(branch: unknown[] = [], entries: unknown[] = []): any {
	return {
		ui: {
			setStatus() {},
			setWidget() {},
			theme: {
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => entries,
		},
	};
}

test("migrateLegacyTodos converts old plan-mode todo shape", () => {
	assert.deepEqual(migrateLegacyTodos([{ step: 1, text: "Read files", completed: true }]), [
		{ content: "Read files", status: "completed" },
	]);
});

test("plan-mode updates are ignored after TodoWrite owns the list", async () => {
	reconstructTodosFromSession(makeCtx());
	setTodosFromPlanMode([{ content: "Plan item", status: "pending" }]);
	markPlanModeDone(0, true);
	assert.deepEqual(getTodos(), [{ content: "Plan item", status: "completed" }]);

	let tool: any;
	registerTodoTool({ registerTool(def: any) { tool = def; }, on() {} } as any);
	await tool.execute("1", { todos: [{ content: "Tool item", status: "in_progress" }] }, undefined, undefined, makeCtx());

	setTodosFromPlanMode([{ content: "Ignored", status: "pending" }]);
	markPlanModeDone(0, true);
	assert.equal(getTodoOwner(), "todo-tool");
	assert.deepEqual(getTodos(), [{ content: "Tool item", status: "in_progress" }]);
});

test("reconstructTodosFromSession restores the latest TodoWrite result on the active branch", () => {
	reconstructTodosFromSession(makeCtx([
		{ type: "message", message: { role: "toolResult", toolName: "TodoWrite", details: { todos: [{ content: "Old", status: "pending" }], owner: "todo-tool" } } },
		{ type: "message", message: { role: "toolResult", toolName: "TodoWrite", details: { todos: [{ content: "New", status: "completed" }], owner: "todo-tool" } } },
	]));
	assert.deepEqual(getTodos(), [{ content: "New", status: "completed" }]);
});

test("reconstructTodosFromSession restores plan-mode todos but lets TodoWrite override them", () => {
	reconstructTodosFromSession(makeCtx([
		{ type: "custom", customType: "plan-mode", data: { todos: [{ content: "Plan", status: "pending" }] } },
	]));
	assert.equal(getTodoOwner(), "plan-mode");
	assert.deepEqual(getTodos(), [{ content: "Plan", status: "pending" }]);

	reconstructTodosFromSession(makeCtx([
		{ type: "custom", customType: "plan-mode", data: { todos: [{ content: "Plan", status: "pending" }] } },
		{ type: "message", message: { role: "toolResult", toolName: "TodoWrite", details: { todos: [{ content: "Tool", status: "completed" }], owner: "todo-tool" } } },
	]));
	assert.equal(getTodoOwner(), "todo-tool");
	assert.deepEqual(getTodos(), [{ content: "Tool", status: "completed" }]);
});

test("TodoWrite rejects multiple in_progress items without changing state", async () => {
	reconstructTodosFromSession(makeCtx());
	let tool: any;
	registerTodoTool({ registerTool(def: any) { tool = def; }, on() {} } as any);
	await tool.execute("1", { todos: [{ content: "Stable", status: "pending" }] }, undefined, undefined, makeCtx());

	const result = await tool.execute(
		"2",
		{ todos: [{ content: "A", status: "in_progress" }, { content: "B", status: "in_progress" }] },
		undefined,
		undefined,
		makeCtx(),
	);
	assert.match(result.content[0].text, /at most ONE/);
	assert.deepEqual(getTodos(), [{ content: "Stable", status: "pending" }]);
});
