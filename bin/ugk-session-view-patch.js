const PATCHED = Symbol.for("ugk.sessionViewPatch.installed");
const ACTIVE_VIEW = Symbol.for("ugk.sessionViewPatch.activeView");

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
		};
	};

	Object.defineProperty(proto, PATCHED, {
		configurable: false,
		value: true,
	});
	return true;
}
