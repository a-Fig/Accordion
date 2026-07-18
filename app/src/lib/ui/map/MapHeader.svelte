<script lang="ts">
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { BlockKind } from "../../engine/types";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
	import EditableNumber from "$lib/ui/EditableNumber.svelte";
	import Icon from "$lib/ui/Icon.svelte";
	import { folding } from "$lib/live/folding.svelte";
	import { live, setArmed, conductorState, conductorStatus } from "$lib/live/liveClient.svelte";
	import ConductorMenu from "./ConductorMenu.svelte";

	let { store, readOnly = false }: { store: AccordionStore; readOnly?: boolean } = $props();

	const LADDER: { kind: BlockKind; label: string }[] = [
		{ kind: "tool_result", label: "tool results" },
		{ kind: "thinking", label: "thinking" },
		{ kind: "text", label: "replies" },
		{ kind: "tool_call", label: "tool calls" },
		{ kind: "user", label: "your messages" },
	];

	const liveByKind = $derived.by(() => {
		const m: Record<string, number> = {};
		for (const k of LADDER) m[k.kind] = 0;
		for (const b of store.blocks) if (b.kind in m) m[b.kind] += store.effTokens(b);
		return m;
	});

	const denom = $derived(Math.max(store.fullTokens, store.budget, 1));
	// fmt/k formatters must round their input because AnimatedNumber passes a float mid-tween
	const fmt = (n: number) => Math.round(n).toLocaleString();
	const k = (n: number) => {
		const r = Math.round(n);
		if (r >= 1_000_000) {
			const m = r / 1_000_000;
			return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
		}
		return r >= 1000 ? `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}k` : `${r}`;
	};
	const fmtOverBy = (n: number) => k(n);

	// ── Involvement locks (ADR 0011) — the honest mirror of the engine's gating. A locked
	// control LOOKS locked in every mode (preview/demo/read-only included), driven purely off
	// `store.isLocked(...)`. The engine already no-ops the underlying action; this is the UI
	// reflecting that, not the enforcement. The budget dial is NEVER gated (sacred tier).
	//
	// Declared ABOVE the protected-tail bar math below because protPct/handlePct/targetTokens
	// all need to key off the same enforced value the PROTECT readout uses (`protectTarget`) —
	// under a tail-size lock the active strategy owns the tail, so every chrome element (bar
	// tint, grip position, underline, ARIA) must agree with the text, not just the text (S11).
	const tailLocked = $derived(store.isLocked("tail-size"));
	const steerLocked = $derived(store.isLocked("human-steering"));
	// Under the tail-size lock the active strategy OWNS the tail — the enforced target is its
	// declared `activeTailTokens`, not the human's now-stale `protectTokens` (ADR 0011 §7). Every
	// PROTECT-related readout/visual must show what is actually enforced.
	const protectTarget = $derived(tailLocked ? store.activeTailTokens : store.protectTokens);
	const lockTip = $derived(
		`Locked by ${store.lockHolder ?? "the active strategy"} — release the lock to take back control`,
	);

	// ── Protected tail: an on-bar handle (left = 0, drag right to protect more) ──
	const PROT_MAX = 60_000;
	const PROT_STEP = 2_000;
	// Budget slider bounds + fill fraction (native range tracks don't paint a colored
	// fill once a custom thumb is defined, so we drive it via background-size).
	const BUDGET_MIN = 12_000;
	const budgetMax = $derived(Math.max(store.contextWindow ?? 200_000, store.budget, 200_000));
	const budgetPct = $derived(((store.budget - BUDGET_MIN) / (budgetMax - BUDGET_MIN)) * 100);
	let barEl = $state<HTMLDivElement>();
	// Everything on the bar is scaled to `denom` so the protected handle/tint share
	// the composition bar's token axis. Clamp the readout to the bar so a tiny session
	// (protect target > whole context) never paints past the right edge. Keyed off
	// `protectTarget` (not the raw `store.protectTokens`) so the bar tint agrees with the
	// numeric readout under a tail-size lock (S11) — unlocked, protectTarget === protectTokens.
	const protPct = $derived(Math.min(100, (protectTarget / denom) * 100));
	// While dragging, the handle follows the cursor continuously (smooth) and the
	// expensive fold commit is throttled to one per frame. `dragTokens` is non-null
	// only mid-drag; otherwise the handle tracks the committed target. Dragging is already
	// impossible while tail-locked (onProtPointerDown bails out), so `dragTokens` stays null
	// and this always falls through to `protPct` in that state.
	let dragTokens = $state<number | null>(null);
	const handlePct = $derived(
		dragTokens != null ? Math.min(100, (dragTokens / denom) * 100) : protPct,
	);
	// The TARGET protected size the user is dialing in. The underline + its label echo
	// this (smooth, matches the grip), NOT the actual protected tail — `protectedTokens`
	// snaps to whole-block boundaries, so it differs slightly and jitters as you drag.
	// Falls back to `protectTarget` (not `store.protectTokens`) so the underline label
	// agrees with the readout under a tail-size lock (S11).
	const targetTokens = $derived(dragTokens ?? protectTarget);
	// Headroom: the slack between what's used and the budget ceiling. Only present when
	// the budget exceeds the full (unfolded) size — i.e. denom === budget.
	const headroomPct = $derived(Math.max(0, ((denom - store.fullTokens) / denom) * 100));
	// What "Revert to auto" will clear: every block carrying a manual/agent override.
	const editCount = $derived(store.blocks.filter((b) => b.override !== null).length);

	// ── Latency badge (Phase B): the extension's `context` hook is now a LOCAL operation, so we
	// show its DURATION, not a plan round-trip outcome. Neutral/green under 250ms (the old plan
	// timeout — a local hook should be far below it), amber ≥250ms, red ≥1000ms. The tooltip
	// carries max / p95 / structural-rebuild counts. Monochrome per the visual grammar.
	//
	// Phase C (v13): an attached conductor can legitimately spend up to `holdWireUpToMs` of that
	// same hook holding the departing wire for a last-moment proposal (`telemetry.lastHoldMs`).
	// That hold is DECLARED, wanted latency, not a slow hook — so the amber/red thresholds are
	// re-keyed off `lastHookMs - lastHoldMs` (the hook's own work, hold excluded). The displayed
	// number stays the honest total; only the COLOR ignores a conductor spending its own budget.
	const LAT_AMBER = 250;
	const LAT_RED = 1000;
	const hookMs = $derived(live.telemetry.lastHookMs);
	const hookCount = $derived(live.telemetry.hookCount);
	const holdMs = $derived(live.telemetry.lastHoldMs);
	const netHookMs = $derived(Math.max(0, hookMs - holdMs));
	const latClass = $derived(netHookMs >= LAT_RED ? "lat-red" : netHookMs >= LAT_AMBER ? "lat-amber" : "lat-ok");
	const latTip = $derived(
		`Local context-hook latency (no plan round trip in Phase B)\n` +
			`last: ${hookMs} ms` +
			(holdMs > 0 ? ` (of which ${holdMs} ms was a conductor's wire-departing hold — net ${netHookMs} ms)\n` : `\n`) +
			`max: ${live.telemetry.maxHookMs} ms\n` +
			`p95: ${live.telemetry.p95HookMs} ms\n` +
			`hooks this connection: ${hookCount}\n` +
			`structural rebuilds: ${live.telemetry.rebuilds}`,
	);

	// ── HOLD chip (Phase C): the host's most recent wire-departing hold for the attached
	// conductor's last-moment proposal — its own neutral chip, distinct from LATENCY, so a
	// conductor legitimately using its declared hold budget reads as informational, never a
	// warning. Hidden until a hold has actually happened this connection.
	const holdTip = $derived(
		`Wire-departing hold for the attached conductor's last-moment proposal\n` +
			`last: ${holdMs} ms\n` +
			`timeouts this connection: ${live.telemetry.holdTimeouts} (passed through unchanged when the hold ran out)`,
	);

	// ── Conductor status readout (Phase C): the attached conductor's own display-only status
	// line (`conductorStatus.text`), shown only while a conductor is actually attached and has
	// published non-empty text — mirrors the PROTECT/BUDGET ctl-field visual pattern.
	const showCondStatus = $derived(live.status === "connected" && !!conductorState.active && !!conductorStatus.text);

	function protectFromClientX(clientX: number): number {
		if (!barEl) return store.protectTokens;
		const r = barEl.getBoundingClientRect();
		const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
		return Math.max(0, Math.min(PROT_MAX, frac * denom));
	}
	// Snap to the step and commit the real fold. Only ever called on release (or via
	// keyboard) — NEVER mid-drag, so blocks are re-folded once when you let go, not
	// continuously while you move the handle.
	function commitTarget(tokens: number) {
		const snapped = Math.round(tokens / PROT_STEP) * PROT_STEP;
		if (snapped !== store.protectTokens) store.setProtect(snapped);
	}
	function onProtPointerDown(e: PointerEvent) {
		if (tailLocked) return; // tail-size locked by the active strategy — the handle is inert
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragTokens = protectFromClientX(e.clientX); // visual only — no refold yet
	}
	function onProtPointerMove(e: PointerEvent) {
		if (dragTokens == null) return; // only while held
		dragTokens = protectFromClientX(e.clientX); // visual only — no refold yet
	}
	function onProtPointerUp() {
		if (dragTokens == null) return;
		commitTarget(dragTokens); // single refold, on release
		dragTokens = null;
	}
	function onProtKeydown(e: KeyboardEvent) {
		if (tailLocked) return; // tail-size locked — keyboard nudges are inert too
		let v = store.protectTokens;
		if (e.key === "ArrowLeft" || e.key === "ArrowDown") v -= PROT_STEP;
		else if (e.key === "ArrowRight" || e.key === "ArrowUp") v += PROT_STEP;
		else if (e.key === "Home") v = 0;
		else if (e.key === "End") v = PROT_MAX;
		else return;
		e.preventDefault();
		store.setProtect(Math.max(0, Math.min(PROT_MAX, v)));
	}
