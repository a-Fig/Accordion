<script lang="ts">
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { Block } from "../../engine/types";

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

	// the call/result partner — they're separate blocks sharing a callId
	const partner = $derived.by<Block | null>(() => {
		if (!block?.callId) return null;
		return store.blocks.find((x) => x.id !== block.id && x.callId === block.callId) ?? null;
	});

	function body(b: Block): { text: string; clipped: number } {
		const t = b.text ?? "";
		return t.length > CAP ? { text: t.slice(0, CAP) + "…", clipped: t.length } : { text: t, clipped: 0 };
	}

	const bd = $derived(block ? body(block) : { text: "", clipped: 0 });
</script>

{#if block}
	<aside class="insp">
		<header>
			<span class="kind k-{block.kind}">{KIND_LABEL[block.kind]}</span>
			{#if block.toolName}<span class="tool mono">{block.toolName}</span>{/if}
			<span class="turn">turn {block.turn}</span>
			<span class="grow"></span>
			<button class="x" onclick={onclose} aria-label="Close inspector" title="Close">✕</button>
		</header>

		<div class="meta">
			{#if folded}
				<span class="state folded">folded</span>
				<span class="mono"><s>{fmt(block.tokens)}</s> → <b>{fmt(store.effTokens(block))}</b> tok</span>
			{:else}
				<span class="state live">live</span>
				<span class="mono">{fmt(block.tokens)} tok</span>
			{/if}
			<span class="grow"></span>
			<button class="btn" onclick={() => store.toggle(block.id)}>{folded ? "Unfold" : "Fold"}</button>
			<button class="btn" class:on={pinned} onclick={() => (pinned ? store.unpin(block.id) : store.pin(block.id))}>
				{pinned ? "Unpin" : "Pin"}
			</button>
		</div>

		{#if folded}
			<div class="digestlbl">Digest in context now</div>
			<pre class="digest mono">{store.digestOf(block)}</pre>
			<div class="digestlbl">Full content (kept on disk, restored on unfold)</div>
		{/if}
		<pre class="content" class:mono={block.kind === "tool_call" || block.kind === "tool_result"}>{bd.text}</pre>
		{#if bd.clipped}
			<div class="clip mono">showing first {fmt(CAP)} of {fmt(bd.clipped)} chars</div>
		{/if}

		{#if partner}
			<div class="partner">
				<div class="plbl">
					{partner.kind === "tool_result" ? "↳ Result it produced" : "↰ Call that produced this"}
					<span class="mono dim">{store.isFolded(partner) ? "folded" : "live"} · {fmt(store.effTokens(partner))} tok</span>
				</div>
				<button class="jump" onclick={() => store.toggle(partner.id)}>
					{store.isFolded(partner) ? "Unfold" : "Fold"} partner
				</button>
				<pre class="content sub mono">{body(partner).text}</pre>
			</div>
		{/if}
	</aside>
{/if}

<style>
	.insp {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--panel);
		border-left: 1px solid var(--line);
		overflow-y: auto;
	}
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--line);
		position: sticky;
		top: 0;
		background: var(--panel);
		z-index: 2;
	}
	.kind {
		font-weight: 700;
		font-size: 14px;
		color: var(--kc);
	}
	.tool {
		font-size: 11px;
		background: var(--panel-3);
		padding: 1px 6px;
		border-radius: 4px;
		color: var(--text);
	}
	.turn {
		font-size: 11px;
		color: var(--faint);
	}
	.grow {
		flex: 1;
	}
	.x {
		background: transparent;
		border: none;
		color: var(--muted);
		font-size: 14px;
		padding: 2px 6px;
		border-radius: 5px;
	}
	.x:hover {
		color: var(--text);
		background: var(--panel-3);
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		font-size: 12px;
		color: var(--muted);
		border-bottom: 1px solid var(--line-soft);
	}
	.state {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 7px;
		border-radius: 999px;
		font-weight: 600;
	}
	.state.live {
		color: var(--ok);
		background: color-mix(in srgb, var(--ok) 16%, transparent);
	}
	.state.folded {
		color: var(--warn);
		background: color-mix(in srgb, var(--warn) 16%, transparent);
	}
	.meta s {
		color: var(--faint);
	}
	.meta b {
		color: var(--text);
	}
	.btn {
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 4px 11px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		font-weight: 600;
	}
	.btn:hover {
		background: var(--line);
	}
	.btn.on {
		color: var(--accent);
		border-color: var(--accent-dim);
	}

	.digestlbl {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--faint);
		font-weight: 600;
		padding: 12px 14px 4px;
	}
	.digest {
		margin: 0 14px;
		padding: 9px 11px;
		background: var(--panel-2);
		border: 1px dashed var(--line);
		border-radius: var(--radius-sm);
		font-size: 12px;
		color: var(--warn);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.content {
		margin: 8px 14px 0;
		padding: 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: var(--sans);
	}
	.content.mono {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--muted);
	}
	.clip {
		padding: 6px 14px 0;
		font-size: 10px;
		color: var(--faint);
	}

	.partner {
		margin: 16px 0 18px;
		border-top: 1px solid var(--line);
		padding-top: 12px;
	}
	.plbl {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 0 14px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}
	.plbl .dim {
		color: var(--faint);
		font-weight: 400;
		font-size: 11px;
	}
	.jump {
		margin: 6px 14px 0;
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--muted);
		padding: 3px 9px;
		border-radius: var(--radius-sm);
		font-size: 11px;
	}
	.jump:hover {
		color: var(--text);
	}
	.content.sub {
		color: var(--faint);
		max-height: 180px;
		overflow-y: auto;
	}
	.k-user { --kc: var(--k-user); }
	.k-text { --kc: var(--k-text); }
	.k-thinking { --kc: var(--k-thinking); }
	.k-tool_call { --kc: var(--k-tool_call); }
	.k-tool_result { --kc: var(--k-tool_result); }
</style>
