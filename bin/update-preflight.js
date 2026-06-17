import { createInterface } from "node:readline/promises";
import {
	applyUgkUpdate,
	detectUgkUpdate,
	getUgkUpdateCommandLabel,
	readUgkUpdateState,
	shouldCheckForUgkUpdate,
	shouldPromptForUgkUpdate,
	shortRef,
	writeUgkUpdateState,
} from "./update-core.js";

const HELP_ARGS = new Set(["-h", "--help", "-v", "--version"]);

export function shouldRunCliUpdatePreflight({
	argv = process.argv.slice(2),
	env = process.env,
	stdin = process.stdin,
	stdout = process.stdout,
} = {}) {
	if (env.UGK_SKIP_UPDATE_CHECK === "1") return false;
	if (!stdin?.isTTY || !stdout?.isTTY) return false;
	if (argv.some((arg) => HELP_ARGS.has(arg))) return false;
	if (argv.includes("--print")) return false;
	return true;
}

export function formatCliUpdatePrompt(info, commandLabel) {
	return [
		`✨ Update available! ${info.currentVersion} (${shortRef(info.currentRef)}) -> ${shortRef(info.latestRef)}`,
		"",
		"Release notes: https://github.com/mhgd3250905/ugk-tui/commits/main",
		"",
		`› 1. Update now (runs \`${commandLabel}\`)`,
		"  2. Skip",
		"  3. Skip until next version",
		"",
		"  Press enter to continue",
	].join("\n");
}

export async function promptCliUpdateChoice(input = process.stdin, output = process.stdout) {
	const rl = createInterface({ input, output });
	try {
		const answer = (await rl.question("")).trim().toLowerCase();
		if (!answer || answer === "1" || answer === "y" || answer === "yes") return "update";
		if (answer === "2" || answer === "s" || answer === "skip" || answer === "n" || answer === "no") {
			return "skip";
		}
		if (answer === "3") return "skip-until-next";
		return "skip";
	} finally {
		rl.close();
	}
}

export async function runUgkUpdatePreflight(options = {}) {
	const stdin = options.stdin || process.stdin;
	const stdout = options.stdout || process.stdout;
	const stderr = options.stderr || process.stderr;
	if (!options.force && !shouldRunCliUpdatePreflight({ argv: options.argv, env: options.env, stdin, stdout })) {
		return { action: "continue" };
	}

	const now = (options.now || (() => new Date()))();
	const readState = options.readState || (() => readUgkUpdateState(options.agentDir));
	const writeState = options.writeState || ((state) => writeUgkUpdateState(state, options.agentDir));
	const state = readState();

	if (!shouldCheckForUgkUpdate(state, now, options.force)) return { action: "continue" };

	const info = await (options.detectUpdate || (() => detectUgkUpdate(options)))();
	const checkedState = { ...state, lastCheckedAt: now.toISOString() };
	writeState(checkedState);
	if (!info || !shouldPromptForUgkUpdate(state, info, now)) return { action: "continue" };

	const commandLabel = (options.updateCommandLabel || (() => getUgkUpdateCommandLabel(options.packageRoot)))();
	stdout.write(`${formatCliUpdatePrompt(info, commandLabel)}\n`);

	const choice = await (options.selectUpdateChoice || (() => promptCliUpdateChoice(stdin, stdout)))();
	if (choice === "skip") {
		stdout.write("\nSkipping this UGK update for now.\n");
		return { action: "continue" };
	}
	if (choice === "skip-until-next") {
		writeState({
			...checkedState,
			skippedRef: info.latestRef,
			skippedAt: now.toISOString(),
		});
		stdout.write("\nSkipping this UGK update until the next version.\n");
		return { action: "continue" };
	}

	try {
		stdout.write(`\nUpdating UGK via \`${commandLabel}\`...\n`);
		const applyUpdate = options.applyUpdate || (() => applyUgkUpdate(options.packageRoot, { stdio: "inherit" }));
		await applyUpdate();
		stdout.write("\n🎉 Update ran successfully! Please restart UGK.\n");
		return { action: "exit", exitCode: 0 };
	} catch (error) {
		const message = error instanceof Error ? error.message : "UGK update failed.";
		stderr.write(`\nUGK update failed: ${message}\nContinuing with the current version.\n`);
		return { action: "continue" };
	}
}

