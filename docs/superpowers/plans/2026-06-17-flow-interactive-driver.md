# Flow Interactive Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Flow interactive driver sessions so `/flow task prove/run` can start isolated task drivers, `/flow attach` can enter or choose a driver, user input can be routed to the attached driver, and the TUI shows persistent driver focus.

**Architecture:** Keep Flow V0 prompt-injection for `task create`, `task review`, and `status`, but move `task prove` and `run` into extension-owned run creation and SDK-backed `AgentSession` drivers. Flow stores run metadata in `.flow/tasks/<task-id>/runs/<run-id>/`, keeps focus state in extension session entries, renders the active driver banner through UGK's existing header, and routes driver-focus input to the selected driver instead of main.

**Tech Stack:** TypeScript ESM, `@earendil-works/pi-coding-agent` extension API, pi SDK `createAgentSession`, `SessionManager`, Node built-in `node:test`, existing UGK brand UI, existing Flow parser/prompt tests.

---

## Scope

Implement the first complete interactive driver slice:

- `/flow attach <run-id>` directly focuses a running or recoverable driver.
- `/flow attach` opens a selector of all known drivers with status, task/run id, current step, summary, and update time.
- `/flow detach` clears driver focus.
- Driver focus renders a persistent high-visibility banner in the UGK header.
- Driver focus routes ordinary user input to the attached driver and records the intervention in `feedback.md`.
- `/flow task prove <task-id>` and `/flow run <task-id>` create run artifacts and start a Flow-owned driver session.
- Driver session output is mirrored into run artifacts and a live driver-view widget. Do not append driver transcript as visible custom messages because `CustomMessageEntry` participates in LLM context.

Out of scope for this plan:

- DAG orchestration.
- Multiple driver panes at the same time.
- Search/filter inside the picker.
- Changing ordinary `subagent` behavior.
- Replacing pi's core message list renderer.

## File Structure

Modify:

- `extensions/flow/types.ts`
  Add attach/detach/driver-status request types and driver run/focus types.

- `extensions/flow/parser.ts`
  Parse `/flow attach`, `/flow attach <run-id>`, `/flow detach`, and `/flow driver status`.

- `extensions/flow/prompts.ts`
  Update help text and prove/run wording so users see the new interactive driver behavior.

- `extensions/flow/formatter.ts`
  Add acknowledgement text for direct attach, picker attach, detach, and driver status.

- `extensions/flow/index.ts`
  Register new command behavior, own driver lifecycle, route focused input, and persist focus state.

- `extensions/ui-brand.ts`
  Render the Flow driver banner inside the existing UGK header instead of replacing the header from Flow.

- `package.json`
  Add new focused tests to the `npm test` script.

Create:

- `extensions/flow/driver-store.ts`
  Reads and writes `.flow` run metadata and feedback/progress artifact files.

- `extensions/flow/driver-focus.ts`
  Pure focus state helpers and session-entry restoration helpers.

- `extensions/flow/driver-picker.ts`
  Sorting and formatting of driver picker options.

- `extensions/flow/driver-banner.ts`
  Shared in-memory banner state and pure banner formatting.

- `extensions/flow/driver-session.ts`
  SDK-backed driver session wrapper with an injectable factory for tests.

- `extensions/flow/driver-view.ts`
  In-memory tail buffer and widget formatting for the attached driver's live output.

- `tests/flow-driver-store.test.ts`
- `tests/flow-driver-focus.test.ts`
- `tests/flow-driver-picker.test.ts`
- `tests/flow-driver-banner.test.ts`
- `tests/flow-driver-session.test.ts`

## Task 1: Extend Flow Command Parsing

**Files:**

- Modify: `extensions/flow/types.ts`
- Modify: `extensions/flow/parser.ts`
- Modify: `extensions/flow/prompts.ts`
- Test: `tests/flow-parser.test.ts`
- Test: `tests/flow-prompts.test.ts`

- [ ] **Step 1: Add parser tests for attach, detach, and driver status**

Append to `tests/flow-parser.test.ts`:

```ts
test("parses interactive driver commands", () => {
	assert.deepEqual(parseFlowCommand("attach"), {
		kind: "attach",
		runId: undefined,
	});
	assert.deepEqual(parseFlowCommand("attach run-001"), {
		kind: "attach",
		runId: "run-001",
	});
	assert.deepEqual(parseFlowCommand("detach"), {
		kind: "detach",
	});
	assert.deepEqual(parseFlowCommand("driver status"), {
		kind: "driver-status",
	});
});
```

- [ ] **Step 2: Run parser tests and confirm the new case fails**

Run:

```powershell
node --test tests/flow-parser.test.ts
```

Expected: fails because `parseFlowCommand("attach")` currently returns `{ kind: "help" }`.

- [ ] **Step 3: Extend Flow request and driver types**

Modify `extensions/flow/types.ts` to this complete file:

```ts
export type FlowDriverStatus =
	| "starting"
	| "running"
	| "waiting"
	| "waiting-for-user"
	| "needs-human"
	| "validating"
	| "done"
	| "failed"
	| "paused";

export interface FlowDriverSummary {
	taskId: string;
	runId: string;
	status: FlowDriverStatus;
	step?: string;
	summary?: string;
	updatedAt?: string;
	runDir: string;
}

export type FlowFocusState = { focus: "main" } | { focus: "driver"; runId: string; taskId?: string };

export type FlowRequest =
	| { kind: "task-create"; goal: string }
	| { kind: "task-prove"; taskId: string; input?: string }
	| { kind: "task-run"; taskId: string; input?: string }
	| { kind: "task-review"; runId: string }
	| { kind: "attach"; runId?: string }
	| { kind: "detach" }
	| { kind: "driver-status" }
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "error"; message: string };

export type FlowActionKind = FlowRequest["kind"];
```

- [ ] **Step 4: Implement parsing**

In `extensions/flow/parser.ts`, add these branches after the `status` branch and before `task create`:

```ts
	if (text === "detach") return { kind: "detach" };
	if (text === "driver status") return { kind: "driver-status" };

	const attachPrefix = "attach";
	if (text === attachPrefix) return { kind: "attach", runId: undefined };
	if (text.startsWith(`${attachPrefix} `)) {
		const runId = text.slice(attachPrefix.length).trim();
		if (!runId) return { kind: "attach", runId: undefined };
		return { kind: "attach", runId };
	}
```

- [ ] **Step 5: Update help text**

In `extensions/flow/prompts.ts`, update `buildFlowHelpText()` so the command list includes:

```ts
		"- /flow attach 选择一个正在运行或可恢复的 driver",
		"- /flow attach <run-id> 直接进入指定 driver",
		"- /flow detach 退出当前 driver focus",
		"- /flow driver status 查看 driver focus 和活跃 run",
```

Keep the existing task commands.

- [ ] **Step 6: Add help assertions**

Append to `tests/flow-prompts.test.ts` inside `builds flow help text`:

```ts
	assert.match(help, /\/flow attach/);
	assert.match(help, /\/flow detach/);
	assert.match(help, /\/flow driver status/);
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
node --test tests/flow-parser.test.ts tests/flow-prompts.test.ts
```

Expected: all pass.

- [ ] **Step 8: Commit command parsing**

Run:

```powershell
git add extensions/flow/types.ts extensions/flow/parser.ts extensions/flow/prompts.ts tests/flow-parser.test.ts tests/flow-prompts.test.ts
git commit -m "feat: parse flow driver commands"
```

## Task 2: Add Driver Artifact Store

**Files:**

- Create: `extensions/flow/driver-store.ts`
- Test: `tests/flow-driver-store.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write artifact store tests**

Create `tests/flow-driver-store.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendDriverFeedback,
	createRunArtifacts,
	listDriverSummaries,
	readDriverStatus,
	writeDriverStatus,
} from "../extensions/flow/driver-store.ts";

function tempProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "flow-driver-store-"));
}

test("createRunArtifacts creates run directory and base files", () => {
	const cwd = tempProject();
	const taskDir = path.join(cwd, ".flow", "tasks", "x-search-post-collector");
	fs.mkdirSync(taskDir, { recursive: true });
	fs.writeFileSync(path.join(taskDir, "todo.template.md"), "# Run Todo\n\n## A. Prepare\n", "utf8");

	const run = createRunArtifacts(cwd, "x-search-post-collector", "keyword=Medtrum", "run-001");

	assert.equal(run.taskId, "x-search-post-collector");
	assert.equal(run.runId, "run-001");
	assert.ok(fs.existsSync(path.join(run.runDir, "input.json")));
	assert.equal(fs.readFileSync(path.join(run.runDir, "todo.md"), "utf8"), "# Run Todo\n\n## A. Prepare\n");
	assert.ok(fs.existsSync(path.join(run.runDir, "progress.md")));
	assert.ok(fs.existsSync(path.join(run.runDir, "feedback.md")));
	assert.equal(readDriverStatus(run.runDir)?.status, "starting");
});

test("listDriverSummaries reads status files and sorts active runs first", () => {
	const cwd = tempProject();
	const first = createRunArtifacts(cwd, "x", "one", "run-001");
	const second = createRunArtifacts(cwd, "reddit", "two", "run-004");

	writeDriverStatus(first.runDir, {
		taskId: "x",
		runId: "run-001",
		status: "done",
		step: "step 5/5",
		summary: "validated",
		updatedAt: "2026-06-17T00:00:01.000Z",
	});
	writeDriverStatus(second.runDir, {
		taskId: "reddit",
		runId: "run-004",
		status: "running",
		step: "step 1/4",
		summary: "collecting",
		updatedAt: "2026-06-17T00:00:02.000Z",
	});

	const summaries = listDriverSummaries(cwd);

	assert.equal(summaries.length, 2);
	assert.equal(summaries[0].runId, "run-004");
	assert.equal(summaries[0].status, "running");
	assert.equal(summaries[1].runId, "run-001");
});

test("appendDriverFeedback records user intervention", () => {
	const cwd = tempProject();
	const run = createRunArtifacts(cwd, "x", "keyword=Medtrum", "run-001");

	appendDriverFeedback(run.runDir, {
		message: "停，先等首屏加载",
		driverResponse: "queued",
		affectedStep: "C",
	});

	const feedback = fs.readFileSync(path.join(run.runDir, "feedback.md"), "utf8");
	assert.match(feedback, /停，先等首屏加载/);
	assert.match(feedback, /affected step: C/);
});
```

- [ ] **Step 2: Run store tests and confirm they fail**

Run:

```powershell
node --test tests/flow-driver-store.test.ts
```

Expected: fails because `extensions/flow/driver-store.ts` does not exist.

- [ ] **Step 3: Implement artifact store**

Create `extensions/flow/driver-store.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { FlowDriverStatus, FlowDriverSummary } from "./types.ts";

export interface FlowDriverStatusFile {
	taskId: string;
	runId: string;
	status: FlowDriverStatus;
	step?: string;
	summary?: string;
	updatedAt: string;
	sessionFile?: string;
}

export interface CreatedRunArtifacts {
	taskId: string;
	runId: string;
	taskDir: string;
	runDir: string;
}

const STATUS_ORDER: Record<FlowDriverStatus, number> = {
	starting: 0,
	running: 1,
	waiting: 2,
	"waiting-for-user": 2,
	"needs-human": 3,
	validating: 4,
	failed: 5,
	paused: 6,
	done: 7,
};