</script>

<div class="hdr">
	<div class="top">
		<!-- ── Left: the hero live number / budget. Single focal stat — no echoing
		     CONTEXT eyebrow or live·folded readout (those just restated this). ── -->
		<div class="nums">
			<div class="hero-line">
				<span class="hero-stat mono tnum" class:over={store.overBudget}>
					<AnimatedNumber value={store.liveTokens} format={fmt} />
				</span>
				<span class="budget-denom mono tnum">/ <AnimatedNumber value={store.budget} format={fmt} /></span>
				{#if store.overBudget}
					<span class="over-flag mono tnum">
						over by <AnimatedNumber value={store.liveTokens - store.budget} format={fmtOverBy} />
					</span>
				{/if}
			</div>
		</div>

		<!-- ── Right: controls cluster ── -->
		<div class="ctl">
			{#if readOnly}
				<span
					class="ro-badge mono"
					role="status"
					aria-label="Read-only session"
					title="Viewing a recording — folds are local and do not affect any agent."
				>
					<Icon name="eye" size={11} />
					READ-ONLY
				</span>
			{/if}

			{#if live.status === "connected"}
				<button
					class="fold-arm"
					class:on={folding.enabled}
					aria-pressed={folding.enabled}
					aria-label="Apply folds to the live agent"
					title={folding.enabled
						? "Accordion is applying folds to the live agent's context. Takes effect on the agent's next turn."
						: "Folds are previewed in the view only. The agent's context is unchanged."}
					onclick={() => setArmed(!folding.enabled)}
				>
					<span class="fold-arm-dot" aria-hidden="true"></span>
					<span class="fold-arm-eyebrow mono">FOLDING</span>
					<span class="fold-arm-state">{folding.enabled ? "steering" : "preview"}</span>
				</button>
			{/if}

			<!-- Conductor picker (Phase C): hidden entirely when not connected live or the host's
			     catalog is empty (see ConductorMenu's own gate). -->
			<ConductorMenu />

			<!-- Attached conductor's own display-only status line (Phase C) — same ctl-field
			     visual pattern as PROTECT/BUDGET below. Shown only while a conductor is actually
			     attached and has published non-empty text. -->
			{#if showCondStatus}
				<div class="ctl-field cond-status-read" title={conductorStatus.text ?? ""}>
					<span class="ctl-eyebrow mono">
						<Icon name="activity" size={10} />
						STATUS
					</span>
					<span class="ctl-value mono">{conductorStatus.text}</span>
				</div>
			{/if}

			<!-- Latency badge (Phase B): the local context-hook duration. Hidden until this
			     connection has seen at least one hook — browsing/read-only/demo sessions have no
			     wire, so they show nothing. Monochrome; amber/red only tint the value on a slow
			     hook (#044EFF stays reserved for the user block kind, never UI chrome). Phase C:
			     the amber/red thresholds are re-keyed off (lastHookMs - lastHoldMs) — see latClass. -->
			{#if live.status === "connected" && hookCount > 0}
				<div class="ctl-field lat-read" title={latTip}>
					<span class="ctl-eyebrow mono">
						<Icon name="activity" size={10} />
						LATENCY
					</span>
					<span class="ctl-value mono tnum {latClass}">
						{hookMs}ms
					</span>
				</div>
			{/if}

			<!-- HOLD chip (Phase C): the host's last wire-departing hold for the attached
			     conductor's proposal. Its OWN neutral chip, visually distinct from LATENCY (no
			     amber/red tinting — using the declared hold budget is expected, not a warning).
			     Hidden until a hold has actually happened this connection. -->
			{#if live.status === "connected" && holdMs > 0}
				<div class="ctl-field hold-read" title={holdTip}>
					<span class="ctl-eyebrow mono">
						<Icon name="square" size={10} />
						HOLD
					</span>
					<span class="ctl-value mono tnum">
						{holdMs}ms
					</span>
				</div>
			{/if}

			<!-- Protect readout: eyebrow + editable mono value (the dial lives on the bar).
			     Under the tail-size lock the active strategy owns the tail — the dial becomes a
			     static readout and the field shows locked (ADR 0011 §7). -->
			<div
				class="ctl-field protect-read"
				class:ctl-locked={tailLocked}
				aria-disabled={tailLocked}
				title={tailLocked
					? lockTip + ` (the active strategy now owns the tail — enforcing ${fmt(protectTarget)} tokens)`
					: `Actual protected tail: ${fmt(store.protectedTokens)} tokens; target: ${fmt(store.protectTokens)} tokens — click the value or drag the handle to change it`}
			>
				<span class="ctl-eyebrow mono">
					<Icon name="lock" size={10} />
					PROTECT
				</span>
				<span class="ctl-value mono tnum">
					{#if tailLocked}
						<!-- tail-size locked: a static readout of the ENFORCED tail, not an editable dial. -->
						<span class="kl-val">{k(protectTarget)}</span>
					{:else}
						<EditableNumber
							value={store.protectTokens}
							format={k}
							label="Protected tail target in thousands of tokens"
							oncommit={(n) => store.setProtect(Math.max(0, Math.min(PROT_MAX, n)))}
						/>
					{/if}
					{#if Math.abs(store.protectedTokens - protectTarget) > 500}
						<span class="kl-target tnum">({k(store.protectedTokens)})</span>
					{/if}
				</span>
			</div>

			<!-- Budget: eyebrow + editable mono value + fill slider. -->
			<div class="ctl-field knob">
				<span class="ctl-eyebrow mono">
					<Icon name="target" size={10} />
					BUDGET
				</span>
				<span class="ctl-value mono tnum">
					<EditableNumber
						value={store.budget}
						format={k}
						label="Context budget in thousands of tokens"
						oncommit={(n) => store.setBudget(Math.max(BUDGET_MIN, Math.min(budgetMax, n)))}
					/>
				</span>
				<input
					type="range"
					min={BUDGET_MIN}
					max={budgetMax}
					step="2000"
					value={store.budget}
					oninput={(e) => store.setBudget(+e.currentTarget.value)}
					aria-label="Context budget"
					style:background-size="{budgetPct}% 100%"
				/>
			</div>

			<button
				class="btn-secondary reset-btn"
				onclick={() => store.resetAll()}
				disabled={editCount === 0 || steerLocked}
				aria-disabled={steerLocked}
				title={steerLocked
					? lockTip
					: editCount === 0
						? "No manual edits — the view is already automatic"
						: `Clear ${editCount} manual edit${editCount === 1 ? "" : "s"} and return to the automatic fold view`}
			>
				<Icon name="rotate-ccw" size={13} />
				Revert to auto
				{#if editCount > 0}<span class="reset-cnt mono tnum">{editCount}</span>{/if}
			</button>
		</div>
	</div>

	<!-- ── Composition bar + on-bar protected control ── -->
	<div class="bar-area">
		<div class="bar" bind:this={barEl} role="img" aria-label="Context composition">
			{#each LADDER as seg (seg.kind)}
				{@const v = liveByKind[seg.kind]}
				{#if v > 0}
					<span class="seg k-{seg.kind}" style:width="{(v / denom) * 100}%" title="{seg.label}: {fmt(v)} live"></span>
				{/if}
			{/each}
			{#if store.savedTokens > 0}
				<span class="seg saved-seg" style:width="{(store.savedTokens / denom) * 100}%" title="folded away: {fmt(store.savedTokens)}"></span>
			{/if}
			{#if headroomPct > 0.5}
				<span class="headroom" style:left="{100 - headroomPct}%" style:width="{headroomPct}%" title="headroom: {fmt(store.budget - store.fullTokens)} under budget"></span>
			{/if}
			<!-- protected extent, clipped to the bar -->
			<span class="prot-tint" style:width="{handlePct}%" aria-hidden="true"></span>
		</div>

		<!-- budget ceiling marker — sibling of .bar so its cap escapes overflow:hidden -->
		<span class="bar-marker" style:left="{(store.budget / denom) * 100}%" title="budget: {fmt(store.budget)}">
			<span class="bar-marker-cap" aria-hidden="true"></span>
		</span>

		<!-- draggable protected handle (floats above the clipped bar). Inert under the
		     tail-size lock — the active strategy owns the tail (ADR 0011 §7). -->
		<div
			class="prot-grip"
			class:dragging={dragTokens != null}
			class:locked={tailLocked}
			style:left="{handlePct}%"
			role="slider"
			tabindex={tailLocked ? -1 : 0}
			aria-label="Protected tail in tokens"
			aria-disabled={tailLocked}
			aria-valuemin="0"
			aria-valuemax={PROT_MAX}
			aria-valuenow={protectTarget}
			aria-valuetext="{fmt(protectTarget)} tokens protected"
			title={tailLocked ? lockTip : undefined}
			onpointerdown={onProtPointerDown}
			onpointermove={onProtPointerMove}
			onpointerup={onProtPointerUp}
			onpointercancel={onProtPointerUp}
			onkeydown={onProtKeydown}
		></div>

		<!-- the slight underline echoing the protected extent -->
		<div class="prot-underline-track" aria-hidden="true">
			<span class="prot-underline" style:width="{handlePct}%"></span>
			<span class="prot-underline-lab" style:left="{handlePct}%">{k(targetTokens)} protected</span>
		</div>
	</div>
</div>

<style>
	/* ── Container ── */
	.hdr {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		padding: var(--sp-3) var(--sp-4) var(--sp-3);
		border-bottom: 1px solid var(--line-soft);
		background: var(--panel);
		box-shadow: var(--shadow-1);
		flex: 0 0 auto;
	}

	/* ── Top row: nums left, ctl right ── */
	.top {
		display: flex;
		align-items: flex-start;
		gap: var(--sp-4);
		flex-wrap: wrap;
		min-width: 0;
	}

	/* ── Nums cluster — the brand data device ── */
	.nums {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
		min-width: 0;
	}

	/* Hero line: live number + denominator + optional over-flag */
	.hero-line {
		display: flex;
		align-items: baseline;
		gap: var(--sp-2);
	}

	/* Hero stat — the primary focal point */
	.hero-stat {
		font-size: var(--fs-2xl);
		font-weight: 600;
		color: var(--text);
		line-height: 1;
		letter-spacing: 0;
		transition: color var(--dur-fast) var(--ease-out);
	}
	.hero-stat.over {
		color: var(--danger);
	}

	.budget-denom {
		font-size: var(--fs-sm);
		color: var(--faint);
		align-self: baseline;
	}

	/* Over-budget flag — danger, no pill chrome */
	.over-flag {
		font-size: var(--fs-xs);
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--danger);
	}

	/* ── Controls cluster ── */
	.ctl {
		margin-left: auto;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--sp-3);
		row-gap: var(--sp-2);
		flex: 1 1 520px;
		min-width: 0;
		flex-wrap: wrap;
	}

	/* Eyebrow shared by every control field — mono, uppercase, wide tracking, faint. */
	.ctl-eyebrow {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-2xs);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--faint);
		line-height: 1;
		user-select: none;
	}
	/* The mono value beneath an eyebrow. */
	.ctl-value {
		display: inline-flex;
		align-items: baseline;
		gap: 5px;
		font-size: var(--fs-sm);
		color: var(--text);
		line-height: 1;
	}
	.ctl-field {
		display: flex;
		flex-direction: column;
		gap: 5px;
		cursor: default;
		min-width: 0;
	}

	/* Read-only badge — mono eyebrow chip */
	.ro-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-2xs);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--faint);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 4px 9px 4px 7px;
		border-radius: var(--radius-sm);
		white-space: nowrap;
		user-select: none;
	}

	/* ── Folding-arm toggle — quiet ghost; armed → --ok green (state color) ── */
	.fold-arm {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: transparent;
		border: 1px solid var(--line);
		color: var(--muted);
		padding: 6px 12px 6px 10px;
		border-radius: var(--radius-sm);
		line-height: 1;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.fold-arm:hover {
		border-color: var(--line-strong);
		background: var(--accent-soft);
		color: var(--text);
	}
	.fold-arm-eyebrow {
		font-size: var(--fs-2xs);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--faint);
	}
	.fold-arm-state {
		font-size: var(--fs-xs);
		font-weight: 600;
		letter-spacing: 0.01em;
	}
	.fold-arm-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--faint);
		flex: 0 0 auto;
		transition:
			background var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out);
	}
	.fold-arm.on {
		background: color-mix(in srgb, var(--ok) 12%, transparent);
		border-color: color-mix(in srgb, var(--ok) 55%, var(--line));
		color: var(--ok);
	}
	.fold-arm.on:hover {
		background: color-mix(in srgb, var(--ok) 20%, var(--panel));
		border-color: var(--ok);
	}
	.fold-arm.on .fold-arm-eyebrow {
		color: color-mix(in srgb, var(--ok) 70%, var(--muted));
	}
	.fold-arm.on .fold-arm-dot {
		background: var(--ok);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 28%, transparent);
	}

	/* Protect / Budget value helpers */
	.kl-val {
		color: var(--text);
		font-weight: 600;
	}
	.kl-target {
		color: var(--faint);
		font-weight: 400;
	}

	/* ── Slider knob ── */
	.knob input[type="range"] {
		width: clamp(92px, 16vw, 150px);
		height: 4px;
		accent-color: var(--accent);
		margin: 0;
		cursor: pointer;
		/* Custom track via appearance manipulation where supported */
		appearance: none;
		-webkit-appearance: none;
		/* native range tracks won't paint a colored fill once a custom thumb is set,
		   so the accent "progress" is a no-repeat background sized via --budgetPct */
		background-color: var(--panel-2);
		background-image: linear-gradient(var(--accent), var(--accent));
		background-repeat: no-repeat;
		background-size: 0% 100%;
		border-radius: var(--radius-pill);
		outline: none;
	}
	.knob input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
		transition: box-shadow var(--dur-fast) var(--ease-out);
	}
	.knob input[type="range"]:hover::-webkit-slider-thumb {
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent);
	}
	.knob input[type="range"]:focus-visible {
		box-shadow: var(--focus-ring);
		border-radius: var(--radius-pill);
	}

	/* ── Secondary (outline) button — brand button system ── */
	.btn-secondary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: transparent;
		border: 1px solid var(--line-strong);
		color: var(--text);
		padding: 7px 12px 7px 10px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		font-weight: 500;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out);
	}
	.btn-secondary:hover:not(:disabled) {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.btn-secondary:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.btn-secondary:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.reset-cnt {
		font-size: 10px;
		line-height: 1;
		font-weight: 600;
		color: var(--ink);
		background: var(--paper);
		border-radius: var(--radius-pill);
		padding: 2px 6px;
	}
	.reset-btn {
		white-space: nowrap;
	}

	/* Protect readout (the dial lives on the bar) */
	.protect-read {
		cursor: default;
	}

	/* A control gated by an involvement lock (ADR 0011): greyed, reduced affordance. The
	   honest mirror of the engine's gating — looks locked in every mode. */
	.ctl-locked {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Latency badge (Phase B) — quiet, monochrome; never the reserved user-block blue. The value
	   tints only when a hook runs slow: amber ≥250ms (the old plan timeout), red ≥1000ms. A fast
	   local hook (the common case) stays neutral. */
	.lat-read {
		cursor: default;
	}
	.lat-read .lat-ok {
		color: var(--text);
	}
	.lat-read .lat-amber {
		color: var(--warn, #d9a03a);
	}
	.lat-read .lat-red {
		color: var(--bad, #d9534f);
	}

	/* Conductor status readout — same ctl-field shape as PROTECT/BUDGET; the value truncates
	   rather than wrapping/pushing the header (the conductor's status text has no length limit). */
	.cond-status-read {
		cursor: default;
		max-width: 220px;
	}
	.cond-status-read .ctl-value {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: block;
	}

	/* HOLD chip — its own neutral chip, deliberately DISTINCT from LATENCY: no amber/red tint (no
	   override rule at all — it keeps the plain `.ctl-value` --text color in every case). A
	   conductor spending its declared wire-departing hold budget is expected behavior, not a
	   warning. */
	.hold-read {
		cursor: default;
	}

	/* ── Composition bar area: bar + on-bar protected control + underline ── */
	.bar-area {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}

	/* Budget headroom: slack between usage and the ceiling */
	.headroom {
		position: absolute;
		top: 0;
		bottom: 0;
		pointer-events: none;
		background: repeating-linear-gradient(
			90deg,
			transparent,
			transparent 5px,
			rgba(255, 255, 255, 0.03) 5px,
			rgba(255, 255, 255, 0.03) 6px
		);
		border-left: 1px dashed var(--line-strong);
	}

	/* Protected extent tint — clipped to the bar's rounded shape */
	.prot-tint {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		pointer-events: none;
		background: var(--accent-soft);
		border-right: 2px solid var(--accent);
		border-radius: var(--radius-pill) 0 0 var(--radius-pill);
	}

	/* Draggable handle — lives in .bar-area so it can extend past the clipped bar */
	.prot-grip {
		position: absolute;
		top: -4px;
		height: 34px;
		width: 14px;
		margin-left: -7px;
		cursor: ew-resize;
		z-index: 5;
		touch-action: none;
		display: flex;
		align-items: center;
		justify-content: center;
		/* the focus-visible ring (global box-shadow) follows this radius — without it the
		   ring would be a sharp rectangle around the transparent hit area. */
		border-radius: var(--radius-sm);
	}
	.prot-grip::before {
		content: "";
		width: 4px;
		height: 100%;
		border-radius: 4px;
		background: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
		transition: box-shadow var(--dur-fast) var(--ease-out);
	}
	.prot-grip:hover::before,
	.prot-grip:focus-visible::before,
	.prot-grip.dragging::before {
		box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 32%, transparent);
	}
	.prot-grip:focus-visible {
		outline: none;
	}

	/* tail-size locked: the handle is inert and dimmed (the active strategy owns the tail). */
	.prot-grip.locked {
		cursor: not-allowed;
		opacity: 0.4;
	}
	.prot-grip.locked::before {
		background: var(--faint);
		box-shadow: none;
	}
	.prot-grip.locked:hover::before {
		box-shadow: none;
	}

	/* The slight underline echoing the protected extent */
	.prot-underline-track {
		position: relative;
		height: 13px;
	}
	.prot-underline {
		position: absolute;
		left: 0;
		top: 0;
		height: 3px;
		border-radius: 3px;
		background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 40%, transparent), var(--accent));
	}
	.prot-underline-lab {
		position: absolute;
		top: 5px;
		transform: translateX(-50%);
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		color: var(--accent);
		white-space: nowrap;
		pointer-events: none;
	}

	/* ── Composition bar ── */
	.bar {
		position: relative;
		display: flex;
		height: 26px;
		width: 100%;
		background: var(--panel-2);
		border: 1px solid var(--line-soft);
		/* inset frame shadow gives the "recessed track" feeling */
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
		border-radius: var(--radius-pill);
		overflow: hidden;
	}
	.seg {
		height: 100%;
		/* 1px gap between segments via outline trick — avoids reflow */
		outline: 1px solid var(--panel);
		outline-offset: -1px;
		transition: width 180ms var(--ease-out);
		flex: 0 0 auto;
	}
	/* Segment rounding — only first and last visible get radius (paint trick via box-shadow) */
	.seg:first-child  { border-radius: var(--radius-pill) 0 0 var(--radius-pill); }
	.seg:last-of-type { border-radius: 0 var(--radius-pill) var(--radius-pill) 0; }

	.seg.k-user       { background: var(--k-user); }
	.seg.k-text       { background: var(--k-text); }
	.seg.k-thinking   { background: var(--k-thinking); }
	.seg.k-tool_call  { background: var(--k-tool_call); }
	.seg.k-tool_result{ background: var(--k-tool_result); }
	.seg.saved-seg {
		background-color: var(--panel-3);
		background-image: repeating-linear-gradient(
			45deg,
			transparent,
			transparent 4px,
			rgba(255, 255, 255, 0.045) 4px,
			rgba(255, 255, 255, 0.045) 8px
		);
	}

	/* Budget marker line + tiny cap. Sibling of .bar (not a child) so the cap at
	   top:-3px escapes .bar's overflow:hidden; height matches the bar's 28px box. */
	.bar-marker {
		position: absolute;
		top: 0;
		height: 28px;
		width: 2px;
		background: var(--text);
		box-shadow: 0 0 0 1px var(--panel-2);
		pointer-events: none;
		transform: translateX(-50%);
		z-index: 4;
	}
	.bar-marker-cap {
		position: absolute;
		top: -3px;
		left: 50%;
		transform: translateX(-50%);
		width: 6px;
		height: 6px;
		background: var(--text);
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--panel-2);
	}

	@media (max-width: 920px) {
		.hdr {
			padding: var(--sp-3);
		}
		.top {
			gap: var(--sp-3);
		}
		.ctl {
			margin-left: 0;
			justify-content: flex-start;
			flex-basis: 100%;
		}
		.hero-line {
			flex-wrap: wrap;
			row-gap: 3px;
		}
	}

	@media (max-width: 560px) {
		.ctl {
			align-items: stretch;
		}
		.fold-arm,
		.reset-btn {
			justify-content: center;
		}
		.knob {
			flex: 1 1 180px;
		}
		.knob input[type="range"] {
			width: 100%;
		}
	}
</style>
