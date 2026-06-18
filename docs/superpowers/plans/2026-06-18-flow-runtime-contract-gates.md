# Flow Runtime Contract Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Flow contract failures runtime-owned so users are not asked to understand or repair internal task/run output rules.

**Architecture:** Add explicit runtime gates for task draft assets and run output contracts. When a gate fails, Flow sends a repair prompt to the responsible agent/session and only advances to user-facing review after the gate passes; if repair still fails, Flow reports a system contract failure rather than asking the user to provide internal instructions.

**Tech Stack:** TypeScript extension code, Node test runner, existing Flow driver/session abstractions.

---

### Task 1: Run Output Contract Repair Gate

**Files:**
- Modify: `extensions/flow/index.ts`
- Modify: `extensions/flow/prompts.ts`
- Test: `tests/flow-extension.test.ts`

- [x] **Step 1: Write failing test**

Add a test where a driver finishes without `output/result.json`, then handles runtime repair by writing the missing contract file from `sendUserInput`. Assert Flow does not queue a main-agent/user validation handoff for the first failure and instead advances to review after repair passes.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/flow-extension.test.ts`

Expected: FAIL because the current runtime queues `[FLOW DRIVER COMPLETION]` and never sends a repair prompt to the driver.

- [x] **Step 3: Implement minimal repair loop**

Add a `buildFlowDriverContractRepairPrompt` prompt and call `liveDriver.sendUserInput(...)` once when `validateFlowRun` returns non-PASS. Re-run validation after repair. Only continue to review gate when validation becomes PASS.

- [x] **Step 4: Verify**

Run: `npm test -- tests/flow-extension.test.ts`

Expected: PASS.

### Task 2: Task Draft Asset Gate

**Files:**
- Create: `extensions/flow/task-validation.ts`
- Modify: `extensions/flow/index.ts`
- Test: `tests/flow-extension.test.ts`

- [x] **Step 1: Write failing test**

Add a create-completion test where the new draft task is missing required assets. Assert Flow queues a hidden repair prompt instead of showing the prove gate.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/flow-extension.test.ts`

Expected: FAIL because create completion currently only checks for a new draft task and immediately opens `Continue: prove`.

- [x] **Step 3: Implement draft validation**

Add a small validator requiring `task.json`, `SKILL.md`, `todo.template.md`, `validator.md`, `input.schema.json`, and `output.schema.json`. On create completion, if validation fails, queue a hidden repair prompt containing the missing assets; only open prove gate when validation passes.

- [x] **Step 4: Verify**

Run: `npm test -- tests/flow-extension.test.ts`

Expected: PASS.

### Task 3: Full Verification

- [x] Run `npm test`
- [x] Run `git diff --check`
- [x] Run a real `ugk --mode rpc` smoke test for `/flow` menu loading if CLI behavior changed.
