import test from "node:test";
import assert from "node:assert/strict";
import { getChromeLaunchCommand, getDefaultChromeProfilePath } from "../extensions/chrome-cdp/launcher.ts";

test("getDefaultChromeProfilePath uses dedicated ugk profile", () => {
	assert.match(getDefaultChromeProfilePath("/Users/demo"), /\/Users\/demo\/\.ugk\/chrome-cdp-profile$/);
});

test("getChromeLaunchCommand builds macOS Chrome command with local debugging port and profile", () => {
	const command = getChromeLaunchCommand({ port: 9222, homeDir: "/Users/demo", platform: "darwin" });

	assert.equal(command.command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.deepEqual(command.args, ["--remote-debugging-port=9222", "--user-data-dir=/Users/demo/.ugk/chrome-cdp-profile"]);
});
