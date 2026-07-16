<script lang="ts">
	import Icon from "$lib/ui/Icon.svelte";
	import SegControl from "$lib/ui/SegControl.svelte";
	import { settings } from "$lib/settings.svelte";
	import { isTauriEnv } from "$lib/session.svelte";

	let {
		open = false,
		onclose = () => {},
	}: {
		open?: boolean;
		onclose?: () => void;
	} = $props();

	// ── Fake pi session (dev tool) ────────────────────────────────────────────
	// Spawns extension/mock-server.mjs via a Tauri command and opens its browser
	// control panel. Desktop-only: the spawn + opener live in native code, and the
	// fake advertises itself through ~/.accordion which a plain browser can't read.
	let mockRunning = $state(false);
	let mockBusy = $state(false);
	let mockError = $state("");
	let mockPort = $state(4318);

	async function invoke<T>(cmd: string): Promise<T> {
		const { invoke } = await import("@tauri-apps/api/core");
		return invoke<T>(cmd);
	}
	async function openUrl(url: string): Promise<void> {
		const { openUrl } = await import("@tauri-apps/plugin-opener");
		await openUrl(url);
	}

	// Refresh the running state each time the panel opens, so Launch/Stop is accurate
	// even if the mock was started/stopped elsewhere.
	$effect(() => {
		if (!open || !isTauriEnv) return;
		invoke<boolean>("mock_session_running")
			.then((r) => (mockRunning = r))
			.catch(() => {});
	});

	async function launchMock() {
		mockBusy = true;
		mockError = "";
		try {
			mockPort = await invoke<number>("launch_mock_session");
			mockRunning = true;
			await openUrl(`http://localhost:${mockPort}`);
		} catch (e) {
			mockError = e instanceof Error ? e.message : String(e);
		} finally {
			mockBusy = false;
		}
	}
	async function stopMock() {
		mockBusy = true;
		mockError = "";
		try {
			await invoke("stop_mock_session");
			mockRunning = false;
		} catch (e) {
			mockError = e instanceof Error ? e.message : String(e);
		} finally {
			mockBusy = false;
		}
	}

	// Focus management: move focus into the close button when the panel opens,
	// and restore focus to the previously-focused element when it closes.
	let closeBtn = $state<HTMLButtonElement | null>(null);
	let returnFocus = $state<HTMLElement | null>(null);

	$effect(() => {
		if (open) {
			// activeElement may be null or a non-HTMLElement (e.g. SVG); only keep something focusable.
			returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			// Defer one microtask so the DOM is rendered before we focus
			Promise.resolve().then(() => closeBtn?.focus());
		} else {
			if (returnFocus instanceof HTMLElement) {
				returnFocus.focus();
			}
			returnFocus = null;
		}
	});

	// Escape key closes the panel
	$effect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				onclose();
			}
		}
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	});
</script>

