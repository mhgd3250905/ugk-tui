import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	defaultAgentDir,
	findWorkspaceRoot,
	isWorkspaceTrusted,
	readTrustedWorkspaces,
} from "../bin/workspace-trust.js";
import { getDeepSeekAuthState } from "../bin/ugk-auth-status.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packageVersion() {
	return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}

export function diagnoseUgk(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const version = options.version ?? packageVersion();
	try {
		if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
	} catch {
		return { ok: false, status: "needs_setup", code: "WORKSPACE_NOT_FOUND", version, workspaceRoot: null, nextAction: "choose_existing_workspace" };
	}

	const workspaceRoot = findWorkspaceRoot(cwd);
	const agentDir = options.agentDir ?? defaultAgentDir();
	if (!isWorkspaceTrusted(workspaceRoot, readTrustedWorkspaces(agentDir))) {
		return { ok: false, status: "needs_approval", code: "WORKSPACE_UNTRUSTED", version, workspaceRoot, nextAction: "trust_workspace" };
	}
	const auth = getDeepSeekAuthState({
		env: options.env ?? process.env,
		authPath: path.join(agentDir, "auth.json"),
	});
	if (!auth.configured) {
		return { ok: false, status: "needs_setup", code: "MODEL_AUTH_MISSING", version, workspaceRoot, nextAction: "configure_model_auth" };
	}
	return { ok: true, status: "ready", code: "READY", version, workspaceRoot, nextAction: "start" };
}
