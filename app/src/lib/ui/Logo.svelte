<script lang="ts">
	// The Accordion brand symbol — the SPECTRUM tile (symbol-spectrum.png): the brand
	// spectrum gradient on Ink with the white bellows-A centered, generous corner radius
	// (brand.md app-icon recipe). Master art is raster PNG ("not vector"), so we render
	// the real asset as-is — it carries its own color + mark, no invert/recolor.
	let {
		size = 20,
		class: klass = "",
		alt = "Accordion",
	}: { size?: number; class?: string; alt?: string } = $props();
</script>

<img
	src="/brand-symbol-spectrum.png"
	{alt}
	width={size}
	height={size}
	class={klass}
	draggable="false"
	style="display:block;width:{size}px;height:{size}px;object-fit:contain;"
/>
