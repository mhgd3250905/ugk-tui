# Flow Review Contract Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep review questions user-facing and prevent malformed accepted review/task state from blocking `/flow run`.

**Architecture:** Tighten review prompts so internal contract questions are resolved by the agent/runtime, not the user. Add a runtime repair gate before `/flow run` that canonicalizes repairable accepted review records by rewriting them through the existing `acceptFlowReview` path.

**Tech Stack:** TypeScript extension code, Node test runner, existing Flow review/task stores.

---

### Task 1: User-Boundary Review Prompt

**Files:**
- Modify: `extensions/flow/prompts.ts`
- Test: `tests/flow-prompts.test.ts`

- [x] **Step 1: Write failing test**

Assert review prompts do not ask the user to understand internal evidence/input/schema details, and do instruct the agent to explain unclear user-facing questions instead of skipping them.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/flow-prompts.test.ts`

Expected: FAIL because the current prompt asks to核对 evidence粒度 and path internals too directly.

- [x] **Step 3: Implement minimal prompt change**

Rewrite review prompt wording so the agent asks only business-level questions: result acceptable, search path acceptable, what behavior to persist. Internal files like `input.json`, schema, validator, and review JSON are agent/runtime repair work.

- [x] **Step 4: Verify**

Run: `npm test -- tests/flow-prompts.test.ts`

Expected: PASS.

### Task 2: Repairable Accepted Review Gate

**Files:**
- Modify: `extensions/flow/index.ts`
- Test: `tests/flow-extension.test.ts`

- [x] **Step 1: Write failing test**

Create an active task whose latest review has `status: accepted` and `userConfirmed: true` but is missing `taskVersion`, `taskDesignDecision`, and `acceptedAt`. Assert `/flow run <task>` canonicalizes the review through runtime and starts the driver instead of blocking the user.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/flow-extension.test.ts`

Expected: FAIL because the current guard only reports an invalid accepted review.

- [x] **Step 3: Implement minimal runtime repair**

Before rejecting an invalid accepted review, detect repairable accepted records and call `acceptFlowReview({ taskVersion: task.version })` to produce canonical `review.json`. Re-read the review and proceed only if `isFlowReviewAccepted` passes.

- [x] **Step 4: Verify**

Run: `npm test -- tests/flow-extension.test.ts`

Expected: PASS.

### Task 3: Full Verification

- [x] Run `npm test`
- [x] Run `git diff --check`
