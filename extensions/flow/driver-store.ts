import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowDriverStatus, FlowDriverSummary } from "./types.ts";

export interface FlowDriverStatusFile {
	taskId: string;
	runId: string;
	status: FlowDriverStatus;
	step?: string;
	summary?: string;
	updatedAt: string;
	sessionFile?: string;
}

export interface CreatedRunArtifacts {
	taskId: string;
	runId: string;
	taskDir: string;
	runDir: string;
}

type WritableDriverStatus = Omit<FlowDriverStatusFile, "updatedAt"> & { updatedAt?: string };

const DRIVER_STATUSES: FlowDriverStatus[] = [
	"starting",
	"running",
	"waiting",
	"waiting-for-user",
	"needs-human",
	"validating",
	"done",
	"failed",
	"paused",
];

const SUMMARY_STATUS_ORDER: FlowDriverStatus[] = [
	"starting",
	"running",
	"waiting",
	"waiting-for-user",
	"needs-human",
	"validating",
	"failed",
	"paused",
	"done",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDriverStatus(value: unknown): value is FlowDriverStatus {
	return typeof value === "string" && DRIVER_STATUSES.includes(value as FlowDriverStatus);
}

function inferTaskId(runDir: string): string | undefined {
	const parts = path.normalize(runDir).split(path.sep);
	const runsIndex = parts.lastIndexOf("runs");
	if (runsIndex >= 2 && parts[runsIndex - 2] === "tasks") {
		return parts[runsIndex - 1];
	}
	return undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export async function readDriverStatus(runDir: string): Promise<FlowDriverStatusFile | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8"));
	} catch {
		return undefined;
	}

	if (!isRecord(parsed)) {
		return undefined;
	}

	const taskId = optionalString(parsed.taskId) ?? inferTaskId(runDir);
	const runId = optionalString(parsed.runId) ?? path.basename(runDir);
	if (!taskId || !runId) {
		return undefined;
	}

	return {
		taskId,
		runId,
		status: isDriverStatus(parsed.status) ? parsed.status : "paused",
		step: optionalString(parsed.step),
		summary: optionalString(parsed.summary),
		updatedAt: optionalString(parsed.updatedAt) ?? new Date(0).toISOString(),
		sessionFile: optionalString(parsed.sessionFile),
	};
}

export async function writeDriverStatus(runDir: string, status: WritableDriverStatus): Promise<void> {
	await mkdir(runDir, { recursive: true });
	const statusFile: FlowDriverStatusFile = {
		...status,
		updatedAt: status.updatedAt ?? new Date().toISOString(),
	};
	await writeFile(path.join(runDir, "status.json"), `${JSON.stringify(statusFile, null, "\t")}\n`);
}

export async function createRunArtifacts(
	cwd: string,
	taskId: string,
	input: string | undefined,
	runId: string,
): Promise<CreatedRunArtifacts> {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	const runDir = path.join(taskDir, "runs", runId);
	await mkdir(path.join(runDir, "output"), { recursive: true });
	await mkdir(path.join(runDir, "evidence"), { recursive: true });

	await writeFile(path.join(runDir, "input.json"), `${JSON.stringify({ input: input ?? "" }, null, "\t")}\n`);
	await writeFile(
		path.join(runDir, "prompt.md"),
		["# Driver Prompt", "", `Task: ${taskId}`, `Run: ${runId}`, `Input: ${input ?? ""}`, ""].join("\n"),
	);

	try {
		await copyFile(path.join(taskDir, "todo.template.md"), path.join(runDir, "todo.md"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		await writeFile(path.join(runDir, "todo.md"), "# Run Todo\n");
	}

	await writeFile(path.join(runDir, "progress.md"), "# Progress\n\nStatus: starting\n\n## Timeline\n");
	await writeFile(path.join(runDir, "feedback.md"), "# User Feedback\n\n");
	await writeDriverStatus(runDir, {
		taskId,
		runId,
		status: "starting",
		step: "not started",
		summary: "driver created",
	});

	return { taskId, runId, taskDir, runDir };
}

export async function appendDriverFeedback(
	runDir: string,
	feedback: { message: string; driverResponse: string; affectedStep?: string },
	now = new Date(),
): Promise<void> {
	const entry = [
		`## ${now.toISOString()}`,
		"",
		"focus: driver",
		`user message: ${feedback.message}`,
		`driver response: ${feedback.driverResponse}`,
		`affected step: ${feedback.affectedStep ?? "unknown"}`,
		"should review for skill update: unknown",
		"",
	].join("\n");
	await appendFile(path.join(runDir, "feedback.md"), entry);
}

export async function listDriverSummaries(cwd: string): Promise<FlowDriverSummary[]> {
	const tasksDir = path.join(cwd, ".flow", "tasks");
	let taskEntries;
	try {
		taskEntries = await readdir(tasksDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const summaries: FlowDriverSummary[] = [];
	for (const taskEntry of taskEntries) {
		if (!taskEntry.isDirectory()) {
			continue;
		}
		const runsDir = path.join(tasksDir, taskEntry.name, "runs");
		let runEntries;
		try {
			runEntries = await readdir(runsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const runEntry of runEntries) {
			if (!runEntry.isDirectory()) {
				continue;
			}
			const runDir = path.join(runsDir, runEntry.name);
			const status = await readDriverStatus(runDir);
			if (!status) {
				continue;
			}
			summaries.push({ ...status, runDir });
		}
	}

	return summaries.sort((left, right) => {
		const statusOrder = SUMMARY_STATUS_ORDER.indexOf(left.status) - SUMMARY_STATUS_ORDER.indexOf(right.status);
		if (statusOrder !== 0) {
			return statusOrder;
		}
		return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
	});
}

export async function findDriverSummary(cwd: string, runId: string): Promise<FlowDriverSummary | undefined> {
	return (await listDriverSummaries(cwd)).find((summary) => summary.runId === runId);
}
