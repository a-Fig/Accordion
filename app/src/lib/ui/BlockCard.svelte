<script lang="ts">
	import { slide } from "svelte/transition";
	import type { AccordionStore } from "../engine/store.svelte";
	import type { Block } from "../engine/types";

	let { store, block }: { store: AccordionStore; block: Block } = $props();

	const folded = $derived(store.isFolded(block));
	const pinned = $derived(block.override === "pinned");

	const KIND_LABEL: Record<Block["kind"], string> = {
		user: "User",
		text: "Reply",
		thinking: "Thinking",
		tool_call: "Tool call",
		tool_result: "Tool result",
	};

	// Cap rendered text so a 40KB tool_result doesn't bloat the DOM.
	const preview = $derived(block.text.length > 700 ? block.text.slice(0, 700) + "…" : block.text);
	const fmt = (n: number) => n.toLocaleString();
</script>

<article
	class="card k-{block.kind}"
	class:folded
	class:pinned
	id="block-{block.id}"
	data-order={block.order}
>
	<div class="accent"></div>
	<div class="body">
		<header>
			<span class="kind">{KIND_LABEL[block.kind]}</span>
			{#if block.toolName}<span class="tool mono">{block.toolName}</span>{/if}
			<span class="turn">·&nbsp;turn {block.turn}</span>
			<span class="grow"></span>

			{#if folded}
				<span class="chip" class:auto={block.by === "auto"}>
					{block.by === "auto" ? "auto" : block.by === "agent" ? "agent" : "folded"}
				</span>
			{/if}
			{#if folded}
				<span class="tok comp mono" title="folded: {fmt(block.tokens)} → {fmt(store.effTokens(block))} tokens">
					<s>{fmt(block.tokens)}</s>&nbsp;→&nbsp;<b>{fmt(store.effTokens(block))}</b><span class="unit">t</span>
				</span>
			{:else}
				<span class="tok mono" title="estimated tokens">{fmt(block.tokens)}<span class="unit">t</span></span>
			{/if}

			<button
				class="act pin"
				class:on={pinned}
				title={pinned ? "Unpin" : "Pin open (never auto-folds)"}
				onclick={() => (pinned ? store.unpin(block.id) : store.pin(block.id))}
				aria-label="pin"
			>
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
					<path
						d="M9.5 1.5l5 5-2 .4-2.6 2.6.3 3.4L8 10.5 3.8 14.7 2.5 13.5 6.9 9 4 6.9l3.4.3L10 4.6l-.5-3.1z"
						fill="currentColor"
					/>
				</svg>
			</button>
			<button
				class="act"
				title={folded ? "Unfold to full detail" : "Fold to a digest"}
				onclick={() => store.toggle(block.id)}
				aria-label={folded ? "unfold" : "fold"}
			>
				<svg viewBox="0 0 16 16" width="14" height="14" class="chev" class:up={!folded} aria-hidden="true">
					<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</button>
		</header>

		{#if folded}
			<div class="digest mono" transition:slide={{ duration: 200 }}>{store.digestOf(block)}</div>
		{:else}
			<div class="content" class:mono={block.kind === "tool_call" || block.kind === "tool_result"} transition:slide={{ duration: 200 }}>{preview}</div>
		{/if}
	</div>
</article>

<style>
	.card {
		position: relative;
		display: flex;
		/* live = raised: solid surface, border, a little elevation */
		background: var(--panel);
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-sm);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
		overflow: hidden;
		transition: background 160ms ease, border-color 160ms ease, opacity 160ms ease, margin-left 160ms ease;
		/* Skip layout/paint for off-screen cards — keeps thousands of blocks smooth. */
		content-visibility: auto;
		contain-intrinsic-size: auto 56px;
	}
	.card:hover {
		border-color: var(--line);
		background: var(--panel-2);
	}
	/* folded = tucked away: indented, dimmed, flat/recessed, separated by a dashed crease */
	.card.folded {
		background: transparent;
		border-color: transparent;
		border-bottom: 1px dashed var(--line);
		border-radius: 0;
		box-shadow: none;
		opacity: 0.5;
		margin-left: 16px;
	}
	.card.folded:hover {
		opacity: 1;
		background: var(--panel);
		border-bottom-color: transparent;
	}
	.accent {
		width: 3px;
		flex: 0 0 3px;
		background: var(--kc);
	}
	/* live accent is a solid bar; folded accent breaks into a dashed pleat */
	.card.folded .accent {
		background: transparent;
		background-image: repeating-linear-gradient(0deg, var(--kc) 0 2px, transparent 2px 5px);
	}
	.body {
		flex: 1;
		min-width: 0;
		padding: 7px 9px 9px;
	}
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	.kind {
		color: var(--kc);
		font-weight: 600;
	}
	.tool {
		color: var(--text);
		font-size: 11px;
		background: var(--panel-3);
		padding: 1px 6px;
		border-radius: 4px;
	}
	.turn {
		color: var(--faint);
		font-size: 11px;
	}
	.grow {
		flex: 1;
	}
	.tok {
		color: var(--muted);
		font-size: 11px;
	}
	.tok .unit {
		opacity: 0.5;
		margin-left: 1px;
	}
	.tok.comp s {
		color: var(--faint);
		text-decoration-thickness: 1px;
	}
	.tok.comp b {
		color: var(--text);
		font-weight: 600;
	}
	.chip {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		background: var(--panel-3);
		padding: 1px 6px;
		border-radius: 999px;
	}
	.chip.auto {
		color: var(--warn);
	}

	.act {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 5px;
		color: var(--muted);
		transition: color 120ms ease, background 120ms ease;
	}
	.act:hover {
		color: var(--text);
		background: var(--panel-3);
	}
	.act.pin.on {
		color: var(--accent);
	}
	.chev {
		transition: transform 200ms ease;
	}
	.chev.up {
		transform: rotate(180deg);
	}

	.content {
		margin-top: 6px;
		font-size: 13px;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		overflow: hidden;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 6;
		line-clamp: 6;
	}
	.content.mono {
		font-size: 12px;
		color: var(--muted);
	}
	.digest {
		margin-top: 5px;
		font-size: 12px;
		color: var(--muted);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.k-user {
		--kc: var(--k-user);
	}
	.k-text {
		--kc: var(--k-text);
	}
	.k-thinking {
		--kc: var(--k-thinking);
	}
	.k-tool_call {
		--kc: var(--k-tool_call);
	}
	.k-tool_result {
		--kc: var(--k-tool_result);
	}
</style>
