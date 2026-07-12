<script lang="ts">
	import { fly } from "svelte/transition";
	import { cubicOut } from "svelte/easing";
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { Block, Group } from "../../engine/types";
	import Icon from "$lib/ui/Icon.svelte";

	let {
		store,
		block,
		group,
		onselect,
		onclose,
	}: {
		store: AccordionStore;
		block: Block | null;
		group: Group | null;
		onselect: (id: string) => void;
		onclose: () => void;
	} = $props();

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

	// Involvement locks (ADR 0011): under `human-steering` the human's fold / unfold / pin /
	// group / reset controls are the conductor's, so they show disabled — the honest mirror of
	// the engine's no-op. Observation (this whole panel's content, the digest, the partner
	// preview) is NEVER gated; only the mutating buttons are. Drive purely off `store.isLocked`
	// so it's correct in preview/demo/read-only too.
	const steerLocked = $derived(store.isLocked("human-steering"));
	const lockTip = $derived(
		`Locked by ${store.lockingConductorLabel ?? "the active conductor"} — detach to take back control`,
	);

	// the call/result partner — they're separate blocks sharing a callId
	const partner = $derived.by<Block | null>(() => {
		if (!block?.callId) return null;
		return store.blocks.find((x) => x.id !== block.id && x.callId === block.callId) ?? null;
	});
	const partnerProtected = $derived(partner ? store.isProtected(partner) : false);

	// Can the human fold this block / its partner right now? The single engine predicate the
	// fold controls consult, so the Inspector never offers a fold the wire would refuse (a live
	// user/tool_call) — matching ContextMap. Unfold of an already-folded block always stays.
	const canFoldBlock = $derived(block ? store.canFold(block) : false);
	const canFoldPartner = $derived(partner ? store.canFold(partner) : false);
	const partnerFolded = $derived(partner ? store.isFolded(partner) : false);

	function body(b: Block): { text: string; clipped: number } {
		const t = b.text ?? "";
		return t.length > CAP ? { text: t.slice(0, CAP) + "…", clipped: t.length } : { text: t, clipped: 0 };
	}

	const bd = $derived(block ? body(block) : { text: "", clipped: 0 });

	const isMono = $derived(block?.kind === "tool_call" || block?.kind === "tool_result");

	// Block mode: is this block part of a group? Used to render the "part of group" link.
	const inGroup = $derived(block ? store.groupOf(block) : null);

	// Group mode derived values
	const gMembers = $derived(group ? store.groupMembers(group) : []);
	const gFullTok = $derived(group ? store.groupFullTokens(group) : 0);
	const gLiveTok = $derived(group ? store.groupLiveTokens(group) : 0);
	const gSavedTok = $derived(group ? store.groupSavedTokens(group) : 0);
	const gStrag = $derived(group ? store.groupStragglerCount(group) : 0);
	const gIsDropGroup = $derived(group ? store.isDropGroup(group) : false);
	// The EXACT summary the agent receives for this group: the conductor's custom digest
	// (e.g. naive compaction's LLM summary) when present, else the deterministic structural
	// recap. Mirrors the wire (`plan.ts` → `store.groupSummary`) so this "shown to agent"
	// panel never diverges from what the agent actually sees. (Drop groups return ""; this
	// derived is only rendered in the non-drop branch.)
	const gDigest = $derived(group ? store.groupSummary(group) : "");
	const gTurnFirst = $derived(gMembers.length > 0 ? gMembers[0].turn : 0);
	const gTurnLast = $derived(gMembers.length > 0 ? gMembers[gMembers.length - 1].turn : 0);

	function gTurnLabel(): string {
		if (gMembers.length === 0) return "";
		if (gTurnFirst === gTurnLast) return gTurnFirst === 0 ? "preamble" : `turn ${gTurnFirst}`;
		if (gTurnFirst === 0) return `preamble–turn ${gTurnLast}`;
		return `turns ${gTurnFirst}–${gTurnLast}`;
	}
