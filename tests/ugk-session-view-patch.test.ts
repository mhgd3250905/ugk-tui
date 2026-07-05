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

	assert.equal(ui.attachSessionView("driver-view", driverSession, {
		detachCommand: "/driver detach",
		onDetach: () => {
			detached += 1;
		},
	}), true);
	assert.equal(mode.session, driverSession);
	assert.equal(mode.agent, driverSession.agent);
	assert.equal(mode.sessionManager, driverSession.sessionManager);

	await mode.defaultEditor.onSubmit("继续执行");
	assert.deepEqual(mode.submitted, ["driver:继续执行"]);

	await mode.defaultEditor.onSubmit(" /driver detach ");

	assert.equal(detached, 1);
	assert.equal(mode.session, mainSession);
	assert.equal(mode.editorText, "");
	assert.deepEqual(mode.submitted, ["driver:继续执行"]);
	assert.ok(mode.calls.includes("unsubscribe:main"));
	assert.ok(mode.calls.includes("subscribe:driver"));
	assert.ok(mode.calls.includes("unsubscribe:driver"));
	assert.ok(mode.calls.includes("subscribe:main"));
});

test("session switcher renders below editor and handles empty-editor navigation", async () => {
	class FakeInteractiveMode {
		constructor(mainSession) {
			this.runtimeHost = { session: mainSession };
			this.calls = [];
			this.selected = [];
			this.editorText = "";
			this.editor = {
				getText: () => this.editorText,
				setText: (text) => {
					this.editorText = text;
				},
			};
			this.defaultEditor = {
				onExtensionShortcut: (data) => {
					this.calls.push(`previous:${data}`);
					return false;
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
			return {};
		}

		setExtensionWidget(key, content, options) {
			this.widgetKey = key;
			this.widgetOptions = options;
			this.widget = content?.(this.ui, {
				fg: (_name, text) => text,
				bold: (text) => text,
			});
		}
	}

	installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode });
	const mode = new FakeInteractiveMode(createSession("main"));
	const ui = mode.createExtensionUIContext();

	assert.equal(ui.setSessionSwitcher("driver-view", {
		title: "Driver sessions",
		items: [
			{ id: "main", label: "main", description: "main agent", active: true },
			{ id: "x/run-001", label: "x/run-001", description: "running" },
		],
		onSelect: async (id) => {
			mode.selected.push(id);
		},
	}), true);

	assert.equal(mode.widgetKey, "ugk-session-switcher");
	assert.deepEqual(mode.widgetOptions, { placement: "belowEditor" });
	assert.match(mode.widget.render(80).join("\n"), /Driver sessions/);

	assert.equal(mode.defaultEditor.onExtensionShortcut("\x1b[B"), true);
	assert.match(mode.widget.render(80).join("\n"), /> x\/run-001/);
	assert.equal(mode.defaultEditor.onExtensionShortcut("\r"), true);
	await Promise.resolve();

	assert.deepEqual(mode.selected, ["x/run-001"]);
	assert.equal(mode.defaultEditor.onExtensionShortcut("\x1b[B"), true);
	assert.equal(mode.defaultEditor.onExtensionShortcut("\x1b"), true);

	mode.editorText = "draft";
	assert.equal(mode.defaultEditor.onExtensionShortcut("\x1b[B"), false);
	assert.deepEqual(mode.calls.filter((call) => call.startsWith("previous:")), ["previous:\x1b[B"]);
});

test("session switcher rewraps editor shortcuts after pi replaces them", () => {
	class FakeInteractiveMode {
		constructor(mainSession) {
			this.runtimeHost = { session: mainSession };
			this.editorText = "";
			this.editor = {
				getText: () => this.editorText,
			};
			this.defaultEditor = {
				onExtensionShortcut: () => false,
			};
			this.ui = {
				requestRender: () => {},
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
			return {};
		}

		setExtensionWidget() {}
	}

	installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode });
	const mode = new FakeInteractiveMode(createSession("main"));
	const ui = mode.createExtensionUIContext();

	ui.setSessionSwitcher("driver-view", {
		items: [{ id: "x/run-001", label: "x/run-001" }],
		onSelect: () => {},
	});
	mode.defaultEditor.onExtensionShortcut = () => false;
	ui.setSessionSwitcher("driver-view", {
		items: [{ id: "x/run-001", label: "x/run-001" }],
		onSelect: () => {},
	});

	assert.equal(mode.defaultEditor.onExtensionShortcut("\x1b[B"), true);
});

test("session view patch guards autocomplete providers without applyCompletion", () => {
	class FakeInteractiveMode {
		constructor(mainSession) {
			this.runtimeHost = { session: mainSession };
			this.defaultEditor = {
				provider: undefined,
				setAutocompleteProvider(provider) {
					this.provider = provider;
				},
			};
			this.editor = this.defaultEditor;
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
			return {};
		}

		setupAutocompleteProvider() {
			this.autocompleteProvider = {
				async getSuggestions() {
					return { items: [{ value: "new", label: "new" }], prefix: "/ne" };
				},
			};
			this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
		}
	}

	installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode });
	const mode = new FakeInteractiveMode(createSession("main"));

	mode.setupAutocompleteProvider();

	assert.equal(typeof mode.autocompleteProvider.applyCompletion, "function");
	assert.deepEqual(
		mode.autocompleteProvider.applyCompletion(["/ne"], 0, 3, { value: "new", label: "new" }, "/ne"),
		{ lines: ["/new "], cursorLine: 0, cursorCol: 5 },
	);
	assert.deepEqual(
		mode.autocompleteProvider.applyCompletion(["read @sr"], 0, 8, { value: "@src/", label: "@src/" }, "@sr"),
		{ lines: ["read @src/"], cursorLine: 0, cursorCol: 10 },
	);
	assert.deepEqual(
		mode.autocompleteProvider.applyCompletion(["/task run sm"], 0, 12, { value: "smoke", label: "smoke" }, "sm"),
		{ lines: ["/task run smoke"], cursorLine: 0, cursorCol: 15 },
	);
	assert.equal(mode.defaultEditor.provider, mode.autocompleteProvider);
});

