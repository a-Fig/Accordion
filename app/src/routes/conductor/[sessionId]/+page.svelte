<script lang="ts">
	import { page } from "$app/state";
	import ConductorDashboard from "$lib/ui/conductor/ConductorDashboard.svelte";

	const requestedId = $derived(page.params.sessionId ?? null);
</script>

<ConductorDashboard {requestedId} />
