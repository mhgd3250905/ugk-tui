# Stabilization Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit and harden UGK after its first stable stage across architecture, module decoupling, boundaries, readability, redundancy, cleanup, documentation, and logging.

**Architecture:** Work stays on a dedicated branch from `origin/main`. Each audit slice must produce a small, reviewable change set with a documented reason, tests or an explicit verification command, and one git commit. Runtime behavior should continue to reuse pi extension seams instead of replacing pi internals.

**Tech Stack:** Node.js ESM, TypeScript extension files loaded by pi/jiti, TypeBox schemas, Node test runner, Markdown documentation.

---

## Files

- Create: `docs/reports/2026-06-17-stabilization-audit.md`
- Modify as findings require: `extensions/**/*.ts`
- Modify as findings require: `tests/*.test.ts`
- Modify as findings require: `README.md`
- Modify as findings require: `skills/**/SKILL.md`

## Success Criteria

- Architecture design is reviewed against the existing pi extension model.
- Module decoupling is reviewed for shallow pass-through modules, duplicated logic, and unnecessary coupling.
- Boundary design is reviewed for user-controlled inputs, process execution, file writes, browser control, and local services.
- Code implementation is simplified where the evidence shows real readability or maintenance gain.
- Redundant code introduced by this branch is removed; pre-existing redundant code is only removed when it is proven unused and covered by tests or searches.
- Messy code is cleaned in small, behavior-preserving slices.
- Documentation explains the stable architecture, operational boundaries, verification commands, and known tradeoffs.
- Logging/status reporting is reviewed for useful operator visibility without leaking secrets or noisy internals.

## Task 1: Audit Ledger And Baseline

- [ ] Create `docs/reports/2026-06-17-stabilization-audit.md` with the eight audit dimensions, current baseline, commit protocol, and an optimization log table.
- [ ] Run `npm test`.
- [ ] Commit the documentation baseline with `docs: add stabilization audit ledger`.

## Task 2: Architecture And Module Boundary Review

- [ ] Read `extensions/index.ts`, `extensions/subagent.ts`, `extensions/plan-mode.ts`, `extensions/cron.ts`, `extensions/chrome-cdp/index.ts`, and the matching tests.
- [ ] Record concrete findings in `docs/reports/2026-06-17-stabilization-audit.md`.
- [ ] Apply only low-risk refactors where the caller interface stays stable and tests cover the behavior.
- [ ] Run the focused tests for touched modules, then `npm test`.
- [ ] Commit with a message beginning `refactor:` or `test:` and add the reason to the audit log.

## Task 3: Boundary And Safety Review

- [ ] Inspect process spawning, local HTTP calls, CDP actions, file writes, env var reads, and command parsing.
- [ ] Add or tighten tests for invalid inputs, unsafe paths, failed subprocesses, and user-confirmed actions where coverage is missing.
- [ ] Keep the user-visible interface stable unless the audit finds a safety problem.
- [ ] Run the focused tests for touched modules, then `npm test`.
- [ ] Commit with a message beginning `fix:`, `test:`, or `refactor:` and add the reason to the audit log.

## Task 4: Readability, Redundancy, And Cleanup Review

- [ ] Search for unused exports, duplicate formatting code, shallow wrappers, stale docs, and inconsistent names.
- [ ] Delete only code proven unused by repository search and tests.
- [ ] Prefer small local simplifications over broad rewrites.
- [ ] Run the focused tests for touched modules, then `npm test`.
- [ ] Commit with a message beginning `refactor:` or `chore:` and add the reason to the audit log.

## Task 5: Documentation And Logging Review

- [ ] Update README and skill docs where current behavior is missing, stale, or operationally unclear.
- [ ] Review user-facing status/log text for actionability, secret safety, and consistency.
- [ ] Add tests for formatting or status text when the behavior is logic-heavy.
- [ ] Run `npm test`.
- [ ] Commit with a message beginning `docs:` or `refactor:` and add the reason to the audit log.

## Task 6: Final Verification

- [ ] Run `git diff origin/main...HEAD --stat`.
- [ ] Run `npm test`.
- [ ] Review `docs/reports/2026-06-17-stabilization-audit.md` for every requested dimension.
- [ ] Ensure every optimization has a reason, affected files, and verification evidence.
