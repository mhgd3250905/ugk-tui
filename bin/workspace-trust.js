import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const TRUST_STATE_FILE = "trusted-workspaces.json";
const PROJECT_MARKERS = [".git", "AGENTS.md", "CLAUDE.md", "package.json"];

export function defaultAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function trustStatePath(agentDir = defaultAgentDir()) {
	return path.join(agentDir, TRUST_STATE_FILE);
}

export function normalizeWorkspacePath(workspacePath) {
	return path.resolve(workspacePath);
}

export function findWorkspaceRoot(cwd = process.cwd()) {
	let current = normalizeWorkspacePath(cwd);
	while (true) {
		for (const marker of PROJECT_MARKERS) {
			if (fs.existsSync(path.join(current, marker))) return current;
		}

		const parent = path.dirname(current);
		if (parent === current) return normalizeWorkspacePath(cwd);
		current = parent;
	}
}

export function readTrustedWorkspaces(agentDir = defaultAgentDir()) {
	try {
		const parsed = JSON.parse(fs.readFileSync(trustStatePath(agentDir), "utf8"));
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		// Missing or invalid trust state means nothing is trusted yet.
	}
	return { version: 1, workspaces: {} };
}

export function writeTrustedWorkspaces(state, agentDir = defaultAgentDir()) {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(trustStatePath(agentDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function isWorkspaceTrusted(workspaceRoot, state = readTrustedWorkspaces()) {
	const normalized = normalizeWorkspacePath(workspaceRoot);
	if (Array.isArray(state.workspaces)) {
		return state.workspaces.map(normalizeWorkspacePath).includes(normalized);
	}
	return Boolean(state.workspaces?.[normalized]);
}

export function trustWorkspace(workspaceRoot, agentDir = defaultAgentDir(), now = new Date()) {
	const normalized = normalizeWorkspacePath(workspaceRoot);
	const current = readTrustedWorkspaces(agentDir);
	const workspaces = Array.isArray(current.workspaces)
		? Object.fromEntries(current.workspaces.map((entry) => [normalizeWorkspacePath(entry), { trustedAt: now.toISOString() }]))
		: { ...(current.workspaces || {}) };

	workspaces[normalized] = {
		trustedAt: now.toISOString(),
	};

	writeTrustedWorkspaces({ version: 1, workspaces }, agentDir);
}

export function shouldBypassWorkspaceTrust(args = process.argv.slice(2), env = process.env) {
	if (env.UGK_SKIP_WORKSPACE_TRUST === "1") return true;
	return args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v");
}

export async function promptWorkspaceTrust(workspaceRoot, input = process.stdin, output = process.stdout) {
	output.write(
		[
			"",
			"Quick safety check: Is this a project you created or one you trust?",
			"",
			"UGK will be able to read, edit, and execute files in this folder.",
			"",
			`Folder: ${workspaceRoot}`,
			"",
			"  1. Yes, I trust this folder",
			"  2. No, exit",
			"",
		].join("\n"),
	);

	const rl = readline.createInterface({ input, output });
	try {
		const answer = (await rl.question("Select 1 or 2 [1]: ")).trim().toLowerCase();
		return answer === "" || answer === "1" || answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

export async function ensureWorkspaceTrusted(options = {}) {
	const cwd = options.cwd || process.cwd();
	const args = options.args || process.argv.slice(2);
	const env = options.env || process.env;
	const agentDir = options.agentDir || defaultAgentDir();
	const workspaceRoot = findWorkspaceRoot(cwd);

	if (shouldBypassWorkspaceTrust(args, env)) {
		return { trusted: true, workspaceRoot, bypassed: true };
	}

	const state = readTrustedWorkspaces(agentDir);
	if (isWorkspaceTrusted(workspaceRoot, state)) {
		return { trusted: true, workspaceRoot };
	}

	const detectedInteractive =
		Boolean(options.stdin?.isTTY ?? process.stdin.isTTY) && Boolean(options.stdout?.isTTY ?? process.stdout.isTTY);
	const isInteractive = options.isInteractive ?? detectedInteractive;
	if (!isInteractive) {
		return {
			trusted: false,
			workspaceRoot,
			reason: `Workspace requires trust before UGK can run: ${workspaceRoot}`,
		};
	}

	const promptTrust = options.promptTrust || ((root) => promptWorkspaceTrust(root, options.stdin, options.stdout));
	const approved = await promptTrust(workspaceRoot);
	if (!approved) {
		return {
			trusted: false,
			workspaceRoot,
			reason: "Workspace trust declined.",
		};
	}

	trustWorkspace(workspaceRoot, agentDir, (options.now || (() => new Date()))());
	return { trusted: true, workspaceRoot };
}