</script>

{#if group}
	<!-- ── GROUP MODE ──────────────────────────────────────────── -->
	<aside class="insp" transition:fly={{ x: 24, duration: 200, easing: cubicOut, opacity: 0 }}>
		<!-- ── Header ─────────────────────────────────────────────── -->
		<header class="insp-header">
			<span class="group-dot"></span>
			<span class="eyebrow group-eyebrow">Group</span>
			<span class="header-count mono">{gMembers.length} blocks</span>
			<span class="grow"></span>
			<span class="turn-badge mono">{gTurnLabel()}</span>
			<button class="close-btn" onclick={onclose} aria-label="Close inspector" title="Close">
				<Icon name="x" size={16} />
			</button>
		</header>

		<!-- ── Meta section ───────────────────────────────────────── -->
		<div class="meta-section">
			<span class="eyebrow">Status</span>
			<div class="meta-row">
				<div class="meta-pills">
					{#if group.folded}
						<span class="pill pill-warn">
							<span class="pill-dot"></span>folded
						</span>
					{:else}
						<span class="pill pill-ok">
							<span class="pill-dot"></span>live
						</span>
					{/if}
					{#if gStrag > 0}
						<span class="pill pill-accent" title="{gStrag} member(s) kept live (split tool pair)">
							{gStrag} kept live
						</span>
					{/if}
				</div>
				<!-- Token data row: tabular mono -->
				<div class="tok-table mono">
					<span class="tok-row">
						<span class="tok-key">full</span>
						<span class="tok-val">{fmt(gFullTok)}</span>
					</span>
					<span class="tok-sep-char">→</span>
					<span class="tok-row">
						<span class="tok-key">live</span>
						<span class="tok-val">{fmt(gLiveTok)}</span>
					</span>
					{#if gSavedTok > 0}
						<span class="tok-saved mono">saves {fmt(gSavedTok)}</span>
					{/if}
				</div>
			</div>

			<!-- Actions -->
			<div class="action-row">
				{#if group.folded}
					<button
						class="action-btn action-primary"
						class:action-disabled={steerLocked}
						disabled={steerLocked}
						aria-disabled={steerLocked}
						onclick={() => store.unfoldGroup(group!.id)}
						title={steerLocked ? lockTip : "Unfold group to context"}
					>
						<Icon name="chevrons-up-down" size={14} />
						Unfold to context
					</button>
					<button
						class="action-btn action-danger"
						class:action-disabled={steerLocked}
						disabled={steerLocked}
						aria-disabled={steerLocked}
						onclick={() => { store.deleteGroup(group!.id); onclose(); }}
						title={steerLocked ? lockTip : "Delete group"}
					>
						<Icon name="trash-2" size={14} />
						Delete
					</button>
				{:else}
					<button
						class="action-btn action-outline"
						class:action-disabled={steerLocked}
						disabled={steerLocked}
						aria-disabled={steerLocked}
						onclick={() => store.foldGroup(group!.id)}
						title={steerLocked ? lockTip : "Re-fold group"}
					>
						<Icon name="chevrons-down-up" size={14} />
						Re-fold
					</button>
					<button
						class="action-btn action-danger"
						class:action-disabled={steerLocked}
						disabled={steerLocked}
						aria-disabled={steerLocked}
						onclick={() => { store.deleteGroup(group!.id); onclose(); }}
						title={steerLocked ? lockTip : "Delete group"}
					>
						<Icon name="trash-2" size={14} />
						Delete
					</button>
				{/if}
			</div>
		</div>

		<!-- ── Body: group digest ─────────────────────────────────── -->
		<div class="body-wrap">
			<span class="eyebrow section-eyebrow">
				{gIsDropGroup ? "Drop group" : "Digest — shown to agent"}
			</span>
			{#if gIsDropGroup}
				<div class="digest-callout digest-callout-drop">
					<div class="digest-label digest-label-drop">
						<Icon name="chevrons-down-up" size={12} stroke={2} />
						Removed from wire
					</div>
					<p class="drop-note">The agent does not see this block</p>
				</div>
			{:else}
				<div class="digest-callout">
					<pre class="digest-text mono">{gDigest}</pre>
				</div>
			{/if}
		</div>
	</aside>
{:else if block}
	<!-- ── BLOCK MODE ──────────────────────────────────────────── -->
	<aside class="insp" transition:fly={{ x: 24, duration: 200, easing: cubicOut, opacity: 0 }}>
		<!-- ── Header ─────────────────────────────────────────────── -->
		<header class="insp-header">
			<!-- Kind spine accent -->
			<span class="kind-dot k-{block.kind}"></span>
			<!-- Kind eyebrow — tinted with the spectrum hue -->
			<span class="eyebrow kind-eyebrow k-{block.kind}">{KIND_LABEL[block.kind]}</span>
			{#if block.toolName}
				<span class="tool-name mono">{block.toolName}</span>
			{/if}
			{#if inGroup}
				<button class="group-link" onclick={() => onselect(inGroup.id)} title="Go to group">
					<Icon name="layers" size={11} />
					group
				</button>
			{/if}
			<span class="grow"></span>
			<span class="turn-badge mono">turn {block.turn}</span>
			<button class="close-btn" onclick={onclose} aria-label="Close inspector" title="Close">
				<Icon name="x" size={16} />
			</button>
		</header>

		<!-- ── Meta section ───────────────────────────────────────── -->
		<div class="meta-section">
			<span class="eyebrow">Block data</span>
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
				</div>
				<!-- Token data: tabular mono -->
				<div class="tok-table mono">
					{#if folded}
						<span class="tok-row">
							<span class="tok-key">full</span>
							<span class="tok-val tok-struck">{fmt(block.tokens)}</span>
						</span>
						<span class="tok-sep-char">→</span>
						<span class="tok-row">
							<span class="tok-key">live</span>
							<span class="tok-val tok-live">{fmt(store.effTokens(block))}</span>
						</span>
					{:else}
						<span class="tok-row">
							<span class="tok-key">tokens</span>
							<span class="tok-val tok-live">{fmt(block.tokens)}</span>
						</span>
					{/if}
				</div>
			</div>

			<!-- Actions -->
			<div class="action-row">
				<button
					class="action-btn"
					class:action-primary={folded}
					class:action-outline={!folded && canFoldBlock}
					class:action-disabled={steerLocked || (!folded && !canFoldBlock)}
					disabled={steerLocked || (!folded && !canFoldBlock)}
					aria-disabled={steerLocked}
					title={steerLocked
						? lockTip
						: folded
							? "Unfold block"
							: canFoldBlock
								? "Fold block"
								: protect
									? "Protected working tail — never folded"
									: pinned
										? "Pinned — unpin to fold"
										: "Only text, thinking & tool results can fold"}
					onclick={() => store.toggle(block!.id)}
				>
					<Icon name={folded ? "chevrons-up-down" : "chevrons-down-up"} size={14} />
					{folded ? "Unfold" : "Fold"}
				</button>
				<button
					class="action-btn"
					class:action-outline={!pinned}
					class:action-active={pinned}
					class:action-disabled={steerLocked}
					disabled={steerLocked}
					aria-disabled={steerLocked}
					onclick={() => (pinned ? store.unpin(block!.id) : store.pin(block!.id))}
					title={steerLocked ? lockTip : pinned ? "Unpin block" : "Pin block (keeps it live)"}
				>
					<Icon name={pinned ? "pin-off" : "pin"} size={14} />
					{pinned ? "Unpin" : "Pin"}
				</button>
			</div>
		</div>

		<!-- ── Body ───────────────────────────────────────────────── -->
		<div class="body-wrap">
			{#if folded}
				<span class="eyebrow section-eyebrow">Digest — shown to agent</span>
				<div class="digest-callout">
					<pre class="digest-text mono">{store.digestOf(block)}</pre>
				</div>
				<div class="body-divider">
					<span class="body-divider-label eyebrow">Full content</span>
				</div>
			{:else}
				<span class="eyebrow section-eyebrow">Content</span>
			{/if}

			<pre
				class="content"
				class:content-mono={isMono}
			>{bd.text}</pre>

			{#if bd.clipped}
				<p class="clip-note mono">
					showing first {fmt(CAP)} of {fmt(bd.clipped)} chars
				</p>
			{/if}
		</div>

		<!-- ── Partner ────────────────────────────────────────────── -->
		{#if partner}
			<div class="partner-section">
				<div class="partner-header">
					<span class="eyebrow">
						{partner.kind === "tool_result" ? "Result produced" : "Call that produced this"}
					</span>
					<span class="partner-meta mono">
						{partnerFolded ? "folded" : "live"} · {fmt(store.effTokens(partner))} tok
					</span>
				</div>

				<button
					class="action-btn"
					class:action-outline={!partnerFolded && canFoldPartner}
					class:action-primary={partnerFolded}
					class:action-disabled={steerLocked || (!partnerFolded && !canFoldPartner)}
					disabled={steerLocked || (!partnerFolded && !canFoldPartner)}
					aria-disabled={steerLocked}
					title={steerLocked
						? lockTip
						: partnerFolded
							? "Unfold partner"
							: canFoldPartner
								? "Fold partner"
								: partnerProtected
									? "Protected — never folded"
									: partner?.override === "pinned"
										? "Pinned — unpin to fold"
										: "Only text, thinking & tool results can fold"}
					onclick={() => store.toggle(partner!.id)}
				>
					<Icon name="corner-down-right" size={14} />
					{partnerFolded ? "Unfold" : canFoldPartner ? "Fold" : partnerProtected ? "Protected" : "Fold"} partner
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

	/* ── Mono eyebrow — brand signature device ───────────────── */
	.eyebrow {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--faint);
		line-height: 1;
		white-space: nowrap;
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

	/* Kind eyebrow inherits brand eyebrow style but is tinted with the spectrum hue */
	.kind-eyebrow {
		color: var(--kc);
		font-weight: 500;
		letter-spacing: 0.1em;
	}

	/* Group header eyebrow */
	.group-eyebrow {
		color: var(--group-accent);
		font-weight: 500;
		letter-spacing: 0.1em;
	}

	.header-count {
		font-size: var(--fs-xs);
		color: var(--faint);
		letter-spacing: 0.06em;
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

	/* Turn badge: data → mono */
	.turn-badge {
		font-size: var(--fs-xs);
		color: var(--faint);
		letter-spacing: 0.06em;
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
		cursor: pointer;
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

	/* ── Meta section ────────────────────────────────────────── */
	.meta-section {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		padding: var(--sp-3) var(--sp-4) var(--sp-4);
		border-bottom: 1px solid var(--line-soft);
	}

	.meta-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
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

	/* Token table: tabular mono data display */
	.tok-table {
		display: flex;
		align-items: baseline;
		gap: var(--sp-2);
		font-size: var(--fs-xs);
		color: var(--muted);
		flex-shrink: 0;
	}
	.tok-row {
		display: flex;
		align-items: baseline;
		gap: 4px;
	}
	.tok-key {
		color: var(--faint);
		font-size: var(--fs-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.tok-val {
		color: var(--text);
		font-weight: 600;
	}
	.tok-live {
		color: var(--text);
	}
	.tok-struck {
		color: var(--faint);
		text-decoration: line-through;
	}
	.tok-sep-char {
		color: var(--faint);
		font-size: var(--fs-xs);
	}
	.tok-saved {
		color: var(--ok);
		font-size: var(--fs-xs);
	}

	/* Action row: buttons laid out in a flex row */
	.action-row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex-wrap: wrap;
	}

	/* ── Button system (brand spec) ─────────────────────────── */

	/* Base action button — secondary/outline variant */
	.action-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		background: transparent;
		border: 1px solid var(--line-strong);
		color: var(--text);
		padding: 5px var(--sp-3);
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		font-weight: 500;
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease-out),
		            border-color var(--dur-fast) var(--ease-out),
		            color var(--dur-fast) var(--ease-out);
	}
	.action-btn:hover {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	/* Primary: Paper solid — white-on-ink, main positive CTA */
	.action-btn.action-primary {
		background: var(--paper);
		color: var(--ink);
		border-color: var(--paper);
		font-weight: 600;
	}
	.action-btn.action-primary:hover {
		background: #ffffff;
		border-color: #ffffff;
	}

	/* Outline: explicit secondary */
	.action-btn.action-outline {
		background: transparent;
		border-color: var(--line-strong);
		color: var(--text);
	}
	.action-btn.action-outline:hover {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	/* Active / pinned state */
	.action-btn.action-active {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 50%, transparent);
		color: var(--accent);
	}
	.action-btn.action-active:hover {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		border-color: var(--accent);
	}

	/* Disabled */
	.action-btn.action-disabled,
	.action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.action-btn.action-disabled:hover,
	.action-btn:disabled:hover {
		background: transparent;
		border-color: var(--line-strong);
		color: var(--text);
	}

	/* Danger variant: revealed on hover */
	.action-btn.action-danger {
		border-color: var(--line);
		color: var(--muted);
	}
	.action-btn.action-danger:hover {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 55%, transparent);
		background: color-mix(in srgb, var(--danger) 10%, transparent);
	}
	.action-btn.action-danger.action-disabled:hover,
	.action-btn.action-danger:disabled:hover {
		color: var(--muted);
		border-color: var(--line);
		background: transparent;
	}

	/* ── Body ────────────────────────────────────────────────── */
	.body-wrap {
		padding: var(--sp-4);
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}

	.section-eyebrow {
		display: block;
		margin-bottom: var(--sp-1);
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

	/* Drop group variant: muted palette */
	.digest-callout-drop {
		border-left-color: var(--faint);
		opacity: 0.75;
	}

	/* In group mode the callout has no separate label row — eyebrow is above */
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

	.digest-label-drop {
		color: var(--faint);
	}

	.digest-text {
		margin: 0;
		font-size: var(--fs-sm);
		color: var(--muted);
		white-space: pre-wrap;
		word-break: break-word;
		line-height: 1.5;
	}

	/* Muted note shown instead of a digest for drop groups. */
	.drop-note {
		margin: 0;
		font-size: var(--fs-sm);
		font-style: italic;
		color: var(--faint);
		line-height: 1.5;
	}

	.body-divider {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		margin: var(--sp-1) 0;
	}

	.body-divider::before,
	.body-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--line-soft);
	}

	.body-divider-label {
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
		letter-spacing: 0.04em;
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
		justify-content: space-between;
		gap: var(--sp-2);
	}

	.partner-meta {
		font-size: var(--fs-xs);
		color: var(--faint);
		letter-spacing: 0.04em;
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

	/* ── Group mode ─────────────────────────────────────────────── */
	.group-dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-pill);
		background: var(--group-accent);
		flex: 0 0 auto;
	}

	/* "Part of a group" chip in block mode header */
	.group-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: color-mix(in srgb, var(--group-accent) 12%, var(--panel-2));
		border: 1px solid color-mix(in srgb, var(--group-accent) 40%, transparent);
		color: var(--group-accent);
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 400;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		border-radius: var(--radius-pill);
		padding: 2px 8px;
		cursor: pointer;
		white-space: nowrap;
		transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
	}
	.group-link:hover {
		background: color-mix(in srgb, var(--group-accent) 22%, var(--panel-2));
		border-color: color-mix(in srgb, var(--group-accent) 70%, transparent);
	}
</style>
