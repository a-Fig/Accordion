<script lang="ts">
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { BlockKind } from "../../engine/types";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
	import Icon from "$lib/ui/Icon.svelte";
	import ConductorMenu from "./ConductorMenu.svelte";
	import { folding, setFolding } from "$lib/live/folding.svelte";
	import { live } from "$lib/live/liveClient.svelte";

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
	const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
	const k = (n: number) => {
		const r = Math.round(n);
		if (r >= 1_000_000) {
			const m = r / 1_000_000;
			return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
		}
		return r >= 1000 ? `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}k` : `${r}`;
	};
	const fmtOverBy = (n: number) => k(Math.round(n));

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
	// (protect target > whole context) never paints past the right edge.
	const protPct = $derived(Math.min(100, (store.protectTokens / denom) * 100));
	// While dragging, the handle follows the cursor continuously (smooth) and the
	// expensive fold commit is throttled to one per frame. `dragTokens` is non-null
	// only mid-drag; otherwise the handle tracks the committed target.
	let dragTokens = $state<number | null>(null);
	const handlePct = $derived(
		dragTokens != null ? Math.min(100, (dragTokens / denom) * 100) : protPct,
	);
	// The TARGET protected size the user is dialing in. The underline + its label echo
	// this (smooth, matches the grip), NOT the actual protected tail — `protectedTokens`
	// snaps to whole-block boundaries, so it differs slightly and jitters as you drag.
	const targetTokens = $derived(dragTokens ?? store.protectTokens);
	// Headroom: the slack between what's used and the budget ceiling. Only present when
	// the budget exceeds the full (unfolded) size — i.e. denom === budget.
	const headroomPct = $derived(Math.max(0, ((denom - store.fullTokens) / denom) * 100));
	// What "Revert to auto" will clear: every block carrying a manual/agent override.
	const editCount = $derived(store.blocks.filter((b) => b.override !== null).length);

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
		<!-- ── Left: hero stat + usage pill + saved ── -->
		<div class="nums">
			<span class="hero-stat mono tnum" class:over={store.overBudget}>
				<AnimatedNumber value={store.liveTokens} format={fmt} />
			</span>
			<span class="budget-denom tnum">/ <AnimatedNumber value={store.budget} format={fmt} /></span>
			<span class="usage-pill tnum" class:over={store.overBudget}>
				<span class="pill-dot" aria-hidden="true"></span>
				{#if store.overBudget}
					over by <AnimatedNumber value={store.liveTokens - store.budget} format={fmtOverBy} />
				{:else}
					<AnimatedNumber value={pct(store.liveTokens, store.budget)} format={(n) => `${Math.round(n)}%`} />
				{/if}
			</span>
			{#if store.savedTokens > 0}
				<span class="saved-stat tnum">
					<Icon name="chevrons-down-up" size={12} />
					<AnimatedNumber value={store.savedTokens} format={k} /> saved
				</span>
			{/if}
		</div>

		<!-- ── Right: controls cluster ── -->
		<div class="ctl">
			<!-- Active conductor (ADR 0007): which strategy is managing this context. -->
			<ConductorMenu />

			{#if readOnly}
				<span
					class="ro-badge"
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
					onclick={() => setFolding(!folding.enabled)}
				>
					<Icon name="activity" size={13} />
					<span class="fold-arm-dot" aria-hidden="true"></span>
					<span class="fold-arm-label">Folding: {folding.enabled ? "steering" : "preview"}</span>
				</button>
			{/if}

			<span
				class="kl protect-read"
				title="Actual protected tail: {fmt(store.protectedTokens)} tokens; target: {fmt(store.protectTokens)} tokens — drag the amber handle on the bar to change it"
			>
				<Icon name="lock" size={11} />
				<span class="kl-text">protect</span>
				<b class="mono tnum kl-val">{k(store.protectedTokens)}</b>
				{#if store.protectedTokens !== store.protectTokens}
					<span class="kl-target tnum">/{k(store.protectTokens)}</span>
				{/if}
			</span>

			<label class="knob">
				<span class="kl">
					<Icon name="target" size={11} />
					<span class="kl-text">budget</span>
					<b class="mono tnum kl-val">{k(store.budget)}</b>
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
			</label>

			<button
				class="reset-btn"
				onclick={() => store.resetAll()}
				disabled={editCount === 0}
				title={editCount === 0
					? "No manual edits — the view is already automatic"
					: `Clear ${editCount} manual edit${editCount === 1 ? "" : "s"} and return to the automatic fold view`}
			>
				<Icon name="rotate-ccw" size={13} />
				Revert to auto
				{#if editCount > 0}<span class="reset-cnt tnum">{editCount}</span>{/if}
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

		<!-- draggable protected handle (floats above the clipped bar) -->
		<div
			class="prot-grip"
			class:dragging={dragTokens != null}
			style:left="{handlePct}%"
			role="slider"
			tabindex="0"
			aria-label="Protected tail in tokens"
			aria-valuemin="0"
			aria-valuemax={PROT_MAX}
			aria-valuenow={store.protectTokens}
			aria-valuetext="{fmt(store.protectTokens)} tokens protected"
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
		align-items: center;
		gap: var(--sp-4);
	}

	/* ── Nums cluster ── */
	.nums {
		display: flex;
		align-items: baseline;
		gap: var(--sp-2);
		min-width: 0;
		flex-wrap: wrap;
	}

	/* Hero stat — the primary focal point */
	.hero-stat {
		font-size: var(--fs-2xl);
		font-weight: 700;
		color: var(--text);
		line-height: 1;
		letter-spacing: -0.01em;
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

	/* Usage pill */
	.usage-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 2px 8px 2px 6px;
		border-radius: var(--radius-pill);
		transition:
			color var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			background var(--dur-fast) var(--ease-out);
	}
	.usage-pill.over {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 10%, var(--panel-2));
		border-color: color-mix(in srgb, var(--danger) 40%, var(--line));
	}
	.pill-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted);
		flex: 0 0 auto;
		transition: background var(--dur-fast) var(--ease-out);
	}
	.usage-pill.over .pill-dot {
		background: var(--danger);
	}

	/* Saved stat */
	.saved-stat {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		color: var(--ok);
		opacity: 0.85;
	}

	/* ── Controls cluster ── */
	.ctl {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		flex: 0 0 auto;
	}

	/* Read-only badge */
	.ro-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--faint);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 3px 8px 3px 6px;
		border-radius: var(--radius-pill);
		white-space: nowrap;
		user-select: none;
	}

	/* Folding-arm toggle */
	.fold-arm {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--muted);
		padding: 5px 11px 5px 9px;
		border-radius: var(--radius-pill);
		font-size: var(--fs-xs);
		font-weight: 600;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.fold-arm:hover {
		background: var(--panel-4);
		border-color: var(--line-strong);
		color: var(--text);
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
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 60%, var(--line));
		color: var(--accent);
	}
	.fold-arm.on:hover {
		background: color-mix(in srgb, var(--accent) 22%, var(--panel));
		border-color: var(--accent);
	}
	.fold-arm.on .fold-arm-dot {
		background: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
	}

	/* Slider knob */
	.knob {
		display: flex;
		flex-direction: column;
		gap: 4px;
		cursor: default;
	}
	.kl {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		color: var(--faint);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		user-select: none;
	}
	.kl-val {
		color: var(--muted);
		font-weight: 600;
		text-transform: none;
		letter-spacing: 0;
	}
	.kl-target {
		color: var(--faint);
		font-weight: 500;
		text-transform: none;
		letter-spacing: 0;
	}
	.knob input[type="range"] {
		width: 120px;
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

	/* Reset button */
	.reset-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 5px 10px 5px 8px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		font-weight: 500;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out);
	}
	.reset-btn:hover:not(:disabled) {
		background: var(--panel-4);
		border-color: var(--line-strong);
	}
	.reset-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.reset-cnt {
		font-family: var(--mono);
		font-size: 10px;
		line-height: 1;
		font-weight: 600;
		color: var(--accent);
		background: var(--accent-soft);
		border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line));
		border-radius: var(--radius-pill);
		padding: 1px 6px;
	}

	/* Protect readout (the slider moved onto the bar) */
	.protect-read {
		cursor: default;
	}

	/* ── Composition bar area: bar + on-bar protected control + underline ── */
	.bar-area {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 5px;
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
</style>
