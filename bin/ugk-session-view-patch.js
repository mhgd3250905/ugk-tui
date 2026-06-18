import { matchesKey } from "@earendil-works/pi-tui";

const PATCHED = Symbol.for("ugk.sessionViewPatch.installed");
const ACTIVE_VIEW = Symbol.for("ugk.sessionViewPatch.activeView");
const SESSION_SWITCHER = Symbol.for("ugk.sessionViewPatch.sessionSwitcher");
const SESSION_SWITCHER_SHORTCUT = Symbol.for("ugk.sessionViewPatch.sessionSwitcherShortcut");
const SESSION_SWITCHER_WIDGET_KEY = "ugk-session-switcher";

function getEditorText(mode) {
	const text = mode.editor?.getText?.() ?? mode.defaultEditor?.getText?.() ?? "";
	return typeof text === "string" ? text : "";
}

function getActiveSwitcherIndex(items) {
	return items.findIndex((item) => item?.active);
}

function clampSwitcherIndex(index, items) {
	if (items.length === 0) {
		return 0;
	}
	return Math.max(0, Math.min(index, items.length - 1));
}

function setSwitcherSelectedFromEditor(state, direction) {
	const activeIndex = getActiveSwitcherIndex(state.items);
	if (direction > 0) {
		state.selectedIndex = activeIndex >= 0 ? (activeIndex + 1) % state.items.length : 0;
		return;
	}
	state.selectedIndex = activeIndex >= 0
		? (activeIndex - 1 + state.items.length) % state.items.length
		: state.items.length - 1;
}

function renderSessionSwitcher(state, width) {
	const lines = [];
	if (state.title) {
		lines.push(state.title);
	}
	for (let index = 0; index < state.items.length; index += 1) {
		const item = state.items[index];
		const selector = state.active && index === state.selectedIndex ? "> " : "  ";
		const active = item.active ? "* " : "";
		const description = item.description ? `  ${item.description}` : "";
		const line = `${selector}${active}${item.label}${description}`;
		lines.push(width > 0 && line.length > width ? line.slice(0, width) : line);
	}
	if (state.active) {
		const hint = "  Up/Down select, Enter switch, Esc cancel";
		lines.push(width > 0 && hint.length > width ? hint.slice(0, width) : hint);
	}
	return lines;
}

function setSessionSwitcherWidget(mode, state) {
	if (typeof mode.setExtensionWidget !== "function") {
		return false;
	}
	mode.setExtensionWidget(
		SESSION_SWITCHER_WIDGET_KEY,
		state
			? () => ({
				render: (width) => renderSessionSwitcher(state, width),
			})
			: undefined,
		{ placement: "belowEditor" },
	);
	return true;
}

function handleSessionSwitcherInput(mode, data) {
	const state = mode[SESSION_SWITCHER];
	if (!state || state.items.length === 0) {
		return false;
	}
	const isUp = matchesKey(data, "up");
	const isDown = matchesKey(data, "down");
	const isEnter = matchesKey(data, "enter");
	const isEscape = matchesKey(data, "escape") || matchesKey(data, "esc");

	if (!state.active) {
		if (!isUp && !isDown) {
			return false;
		}
		if (getEditorText(mode).trim()) {
			return false;
		}
		state.active = true;
		setSwitcherSelectedFromEditor(state, isDown ? 1 : -1);
		mode.ui?.requestRender?.();
		return true;
	}

	if (isUp || isDown) {
		const direction = isDown ? 1 : -1;
		state.selectedIndex = (state.selectedIndex + direction + state.items.length) % state.items.length;
		mode.ui?.requestRender?.();
		return true;
	}
	if (isEscape) {
		state.active = false;
		mode.ui?.requestRender?.();
		return true;
	}
	if (isEnter) {
		const selected = state.items[clampSwitcherIndex(state.selectedIndex, state.items)];
		state.active = false;
		mode.ui?.requestRender?.();
		if (selected) {
			Promise.resolve(state.onSelect(selected.id, selected)).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				mode.showStatus?.(`Session switch failed: ${message}`);
			});
		}
		return true;
	}

	state.active = false;
	mode.ui?.requestRender?.();
	return false;
}

function installSessionSwitcherShortcut(mode) {
	if (!mode.defaultEditor || mode.defaultEditor.onExtensionShortcut?.[SESSION_SWITCHER_SHORTCUT]) {
		return;
	}
	const previousShortcut = mode.defaultEditor.onExtensionShortcut;
	const shortcut = (data) => {
		if (handleSessionSwitcherInput(mode, data)) {
			return true;
		}
		return previousShortcut?.(data) ?? false;
	};
	Object.defineProperty(shortcut, SESSION_SWITCHER_SHORTCUT, {
		configurable: false,
		value: true,
	});
	mode.defaultEditor.onExtensionShortcut = shortcut;
}

