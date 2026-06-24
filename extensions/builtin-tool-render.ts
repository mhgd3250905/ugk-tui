import {
	createBashTool,
	createEditTool,
	type BashToolDetails,
	type EditToolDetails,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function registerBuiltinToolRenderers(pi: ExtensionAPI): void {
	const bashTool = createBashTool(process.cwd());
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bashTool.description,
		parameters: bashTool.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createBashTool(ctx?.cwd ?? process.cwd()).execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("$ "));
			const command = args.command.length > 80 ? `${args.command.slice(0, 77)}...` : args.command;
			text += theme.fg("accent", command);
			if (args.timeout) text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";
			const exitMatch = output.match(/exited with code (\d+)/);
			const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : result.isError ? 1 : null;
			const outputLines = output.split("\n");
			const lineCount = outputLines.filter((line) => line.trim()).length;

			let text = exitCode === null
				? theme.fg("success", "done")
				: theme.fg("error", `exit ${exitCode}`);
			text += theme.fg("dim", ` (${lineCount} lines)`);
			if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");

			if (expanded) {
				for (const line of outputLines.slice(0, 20)) text += `\n${theme.fg("dim", line)}`;
				if (outputLines.length > 20) text += `\n${theme.fg("muted", "... more output")}`;
			}

			return new Text(text, 0, 0);
		},
	});

	const editTool = createEditTool(process.cwd());
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: editTool.description,
		parameters: editTool.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createEditTool(ctx?.cwd ?? process.cwd()).execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}
			if (!details?.diff) return new Text(theme.fg("success", "Applied"), 0, 0);

			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);

			if (expanded) {
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) text += `\n${theme.fg("success", line)}`;
					else if (line.startsWith("-") && !line.startsWith("---")) text += `\n${theme.fg("error", line)}`;
					else text += `\n${theme.fg("dim", line)}`;
				}
				if (diffLines.length > 30) {
					text += `\n${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
