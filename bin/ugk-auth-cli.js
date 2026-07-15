import fs from "node:fs";
import path from "node:path";
import { resolveAuthPath } from "./ugk-auth-status.js";

const MODELS_URL = "https://api.deepseek.com/models";

export async function importDeepSeekAuth(options) {
	const { filePath } = options;
	if (!filePath || !fs.statSync(filePath).isFile()) throw new Error("--file 必须指向存在的普通文件。");
	const key = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
	if (!key.startsWith("sk-")) throw new Error("DeepSeek key 格式无效。");
	const response = await (options.fetchImpl ?? fetch)(MODELS_URL, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
	});
	if (!response.ok) {
		throw new Error(`DeepSeek key 验证失败 (HTTP ${response.status})。`);
	}

	const authPath = options.authPath ?? resolveAuthPath(options);
	let auth = {};
	if (fs.existsSync(authPath)) {
		const parsed = JSON.parse(fs.readFileSync(authPath, "utf8").replace(/^\uFEFF/, ""));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) auth = parsed;
	}
	auth.deepseek = { type: "api_key", key };
	fs.mkdirSync(path.dirname(authPath), { recursive: true });
	fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		(options.chmod ?? fs.chmodSync)(authPath, 0o600);
	} catch {
		// Windows may not support chmod.
	}
	return { ok: true, provider: "deepseek", source: "file", configured: true };
}

export function isAuthCliCommand(args) {
	return args[0] === "auth";
}

export async function runAuthCli(args, deps = {}) {
	const providerIndex = args.indexOf("--provider");
	const fileIndex = args.indexOf("--file");
	if (args[1] !== "import" || args[providerIndex + 1] !== "deepseek" || !args[fileIndex + 1]) {
		deps.stderr?.write?.("用法: ugk auth import --provider deepseek --file <path>\n");
		return 2;
	}
	try {
		const result = await importDeepSeekAuth({ ...deps, filePath: args[fileIndex + 1] });
		deps.stdout?.write?.(`${JSON.stringify(result)}\n`);
		return 0;
	} catch (error) {
		deps.stderr?.write?.(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
		return 1;
	}
}
