import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";

const failures = [];
function check(assertion, fn) {
	try {
		fn();
	} catch (error) {
		failures.push({
			assertion,
			expected: "pass",
			actual: error instanceof Error ? error.message : String(error),
		});
	}
}

const outputDir = process.env.TASK_OUTPUT_DIR;
const input = JSON.parse(process.env.TASK_INPUT || "{}");
const resultPath = path.join(outputDir || "", "result.json");
const raw = await readFile(resultPath, "utf8").catch((error) => {
	failures.push({ assertion: "result.json exists", expected: resultPath, actual: error.message });
	return "{}";
});
const result = JSON.parse(raw);
const text = String(input.text ?? "");
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const expected = [...segmenter.segment(text)].length;

check("input is preserved", () => assert.equal(result.input, text));
check("graphemes matches Intl.Segmenter", () => assert.equal(result.graphemes, expected));

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
