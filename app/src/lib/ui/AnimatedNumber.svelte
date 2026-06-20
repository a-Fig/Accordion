<script lang="ts">
	import { Tween } from "svelte/motion";
	import { cubicOut } from "svelte/easing";

	interface Props {
		value: number;
		format?: (n: number) => string;
		duration?: number;
	}

	let { value, format = (n: number) => String(Math.round(n)), duration = 320 }: Props = $props();

	// Initialise at 0 with duration 0 so construction doesn't capture the prop early
	// (avoids a Svelte warning); the effect immediately drives it to `value`, giving a
	// count-up on first mount and a smooth tween on every change.
	//
	// Renders a BARE TEXT NODE (no wrapper element): a parent component's *scoped*
	// styles can't reach a child component's elements, so callers wrap this in their
	// own styled span instead of passing a class in.
	const tween = new Tween(0, { duration: 0, easing: cubicOut });

	$effect(() => {
		// Snap (don't tween) when the user prefers reduced motion. This SPA is
		// ssr=false so window always exists at runtime.
		const d = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
		tween.set(value, { duration: d });
	});
</script>{format(tween.current)}
