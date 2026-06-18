# Flow Control Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Flow task operation menu-driven, interruptive at fixed lifecycle gates, visually prominent, and non-destructive to the main conversation view during prove/run.

**Architecture:** Keep `extensions/flow/index.ts` as orchestration, but move decision menus into `flow-console.ts` and rendering into `status-presenter.ts`. Use `ctx.ui.select` for command menus and stage gates, derive options from `.flow/tasks`, and render stable widget cards from task/run/review/validation state. Keep driver sessions available, but do not switch the visible chat session unless the user explicitly attaches a driver.

**Tech Stack:** TypeScript, pi extension UI APIs (`select`, `setWidget`, `notify`, `setSessionSwitcher`), Node built-in filesystem APIs, existing Flow task/run/review stores, `node:test`.

---

### Task 1: Flow Status Presenter

**Files:**
- Create: `extensions/flow/status-presenter.ts`
- Modify: `extensions/flow/index.ts`
- Test: `tests/flow-status-presenter.test.ts`
- Test: `tests/flow-extension.test.ts`

- [ ] **Step 1: Write failing presenter tests**

Create `tests/flow-status-presenter.test.ts` with tests for:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { formatFlowActivityCard } from "../extensions/flow/status-presenter.ts";

test("formatFlowActivityCard renders a prominent running card", () => {
	const lines = formatFlowActivityCard([
		{
			taskId: "x",
			runId: "run-001",
			status: "running",
			step: "starting",
			summary: "prove driver running",
		},
	]);

	assert.deepEqual(lines, [
		"╭─ Flow Activity ─────────────────────────────",
		"│ ● x/run-001",
		"│   status: running / starting",
		"│   next: waiting for driver result",
		"╰─────────────────────────────────────────────",
	]);
});

