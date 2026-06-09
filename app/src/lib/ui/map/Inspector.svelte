<script lang="ts">
	import { fly } from "svelte/transition";
	import { cubicOut } from "svelte/easing";
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { Block } from "../../engine/types";
	import Icon from "$lib/ui/Icon.svelte";

	let { store, block, onclose }: { store: AccordionStore; block: Block | null; onclose: () => void } = $props();

	const KIND_LABEL: Record<Block["kind"], string> = {
		user: "User",
		text: "Reply",
		thinking: "Thinking",
		tool_call: "Tool call",
		tool_result: "Tool result",
	};

	const CAP = 6000;
	const fmt = (n: number) => n.toLocaleString();

	const folded = $derived(block ? store.isFolded(block) : false);
	const pinned = $derived(block?.override === "pinned");
	// Protected working tail — never folded (the safety pillar). The Fold control is
	// disabled here so the guarantee is visible, not just enforced silently.
	const protect = $derived(block ? store.isProtected(block) : false);

	// the call/result partner — they're separate blocks sharing a callId
	const partner = $derived.by<Block | null>(() => {
		if (!block?.callId) return null;
		return store.blocks.find((x) => x.id !== block.id && x.callId === block.callId) ?? null;
	});
	const partnerProtected = $derived(partner ? store.isProtected(partner) : false);

	function body(b: Block): { text: string; clipped: number } {
		const t = b.text ?? "";
		return t.length > CAP ? { text: t.slice(0, CAP) + "…", clipped: t.length } : { text: t, clipped: 0 };
	}

	const bd = $derived(block ? body(block) : { text: "", clipped: 0 });

	const isMono = $derived(block?.kind === "tool_call" || block?.kind === "tool_result");
</script>

