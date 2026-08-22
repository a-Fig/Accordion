<script lang="ts">
	/*
	 * DigestEditor — the folded digest, editable in place.
	 *
	 * Folding replaces a block's content with a digest, and that digest is EXACTLY what the model
	 * receives. This component lets the human author it: click the text, type, save. The result is
	 * a `fold` op carrying `digest` (`Truth.opFold`'s human branch), stored verbatim and — unlike a
	 * conductor's recoverable `replace` — WITHOUT a `{#code FOLDED}` tag, so the agent gets no
	 * handle to unfold or recall what the human chose to hide. "Restore auto" clears the override
	 * and hands the engine digest (and its tag) back.
	 *
	 * IT IS ALWAYS A REAL TEXTAREA, never a click-to-swap `<pre>`. Selecting a word, dragging a
	 * range, and copy/paste all have to behave exactly as they do in any other text field, and the
	 * transcript row underneath binds BOTH click (inspect) and dblclick (fold/unfold) — a
	 * word-select double-click inside a swap-in editor would pop the block open mid-sentence. A
	 * permanently-live field with the row's gestures stopped at its edge sidesteps that entirely;
	 * unfolding stays on the row's own Fold/Unfold button, which already exists.
	 *
	 * `editable` false degrades to a plain `<pre>` — same type, same colour, no caret, nothing to
	 * discover and then be refused. Callers must pass false for every state where a save would be
	 * REFUSED, not just where it is forbidden: a `human-steering` lock, a non-controller surface,
	 * and — easy to miss — anything `Truth.canFold(b, "you")` rejects, which includes the protected
	 * working tail (a lock-free conductor's birth-fold puts a FOLDED block in there, and the human
	 * branch has no birth-fold exemption) and a block inside a folded group. A read-only Claude Code
	 * transcript is NOT one of those states: it has a local Truth and no wire, so editing is a
	 * legitimate preview — the RULE in CLAUDE.md requires preview to obey the same rules as
	 * steering, not to be more restrictive than it.
	 */
	import Icon from "$lib/ui/Icon.svelte";
	import { EMPTY_DIGEST, stripFoldTags } from "$core/digest";
	import { estTokens, BLOCK_OVERHEAD } from "$core/tokens";
	import { getDraft, setDraft, clearDraft } from "./digestDrafts";

	let {
		id,
		text,
		editable = true,
		isCustom = false,
		disabledTitle = "",
		fullTokens = 0,
		emptyMeans = "sentinel",
		savingsExact = true,
		onsave,
	}: {
		/** Block or group id — the draft key, and what the parent needs to route the save. */
		id: string;
		/** The COMMITTED digest: exactly what the agent receives right now. */
		text: string;
		/** False under a `human-steering` lock, on a non-controller surface, or in a CC transcript. */
		editable?: boolean;
		/** True when a human already authored this digest (enables "Restore auto"). */
		isCustom?: boolean;
		/** Tooltip explaining WHY editing is unavailable, when it is. */
		disabledTitle?: string;
		/** The block's/group's UNFOLDED cost, for the live savings readout. Raw estimate, matching
		 *  the estimate this component computes for the draft — the two must share a basis. */
		fullTokens?: number;
		/**
		 * What clearing the box actually does — the block/group asymmetry, made explicit.
		 *
		 * `"sentinel"` (a BLOCK): commits the `{empty}` literal. Per-block folding is content
		 * substitution and `applyPlan` drops an empty `digestText`, which would ship the block
		 * WHOLE — so there is no such thing as a zero-cost block here.
		 * `"drop"` (a GROUP): commits a real removal (`Group.digest === null`). A group may legally
		 * change the wire's message count, so the messages genuinely go — subject to the tool-pair
		 * fixpoint and role-validity floor, which can degrade it to a stub.
		 *
		 * The component needs this to predict what `text` will BECOME after a save, so the Save
		 * button clears itself when the write lands instead of hanging around forever.
		 */
		emptyMeans?: "sentinel" | "drop";
		/**
		 * May the savings delta (`fullTokens − draftTokens`) be shown as fact?
		 *
		 * True for a BLOCK, where it is exact: a folded block costs precisely `substTokens(subst)`,
		 * so full-minus-draft is what the wire really saves. FALSE for a GROUP, where it is not:
		 * `groupLiveTokens` also carries STRAGGLERS — members the wire must keep live because their
		 * id is non-durable or their tool-pair half sits outside the range — so full-minus-summary
		 * overstates the saving, sometimes badly. The Inspector's STATUS row already reports the
		 * engine's real FULL → LIVE → saves for a group, and this readout must not contradict it;
		 * when false, only the draft's own cost is shown.
		 */
		savingsExact?: boolean;
		/** `null` restores the engine digest; a string (possibly empty) is the human's own text. */
		onsave: (next: string | null) => void;
	} = $props();

	// `typed` is null until the user actually edits. While it is null the field TRACKS the committed
	// digest, so a conductor rewriting it (or a resnapshot landing) shows up immediately instead of
	// leaving a stale snapshot on screen. Once the user types, their text wins and nothing clobbers
	// it. The fallback in between is the client-local draft — what they had typed before an unfold
	// cleared `subst` in Truth.
	//
	// Callers must key this component on `id` (`{#key}` / an `{#each}` key), since `typed` is
	// deliberately NOT reset by an effect: remounting is both cheaper and less surprising than
	// carrying one block's half-written text onto another.
	let typed = $state<string | null>(null);
	let el = $state<HTMLTextAreaElement | null>(null);

	const draft = $derived(typed ?? getDraft(id) ?? text);
	const dirty = $derived(draft !== text);
	// `{empty}` is a saved state, not an empty field: the block is standing in for itself with three
	// tokens. Clearing the box entirely is how you ASK for that, so both read as "emptied".
	const emptied = $derived(draft.trim().length === 0 || (emptyMeans === "sentinel" && draft.trim() === EMPTY_DIGEST));
	/** What the committed `text` becomes once an emptied save lands. */
	const emptyCommitsTo = $derived(emptyMeans === "drop" ? "" : EMPTY_DIGEST);

	// What this digest will actually COST, live as you type. There is no length cap on the wire —
	// `isValidOp` accepts any string, deliberately, because a conductor's compaction summary is
	// legitimately long — so nothing stops a user pasting a wall of text that costs MORE than the
	// block it replaces. Rather than a cap that would break those conductors, show the number: a
	// negative saving reads as a warning and explains itself.
	// A dropped group costs nothing at all; an emptied block still pays for its sentinel.
	const draftTokens = $derived(
		emptied && emptyMeans === "drop" ? 0 : estTokens(emptied ? EMPTY_DIGEST : draft.trim()) + BLOCK_OVERHEAD,
	);
	const saved = $derived(savingsExact && fullTokens > 0 ? fullTokens - draftTokens : 0);
	/** Only a delta we can stand behind counts as "over budget"; otherwise it is just a cost. */
	const over = $derived(savingsExact && fullTokens > 0 && saved <= 0);

	/** Grow the field to its content — a digest is 1–3 lines, a pasted one can be many. */
	function autosize(node: HTMLTextAreaElement) {
		node.style.height = "auto";
		node.style.height = `${node.scrollHeight}px`;
	}
	$effect(() => {
		void draft;
		if (el) autosize(el);
	});

	function onInput(e: Event) {
		typed = (e.currentTarget as HTMLTextAreaElement).value;
		setDraft(id, typed, text);
	}

	function save() {
		if (!dirty) return;
		// Mirror `Truth.opFold`/`opGroup`'s human branches, which strip leading `{#code FOLDED}` tags
		// so the engine stays the sole author of them — same helper, so the two agree byte-for-byte. Doing it HERE too is not belt-and-braces: the box is
		// seeded with the current digest, so an edited engine digest still starts with the tag, and
		// if we sent it unstripped `typed` would predict a committed value the engine will never
		// produce — leaving Save dirty forever. Predict what actually lands.
		const t = stripFoldTags(draft).trim();
		// NOTE: the draft is deliberately NOT cleared here. A save can be refused outright — a
		// protected block, a block inside a folded group, a lost controller lease — and in demo/CC
		// mode the TxnResult is discarded, so a refusal is silent. Clearing now would leave the
		// user's only copy in `typed`, which the `{#key}` remount discards on the next block click:
		// the paragraph they just wrote would vanish with no message. The draft is cleared when the
		// commit is OBSERVED (the effect below), so a refusal simply leaves the text in the box.
		typed = t.length ? t : emptyCommitsTo;
		onsave(t);
	}

	// Commit observation: the moment `text` catches up with what we asked for, the write really
	// landed and the draft has served its purpose. Until then it stays, so a refused save keeps the
	// user's words recoverable.
	$effect(() => {
		if (typed !== null && typed === text) clearDraft(id);
	});

	function restoreAuto() {
		clearDraft(id);
		typed = null; // fall back to `text`, which the echoed event replaces with the engine digest
		onsave(null);
	}

	function revert() {
		clearDraft(id);
		typed = null;
		el?.blur();
	}

	function onKeydown(e: KeyboardEvent) {
		// The stage's arrow-key block navigation and the row's own handlers must not see anything
		// typed in here — including plain arrows, which move the caret.
		e.stopPropagation();
		if (e.key === "Escape") {
			e.preventDefault();
			revert();
		} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			save();
		}
	}