{#if open}
	<!-- Scrim -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="scrim" onclick={onclose}></div>

	<!-- Panel -->
	<div
		class="panel"
		role="dialog"
		aria-modal="true"
		aria-labelledby="settings-title"
		aria-label="Settings"
	>
		<div class="panel-head">
			<span class="panel-title" id="settings-title">Settings</span>
			<button bind:this={closeBtn} class="close-btn" onclick={onclose} aria-label="Close settings">
				<Icon name="x" size={16} />
			</button>
		</div>

		<div class="panel-body">
			<section class="s-section">
				<h2 class="s-title">Appearance</h2>
				<div class="s-row">
					<div class="s-label-wrap">
						<span class="s-label">Folded blocks</span>
						<span class="s-helper">Classic = dimmed tiles · Sliver = compact slivers with a summary</span>
					</div>
					<div class="s-control">
						<SegControl
							options={[
								{ id: "classic", label: "Classic" },
								{ id: "sliver", label: "Sliver" },
							]}
							value={settings.foldDisplayMode}
							onchange={(v) => settings.set("foldDisplayMode", v as import("$lib/settings.svelte").FoldDisplayMode)}
							ariaLabel="Folded block display mode"
						/>
					</div>
				</div>
			</section>

			{#if isTauriEnv}
				<section class="s-section">
					<h2 class="s-title">Developer</h2>
					<div class="s-row">
						<div class="s-label-wrap">
							<span class="s-label">Fake pi session</span>
							<span class="s-helper">
								Streams the bundled sample as a live pi session so you can drive a conductor
								without running pi. Opens a browser panel to play / pause / restart and set
								speed — then pick the session from the sidebar.
							</span>
							{#if mockError}
								<span class="s-error">{mockError}</span>
							{/if}
						</div>
						<div class="s-control mock-control">
							{#if mockRunning}
								<button class="btn" disabled={mockBusy} onclick={() => openUrl(`http://localhost:${mockPort}`)}>
									<Icon name="activity" size={13} />
									Control panel
								</button>
								<button class="btn btn-danger" disabled={mockBusy} onclick={stopMock}>
									<Icon name="square" size={12} />
									Stop
								</button>
							{:else}
								<button class="btn btn-accent" disabled={mockBusy} onclick={launchMock}>
									<Icon name="play" size={13} />
									{mockBusy ? "Launching…" : "Launch"}
								</button>
							{/if}
						</div>
					</div>
				</section>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* ── Scrim ────────────────────────────────────────────────────────────── */
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 900;
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(1px);
		animation: fade-in var(--dur-fast) var(--ease-out) both;
	}

	/* ── Panel ────────────────────────────────────────────────────────────── */
	.panel {
		position: fixed;
		z-index: 901;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(440px, calc(100vw - 48px));
		max-height: min(80vh, calc(100vh - 48px));
		background: var(--panel);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-3);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		animation: panel-in var(--dur-fast) var(--ease-out) both;
	}

	/* ── Panel header ─────────────────────────────────────────────────────── */
	.panel-head {
		display: flex;
		align-items: center;
		padding: var(--sp-3) var(--sp-4);
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
		gap: var(--sp-2);
	}
	.panel-title {
		font-size: var(--fs-base);
		font-weight: 700;
		color: var(--text);
		flex: 1;
		letter-spacing: 0.01em;
	}
	.close-btn {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--faint);
		cursor: pointer;
		flex: 0 0 auto;
		transition:
			background var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.close-btn:hover {
		background: var(--panel-2);
		color: var(--text);
	}
	.close-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	/* ── Panel body ───────────────────────────────────────────────────────── */
	.panel-body {
		padding: var(--sp-4);
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		overflow-y: auto;
		min-height: 0;
	}

	/* ── Section ──────────────────────────────────────────────────────────── */
	.s-section {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}
	.s-title {
		font-size: var(--fs-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--faint);
		margin: 0;
		padding-bottom: var(--sp-1);
		border-bottom: 1px solid var(--line-soft);
	}

	/* ── Row ──────────────────────────────────────────────────────────────── */
	.s-row {
		display: flex;
		align-items: flex-start;
		gap: var(--sp-4);
	}
	.s-label-wrap {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.s-label {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
	}
	.s-helper {
		font-size: var(--fs-xs);
		color: var(--faint);
		line-height: 1.55;
	}
	.s-error {
		font-size: var(--fs-xs);
		color: var(--danger);
		line-height: 1.5;
	}
	.s-control {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		padding-top: 1px; /* optical alignment with label baseline */
	}
	/* Mock-session controls can stack two buttons; let them wrap, right-aligned. */
	.mock-control {
		flex-direction: column;
		align-items: flex-end;
		gap: var(--sp-2);
	}

	/* ── Buttons (dev section) ────────────────────────────────────────────── */
	.btn {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		white-space: nowrap;
		padding: var(--sp-1) var(--sp-3);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-sm);
		background: var(--panel-2);
		color: var(--text);
		font-size: var(--fs-sm);
		font-weight: 600;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.btn:hover:not(:disabled) {
		background: var(--panel-3);
		border-color: var(--line-strong);
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.btn-accent {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent);
	}
	.btn-accent:hover:not(:disabled) {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent-hover);
	}
	.btn-danger:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--danger) 55%, transparent);
		color: var(--danger);
	}

	/* ── Animations ───────────────────────────────────────────────────────── */
	@keyframes fade-in {
		from { opacity: 0; }
		to   { opacity: 1; }
	}
	@keyframes panel-in {
		from { opacity: 0; transform: translate(-50%, calc(-50% - 8px)); }
		to   { opacity: 1; transform: translate(-50%, -50%); }
	}
</style>