test("formatFlowActivityCard renders review state over stale validation next step", () => {
	const lines = formatFlowActivityCard([
		{
			taskId: "x",
			runId: "run-001",
			status: "done",
			step: "validated",
			summary: "PASS: ok",
			validation: {
				result: "PASS",
				summary: "ok",
				nextStep: "/flow task review x/run-001",
			},
			review: { status: "accepted" },
			task: { status: "verified", nextStep: "/flow run x" },
		},
	]);

	assert.deepEqual(lines, [
		"╭─ Flow Activity ─────────────────────────────",
		"│ ✓ x/run-001",
		"│   status: done / validated",
		"│   result: PASS - ok",
		"│   review: accepted",
		"│   task: verified",
		"│   next: /flow run x",
		"╰─────────────────────────────────────────────",
	]);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/flow-status-presenter.test.ts`

Expected: FAIL because `extensions/flow/status-presenter.ts` does not exist.

- [ ] **Step 3: Implement presenter**

Create `extensions/flow/status-presenter.ts` exporting:

```ts
export interface FlowActivityViewModel {
	taskId: string;
	runId: string;
	status: string;
	step?: string;
	summary?: string;
	validation?: { result: string; summary: string; nextStep: string };
	review?: { status: string };
	task?: { status?: string; nextStep?: string };
	preview?: string[];
}

export function formatFlowActivityCard(items: FlowActivityViewModel[]): string[] {
	const lines = ["╭─ Flow Activity ─────────────────────────────"];
	for (const item of items) {
		const icon = item.status === "done" ? "✓" : item.status === "failed" ? "✕" : item.status === "needs-human" ? "!" : "●";
		lines.push(`│ ${icon} ${item.taskId}/${item.runId}`);
		lines.push(`│   status: ${[item.status, item.step].filter(Boolean).join(" / ")}`);
		if (item.validation) lines.push(`│   result: ${item.validation.result} - ${item.validation.summary}`);
		if (item.review) lines.push(`│   review: ${item.review.status}`);
		if (item.task?.status) lines.push(`│   task: ${item.task.status}`);
		const next = item.task?.nextStep ?? item.validation?.nextStep ?? (item.preview?.[0] ? undefined : "waiting for driver result");
		if (next) lines.push(`│   next: ${next}`);
		if (!item.validation && item.preview?.length) {
			lines.push(`│   latest: ${item.preview[0]}`);
			lines.push(...item.preview.slice(1).map((line) => `│   ${line}`));
		}
	}
	lines.push("╰─────────────────────────────────────────────");
	return lines;
}
```

- [ ] **Step 4: Wire `index.ts` to presenter**

Replace `buildDriverActivityLines()` string construction with construction of `FlowActivityViewModel[]`, reading `review.json` and `task.json` for the run task before calling `formatFlowActivityCard()`.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `npm test -- tests/flow-status-presenter.test.ts tests/flow-extension.test.ts`

Expected: PASS.

### Task 2: Flow Console Menu

**Files:**
- Create: `extensions/flow/flow-console.ts`
- Modify: `extensions/flow/index.ts`
- Test: `tests/flow-console.test.ts`
- Test: `tests/flow-extension.test.ts`

- [ ] **Step 1: Write failing console tests**

Create `tests/flow-console.test.ts` with tests for:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildFlowConsoleOptions, parseFlowConsoleSelection } from "../extensions/flow/flow-console.ts";

test("buildFlowConsoleOptions lists menu actions instead of raw help only", () => {
	const options = buildFlowConsoleOptions({
		tasks: [
			{ id: "draft-task", status: "draft" },
			{ id: "verified-task", status: "verified" },
		],
		drivers: [{ taskId: "draft-task", runId: "run-001", status: "done", step: "validated" }],
	});

	assert.deepEqual(options.map((option) => option.label), [
		"Create task",
		"Prove draft-task",
		"Run verified-task",
		"Review draft-task/run-001",
		"Attach driver",
		"Show status",
		"Exit",
	]);
});

test("parseFlowConsoleSelection returns executable flow command text", () => {
	assert.equal(parseFlowConsoleSelection("Prove draft-task")?.command, "task prove draft-task");
	assert.equal(parseFlowConsoleSelection("Run verified-task")?.command, "run verified-task");
	assert.equal(parseFlowConsoleSelection("Review draft-task/run-001")?.command, "task review draft-task/run-001");
	assert.equal(parseFlowConsoleSelection("Show status")?.command, "status");
	assert.equal(parseFlowConsoleSelection("Exit"), undefined);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/flow-console.test.ts`

Expected: FAIL because `extensions/flow/flow-console.ts` does not exist.

- [ ] **Step 3: Implement console helpers**

Create `extensions/flow/flow-console.ts` with pure helpers:

```ts
export interface FlowConsoleTask {
	id: string;
	status?: string;
}

export interface FlowConsoleDriver {
	taskId: string;
	runId: string;
	status: string;
	step?: string;
}

export interface FlowConsoleOption {
	label: string;
	command?: string;
}

export function buildFlowConsoleOptions(state: { tasks: FlowConsoleTask[]; drivers: FlowConsoleDriver[] }): FlowConsoleOption[] {
	const options: FlowConsoleOption[] = [{ label: "Create task", command: "task create" }];
	for (const task of state.tasks) {
		if (task.status === "draft" || task.status === "needs-human") options.push({ label: `Prove ${task.id}`, command: `task prove ${task.id}` });
		if (task.status === "verified" || task.status === "active") options.push({ label: `Run ${task.id}`, command: `run ${task.id}` });
	}
	for (const driver of state.drivers) {
		if (driver.status === "done") options.push({ label: `Review ${driver.taskId}/${driver.runId}`, command: `task review ${driver.taskId}/${driver.runId}` });
	}
	options.push({ label: "Attach driver", command: "attach" }, { label: "Show status", command: "status" }, { label: "Exit" });
	return options;
}

export function parseFlowConsoleSelection(selection: string | undefined): FlowConsoleOption | undefined {
	if (!selection || selection === "Exit") return undefined;
	if (selection === "Show status") return { label: selection, command: "status" };
	if (selection === "Attach driver") return { label: selection, command: "attach" };
	if (selection === "Create task") return { label: selection, command: "task create" };
	const prove = selection.match(/^Prove (.+)$/);
	if (prove) return { label: selection, command: `task prove ${prove[1]}` };
	const run = selection.match(/^Run (.+)$/);
	if (run) return { label: selection, command: `run ${run[1]}` };
	const review = selection.match(/^Review (.+)$/);
	if (review) return { label: selection, command: `task review ${review[1]}` };
	return undefined;
}
```

- [ ] **Step 4: Wire `/flow` with no args to menu**

In `extensions/flow/index.ts`, when `parseFlowCommand(args)` returns `help` because args are empty, use `ctx.ui.select("Flow", optionLabels)` and dispatch the selected command through the same command handler path. If `Create task` is selected, use `ctx.ui.input("Create Flow task", "Describe the goal")` and dispatch `task create "<goal>"`.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `npm test -- tests/flow-console.test.ts tests/flow-extension.test.ts`

Expected: PASS.

### Task 3: Interruptive Stage Gates

**Files:**
- Modify: `extensions/flow/flow-console.ts`
- Modify: `extensions/flow/index.ts`
- Test: `tests/flow-console.test.ts`
- Test: `tests/flow-extension.test.ts`

- [ ] **Step 1: Write failing stage gate tests**

Add tests proving:

```ts
import { buildFlowStageGateOptions } from "../extensions/flow/flow-console.ts";

test("buildFlowStageGateOptions offers fixed next actions", () => {
	assert.deepEqual(buildFlowStageGateOptions({ phase: "create", taskId: "x" }).map((item) => item.label), [
		"Continue: prove x",
		"Stop here",
	]);
	assert.deepEqual(buildFlowStageGateOptions({ phase: "prove-pass", taskId: "x", runId: "run-001" }).map((item) => item.label), [
		"Continue: review x/run-001",
		"Stop here",
	]);
	assert.deepEqual(buildFlowStageGateOptions({ phase: "review-accepted", taskId: "x", runId: "run-001" }).map((item) => item.label), [
		"Continue: run x",
		"Stop here",
	]);
});
```

Add an integration test in `tests/flow-extension.test.ts` where a completed PASS prove triggers a select call with `Continue: review x/run-001`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/flow-console.test.ts tests/flow-extension.test.ts`

Expected: FAIL because stage gate helpers and integration behavior are missing.

- [ ] **Step 3: Implement stage gate helpers**

Add `buildFlowStageGateOptions()` and `parseFlowStageGateSelection()` to `flow-console.ts`. The returned commands are:

```ts
create -> task prove <task-id>
prove-pass -> task review <task-id>/<run-id>
review-accepted -> run <task-id>
```

- [ ] **Step 4: Wire gates**

In `index.ts`:
- After `task-create` agent completion cannot be detected precisely yet because creation is a main-agent hidden prompt. Keep the command menu and create prompt, but leave create gate for the next runtime hook only if the created task id can be read.
- After driver validation PASS for `prove`, call stage gate and dispatch review if selected.
- After `acceptCompletedFlowReview()`, call stage gate and dispatch run if selected.
- Never stage-gate on failed validation except showing the status card and notification.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `npm test -- tests/flow-console.test.ts tests/flow-extension.test.ts`

Expected: PASS.

### Task 4: Preserve Main Conversation by Default

**Files:**
- Modify: `extensions/flow/index.ts`
- Modify: `bin/ugk-session-view-patch.js` if needed
- Test: `tests/flow-extension.test.ts`
- Test: `tests/ugk-session-view-patch.test.js`

- [ ] **Step 1: Write failing tests**

Add integration coverage proving `task prove` and `run` do not call `attachSessionView()`. Existing explicit `/flow attach` tests must continue to prove attach works.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/flow-extension.test.ts tests/ugk-session-view-patch.test.js`

Expected: FAIL if current behavior attaches unexpectedly or if patch lacks a non-clearing path needed by the implementation.

- [ ] **Step 3: Implement non-destructive default**

Keep `startDriverForTask()` rendering `flow-driver-view` and session switcher, but do not attach visible driver sessions there. Only `attachDriverBySummary()` may call `attachVisibleSessionView()`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- tests/flow-extension.test.ts tests/ugk-session-view-patch.test.js`

Expected: PASS.

### Task 5: Final Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
npm test -- tests/flow-console.test.ts tests/flow-status-presenter.test.ts tests/flow-extension.test.ts tests/ugk-session-view-patch.test.js
```

Expected: PASS.

- [ ] **Step 2: Run full suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: no output, exit code 0.

- [ ] **Step 4: Review diff**

Run:

```powershell
git diff -- extensions/flow tests bin docs/superpowers/plans/2026-06-18-flow-control-console.md
```

Expected: changes are scoped to Flow console/status behavior, tests, and this plan.

## Self-Review

- Spec coverage: `/flow` menu is Task 2; fixed lifecycle gates are Task 3; prominent status rendering is Task 1; preserving main conversation is Task 4.
- Placeholder scan: no TBD/TODO/later placeholders remain.
- Type consistency: helper interfaces are local to `flow-console.ts` and `status-presenter.ts`; `index.ts` remains the orchestration boundary.
