<script lang="ts">
	// The Accordion brand symbol (bellows-A). The master art is raster PNG
	// (brand.md: "not vector"), so we render the real asset rather than a traced SVG.
	// We use the SOLID black master (symbol-black.png) and invert it to white for the
	// dark chrome — the pleat cut-outs let the dark background show through as the
	// bellows lines (matching the PDF's solid mark). The shipped symbol-white.png is a
	// thinner outline treatment that reads poorly at small chrome sizes.
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
	style="display:block;width:{size}px;height:{size}px;object-fit:contain;filter:invert(1);"
/>
