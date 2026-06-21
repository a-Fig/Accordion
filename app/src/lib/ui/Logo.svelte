<script lang="ts">
	// The Accordion brand symbol (bellows-A). The master art is raster PNG
	// (brand.md: "not vector"), so we render the real asset rather than a traced SVG.
	// White variant — for the dark UI chrome.
	let {
		size = 20,
		class: klass = "",
		alt = "Accordion",
	}: { size?: number; class?: string; alt?: string } = $props();
</script>

<img
	src="/brand-symbol.png"
	{alt}
	width={size}
	height={size}
	class={klass}
	draggable="false"
	style="display:block;width:{size}px;height:{size}px;object-fit:contain;"
/>