</script>

{#if editable}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="de"
		class:de-dirty={dirty}
		onclick={(e) => e.stopPropagation()}
		ondblclick={(e) => e.stopPropagation()}
		onkeydown={onKeydown}
		role="group"
	>
		<textarea
			bind:this={el}
			value={draft}
			oninput={onInput}
			class="de-field mono"
			class:de-emptied={emptied}
			rows="1"
			spellcheck="false"
			aria-label="Digest shown to the agent"
			placeholder={emptyMeans === "drop"
				? "Empty — remove these messages from the wire"
				: `Empty — the agent sees only ${EMPTY_DIGEST}`}
		></textarea>
		<div class="de-bar">
			{#if dirty}
				<button class="de-btn de-save" onclick={save} title="Save this digest (Ctrl/Cmd+Enter)">
					<Icon name="check" size={12} />
					Save
				</button>
				<button class="de-btn" onclick={revert} title="Discard changes (Esc)">Cancel</button>
			{/if}
			{#if isCustom && !dirty}
				<button class="de-btn" onclick={restoreAuto} title="Replace your text with the engine's generated digest">
					<Icon name="rotate-ccw" size={12} />
					Auto digest
				</button>
			{/if}
			{#if dirty && emptied}
				<span class="de-hint">
					{#if emptyMeans === "drop"}removes these messages{:else}saves as <code>{EMPTY_DIGEST}</code>{/if}
				</span>
			{/if}
			{#if fullTokens > 0}
				<span class="de-cost mono tnum" class:de-cost-bad={over}>
					~{draftTokens} tok{saved > 0 ? ` · −${saved}` : over ? ` · +${-saved} OVER` : ""}
				</span>
			{/if}
		</div>
	</div>
{:else}
	<pre class="digest-text mono" title={disabledTitle}>{text}</pre>
{/if}

<style>
	.de {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
	}

	/* Reads as the text it replaces until touched — no box, no chrome, just a caret. The border
	   only appears on hover/focus so a folded block still looks folded, not like a form. */
	.de-field {
		width: 100%;
		margin: 0;
		padding: 2px 4px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-family: var(--mono);
		font-size: var(--fs-sm);
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		overflow: hidden;
		resize: none;
	}
	.de-field:hover {
		border-color: var(--faint);
	}
	.de-field:focus {
		outline: none;
		border-color: var(--warn);
		background: var(--panel-2);
		color: var(--fg);
	}
	.de-field::placeholder {
		color: var(--faint);
		font-style: italic;
	}
	.de-emptied {
		font-style: italic;
	}

	.de-bar {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		min-height: 0;
	}
	.de-bar:empty {
		display: none;
	}
	.de-bar > :global(*) {
		flex: 0 0 auto;
	}

	.de-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 7px;
		border: 1px solid var(--faint);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-family: var(--sans);
		font-size: var(--fs-xs);
		cursor: pointer;
	}
	.de-btn:hover {
		color: var(--fg);
		border-color: var(--muted);
	}
	.de-save {
		border-color: var(--warn);
		color: var(--warn);
	}
	.de-save:hover {
		background: var(--warn);
		color: var(--bg);
		border-color: var(--warn);
	}

	.de-hint {
		font-size: var(--fs-xs);
		color: var(--faint);
	}

	/* Live cost of the draft. Pushed right so it reads as a status, not another control. */
	.de-cost {
		margin-left: auto;
		font-size: var(--fs-xs);
		color: var(--faint);
	}
	/* A digest that costs as much as (or more than) the block it replaces. */
	.de-cost-bad {
		color: var(--warn);
	}
	.de-hint code {
		font-family: var(--mono);
	}

	.digest-text {
		margin: 0;
		font-size: var(--fs-sm);
		color: var(--muted);
		white-space: pre-wrap;
		word-break: break-word;
		line-height: 1.5;
	}
</style>
