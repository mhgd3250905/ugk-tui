import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function loadAuthCli(): Promise<any> {
	return import("../bin/ugk-auth-cli.js").catch(() => ({}));
}

test("imports a validated key without exposing it and preserves other providers", async () => {
	const { importDeepSeekAuth } = await loadAuthCli();
	assert.equal(typeof importDeepSeekAuth, "function");
	const dir = mkdtempSync(path.join(os.tmpdir(), "ugk-auth-import-"));
	const sourcePath = path.join(dir, "key.txt");
	const authPath = path.join(dir, "agent", "auth.json");
	const key = "sk-secret-value";
	try {
		writeFileSync(sourcePath, `\uFEFF ${key}\n`, "utf8");
		mkdirSync(path.dirname(authPath), { recursive: true });
		writeFileSync(authPath, `\uFEFF${JSON.stringify({ openai: { type: "api_key", key: "keep" } })}`, "utf8");

		const result = await importDeepSeekAuth({
			filePath: sourcePath,
			authPath,
			fetchImpl: async (_url: string, options: any) => {
				assert.equal(options.headers.Authorization, `Bearer ${key}`);
				assert.equal(options.signal instanceof AbortSignal, true);
				return { ok: true, status: 200 };
			},
			chmod: () => { throw new Error("unsupported"); },
		});

		assert.equal(result.ok, true);
		assert.doesNotMatch(JSON.stringify(result), /sk-secret-value/);
		assert.equal(existsSync(sourcePath), true);
		assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {
			openai: { type: "api_key", key: "keep" },
			deepseek: { type: "api_key", key },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rejects invalid keys and non-file inputs without writing auth", async () => {
	const { importDeepSeekAuth } = await loadAuthCli();
	assert.equal(typeof importDeepSeekAuth, "function");
	const dir = mkdtempSync(path.join(os.tmpdir(), "ugk-auth-reject-"));
	const sourcePath = path.join(dir, "key.txt");
	const authPath = path.join(dir, "auth.json");
	try {
		writeFileSync(sourcePath, "sk-invalid", "utf8");
		await assert.rejects(
			importDeepSeekAuth({ filePath: sourcePath, authPath, fetchImpl: async () => ({ ok: false, status: 401 }) }),
			/HTTP 401/,
		);
		assert.equal(existsSync(authPath), false);
		await assert.rejects(importDeepSeekAuth({ filePath: dir, authPath }), /普通文件/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("auth CLI output is masked", async () => {
	const { runAuthCli } = await loadAuthCli();
	assert.equal(typeof runAuthCli, "function");
	const dir = mkdtempSync(path.join(os.tmpdir(), "ugk-auth-output-"));
	const sourcePath = path.join(dir, "key.txt");
	const authPath = path.join(dir, "auth.json");
	const writes: string[] = [];
	try {
		writeFileSync(sourcePath, "sk-never-print", "utf8");
		const exitCode = await runAuthCli(
			["auth", "import", "--provider", "deepseek", "--file", sourcePath],
			{
				authPath,
				fetchImpl: async () => ({ ok: true, status: 200 }),
				stdout: { write: (text: string) => { writes.push(text); } },
				stderr: { write: (text: string) => { writes.push(text); } },
			},
		);

		assert.equal(exitCode, 0);
		assert.doesNotMatch(writes.join(""), /sk-never-print/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