function flowTasksDir(cwd: string): string {
	return path.join(cwd, ".flow", "tasks");
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isKnownStatus(value: unknown): value is FlowDriverStatus {
	return (
		value === "starting" ||
		value === "running" ||
		value === "waiting" ||
		value === "waiting-for-user" ||
		value === "needs-human" ||
		value === "validating" ||
		value === "done" ||
		value === "failed" ||
		value === "paused"
	);
}

export function readDriverStatus(runDir: string): FlowDriverStatusFile | undefined {
	const statusPath = path.join(runDir, "status.json");
	if (!fs.existsSync(statusPath)) return undefined;
	const raw = safeJsonParse(fs.readFileSync(statusPath, "utf8"));
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const taskId = typeof record.taskId === "string" ? record.taskId : path.basename(path.dirname(path.dirname(runDir)));
	const runId = typeof record.runId === "string" ? record.runId : path.basename(runDir);
	const status = isKnownStatus(record.status) ? record.status : "paused";
	return {
		taskId,
		runId,
		status,
		step: typeof record.step === "string" ? record.step : undefined,
		summary: typeof record.summary === "string" ? record.summary : undefined,
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
		sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : undefined,
	};
}

export function writeDriverStatus(runDir: string, status: Omit<FlowDriverStatusFile, "updatedAt"> & { updatedAt?: string }): void {
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(
		path.join(runDir, "status.json"),
		`${JSON.stringify({ ...status, updatedAt: status.updatedAt ?? new Date().toISOString() }, null, 2)}\n`,
		"utf8",
	);
}

export function createRunArtifacts(cwd: string, taskId: string, input: string | undefined, runId: string): CreatedRunArtifacts {
	const taskDir = path.join(flowTasksDir(cwd), taskId);
	const runDir = path.join(taskDir, "runs", runId);
	const todoTemplate = path.join(taskDir, "todo.template.md");
	fs.mkdirSync(path.join(runDir, "output"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true });
	fs.writeFileSync(path.join(runDir, "input.json"), `${JSON.stringify({ input: input ?? "" }, null, 2)}\n`, "utf8");
	fs.writeFileSync(
		path.join(runDir, "prompt.md"),
		[`# Driver Prompt`, ``, `Task: ${taskId}`, `Run: ${runId}`, `Input: ${input ?? ""}`, ``].join("\n"),
		"utf8",
	);
	fs.writeFileSync(
		path.join(runDir, "todo.md"),
		fs.existsSync(todoTemplate) ? fs.readFileSync(todoTemplate, "utf8") : "# Run Todo\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(runDir, "progress.md"),
		["# Progress", "", "## Current", "", "- Step:", "- Status: starting", "- Last action:", "- Last evidence:", "", "## Timeline", ""].join("\n"),
		"utf8",
	);
	fs.writeFileSync(path.join(runDir, "feedback.md"), "# User Feedback\n\n", "utf8");
	writeDriverStatus(runDir, { taskId, runId, status: "starting", step: "not started", summary: "driver created" });
	return { taskId, runId, taskDir, runDir };
}

export function appendDriverFeedback(
	runDir: string,
	feedback: { message: string; driverResponse: string; affectedStep?: string },
	now = new Date(),
): void {
	const file = path.join(runDir, "feedback.md");
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# User Feedback\n\n";
	const entry = [
		`## Intervention ${now.toISOString()}`,
		"",
		`- timestamp: ${now.toISOString()}`,
		"- focus: driver",
		`- user message: ${feedback.message}`,
		`- driver response: ${feedback.driverResponse}`,
		`- affected step: ${feedback.affectedStep ?? "unknown"}`,
		"- should review for skill update: unknown",
		"",
	].join("\n");
	fs.writeFileSync(file, `${existing.trimEnd()}\n\n${entry}`, "utf8");
}

export function listDriverSummaries(cwd: string): FlowDriverSummary[] {
	const tasksDir = flowTasksDir(cwd);
	if (!fs.existsSync(tasksDir)) return [];
	const summaries: FlowDriverSummary[] = [];
	for (const taskId of fs.readdirSync(tasksDir)) {
		const runsDir = path.join(tasksDir, taskId, "runs");
		if (!fs.existsSync(runsDir)) continue;
		for (const runId of fs.readdirSync(runsDir)) {
			const runDir = path.join(runsDir, runId);
			if (!fs.statSync(runDir).isDirectory()) continue;
			const status = readDriverStatus(runDir);
			if (!status) continue;
			summaries.push({ ...status, runDir });
		}
	}
	return summaries.sort((a, b) => {
		const statusDelta = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
		if (statusDelta !== 0) return statusDelta;
		return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
	});
}

export function findDriverSummary(cwd: string, runId: string): FlowDriverSummary | undefined {
	return listDriverSummaries(cwd).find((driver) => driver.runId === runId);
}
```

- [ ] **Step 4: Add store test to package script**

Modify `package.json` so `tests/flow-driver-store.test.ts` runs after `tests/flow-extension.test.ts`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --test tests/flow-driver-store.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit artifact store**

Run:

```powershell
git add extensions/flow/driver-store.ts tests/flow-driver-store.test.ts package.json
git commit -m "feat: add flow driver artifact store"
```

## Task 3: Add Focus State, Picker, And Banner Formatting

**Files:**

- Create: `extensions/flow/driver-focus.ts`
- Create: `extensions/flow/driver-picker.ts`
- Create: `extensions/flow/driver-banner.ts`
- Test: `tests/flow-driver-focus.test.ts`
- Test: `tests/flow-driver-picker.test.ts`
- Test: `tests/flow-driver-banner.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write focus tests**

Create `tests/flow-driver-focus.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { attachFlowDriver, detachFlowDriver, restoreFlowFocus } from "../extensions/flow/driver-focus.ts";

test("attach and detach update focus state", () => {
	const attached = attachFlowDriver({ focus: "main" }, { taskId: "x", runId: "run-001" });
	assert.deepEqual(attached, { focus: "driver", taskId: "x", runId: "run-001" });
	assert.deepEqual(detachFlowDriver(attached), { focus: "main" });
});

test("restoreFlowFocus reads the latest persisted custom entry", () => {
	const restored = restoreFlowFocus([
		{ type: "custom", customType: "flow-focus", data: { focus: "driver", taskId: "old", runId: "run-000" } },
		{ type: "custom", customType: "flow-focus", data: { focus: "main" } },
		{ type: "custom", customType: "flow-focus", data: { focus: "driver", taskId: "x", runId: "run-001" } },
	] as any);
	assert.deepEqual(restored, { focus: "driver", taskId: "x", runId: "run-001" });
});
```

- [ ] **Step 2: Write picker tests**

Create `tests/flow-driver-picker.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { formatDriverPickerOption, getDriverPickerOptions, parseDriverPickerSelection } from "../extensions/flow/driver-picker.ts";
import type { FlowDriverSummary } from "../extensions/flow/types.ts";

const drivers: FlowDriverSummary[] = [
	{ taskId: "x", runId: "run-001", status: "running", step: "step 2/5", summary: "waiting first page load", updatedAt: "2026-06-17T00:00:02.000Z", runDir: "x/run-001" },
	{ taskId: "reddit", runId: "run-004", status: "waiting", step: "step 1/4", summary: "needs user input", updatedAt: "2026-06-17T00:00:01.000Z", runDir: "reddit/run-004" },
];

test("formats picker options with status and identifiers", () => {
	assert.equal(
		formatDriverPickerOption(drivers[0], new Date("2026-06-17T00:00:14.000Z")),
		"running  x/run-001  step 2/5  waiting first page load  12s ago",
	);
});

test("picker options round-trip back to driver summaries", () => {
	const options = getDriverPickerOptions(drivers, new Date("2026-06-17T00:00:14.000Z"));
	assert.equal(options.length, 2);
	assert.equal(parseDriverPickerSelection(options[1], drivers, new Date("2026-06-17T00:00:14.000Z"))?.runId, "run-004");
});
```

- [ ] **Step 3: Write banner tests**

Create `tests/flow-driver-banner.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { clearFlowDriverBanner, formatFlowDriverBannerText, getFlowDriverBanner, setFlowDriverBanner } from "../extensions/flow/driver-banner.ts";

test("formats active driver banner", () => {
	assert.equal(
		formatFlowDriverBannerText({ taskId: "x-search-post-collector", runId: "run-001", status: "running" }),
		"FLOW DRIVER ACTIVE  x-search-post-collector/run-001  running  /flow detach 返回 main",
	);
});

test("stores and clears current banner", () => {
	setFlowDriverBanner({ taskId: "x", runId: "run-001", status: "running" });
	assert.equal(getFlowDriverBanner()?.runId, "run-001");
	clearFlowDriverBanner();
	assert.equal(getFlowDriverBanner(), undefined);
});
```

- [ ] **Step 4: Run new tests and confirm they fail**

Run:

```powershell
node --test tests/flow-driver-focus.test.ts tests/flow-driver-picker.test.ts tests/flow-driver-banner.test.ts
```

Expected: fail because the new modules do not exist.

- [ ] **Step 5: Implement focus helpers**

Create `extensions/flow/driver-focus.ts`:

```ts
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FlowDriverSummary, FlowFocusState } from "./types.ts";

export const FLOW_FOCUS_ENTRY_TYPE = "flow-focus";

export function attachFlowDriver(_state: FlowFocusState, driver: Pick<FlowDriverSummary, "taskId" | "runId">): FlowFocusState {
	return { focus: "driver", taskId: driver.taskId, runId: driver.runId };
}

export function detachFlowDriver(_state: FlowFocusState): FlowFocusState {
	return { focus: "main" };
}

function isFlowFocusState(value: unknown): value is FlowFocusState {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.focus === "main") return true;
	return record.focus === "driver" && typeof record.runId === "string";
}

export function restoreFlowFocus(entries: SessionEntry[]): FlowFocusState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as SessionEntry & { customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== FLOW_FOCUS_ENTRY_TYPE) continue;
		if (isFlowFocusState(entry.data)) return entry.data;
	}
	return { focus: "main" };
}
```

- [ ] **Step 6: Implement picker helpers**

Create `extensions/flow/driver-picker.ts`:

```ts
import type { FlowDriverSummary } from "./types.ts";

function relativeAge(updatedAt: string | undefined, now: Date): string {
	if (!updatedAt) return "unknown";
	const deltaMs = Math.max(0, now.getTime() - new Date(updatedAt).getTime());
	const seconds = Math.floor(deltaMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}

export function formatDriverPickerOption(driver: FlowDriverSummary, now = new Date()): string {
	const id = `${driver.taskId}/${driver.runId}`;
	return [
		driver.status.padEnd(8),
		id,
		driver.step ?? "-",
		driver.summary ?? "-",
		relativeAge(driver.updatedAt, now),
	].join("  ");
}

export function getDriverPickerOptions(drivers: FlowDriverSummary[], now = new Date()): string[] {
	return drivers.map((driver) => formatDriverPickerOption(driver, now));
}

export function parseDriverPickerSelection(
	selection: string | undefined,
	drivers: FlowDriverSummary[],
	now = new Date(),
): FlowDriverSummary | undefined {
	if (!selection) return undefined;
	return drivers.find((driver) => formatDriverPickerOption(driver, now) === selection);
}
```

- [ ] **Step 7: Implement banner helpers**

Create `extensions/flow/driver-banner.ts`:

```ts
import type { FlowDriverStatus } from "./types.ts";

export interface FlowDriverBanner {
	taskId: string;
	runId: string;
	status: FlowDriverStatus;
}

let current: FlowDriverBanner | undefined;
const listeners = new Set<() => void>();

export function formatFlowDriverBannerText(banner: FlowDriverBanner): string {
	return `FLOW DRIVER ACTIVE  ${banner.taskId}/${banner.runId}  ${banner.status}  /flow detach 返回 main`;
}

export function getFlowDriverBanner(): FlowDriverBanner | undefined {
	return current;
}

export function setFlowDriverBanner(banner: FlowDriverBanner): void {
	current = banner;
	for (const listener of listeners) listener();
}

export function clearFlowDriverBanner(): void {
	current = undefined;
	for (const listener of listeners) listener();
}

export function subscribeFlowDriverBanner(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
```

- [ ] **Step 8: Add tests to package script**

Modify `package.json` so the three new test files run after `tests/flow-driver-store.test.ts`.

- [ ] **Step 9: Run focused tests**

Run:

```powershell
node --test tests/flow-driver-focus.test.ts tests/flow-driver-picker.test.ts tests/flow-driver-banner.test.ts
```

Expected: all pass.

- [ ] **Step 10: Commit focus and picker foundation**

Run:

```powershell
git add extensions/flow/driver-focus.ts extensions/flow/driver-picker.ts extensions/flow/driver-banner.ts tests/flow-driver-focus.test.ts tests/flow-driver-picker.test.ts tests/flow-driver-banner.test.ts package.json
git commit -m "feat: add flow driver focus state"
```

## Task 4: Render Driver Banner In UGK Header

**Files:**

- Modify: `extensions/ui-brand.ts`
- Test: `tests/ui-brand-extension.test.ts`
- Test: `tests/flow-driver-banner.test.ts`

- [ ] **Step 1: Add a header rendering test**

Extend `tests/ui-brand-extension.test.ts` by adding this import after the existing `registerUgkBrandUi` import:

```ts
import { clearFlowDriverBanner, setFlowDriverBanner } from "../extensions/flow/driver-banner.ts";
```

Append this complete test to the file:

```ts
test("ugk header includes active Flow driver banner", async () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};
	let headerFactory: Function | undefined;
	const ctx = {
		cwd: "/Users/shengkai/projects/ugk-tui",
		model: { id: "deepseek-v4-pro" },
		sessionManager: {
			getCwd: () => "/Users/shengkai/projects/ugk-tui",
			getEntries: () => [],
			getBranch: () => [],
		},
		getContextUsage: () => ({ percent: 0, contextWindow: 1000000 }),
		ui: {
			setHeader: (factory: unknown) => {
				headerFactory = factory as Function;
			},
			setFooter: () => {},
			setTitle: () => {},
		},
	};
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	registerUgkBrandUi(pi as any);
	setFlowDriverBanner({ taskId: "x-search-post-collector", runId: "run-001", status: "running" });

	await handlers.get("session_start")!({ reason: "startup" }, ctx);

	const header = headerFactory!({ requestRender() {} }, theme);
	const lines = header.render(100);
	assert.match(lines.join("\n"), /FLOW DRIVER ACTIVE/);
	assert.match(lines.join("\n"), /x-search-post-collector\/run-001/);
	clearFlowDriverBanner();
});
```

- [ ] **Step 2: Run the UI test and confirm it fails**

Run:

```powershell
node --test tests/ui-brand-extension.test.ts
```

Expected: fails because the header does not include the Flow banner yet.

- [ ] **Step 3: Import banner helpers in `extensions/ui-brand.ts`**

Add:

```ts
import {
	formatFlowDriverBannerText,
	getFlowDriverBanner,
	subscribeFlowDriverBanner,
} from "./flow/driver-banner.ts";
```

- [ ] **Step 4: Update `UgkHeader` to subscribe and render banner**

Modify `UgkHeader` in `extensions/ui-brand.ts`:

```ts
class UgkHeader implements Component {
	private readonly ctx: ExtensionContext;
	private readonly theme: any;
	private readonly tui?: { requestRender(): void };
	private unsubscribe?: () => void;

	constructor(ctx: ExtensionContext, theme: any, tui?: { requestRender(): void }) {
		this.ctx = ctx;
		this.theme = theme;
		this.tui = tui;
		this.unsubscribe = subscribeFlowDriverBanner(() => this.tui?.requestRender());
	}

	dispose(): void {
		this.unsubscribe?.();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const cwd = this.ctx.sessionManager?.getCwd?.() ?? this.ctx.cwd ?? process.cwd();
		const modelId = resolveUgkDisplayModelId(this.ctx.model?.id, getDeepSeekStatus());
		const options = {
			version: VERSION,
			cwdName: path.basename(cwd),
			modelId,
			width,
		};
		const lines = hasSessionMessages(this.ctx)
			? buildUgkHeaderLines(options)
			: buildUgkStartupScreenLines({
					...options,
					rows: process.stdout.rows || 24,
				});
		const banner = getFlowDriverBanner();
		const bannerLines = banner
			? ["", this.theme.bold(this.theme.fg("warning", formatFlowDriverBannerText(banner))), ""]
			: [];
		return ["", ...bannerLines, ...lines.map((line, i) => colorHeaderLine(line, i, this.theme)), ""];
	}
}
```

Then update `applyBrandUi`:

```ts
	ctx.ui.setHeader((tui, theme) => new UgkHeader(ctx, theme, tui));
```

- [ ] **Step 5: Run focused UI tests**

Run:

```powershell
node --test tests/flow-driver-banner.test.ts tests/ui-brand-extension.test.ts tests/ui-brand-utils.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit header banner**

Run:

```powershell
git add extensions/ui-brand.ts tests/ui-brand-extension.test.ts
git commit -m "feat: show flow driver focus banner"
```

## Task 5: Add SDK Driver Session Wrapper

**Files:**

- Create: `extensions/flow/driver-view.ts`
- Create: `extensions/flow/driver-session.ts`
- Test: `tests/flow-driver-session.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write driver session wrapper tests using a fake session**

Create `tests/flow-driver-session.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowDriverSession, type DriverSessionFactory } from "../extensions/flow/driver-session.ts";

function tempRunDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "flow-driver-session-"));
}

test("driver session starts with the generated prompt and records transcript tail", async () => {
	const prompts: string[] = [];
	const fakeFactory: DriverSessionFactory = async () => ({
		session: {
			sessionFile: "driver-session.jsonl",
			isStreaming: false,
			subscribe(listener) {
				listener({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "hello" },
				} as any);
				return () => {};
			},
			async prompt(text: string) {
				prompts.push(text);
			},
			async steer(text: string) {
				prompts.push(`steer:${text}`);
			},
			async followUp(text: string) {
				prompts.push(`followUp:${text}`);
			},
			dispose() {},
		},
	});
	const runDir = tempRunDir();
	const driver = await createFlowDriverSession(
		{
			cwd: process.cwd(),
			taskId: "x",
			runId: "run-001",
			runDir,
			initialPrompt: "Read SKILL.md and run the task.",
		},
		fakeFactory,
	);

	await driver.start();

	assert.equal(prompts[0], "Read SKILL.md and run the task.");
	assert.match(driver.getTranscriptText(), /hello/);
});

test("driver session sends steer while streaming and follow-up while idle", async () => {
	const sent: string[] = [];
	let streaming = true;
	const fakeFactory: DriverSessionFactory = async () => ({
		session: {
			sessionFile: "driver-session.jsonl",
			get isStreaming() {
				return streaming;
			},
			subscribe() {
				return () => {};
			},
			async prompt(text: string) {
				sent.push(`prompt:${text}`);
			},
			async steer(text: string) {
				sent.push(`steer:${text}`);
			},
			async followUp(text: string) {
				sent.push(`followUp:${text}`);
			},
			dispose() {},
		},
	});
	const driver = await createFlowDriverSession(
		{ cwd: process.cwd(), taskId: "x", runId: "run-001", runDir: tempRunDir(), initialPrompt: "start" },
		fakeFactory,
	);

	await driver.sendUserInput("stop now");
	streaming = false;
	await driver.sendUserInput("continue");

	assert.deepEqual(sent, ["steer:stop now", "prompt:continue"]);
});
```

- [ ] **Step 2: Run the wrapper tests and confirm they fail**

Run:

```powershell
node --test tests/flow-driver-session.test.ts
```

Expected: fails because `driver-session.ts` does not exist.

- [ ] **Step 3: Implement transcript tail view**

Create `extensions/flow/driver-view.ts`:

```ts
const MAX_DRIVER_TRANSCRIPT_LINES = 30;

export class DriverTranscriptTail {
	private lines: string[] = [];

	appendText(text: string): void {
		const next = text.split(/\r?\n/);
		if (this.lines.length === 0) this.lines.push("");
		this.lines[this.lines.length - 1] += next[0] ?? "";
		for (const line of next.slice(1)) this.lines.push(line);
		if (this.lines.length > MAX_DRIVER_TRANSCRIPT_LINES) {
			this.lines = this.lines.slice(this.lines.length - MAX_DRIVER_TRANSCRIPT_LINES);
		}
	}

	toText(): string {
		return this.lines.join("\n").trimEnd();
	}

	toWidgetLines(title: string): string[] {
		const body = this.toText();
		return body ? [title, ...body.split(/\r?\n/)] : [title, "(no driver output yet)"];
	}
}
```

- [ ] **Step 4: Implement SDK driver session wrapper**

Create `extensions/flow/driver-session.ts`:

```ts
import path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { DriverTranscriptTail } from "./driver-view.ts";

export interface FlowDriverSessionOptions {
	cwd: string;
	taskId: string;
	runId: string;
	runDir: string;
	initialPrompt: string;
}

export type DriverSessionLike = Pick<AgentSession, "sessionFile" | "isStreaming" | "subscribe" | "prompt" | "steer" | "followUp" | "dispose">;

export type DriverSessionFactory = (options: FlowDriverSessionOptions) => Promise<{ session: DriverSessionLike }>;

async function defaultDriverSessionFactory(options: FlowDriverSessionOptions): Promise<CreateAgentSessionResult> {
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: getAgentDir(),
	});
	await resourceLoader.reload();
	return createAgentSession({
		cwd: options.cwd,
		agentDir: getAgentDir(),
		resourceLoader,
		sessionManager: SessionManager.create(options.cwd, path.join(options.runDir, "session")),
	});
}

export interface FlowDriverSession {
	taskId: string;
	runId: string;
	runDir: string;
	sessionFile?: string;
	start(): Promise<void>;
	sendUserInput(text: string): Promise<void>;
	getTranscriptText(): string;
	getWidgetLines(): string[];
	dispose(): void;
}

export async function createFlowDriverSession(
	options: FlowDriverSessionOptions,
	factory: DriverSessionFactory = defaultDriverSessionFactory,
): Promise<FlowDriverSession> {
	const { session } = await factory(options);
	const transcript = new DriverTranscriptTail();
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			transcript.appendText(event.assistantMessageEvent.delta);
		}
	});

	return {
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: session.sessionFile,
		async start() {
			await session.prompt(options.initialPrompt);
		},
		async sendUserInput(text: string) {
			if (session.isStreaming) {
				await session.steer(text);
			} else {
				await session.prompt(text);
			}
		},
		getTranscriptText() {
			return transcript.toText();
		},
		getWidgetLines() {
			return transcript.toWidgetLines(`Flow driver ${options.taskId}/${options.runId}`);
		},
		dispose() {
			unsubscribe();
			session.dispose();
		},
	};
}
```

- [ ] **Step 5: Add driver session test to package script**

Modify `package.json` so `tests/flow-driver-session.test.ts` runs after `tests/flow-driver-banner.test.ts`.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
node --test tests/flow-driver-session.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit driver session wrapper**

Run:

```powershell
git add extensions/flow/driver-view.ts extensions/flow/driver-session.ts tests/flow-driver-session.test.ts package.json
git commit -m "feat: add flow driver session wrapper"
```

## Task 6: Integrate Driver Commands Into Flow Extension

**Files:**

- Modify: `extensions/flow/index.ts`
- Modify: `extensions/flow/formatter.ts`
- Modify: `tests/flow-extension.test.ts`

- [ ] **Step 1: Add extension tests for attach picker, direct attach, detach, and input routing**

Append to `tests/flow-extension.test.ts`:

```ts
test("/flow attach with no args opens picker and focuses selected driver", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	ctx.cwd = makeTempFlowProject([
		{ taskId: "x", runId: "run-001", status: "running", step: "step 2/5", summary: "collecting" },
		{ taskId: "reddit", runId: "run-004", status: "waiting", step: "step 1/4", summary: "needs input" },
	]);
	ctx.ui.select = async (_title: string, options: string[]) => options[1];
	registerFlow(pi as any);

	await commands.get("flow").handler("attach", ctx);

	assert.match(notifications.at(-1)!.message, /Flow driver attached/);
	assert.match(notifications.at(-1)!.message, /run-004/);
});

test("/flow detach clears focused driver", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	ctx.cwd = makeTempFlowProject([{ taskId: "x", runId: "run-001", status: "running" }]);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	await commands.get("flow").handler("detach", ctx);

	assert.match(notifications.at(-1)!.message, /Flow driver detached/);
});

test("driver focus input is handled instead of reaching main", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	ctx.cwd = makeTempFlowProject([{ taskId: "x", runId: "run-001", status: "running" }]);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	const result = await handlers.get("input")![0]({ text: "停，先等首屏加载", source: "interactive" }, ctx);

	assert.deepEqual(result, { action: "handled" });
});
```

Before those tests, add a helper in the same file:

```ts
function makeTempFlowProject(
	drivers: Array<{ taskId: string; runId: string; status: string; step?: string; summary?: string }>,
): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-extension-"));
	for (const driver of drivers) {
		const runDir = path.join(cwd, ".flow", "tasks", driver.taskId, "runs", driver.runId);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "status.json"),
			`${JSON.stringify({ ...driver, updatedAt: new Date().toISOString() }, null, 2)}\n`,
			"utf8",
		);
		fs.writeFileSync(path.join(runDir, "feedback.md"), "# User Feedback\n\n", "utf8");
	}
	return cwd;
}
```

Also import:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
```

- [ ] **Step 2: Run extension tests and confirm the new cases fail**

Run:

```powershell
node --test tests/flow-extension.test.ts
```

Expected: new cases fail because attach/detach are not integrated yet.

- [ ] **Step 3: Update formatter**

In `extensions/flow/formatter.ts`, add cases:

```ts
		case "attach":
			return request.runId ? `Flow driver attach requested: ${request.runId}` : "Flow driver picker opened.";
		case "detach":
			return "Flow driver detached.";
		case "driver-status":
			return "Flow driver status requested.";
```

- [ ] **Step 4: Integrate focus commands in `registerFlow`**

In `extensions/flow/index.ts`, add imports:

```ts
import { clearFlowDriverBanner, setFlowDriverBanner } from "./driver-banner.ts";
import { attachFlowDriver, detachFlowDriver, FLOW_FOCUS_ENTRY_TYPE, restoreFlowFocus } from "./driver-focus.ts";
import { getDriverPickerOptions, parseDriverPickerSelection } from "./driver-picker.ts";
import { appendDriverFeedback, findDriverSummary, listDriverSummaries } from "./driver-store.ts";
import type { FlowDriverSummary, FlowFocusState } from "./types.ts";
```

Inside `registerFlow`, add state:

```ts
	let focusState: FlowFocusState = { focus: "main" };
	let activeContext: ExtensionContext | undefined;
```

Add helpers inside `registerFlow`:

```ts
	function persistFocus(pi: ExtensionAPI, state: FlowFocusState): void {
		pi.appendEntry(FLOW_FOCUS_ENTRY_TYPE, state);
	}

	function renderFocus(ctx: ExtensionContext, driver?: FlowDriverSummary): void {
		if (focusState.focus === "driver" && driver) {
			setFlowDriverBanner({ taskId: driver.taskId, runId: driver.runId, status: driver.status });
			ctx.ui.setStatus("flow-driver", ctx.ui.theme.fg("warning", `driver:${driver.runId}`));
			return;
		}
		clearFlowDriverBanner();
		ctx.ui.setStatus("flow-driver", undefined);
		ctx.ui.setWidget("flow-driver-view", undefined);
	}

	async function attachDriverBySummary(driver: FlowDriverSummary, ctx: ExtensionContext): Promise<void> {
		focusState = attachFlowDriver(focusState, driver);
		persistFocus(pi, focusState);
		renderFocus(ctx, driver);
		ctx.ui.notify(`Flow driver attached: ${driver.taskId}/${driver.runId}`, "info");
	}
```

In the command handler, before the existing actionable prompt path, handle the new request kinds:

```ts
			if (request.kind === "attach") {
				const drivers = listDriverSummaries(ctx.cwd);
				if (request.runId) {
					const driver = findDriverSummary(ctx.cwd, request.runId);
					if (!driver) {
						ctx.ui.notify(`Flow driver not found: ${request.runId}`, "warning");
						return;
					}
					await attachDriverBySummary(driver, ctx);
					return;
				}
				if (drivers.length === 0) {
					ctx.ui.notify("No Flow drivers are running or recoverable.", "info");
					return;
				}
				const now = new Date();
				const options = getDriverPickerOptions(drivers, now);
				const selection = await ctx.ui.select("Select Flow driver", options);
				const selected = parseDriverPickerSelection(selection, drivers, now);
				if (!selected) return;
				await attachDriverBySummary(selected, ctx);
				return;
			}

			if (request.kind === "detach") {
				focusState = detachFlowDriver(focusState);
				persistFocus(pi, focusState);
				renderFocus(ctx);
				ctx.ui.notify("Flow driver detached.", "info");
				return;
			}

			if (request.kind === "driver-status") {
				const lines = listDriverSummaries(ctx.cwd).map(
					(driver) => `${driver.status} ${driver.taskId}/${driver.runId} ${driver.step ?? "-"} ${driver.summary ?? ""}`,
				);
				ctx.ui.notify(lines.length ? lines.join("\n") : "No Flow drivers are running or recoverable.", "info");
				return;
			}
```

Add a session-start handler:

```ts
	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		focusState = restoreFlowFocus(ctx.sessionManager.getEntries() as any);
		if (focusState.focus === "driver") {
			const driver = findDriverSummary(ctx.cwd, focusState.runId);
			if (driver) renderFocus(ctx, driver);
			else renderFocus(ctx);
		}
	});