{#if block}
	<aside class="insp" transition:fly={{ x: 24, duration: 200, easing: cubicOut, opacity: 0 }}>
		<!-- ── Header ─────────────────────────────────────────────── -->
		<header class="insp-header">
			<span class="kind-dot k-{block.kind}"></span>
			<span class="kind-label k-{block.kind}">{KIND_LABEL[block.kind]}</span>
			{#if block.toolName}
				<span class="tool-name mono">{block.toolName}</span>
			{/if}
			<span class="grow"></span>
			<span class="turn-badge tnum">turn {block.turn}</span>
			<button class="close-btn" onclick={onclose} aria-label="Close inspector" title="Close">
				<Icon name="x" size={16} />
			</button>
		</header>

		<!-- ── Meta row ───────────────────────────────────────────── -->
		<div class="meta-row">
			<div class="meta-pills">
				{#if folded}
					<span class="pill pill-warn">
						<span class="pill-dot"></span>folded
					</span>
				{:else}
					<span class="pill pill-ok">
						<span class="pill-dot"></span>live
					</span>
				{/if}
				{#if protect}
					<span class="pill pill-accent" title="In the protected working tail — never folded">
						<Icon name="lock" size={10} stroke={2} />
						protected
					</span>
				{/if}
				<span class="tok-count tnum">
					{#if folded}
						<s class="tok-orig">{fmt(block.tokens)}</s>
						<span class="tok-sep">→</span>
						<strong class="tok-eff">{fmt(store.effTokens(block))}</strong>
						<span class="tok-unit">tok</span>
					{:else}
						{fmt(block.tokens)}<span class="tok-unit"> tok</span>
					{/if}
				</span>
			</div>
			<div class="meta-actions">
				<button
					class="action-btn"
					class:action-disabled={protect}
					disabled={protect}
					title={protect ? "Protected working tail — never folded" : folded ? "Unfold block" : "Fold block"}
					onclick={() => store.toggle(block.id)}
				>
					<Icon name={folded ? "chevrons-up-down" : "chevrons-down-up"} size={14} />
					{folded ? "Unfold" : "Fold"}
				</button>
				<button
					class="action-btn"
					class:action-active={pinned}
					onclick={() => (pinned ? store.unpin(block.id) : store.pin(block.id))}
					title={pinned ? "Unpin block" : "Pin block (keeps it live)"}
				>
					<Icon name={pinned ? "pin-off" : "pin"} size={14} />
					{pinned ? "Unpin" : "Pin"}
				</button>
			</div>
		</div>

		<!-- ── Body ───────────────────────────────────────────────── -->
		<div class="body-wrap">
			{#if folded}
				<div class="digest-callout">
					<div class="digest-label">
						<Icon name="chevrons-down-up" size={12} stroke={2} />
						Folded — showing digest
					</div>
					<pre class="digest-text mono">{store.digestOf(block)}</pre>
				</div>
				<div class="body-divider">
					<span class="body-divider-label">Full content</span>
				</div>
			{/if}

			<pre
				class="content"
				class:content-mono={isMono}
			>{bd.text}</pre>

			{#if bd.clipped}
				<p class="clip-note tnum">
					showing first {fmt(CAP)} of {fmt(bd.clipped)} chars
				</p>
			{/if}
		</div>

		<!-- ── Partner ────────────────────────────────────────────── -->
		{#if partner}
			<div class="partner-section">
				<div class="partner-header">
					<span class="partner-label">
						{partner.kind === "tool_result" ? "Result it produced" : "Call that produced this"}
					</span>
					<span class="partner-meta tnum">
						{store.isFolded(partner) ? "folded" : "live"} · {fmt(store.effTokens(partner))} tok
					</span>
				</div>

				<button
					class="action-btn partner-toggle"
					class:action-disabled={partnerProtected}
					disabled={partnerProtected}
					title={partnerProtected ? "Protected — never folded" : store.isFolded(partner) ? "Unfold partner" : "Fold partner"}
					onclick={() => store.toggle(partner.id)}
				>
					<Icon name="corner-down-right" size={14} />
					{partnerProtected ? "Protected" : store.isFolded(partner) ? "Unfold" : "Fold"} partner
				</button>

				<pre class="partner-preview mono">{body(partner).text}</pre>
			</div>
		{/if}
	</aside>
{/if}

<style>
	/* ── Panel shell ─────────────────────────────────────────── */
	.insp {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--panel);
		border-left: 1px solid var(--line-soft);
		overflow-y: auto;
	}

	/* ── Header ─────────────────────────────────────────────── */
	.insp-header {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-3) var(--sp-4);
		border-bottom: 1px solid var(--line-soft);
		position: sticky;
		top: 0;
		background: var(--panel);
		z-index: 2;
		box-shadow: var(--shadow-1);
	}

	.kind-dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-pill);
		background: var(--kc);
		flex: 0 0 auto;
	}

	.kind-label {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--kc);
		letter-spacing: .01em;
	}

	.tool-name {
		font-size: var(--fs-xs);
		color: var(--muted);
		background: var(--panel-3);
		padding: 2px var(--sp-2);
		border-radius: var(--radius-sm);
		max-width: 160px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.grow {
		flex: 1;
	}

	.turn-badge {
		font-size: var(--fs-xs);
		color: var(--faint);
	}

	.close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: none;
		color: var(--muted);
		padding: var(--sp-1);
		border-radius: var(--radius-sm);
		transition: background var(--dur-fast) var(--ease-out),
		            color var(--dur-fast) var(--ease-out);
	}
	.close-btn:hover {
		background: var(--panel-3);
		color: var(--text);
	}

	/* kind color variables */
	.k-user       { --kc: var(--k-user); }
	.k-text        { --kc: var(--k-text); }
	.k-thinking    { --kc: var(--k-thinking); }
	.k-tool_call   { --kc: var(--k-tool_call); }
	.k-tool_result { --kc: var(--k-tool_result); }

	/* ── Meta row ────────────────────────────────────────────── */
	.meta-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
		padding: var(--sp-2) var(--sp-4);
		border-bottom: 1px solid var(--line-soft);
	}

	.meta-pills {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex-wrap: wrap;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		font-weight: 500;
		padding: 2px var(--sp-2);
		border-radius: var(--radius-pill);
		letter-spacing: .01em;
	}

	.pill-dot {
		width: 6px;
		height: 6px;
		border-radius: var(--radius-pill);
		background: currentColor;
		flex: 0 0 auto;
	}

	.pill-ok {
		color: var(--ok);
		background: color-mix(in srgb, var(--ok) 14%, transparent);
	}

	.pill-warn {
		color: var(--warn);
		background: color-mix(in srgb, var(--warn) 14%, transparent);
	}

	.pill-accent {
		color: var(--accent);
		background: var(--accent-soft);
		gap: 5px;
	}

	.tok-count {
		font-size: var(--fs-xs);
		color: var(--muted);
		display: inline-flex;
		align-items: baseline;
		gap: 3px;
	}

	.tok-orig {
		color: var(--faint);
		text-decoration: line-through;
	}

	.tok-sep {
		color: var(--faint);
	}

	.tok-eff {
		color: var(--text);
		font-weight: 600;
	}

	.tok-unit {
		color: var(--faint);
	}

	.meta-actions {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex-shrink: 0;
	}

	/* ── Shared action button ───────────────────────────────── */
	.action-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 4px var(--sp-2);
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		font-weight: 500;
		transition: background var(--dur-fast) var(--ease-out),
		            border-color var(--dur-fast) var(--ease-out),
		            color var(--dur-fast) var(--ease-out);
	}

	.action-btn:hover {
		background: var(--panel-4);
		border-color: var(--line-strong);
	}

	.action-btn.action-active {
		background: var(--accent-soft);
		border-color: var(--accent-dim);
		color: var(--accent);
	}

	.action-btn.action-active:hover {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		border-color: var(--accent);
	}

	.action-btn.action-disabled,
	.action-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.action-btn.action-disabled:hover,
	.action-btn:disabled:hover {
		background: var(--panel-3);
		border-color: var(--line);
		color: var(--text);
	}

	/* ── Body ────────────────────────────────────────────────── */
	.body-wrap {
		padding: var(--sp-4);
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}

	/* Folded digest callout */
	.digest-callout {
		background: var(--panel-2);
		border-left: 3px solid var(--warn);
		border-radius: var(--radius-sm);
		padding: var(--sp-3);
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
	}

	.digest-label {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--warn);
		text-transform: uppercase;
		letter-spacing: .05em;
	}

	.digest-text {
		margin: 0;
		font-size: var(--fs-sm);
		color: var(--muted);
		white-space: pre-wrap;
		word-break: break-word;
		line-height: 1.5;
	}

	.body-divider {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}

	.body-divider::before,
	.body-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--line-soft);
	}

	.body-divider-label {
		font-size: var(--fs-xs);
		color: var(--faint);
		text-transform: uppercase;
		letter-spacing: .05em;
		font-weight: 500;
		white-space: nowrap;
	}

	.content {
		margin: 0;
		padding: 0;
		font-size: var(--fs-base);
		line-height: 1.6;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: var(--sans);
	}

	.content-mono {
		font-family: var(--mono);
		font-size: var(--fs-sm);
		color: var(--muted);
		line-height: 1.55;
	}

	.clip-note {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--faint);
		font-family: var(--mono);
	}

	/* ── Partner section ────────────────────────────────────── */
	.partner-section {
		border-top: 1px solid var(--line-soft);
		padding: var(--sp-4);
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}

	.partner-header {
		display: flex;
		align-items: baseline;
		gap: var(--sp-2);
	}

	.partner-label {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--faint);
		text-transform: uppercase;
		letter-spacing: .05em;
	}

	.partner-meta {
		font-size: var(--fs-xs);
		color: var(--faint);
		font-weight: 400;
	}

	.partner-toggle {
		align-self: flex-start;
	}

	.partner-preview {
		margin: 0;
		padding: var(--sp-3);
		background: var(--panel-2);
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
		color: var(--faint);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 180px;
		overflow-y: auto;
		line-height: 1.5;
	}
</style>
