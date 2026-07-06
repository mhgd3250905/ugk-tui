# Diabetes News Report Pack/Translate/Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split diabetes news reporting into deterministic packaging, focused translation, and deterministic HTML rendering so large upstream JSON inputs do not overload the report renderer or produce unreadable "localized shell" reports.

**Architecture:** Collectors keep emitting JSON only. A packager task merges, cleans, dedupes, sorts, and truncates collector JSON into one report pack. A translator task translates only the selected visible fields in that pack. The renderer task consumes a pack or translated pack and emits the fixed HTML template.

**Tech Stack:** UGK taskbooks, Node.js ESM scripts, task worker LLM for translation only, existing dispatcher eval harness.

---

## Requirements

- Collectors remain JSON-only and language-neutral.
- `diabetes-news-report-packager` accepts collector JSON paths/directories and outputs `diabetes_news_report_pack.json`.
- Packager performs merge, clean, URL dedupe, newest-first list sorting, device/regulatory-first highlights, and `maxItems` truncation before translation.
- `diabetes-news-report-translator` accepts one pack and `targetLanguage=zh-CN`, translates only visible report fields, and outputs `diabetes_news_report_pack.zh-CN.json`.
- Translator preserves URLs, dates, source names, company/product names, FDA/510(k)/NCT identifiers, and original text fields for audit.
- `diabetes-news-report-renderer` accepts one pack/translated pack and outputs only `diabetes_news_report.html`.
- Chinese HTML must contain Chinese section labels and translated visible title/summary/context fields, not just Chinese prefixes around English body text.

## Implementation Summary

This branch adds a complete diabetes news task chain and the small runtime support it needs:

- Collector taskbooks now emit structured JSON only and stay language-neutral.
- `diabetes-news-report-packager` merges collector JSON, cleans/dedupes/sorts records, preserves source status, and emits a report pack.
- `diabetes-news-report-translator` translates only visible report fields into the requested language while preserving audit metadata.
- `diabetes-news-report-renderer` renders the final HTML report from the pack/translated pack.
- `contract.maxRetry` lets expensive or non-repeatable collectors opt out of whole-worker retries; this prevents CDP/manual-confirmation collectors from rerunning all sources after a verify failure.
- Custom-source collection retries only failed platforms inside the script before returning a single JSON artifact.

## Reviewer Notes

- The runtime change is intentionally small: both `run_task` and `/task run` now call the same `contractMaxRetry()` helper instead of hard-coding `3`.
- `contract.maxRetry` is optional and defaults to existing behavior (`3`), so old taskbooks keep the same retry budget.
- Schema validation rejects malformed `maxRetry` values early, rather than silently falling back to retry defaults.
- `.tasks/` runtime outputs and `taskbook.json` run histories are local artifacts and should not be committed.

## Action Plan

1. [x] Add packager taskbook with script and verify.
2. [x] Add translator taskbook with prepare/build scripts, worker skill, and verify.
3. [x] Refactor renderer contract/script/verify to consume pack JSON instead of raw collector JSON.
4. [x] Add dispatcher evals for packager, translator, and updated renderer.
5. [x] Sync taskbook fixtures and user-scope taskbook copies.
6. [x] Run direct script/verify checks, dispatcher eval reports, and `npm test`.

## Test Acceptance

- [x] Fresh collector outputs still verify as JSON-only.
- [x] Packager verifies that output item count is at most `maxItems`, URLs are unique, list is newest first, highlights prioritize regulatory/device items, and source status is preserved.
- [x] Translator verifies every selected item has translated Chinese visible fields when source text is English-heavy, while URLs/dates/source metadata are unchanged.
- [x] Renderer verifies HTML is the only artifact, uses fixed template sections, renders all pack item URLs once, and for zh-CN contains translated visible text rather than untranslated English-heavy titles/summaries.
- [x] Dispatcher evals pass for all affected taskbooks.
- [x] `npm test` reports zero failures.

## Verification

- `npm test`: 654 passed, 0 failed, 2 skipped.
- Dispatcher evals with production task model `xiaomi-token-plan-cn/mimo-v2.5-pro`:
  - `medical-diabetes-news`: 8/8 passed.
  - `diabetes-device-regulatory-signals`: 12/12 passed.
  - `diabetes-device-custom-source-news`: 5/5 passed.
  - `diabetes-news-report-translator`: 3/3 passed.
  - `diabetes-news-report-renderer`: 4/4 passed.
  - `diabetes-news-report-packager`: 4/4 passed.
