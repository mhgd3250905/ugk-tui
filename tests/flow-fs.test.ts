import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRecord, readJsonOptional, readJsonRecord, readJsonStrict } from "../extensions/flow/flow-fs.ts";

function tempFile(content: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "flow-fs-"));
	const filePath = path.join(dir, "data.json");
	writeFileSync(filePath, content);
	return filePath;
}

test("isRecord accepts plain objects and rejects arrays/null/primitives", () => {
	assert.equal(isRecord({}), true);
	assert.equal(isRecord({ a: 1 }), true);
	assert.equal(isRecord([]), false);
	assert.equal(isRecord(null), false);
	assert.equal(isRecord(undefined), false);
	assert.equal(isRecord("x"), false);
	assert.equal(isRecord(0), false);
});

test("readJsonStrict parses valid JSON and throws on malformed JSON", () => {
	const valid = tempFile('{"a":1}');
	assert.deepEqual(readJsonStrict(valid), { a: 1 });

	const malformed = tempFile("{ not json");
	assert.throws(() => readJsonStrict(malformed), /JSON/);
});

test("readJsonOptional returns undefined for missing files and malformed JSON", () => {
	const valid = tempFile('{"a":1}');
	assert.deepEqual(readJsonOptional(valid), { a: 1 });

	const malformed = tempFile("{ not json");
	assert.equal(readJsonOptional(malformed), undefined);

	const missing = path.join(tempFile('{"a":1}'), "..", "does-not-exist.json");
	assert.equal(readJsonOptional(missing), undefined);
});

test("readJsonRecord returns the object for valid records and undefined otherwise", () => {
	const valid = tempFile('{"a":1}');
	const parsed = readJsonRecord(valid);
	assert.deepEqual(parsed, { a: 1 });
	assert.equal(isRecord(parsed), true);

	const arrayFile = tempFile("[1,2,3]");
	assert.equal(readJsonRecord(arrayFile), undefined);

	const malformed = tempFile("{ not json");
	assert.equal(readJsonRecord(malformed), undefined);
});