```

Add an input handler after the existing context/input handlers, or merge with the existing `input` handler:

```ts
	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) {
			activeContextId = undefined;
		}
		if (event.source === "extension") return { action: "continue" };
		if (event.text.trimStart().startsWith("/")) return { action: "continue" };
		if (focusState.focus !== "driver") return { action: "continue" };

		const driver = findDriverSummary(ctx.cwd, focusState.runId);
		if (!driver) {
			ctx.ui.notify(`Attached Flow driver no longer exists: ${focusState.runId}. Detaching.`, "warning");
			focusState = detachFlowDriver(focusState);
			persistFocus(pi, focusState);
			renderFocus(ctx);
			return { action: "handled" };
		}

		appendDriverFeedback(driver.runDir, {
			message: event.text,
			driverResponse: "queued to driver",
			affectedStep: driver.step,
		});
		ctx.ui.notify(`Sent to Flow driver ${driver.runId}`, "info");
		return { action: "handled" };
	});
```

This step only handles focus, UI, and feedback recording. Task 7 wires this input to a live SDK driver session.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --test tests/flow-extension.test.ts tests/flow-driver-focus.test.ts tests/flow-driver-picker.test.ts tests/flow-driver-store.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit attach/detach integration**

Run:

```powershell
git add extensions/flow/index.ts extensions/flow/formatter.ts tests/flow-extension.test.ts
git commit -m "feat: add flow driver attach and detach"
```

## Task 7: Start Live Drivers For Prove And Run

**Files:**

- Modify: `extensions/flow/index.ts`
- Modify: `extensions/flow/prompts.ts`
- Modify: `extensions/flow/driver-store.ts`
- Test: `tests/flow-extension.test.ts`
- Test: `tests/flow-prompts.test.ts`

- [ ] **Step 1: Add tests that prove/run start a driver instead of only sending hidden main prompt**

In `tests/flow-extension.test.ts`, add a lightweight injection seam to `registerFlow` by importing a new named export after implementation:

```ts
import { registerFlow, setFlowDriverSessionFactoryForTests } from "../extensions/flow/index.ts";
```

Add test:

```ts
test("/flow task prove creates a run and starts a driver session", async () => {
	const started: string[] = [];
	setFlowDriverSessionFactoryForTests(async () => ({
		taskId: "x",
		runId: "run-001",
		runDir: "",
		sessionFile: "driver.jsonl",
		async start() {
			started.push("started");
		},
		async sendUserInput(text: string) {
			started.push(text);
		},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver"];
		},
		dispose() {},
	}));
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	ctx.cwd = makeTempTaskProject("x");
	registerFlow(pi as any);

	await commands.get("flow").handler("task prove x --input keyword=Medtrum", ctx);

	assert.deepEqual(started, ["started"]);
	assert.equal(sentMessages.length, 0);
	assert.match(notifications.at(-1)!.message, /Flow driver running/);
	setFlowDriverSessionFactoryForTests(undefined);
});
```

Add helper:

```ts
function makeTempTaskProject(taskId: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-task-"));
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	fs.mkdirSync(taskDir, { recursive: true });
	fs.writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify({ id: taskId, status: "draft", version: 1 }, null, 2)}\n`, "utf8");
	fs.writeFileSync(path.join(taskDir, "SKILL.md"), "# Skill\n\n## 最优路径\n\nA. Prepare\n", "utf8");
	fs.writeFileSync(path.join(taskDir, "todo.template.md"), "# Run Todo\n", "utf8");
	fs.writeFileSync(path.join(taskDir, "validator.md"), "# Validator\n", "utf8");
	return cwd;
}
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```powershell
node --test tests/flow-extension.test.ts
```

Expected: fails because prove still sends hidden Flow prompt.

- [ ] **Step 3: Add driver prompt builder in `driver-store.ts`**

Append to `extensions/flow/driver-store.ts`:

```ts
export function buildDriverInitialPrompt(args: { taskId: string; runId: string; taskDir: string; runDir: string }): string {
	return [
		"[FLOW INTERACTIVE DRIVER]",
		"",
		`Task: ${args.taskId}`,
		`Run: ${args.runId}`,
		`Task dir: ${args.taskDir}`,
		`Run dir: ${args.runDir}`,
		"",
		"你是本次 Flow Task run 的 driver。",
		"必须读取并遵守：",
		`- ${path.join(args.taskDir, "SKILL.md")}`,
		`- ${path.join(args.runDir, "input.json")}`,
		`- ${path.join(args.runDir, "todo.md")}`,
		`- ${path.join(args.taskDir, "validator.md")}`,
		"",
		"执行要求：",
		"- 按 SKILL.md 的最优路径逐步执行。",
		"- 每一步都填写 todo.md 的实际执行、偏离旧方案、解决过程和证据。",
		"- 输出写入 run/output/，证据写入 run/evidence/。",
		"- 进度写入 progress.md。",
		"- 状态写入 status.json。",
		"- 你不能修改 SKILL.md、todo.template.md 或 validator.md。",
		"- 如果用户通过 driver focus 插嘴，先记录反馈，再调整执行。",
	].join("\n");
}
```

- [ ] **Step 4: Add run id helper**

Append to `extensions/flow/driver-store.ts`:

```ts
export function nextRunId(cwd: string, taskId: string): string {
	const runsDir = path.join(flowTasksDir(cwd), taskId, "runs");
	if (!fs.existsSync(runsDir)) return "run-001";
	const max = fs
		.readdirSync(runsDir)
		.map((name) => name.match(/^run-(\d+)$/)?.[1])
		.filter((value): value is string => Boolean(value))
		.map((value) => Number(value))
		.reduce((current, value) => Math.max(current, value), 0);
	return `run-${String(max + 1).padStart(3, "0")}`;
}
```

- [ ] **Step 5: Wire driver factory into `extensions/flow/index.ts`**

Add imports:

```ts
import { buildDriverInitialPrompt, createRunArtifacts, nextRunId, writeDriverStatus } from "./driver-store.ts";
import { createFlowDriverSession, type FlowDriverSession } from "./driver-session.ts";
```

Add module-level test seam:

```ts
let driverSessionFactoryForTests: ((options: Parameters<typeof createFlowDriverSession>[0]) => Promise<FlowDriverSession>) | undefined;