function clearActiveSessionView(mode, options = {}) {
	const active = mode[ACTIVE_VIEW];
	if (!active) {
		return false;
	}

	active.unsubscribe?.();
	mode.unsubscribe = undefined;
	if (active.previousSubmit) {
		mode.defaultEditor.onSubmit = active.previousSubmit;
	}
	mode[ACTIVE_VIEW] = undefined;

	if (options.rebind !== false) {
		mode.applyRuntimeSettings?.();
		mode.subscribeToAgent?.();
		mode.renderCurrentSessionState?.();
		mode.setupAutocompleteProvider?.();
		mode.ui?.requestRender?.();
	}
	return true;
}

export function installUgkSessionViewPatch({ InteractiveMode } = {}) {
	const proto = InteractiveMode?.prototype;
	if (!proto || proto[PATCHED]) {
		return false;
	}

	const sessionDescriptor = Object.getOwnPropertyDescriptor(proto, "session");
	const agentDescriptor = Object.getOwnPropertyDescriptor(proto, "agent");
	const sessionManagerDescriptor = Object.getOwnPropertyDescriptor(proto, "sessionManager");
	const originalCreateExtensionUIContext = proto.createExtensionUIContext;
	const originalSetupExtensionShortcuts = proto.setupExtensionShortcuts;
	if (
		typeof sessionDescriptor?.get !== "function" ||
		typeof agentDescriptor?.get !== "function" ||
		typeof sessionManagerDescriptor?.get !== "function" ||
		typeof originalCreateExtensionUIContext !== "function"
	) {
		return false;
	}

	Object.defineProperty(proto, "session", {
		configurable: true,
		get() {
			return this[ACTIVE_VIEW]?.session ?? sessionDescriptor.get.call(this);
		},
	});
	Object.defineProperty(proto, "agent", {
		configurable: true,
		get() {
			return this.session.agent;
		},
	});
	Object.defineProperty(proto, "sessionManager", {
		configurable: true,
		get() {
			return this.session.sessionManager;
		},
	});

	if (typeof originalSetupExtensionShortcuts === "function") {
		proto.setupExtensionShortcuts = function setupUgkExtensionShortcuts(...args) {
			const result = originalSetupExtensionShortcuts.apply(this, args);
			installSessionSwitcherShortcut(this);
			return result;
		};
	}

	proto.createExtensionUIContext = function createUgkExtensionUIContext() {
		const ui = originalCreateExtensionUIContext.call(this);
		return {
			...ui,
			attachSessionView: (owner, session, options = {}) => {
				if (!owner || !session || typeof session.subscribe !== "function") {
					return false;
				}

				clearActiveSessionView(this, { rebind: false });

				const previousSubmit = this.defaultEditor?.onSubmit;
				this.unsubscribe?.();
				this.unsubscribe = undefined;
				this[ACTIVE_VIEW] = {
					owner,
					session,
					previousSubmit,
				};

				if (this.defaultEditor && previousSubmit && options.detachCommand) {
					this.defaultEditor.onSubmit = async (text) => {
						const trimmed = typeof text === "string" ? text.trim() : "";
						if (trimmed === options.detachCommand) {
							this.editor?.setText?.("");
							clearActiveSessionView(this);
							await options.onDetach?.();
							return;
						}
						return previousSubmit(text);
					};
				}

				this.applyRuntimeSettings?.();
				this.subscribeToAgent?.();
				if (this[ACTIVE_VIEW]) {
					this[ACTIVE_VIEW].unsubscribe = this.unsubscribe;
				}
				this.renderCurrentSessionState?.();
				this.setupAutocompleteProvider?.();
				if (options.label) {
					this.showStatus?.(options.label);
				}
				this.ui?.requestRender?.();
				return true;
			},
			detachSessionView: (owner) => {
				const active = this[ACTIVE_VIEW];
				if (!active || active.owner !== owner) {
					return false;
				}
				return clearActiveSessionView(this);
			},
			getActiveSessionView: () => {
				const active = this[ACTIVE_VIEW];
				return active ? { owner: active.owner, session: active.session } : undefined;
			},
			setSessionSwitcher: (owner, options) => {
				if (!owner) {
					return false;
				}
				const activeSwitcher = this[SESSION_SWITCHER];
				if (!options) {
					if (activeSwitcher?.owner !== owner) {
						return false;
					}
					this[SESSION_SWITCHER] = undefined;
					return setSessionSwitcherWidget(this, undefined);
				}

				const items = Array.isArray(options.items)
					? options.items.filter((item) => item?.id && item?.label)
					: [];
				if (items.length === 0) {
					this[SESSION_SWITCHER] = undefined;
					return setSessionSwitcherWidget(this, undefined);
				}

				this[SESSION_SWITCHER] = {
					owner,
					title: options.title,
					items,
					onSelect: typeof options.onSelect === "function" ? options.onSelect : () => {},
					active: false,
					selectedIndex: Math.max(0, getActiveSwitcherIndex(items)),
				};
				installSessionSwitcherShortcut(this);
				return setSessionSwitcherWidget(this, this[SESSION_SWITCHER]);
			},
		};
	};

	Object.defineProperty(proto, PATCHED, {
		configurable: false,
		value: true,
	});
	return true;
}
