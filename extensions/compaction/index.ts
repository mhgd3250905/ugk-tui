import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCustomCompact from "./custom-compact.ts";
import registerModelPicker from "./model-picker.ts";
import registerTrigger from "./trigger.ts";

export default function registerCompaction(pi: ExtensionAPI): void {
	registerTrigger(pi);
	registerCustomCompact(pi);
	registerModelPicker(pi);
}
