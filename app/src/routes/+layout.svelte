<script lang="ts">
	import "@fontsource-variable/ibm-plex-sans";
	import "@fontsource/ibm-plex-mono/400.css";
	import "@fontsource/ibm-plex-mono/500.css";
	import "../app.css";
	import { onMount } from "svelte";
	import { primeSurfaceId } from "$lib/live/surfaceId";
	let { children } = $props();
	// v16 (ADR 0024): start the surface-id duplicate-tab dedupe window NOW (init only, no freeze) so
	// it has usually elapsed by the time anything dials — the first connectLive then pays zero wait.
	onMount(primeSurfaceId);
</script>

{@render children()}
