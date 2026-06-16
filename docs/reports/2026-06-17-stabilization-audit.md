# UGK Stabilization Audit

Date: 2026-06-17

Branch: `codex/audit-stabilization`

Baseline: `origin/main` at `7bf8d970669e134bb434354761fc90763e5d99e2`

## Purpose

UGK has reached its first stable stage. This audit reviews and improves the project across eight dimensions:

1. Architecture design rationality
2. Module decoupling rationality
3. Boundary design rationality
4. Code simplicity and readability
5. Redundant code removal
6. Messy code cleanup
7. Complete and standardized documentation
8. Comprehensive logging and operator-facing status

## Ground Rules

- Work happens only on `codex/audit-stabilization`.
- Each audit slice must be small enough to review independently.
- Every code change needs a concrete reason in this file.
- Every slice gets a verification command before commit.
- Prefer existing pi extension APIs and UGK module patterns over new abstractions.
- Do not rewrite adjacent code without evidence that it blocks the audit goal.

## Current Architecture Map

UGK is an npm package that wraps pi rather than replacing pi internals.

- `bin/ugk.js` is the CLI entry. It sets the pi runtime marker, applies startup defaults, and injects `extensions/index.ts`.
- `extensions/index.ts` is the composition root. It registers tools, slash commands, input transforms, UI hooks, safety gates, and package resources.
- `extensions/subagent.ts` delegates isolated work to child `ugk` or `pi` processes.
- `extensions/plan-mode.ts` gates tools and tracks plan execution state.
- `extensions/cron.ts` is a client for the separate local cron service in `cron/service.ts`.
- `extensions/chrome-cdp/*` owns guarded local Chrome CDP control.
- `extensions/ui-*` owns UGK terminal presentation through pi UI hooks.
- `skills/`, `prompts/`, `themes/`, and `agents/` are package resources discovered or installed through existing UGK/pi seams.

## Audit Log

| Slice | Commit | Area | Files | Reason | Verification |
| --- | --- | --- | --- | --- | --- |
| 1 | `docs: add stabilization audit ledger` | Planning and traceability | `docs/superpowers/plans/2026-06-17-stabilization-audit.md`, this file | Establish a durable audit ledger before making optimization changes. | `npm test` passed: 60 tests |
| 2 | `fix: handle invalid cdp port commands` | Boundary design and operator status | `extensions/chrome-cdp/index.ts`, `tests/chrome-cdp-extension.test.ts`, this file | `/cdp port nope` escaped as an exception from the command handler. Stable command boundaries should report invalid input as an actionable warning and preserve the previous port. | `node --test tests/chrome-cdp-extension.test.ts` passed: 6 tests; `npm test` passed: 61 tests |

## Findings

### Architecture Design

Initial read: the core architecture is sound. UGK uses `bin/ugk.js` as a thin package entry and keeps product behavior in pi extension modules. This is the correct direction because it preserves upstream pi behavior and concentrates customization in extension seams.

Open review items:

- Confirm whether `extensions/index.ts` is only a composition root or has accumulated policy logic that deserves moving behind deeper modules.
- Confirm whether user-facing status text is duplicated across README, skills, and `/ugk` output.
- Confirm whether Chrome CDP launch/status behavior is fully documented and tested on Windows, macOS, and Linux.

### Module Decoupling

Initial read: most complex capabilities have a registration file plus pure helpers and tests. This is good for locality.

Open review items:

- Check if `subagent.ts` mixes schema, child-process orchestration, result assembly, and project-agent approval more tightly than needed.
- Check if plan-mode state and UI rendering stay decoupled enough to test without pi.
- Check if cron contract formatting stays shared between tool and service without leaking HTTP details to callers.

### Boundary Design

Initial read: the risky boundaries are process spawning, bash permission gates, local HTTP cron calls, CDP browser control, and file writes.

Open review items:

- Validate path and command handling in subagent prompt temp files and Chrome screenshot output.
- Validate failed launch/status flows.
- Validate cron service payload validation and error text.

Fixed in slice 2:

- `/cdp port <value>` now catches invalid values at the command boundary, reports `Invalid CDP port: <value>. Use /cdp port <1-65535>.`, and keeps the previous resolved port.

### Code Simplicity And Readability

Open review items:

- Search for duplicate formatting, overly broad functions, and mixed concerns in large files.
- Prefer extracting behavior only when it gives callers a smaller interface or improves test locality.

### Redundant Code

Open review items:

- Search for unused exports and stale docs after recent Chrome CDP and UI additions.
- Remove only code proven unused by `rg`, imports, and tests.

### Cleanup

Open review items:

- Keep cleanup behavior-preserving and small.
- Avoid broad formatting churn.

### Documentation

Open review items:

- Align README, skills, extension README files, and status command output.
- Add operational notes for stable-stage maintenance where missing.

### Logging And Status

Open review items:

- Review user-facing notifications for consistency, useful next actions, and secret safety.
- Prefer concise status text over noisy internals.

## Verification History

| Time | Command | Result |
| --- | --- | --- |
| 2026-06-17 baseline | `npm test` | Passed: 60 tests, 0 failures |
| 2026-06-17 slice 2 focused | `node --test tests/chrome-cdp-extension.test.ts` | Passed: 6 tests, 0 failures |
| 2026-06-17 slice 2 full | `npm test` | Passed: 61 tests, 0 failures |
