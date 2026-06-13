<script lang="ts">
	export type IconName =
		| 'chevron-left'
		| 'chevron-right'
		| 'chevron-down'
		| 'chevron-up'
		| 'chevrons-left'
		| 'chevrons-right'
		| 'x'
		| 'check'
		| 'pin'
		| 'pin-off'
		| 'lock'
		| 'eye'
		| 'eye-off'
		| 'rotate-ccw'
		| 'plus'
		| 'minus'
		| 'layout-grid'
		| 'layers'
		| 'git-merge'
		| 'trash-2'
		| 'chevrons-down-up'
		| 'chevrons-up-down'
		| 'corner-down-right'
		| 'target'
		| 'search'
		| 'folder'
		| 'file-text'
		| 'circle'
		| 'dot'
		| 'terminal'
		| 'message-square'
		| 'sliders-horizontal'
		| 'activity'
		| 'accordion';

	// Raw inner SVG markup for each icon (Lucide 24×24 path geometry).
	const icons: Record<IconName, string> = {
		'chevron-left': `<polyline points="15 18 9 12 15 6"/>`,
		'chevron-right': `<polyline points="9 18 15 12 9 6"/>`,
		'chevron-down': `<polyline points="6 9 12 15 18 9"/>`,
		'chevron-up': `<polyline points="18 15 12 9 6 15"/>`,
		'chevrons-left': `<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>`,
		'chevrons-right': `<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>`,
		'x': `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
		'check': `<polyline points="20 6 9 17 4 12"/>`,
		'pin': `<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z"/>`,
		'pin-off': `<line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12"/><path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89"/>`,
		'lock': `<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
		'eye': `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`,
		'eye-off': `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`,
		'rotate-ccw': `<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.98"/>`,
		'plus': `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
		'minus': `<line x1="5" y1="12" x2="19" y2="12"/>`,
		'layout-grid': `<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>`,
		'layers': `<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>`,
		'git-merge': `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`,
		'trash-2': `<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>`,
		// chevrons-down-up = fold vertical (compress toward center)
		'chevrons-down-up': `<polyline points="7 20 12 15 17 20"/><polyline points="7 4 12 9 17 4"/>`,
		// chevrons-up-down = unfold vertical (expand away from center)
		'chevrons-up-down': `<polyline points="7 15 12 20 17 15"/><polyline points="7 9 12 4 17 9"/>`,
		'corner-down-right': `<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>`,
		'target': `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>`,
		'search': `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
		'folder': `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>`,
		'file-text': `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>`,
		'circle': `<circle cx="12" cy="12" r="10"/>`,
		// dot = small filled circle, no stroke
		'dot': `<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>`,
		'terminal': `<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`,
		'message-square': `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
		'sliders-horizontal': `<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="3" y2="12"/><line x1="21" y1="18" x2="3" y2="18"/><circle cx="9" cy="6" r="2" fill="none"/><circle cx="15" cy="12" r="2" fill="none"/><circle cx="9" cy="18" r="2" fill="none"/>`,
		'activity': `<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>`,
		// Custom accordion brand mark: 4 vertical bellows folds on a 24×24 grid.
		// A rounded rect outline (the body) with three interior zig-zag fold lines
		// suggesting a compressed bellows / accordion. Reads crisply at 16–28px.
		'accordion': `<rect x="4" y="3" width="16" height="18" rx="2.5"/><polyline points="4 8 8 6 12 8 16 6 20 8"/><polyline points="4 13 8 11 12 13 16 11 20 13"/><polyline points="4 18 8 16 12 18 16 16 20 18"/>`,
	};

	let {
		name,
		size = 16,
		stroke = 1.5,
		class: cls = '',
		title = '',
	}: {
		name: IconName;
		size?: number;
		stroke?: number;
		class?: string;
		title?: string;
	} = $props();

	const markup = $derived(icons[name] ?? '');
</script>

<svg
	class="icon {cls}"
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	role={title ? "img" : undefined}
	aria-label={title || undefined}
	aria-hidden={title ? undefined : "true"}
	focusable={title ? undefined : "false"}
>
	{#if title}<title>{title}</title>{/if}
	{@html markup}
</svg>

<style>
	.icon {
		display: block;
		flex: 0 0 auto;
	}
</style>
