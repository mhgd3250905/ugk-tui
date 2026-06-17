import test from "node:test";
import assert from "node:assert/strict";
import { installUgkSessionViewPatch } from "../bin/ugk-session-view-patch.js";

function createSession(name) {
	return {
		name,
		agent: { name: `${name}-agent` },
		sessionManager: { name: `${name}-manager` },
		subscribe: () => () => {},
	};
}

test("session view patch switches visible session and restores main on detach command", async () => {
	class FakeInteractiveMode {
		constructor(mainSession) {
			this.runtimeHost = { session: mainSession };
			this.calls = [];
			this.submitted = [];
			this.editor = {
				setText: (text) => {
					this.editorText = text;
				},
			};
			this.defaultEditor = {
				onSubmit: async (text) => {
					this.submitted.push(`${this.session.name}:${text}`);
				},
			};
			this.ui = {
				requestRender: () => {
					this.calls.push("requestRender");
				},
			};
		}

		get session() {
			return this.runtimeHost.session;
		}

		get agent() {
			return this.session.agent;
		}

		get sessionManager() {
			return this.session.sessionManager;
		}

		createExtensionUIContext() {
			return {
				notify: () => {},
			};
		}

		applyRuntimeSettings() {
			this.calls.push(`apply:${this.session.name}`);
		}

		subscribeToAgent() {
			const sessionName = this.session.name;
			this.calls.push(`subscribe:${sessionName}`);
			this.unsubscribe = () => {
				this.calls.push(`unsubscribe:${sessionName}`);
			};
		}

		renderCurrentSessionState() {
			this.calls.push(`render:${this.session.name}`);
		}

		setupAutocompleteProvider() {
			this.calls.push(`autocomplete:${this.session.name}`);
		}
	}

	installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode });
	const mainSession = createSession("main");
	const driverSession = createSession("driver");
	const mode = new FakeInteractiveMode(mainSession);
	mode.subscribeToAgent();
	const ui = mode.createExtensionUIContext();
	let detached = 0;

	assert.equal(ui.attachSessionView("flow-driver", driverSession, {
		detachCommand: "/flow detach",
		onDetach: () => {
			detached += 1;
		},
	}), true);
	assert.equal(mode.session, driverSession);
	assert.equal(mode.agent, driverSession.agent);
	assert.equal(mode.sessionManager, driverSession.sessionManager);

	await mode.defaultEditor.onSubmit("继续执行");
	assert.deepEqual(mode.submitted, ["driver:继续执行"]);

	await mode.defaultEditor.onSubmit(" /flow detach ");

	assert.equal(detached, 1);
	assert.equal(mode.session, mainSession);
	assert.equal(mode.editorText, "");
	assert.deepEqual(mode.submitted, ["driver:继续执行"]);
	assert.ok(mode.calls.includes("unsubscribe:main"));
	assert.ok(mode.calls.includes("subscribe:driver"));
	assert.ok(mode.calls.includes("unsubscribe:driver"));
	assert.ok(mode.calls.includes("subscribe:main"));
});

test("session view patch is idempotent", () => {
	class FakeInteractiveMode {
		get session() {
			return this.runtimeHost.session;
		}

		get agent() {
			return this.session.agent;
		}

		get sessionManager() {
			return this.session.sessionManager;
		}

		createExtensionUIContext() {
			return {};
		}
	}

	assert.equal(installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode }), true);
	assert.equal(installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode }), false);
});
