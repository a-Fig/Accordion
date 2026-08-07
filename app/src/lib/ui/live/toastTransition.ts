/*
 * toastTransition.ts — the one enter/exit transition every toast in `ToastRegion.svelte` uses.
 *
 * Why a custom transition instead of svelte/transition's `fly`/`fade`/`slide`: the region stacks
 * toasts vertically, and the spacing between them lives on each toast (`margin-bottom`, set by the
 * region — flex `gap` can't animate away with a departing child). For the survivor to slide up
 * smoothly when a sibling dismisses, the exiting toast must collapse EVERYTHING it contributes to
 * layout — content height, vertical padding, and its own margin-bottom — while it fades. The same
 * curve reversed gives entry: the toast expands open (pushing existing toasts down smoothly
 * instead of snapping them) as it fades in with a slight slide from the right.
 *
 * Toasts apply this with `|global` (`transition:toastPop|global`): the toast root lives inside the
 * toast component while the `{#if}` that mounts/unmounts it lives in `+page.svelte`, and a default
 * (local) transition would not play for an outer block's toggle.
 */
import { cubicOut } from "svelte/easing";
import type { TransitionConfig } from "svelte/transition";

export function toastPop(node: HTMLElement, { duration = 180 }: { duration?: number } = {}): TransitionConfig {
	const style = getComputedStyle(node);
	const height = node.offsetHeight;
	const marginBottom = parseFloat(style.marginBottom) || 0;
	const paddingTop = parseFloat(style.paddingTop) || 0;
	const paddingBottom = parseFloat(style.paddingBottom) || 0;
	return {
		duration,
		easing: cubicOut,
		css: (t) => `
			overflow: hidden;
			opacity: ${t};
			height: ${t * height}px;
			padding-top: ${t * paddingTop}px;
			padding-bottom: ${t * paddingBottom}px;
			margin-bottom: ${t * marginBottom}px;
			transform: translateX(${(1 - t) * 8}px);
		`,
	};
}