export function setFlowDriverSessionFactoryForTests(factory: typeof driverSessionFactoryForTests): void {
	driverSessionFactoryForTests = factory;
}
```

Inside `registerFlow`, add:

```ts
	const liveDrivers = new Map<string, FlowDriverSession>();

	async function startDriverForTask(kind: "prove" | "run", taskId: string, input: string | undefined, ctx: ExtensionContext): Promise<void> {
		const runId = nextRunId(ctx.cwd, taskId);
		const artifacts = createRunArtifacts(ctx.cwd, taskId, input, runId);
		const initialPrompt = buildDriverInitialPrompt(artifacts);
		const createDriver = driverSessionFactoryForTests ?? createFlowDriverSession;
		const driver = await createDriver({
			cwd: ctx.cwd,
			taskId,
			runId,
			runDir: artifacts.runDir,
			initialPrompt,
		});
		liveDrivers.set(runId, driver);
		writeDriverStatus(artifacts.runDir, {
			taskId,
			runId,
			status: "running",
			step: "starting",
			summary: `${kind} driver running`,
			sessionFile: driver.sessionFile,
		});
		ctx.ui.setWidget("flow-driver-view", driver.getWidgetLines(), { placement: "aboveEditor" });
		void driver.start().catch((error) => {
			writeDriverStatus(artifacts.runDir, {
				taskId,
				runId,
				status: "failed",
				step: "driver start",
				summary: error instanceof Error ? error.message : String(error),
				sessionFile: driver.sessionFile,
			});
		});
		ctx.ui.notify(`Flow driver running: ${taskId}/${runId}\nAttach: /flow attach ${runId}`, "info");
	}
