/*
 * notice.svelte.ts — client-side state for the generic `notice` broadcast (protocol v17). A server
 * `notice` message is a minimal, one-off informational toast (first use: pi compacted the session
 * natively while folding was off — see `session_compact` in extension/accordion.ts). Single latest
 * notice only, no queue: a second notice simply replaces the first, matching the spec's "keep it
 * small and simple" — mirrors `demotionToast`'s shape in controllerUi.svelte.ts (own module since a
 * generic notice is not a controller-lease concept).
 */
const NOTICE_TOAST_MS = 5_000;

export const notice = $state<{ show: boolean; text: string }>({ show: false, text: "" });
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Called from `liveClient`'s `notice` message handler. Auto-dismisses after ~5s. */
export function showNotice(text: string): void {
	notice.text = text;
	notice.show = true;
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		notice.show = false;
	}, NOTICE_TOAST_MS);
}

export function dismissNotice(): void {
	notice.show = false;
	clearTimeout(noticeTimer);
	noticeTimer = undefined;
}