test("session view patch shows loading status while /new creates a session", async () => {
	class FakeInteractiveMode {
		constructor(mainSession) {
			this.runtimeHost = {
				session: mainSession,
				newSession: async () => {
					this.calls.push("newSession");
					return { cancelled: false };
				},
			};
			this.calls = [];
			this.statusContainer = {
				clear: () => {
					this.calls.push("status:clear");
				},
			};
			this.chatContainer = {
				children: [],
				addChild: (child) => {
					this.chatContainer.children.push(child);
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
			return {};
		}

		showStatus(message) {
			const children = this.chatContainer.children;
			const last = children.length > 0 ? children[children.length - 1] : undefined;
			const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
			if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
				this.lastStatusText.message = message;
				this.calls.push(`status:${message}`);
				return;
			}
			const spacer = { kind: "spacer" };
			const text = { kind: "text", message };
			this.chatContainer.addChild(spacer);
			this.chatContainer.addChild(text);
			this.lastStatusSpacer = spacer;
			this.lastStatusText = text;
			this.calls.push(`status:${message}`);
		}

		renderCurrentSessionState() {
			this.calls.push("render");
		}

		async handleClearCommand() {
			this.statusContainer.clear();
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) return;
			this.renderCurrentSessionState();
			this.chatContainer.addChild({});
			this.ui.requestRender();
		}
	}

	installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode });
	const mode = new FakeInteractiveMode(createSession("main"));

	await mode.handleClearCommand();

	const loadingIndex = mode.calls.findIndex((call) => /正在创建新会话.*加载扩展资源.*重连 MCP/.test(call));
	assert.ok(loadingIndex > mode.calls.indexOf("status:clear"));
	assert.ok(loadingIndex < mode.calls.indexOf("newSession"));
	assert.ok(mode.calls.lastIndexOf("status:clear") > mode.calls.indexOf("newSession"));
	assert.equal(mode.chatContainer.children.some((child) => /正在创建新会话/.test(child.message ?? "")), false);
});

test("session view patch shows loading status while rebinding the current session", async () => {
	class FakeInteractiveMode {
		constructor(mainSession) {
			this.runtimeHost = { session: mainSession };
			this.calls = [];
			this.ui = {
				requestRender: () => {
					this.calls.push("requestRender");
				},
			};
			this.statusContainer = {
				clear: () => {
					this.calls.push("status:clear");
				},
			};
			this.chatContainer = {
				children: [],
				addChild: (child) => {
					this.chatContainer.children.push(child);
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
			return {};
		}

		showStatus(message) {
			const spacer = { kind: "spacer" };
			const text = { kind: "text", message };
			this.chatContainer.addChild(spacer);
			this.chatContainer.addChild(text);
			this.lastStatusSpacer = spacer;
			this.lastStatusText = text;
			this.calls.push(`status:${message}`);
		}

		async rebindCurrentSession() {
			this.calls.push("rebind");
		}
	}

	installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode });
	const mode = new FakeInteractiveMode(createSession("main"));

	await mode.rebindCurrentSession();

	const loadingIndex = mode.calls.findIndex((call) => /正在加载会话.*初始化扩展资源.*连接 MCP/.test(call));
	assert.ok(loadingIndex >= 0);
	assert.ok(loadingIndex < mode.calls.indexOf("rebind"));
	assert.ok(mode.calls.indexOf("status:clear") > mode.calls.indexOf("rebind"));
	assert.equal(mode.chatContainer.children.some((child) => /正在加载会话/.test(child.message ?? "")), false);
});

test("session view patch keeps a later status while clearing loading", async () => {
	class FakeInteractiveMode {
		constructor(mainSession) {
			this.runtimeHost = { session: mainSession };
			this.calls = [];
			this.ui = {
				requestRender: () => {
					this.calls.push("requestRender");
				},
			};
			this.statusContainer = {
				clear: () => {
					this.calls.push("status:clear");
				},
			};
			this.chatContainer = {
				children: [],
				addChild: (child) => {
					this.chatContainer.children.push(child);
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
			return {};
		}

		showStatus(message) {
			const children = this.chatContainer.children;
			const last = children.length > 0 ? children[children.length - 1] : undefined;
			const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
			if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
				this.lastStatusText.message = message;
				this.calls.push(`status:${message}`);
				return;
			}
			const spacer = { kind: "spacer" };
			const text = { kind: "text", message };
			this.chatContainer.addChild(spacer);
			this.chatContainer.addChild(text);
			this.lastStatusSpacer = spacer;
			this.lastStatusText = text;
			this.calls.push(`status:${message}`);
		}

		async rebindCurrentSession() {
			this.showStatus("MCP server failed");
			this.calls.push("rebind");
		}
	}

	installUgkSessionViewPatch({ InteractiveMode: FakeInteractiveMode });
	const mode = new FakeInteractiveMode(createSession("main"));

	await mode.rebindCurrentSession();

	assert.equal(mode.calls.includes("status:clear"), false);
	assert.ok(mode.calls.indexOf("status:MCP server failed") < mode.calls.indexOf("rebind"));
	assert.equal(mode.chatContainer.children.some((child) => child.message === "MCP server failed"), true);
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