```

In the command handler, before the old actionable hidden-prompt path:

```ts
			if (request.kind === "task-prove") {
				await startDriverForTask("prove", request.taskId, request.input, ctx);
				return;
			}
			if (request.kind === "task-run") {
				await startDriverForTask("run", request.taskId, request.input, ctx);
				return;
			}
```

- [ ] **Step 6: Wire focused input to live driver sessions**

Replace the Task 6 input-handler notification-only branch after `appendDriverFeedback(...)` with:

```ts
		const liveDriver = liveDrivers.get(driver.runId);
		if (!liveDriver) {
			ctx.ui.notify(`Flow driver ${driver.runId} is recoverable but not live in this process. Feedback was recorded.`, "warning");
			return { action: "handled" };
		}
		await liveDriver.sendUserInput(event.text);
		ctx.ui.setWidget("flow-driver-view", liveDriver.getWidgetLines(), { placement: "aboveEditor" });
		ctx.ui.notify(`Sent to Flow driver ${driver.runId}`, "info");
		return { action: "handled" };
```

- [ ] **Step 7: Clear live driver resources on shutdown**

Add:

```ts
	pi.on("session_shutdown", async () => {
		for (const driver of liveDrivers.values()) driver.dispose();
		liveDrivers.clear();
	});
```

- [ ] **Step 8: Update prove/run prompt tests**

In `tests/flow-prompts.test.ts`, stop asserting that prove/run prompts mention `main agent 使用现有 subagent 工具启动 worker`. Replace with assertions that help text says prove/run starts interactive driver:

```ts
	assert.match(buildFlowHelpText(), /interactive driver|driver/);
```

Keep review prompt assertions because review remains main-agent hosted.

- [ ] **Step 9: Run focused tests**

Run:

```powershell
node --test tests/flow-extension.test.ts tests/flow-prompts.test.ts tests/flow-driver-session.test.ts tests/flow-driver-store.test.ts
```

Expected: all pass.

- [ ] **Step 10: Commit live driver integration**

Run:

```powershell
git add extensions/flow/index.ts extensions/flow/prompts.ts extensions/flow/driver-store.ts tests/flow-extension.test.ts tests/flow-prompts.test.ts
git commit -m "feat: start interactive flow drivers"
```

## Task 8: Verification And Manual Smoke

**Files:**

- Modify only if tests reveal a bug in files touched by prior tasks.

- [ ] **Step 1: Run all Flow-focused tests**

Run:

```powershell
node --test tests/flow-parser.test.ts tests/flow-prompts.test.ts tests/flow-extension.test.ts tests/flow-driver-store.test.ts tests/flow-driver-focus.test.ts tests/flow-driver-picker.test.ts tests/flow-driver-banner.test.ts tests/flow-driver-session.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run UI-focused tests**

Run:

```powershell
node --test tests/ui-brand-utils.test.ts tests/ui-brand-extension.test.ts tests/ugk-command.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Manual smoke test in TUI**

Start UGK from the repo:

```powershell
node bin/ugk.js
```

Run:

```text
/flow task create "创建一个测试 task：读取项目 README 第一段并总结"
/flow task prove <created-task-id> --input "source=README.md"
/flow attach
```

Expected:

- `/flow task prove` reports `Flow driver running: <task-id>/<run-id>`.
- `/flow attach` opens a selector when at least one run exists.
- Selecting a run shows `FLOW DRIVER ACTIVE  <task-id>/<run-id> ... /flow detach 返回 main` in the header.
- A normal message typed while attached is consumed by Flow, recorded in `feedback.md`, and routed to the live driver if it is running in the current process.
- `/flow detach` removes the header banner and returns input to main.

- [ ] **Step 5: Inspect artifacts**

Run:

```powershell
Get-ChildItem -Recurse .flow/tasks | Select-Object FullName
```

Expected run directory contains:

```text
input.json
prompt.md
todo.md
progress.md
feedback.md
output/
evidence/
status.json
session/
```

- [ ] **Step 6: Commit verification fixes if needed**

If any small bugfixes were required:

```powershell
git add <changed-files>
git commit -m "fix: stabilize flow interactive driver"
```

If no fixes were required, do not create an empty commit.

## Spec Coverage Review

- Attach by id: Task 1 parses it, Task 6 focuses the driver.
- Attach picker: Task 3 formats options, Task 6 opens `ctx.ui.select`.
- Detach: Task 1 parses it, Task 6 clears focus and banner.
- Top persistent banner: Task 3 stores banner state, Task 4 renders it in the UGK header.
- Multiple drivers: Task 2 lists all runs, Task 3 sorts/formats, Task 6 picker selects one.
- Input isolation: Task 6 consumes ordinary input in driver focus; Task 7 forwards it to live driver sessions.
- User interventions: Task 2 writes `feedback.md`; Task 6 records every focused input.
- Driver run artifacts: Task 2 creates base run files; Task 7 starts SDK driver sessions with the run directory.
- Driver context isolation: Task 7 uses a separate `AgentSession` for each live run.
- Main does not learn the task's detailed method: Task 7 does not append driver transcript as main visible custom messages; run artifacts remain source of truth.
- Review remains main-hosted: existing `task review` prompt behavior stays intact.

## Residual Risks

- Pi does not expose an API to replace the main message transcript with another session's transcript. This plan uses a driver-view widget plus run artifacts for live visibility. If full transcript replacement becomes mandatory, that is a pi core UI enhancement rather than a Flow extension-only change.
- Recoverable drivers from previous processes can be attached for status and feedback recording, but cannot receive live input until a resume mechanism reopens their saved SDK session. This plan records the limitation in user-facing warnings.
- The first SDK-backed implementation may need auth/model parity adjustments if `createAgentSession()` defaults differ from the active main session. If tests or smoke reveal model drift, pass `ctx.model`, `ctx.getSystemPromptOptions()`-compatible settings, and active tools explicitly in `createFlowDriverSession`.
