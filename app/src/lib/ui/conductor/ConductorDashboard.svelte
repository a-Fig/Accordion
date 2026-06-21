<script lang="ts">
	import { session } from "$lib/session.svelte";
	import { live } from "$lib/live/liveClient.svelte";
	import { conductorStatus } from "$lib/live/conductorClient.svelte";
	import Icon from "$lib/ui/Icon.svelte";
	import {
		computeHealthVerdict,
		computeNeededStats,
		formatCount,
		formatTokens,
		healthFromStore,
		levelName,
		normalizeDiagnostics,
		stageName,
	} from "$lib/conductorDiagnostics";

	let { requestedId = null }: { requestedId?: string | null } = $props();

	const store = $derived(session.store);
	const statusText = $derived(store?.conductorStatus.text || conductorStatus.text);
	const statusDetails = $derived(store?.conductorStatus.text ? store.conductorStatus.details : conductorStatus.details);
	const diagnostics = $derived(normalizeDiagnostics(statusDetails));
	const health = $derived(
		store ? healthFromStore(diagnostics.health, store.liveTokens, store.budget, store.contextWindow) : undefined,
	);
	const currentTurn = $derived(store?.blocks.reduce((mx, b) => Math.max(mx, b.turn), 0));
	const needed = $derived(computeNeededStats(store?.decisionJournal ?? [], currentTurn));
	const verdict = $derived(health ? computeHealthVerdict(diagnostics.unitTrace ?? [], health, needed) : null);
	const withinBudget = $derived((health?.assembledTokens ?? 0) <= (health?.budgetTokens ?? Number.POSITIVE_INFINITY));
	const stale = $derived(!!requestedId && live.sessionId !== requestedId);
	const unitRows = $derived(
		[...(diagnostics.unitTrace ?? [])].sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || (a.score ?? 0) - (b.score ?? 0)),
	);
	const hasRichDiagnostics = $derived(
		!!diagnostics.unitTrace ||
			!!diagnostics.factLedger ||
			!!diagnostics.relevanceTOC ||
			!!diagnostics.proactiveUnfolds ||
			!!diagnostics.caches,
	);

	const pct = (n: number | null | undefined) => n == null ? "n/a" : `${Math.round(n * 100)}%`;
	const score = (n: number | undefined) => n == null ? "" : n.toFixed(2);
</script>

<svelte:head><title>Conductor Dashboard · Accordion</title></svelte:head>

<div class="dash-shell">
	<header class="dash-head">
		<a class="back" href="/">
			<Icon name="chevron-left" size={14} />
			Map
		</a>
		<div class="title">
			<div class="eyebrow">Accordion</div>
			<h1>Conductor Dashboard</h1>
		</div>
		<div class="head-meta">
			<span class="status {live.status}"></span>
			<span>{live.status}</span>
			{#if live.sessionId}<span class="mono">{live.sessionId.slice(0, 10)}</span>{/if}
		</div>
	</header>

	{#if !store}
		<div class="empty-state">
			<Icon name="activity" size={30} />
			<h2>No active session</h2>
			<p>Attach a live pi session or load a transcript to inspect conductor activity.</p>
		</div>
	{:else if stale}
		<div class="warning">
			This dashboard URL is for <span class="mono">{requestedId}</span>, but the active session is
			<span class="mono">{live.sessionId ?? "none"}</span>.
		</div>
		<a class="dash-link" href={live.sessionId ? `/conductor/${encodeURIComponent(live.sessionId)}` : "/conductor"}>Open active dashboard</a>
	{:else}
		<section class="summary-grid">
			<div class="summary-card verdict {verdict?.level ?? 'green'}">
				<div class="card-label">health</div>
				<div class="big">{verdict?.level ?? "green"}</div>
				<div class="sub">coverage {pct(verdict?.foldCoverage)} · needed {pct(verdict?.neededRate)}</div>
			</div>
			<div class="summary-card">
				<div class="card-label">budget</div>
				<div class="big">{formatTokens(health?.assembledTokens)} / {formatTokens(health?.budgetTokens)}</div>
				<div class="sub">{health?.pressure ?? "normal"} · {withinBudget ? "within budget" : "over budget"}</div>
			</div>
			<div class="summary-card">
				<div class="card-label">fold target</div>
				<div class="big">
					{#if health?.foldTargetCalibrated != null}
						{Math.round(health.foldTargetCalibrated * 100)}%
					{:else if health?.foldTargetThisTurn != null}
						{Math.round(health.foldTargetThisTurn * 100)}%
					{:else}
						n/a
					{/if}
				</div>
				<div class="sub">
					{#if health?.foldTargetBand}
						band {Math.round(health.foldTargetBand.min * 100)}-{Math.round(health.foldTargetBand.max * 100)}%
					{:else}
						{statusText || "awaiting first turn"}
					{/if}
				</div>
			</div>
			<div class="summary-card">
				<div class="card-label">calibration</div>
				<div class="big">{needed.needed} needed</div>
				<div class="sub">{needed.pending} pending · {needed.harmless} harmless</div>
			</div>
		</section>

		<main class="dash-grid">
			{#if diagnostics.unitTrace}
				<section class="panel trace-panel">
					<div class="panel-head">
						<h2>Fold Units</h2>
						<span>{unitRows.length} rows</span>
					</div>
					{#if unitRows.length}
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>id</th>
										<th>kind w</th>
										<th>overlap</th>
										<th>recency</th>
										<th>score</th>
										<th>stage</th>
										<th>tokens</th>
										<th>level</th>
										<th>reason</th>
									</tr>
								</thead>
								<tbody>
									{#each unitRows as unit (unit.id)}
										<tr>
											<td class="mono unit-id" title={unit.blockIds.join(", ")}>{unit.id}{unit.blockIds.length > 1 ? ` ×${unit.blockIds.length}` : ""}</td>
											<td>{score(unit.kindWeight)}</td>
											<td>{score(unit.overlap)}</td>
											<td>{score(unit.recency)}</td>
											<td>{score(unit.score)}</td>
											<td>{stageName(unit.stage)}</td>
											<td class="mono">{formatTokens(unit.fullTokens)} → {formatTokens(unit.foldedTokens)}</td>
											<td>{levelName(unit.fromLevel)} → {levelName(unit.level)}</td>
											<td class="reason" title={unit.reason}>{unit.reason}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{:else}
						<div class="empty">No fold-unit rows reported.</div>
					{/if}
				</section>
			{:else}
				<section class="panel trace-panel">
					<div class="panel-head"><h2>Diagnostics</h2></div>
					<div class="empty">
						{hasRichDiagnostics ? "No fold-unit trace reported." : "The active conductor has not reported rich dashboard diagnostics."}
					</div>
				</section>
			{/if}

			<aside class="side-stack">
				{#if diagnostics.factLedger}
					<section class="panel">
						<div class="panel-head"><h2>Fact Ledger</h2></div>
						{#each diagnostics.factLedger.slice(0, 12) as fact}
							<div class="list-row">
								<span class="tag">{fact.category}</span>
								<span title={fact.value}>{fact.value}</span>
								{#if fact.turn != null}<span class="mono faint">t{fact.turn}</span>{/if}
							</div>
						{/each}
					</section>
				{/if}

				{#if diagnostics.relevanceTOC}
					<section class="panel">
						<div class="panel-head"><h2>Relevance TOC</h2></div>
						{#each diagnostics.relevanceTOC.slice(0, 10) as row}
							<div class="list-row">
								<span class="mono">t{row.turn}</span>
								<span title={row.label}>{row.label}</span>
								<span class="mono faint">{score(row.score)}</span>
							</div>
						{/each}
					</section>
				{/if}

				{#if diagnostics.proactiveUnfolds}
					<section class="panel">
						<div class="panel-head"><h2>Proactive Unfolds</h2></div>
						{#each diagnostics.proactiveUnfolds as item}
							<div class="list-row">
								<span class="mono">{item.blockId ?? item.id ?? item.blockIds?.[0]}</span>
								<span>{item.reason ?? "restored by conductor"}</span>
							</div>
						{/each}
					</section>
				{/if}

				{#if diagnostics.caches}
					<section class="panel">
						<div class="panel-head"><h2>Caches</h2></div>
						{#if diagnostics.caches.summary}
							<div class="cache-row"><span>summary</span><span>{formatCount(diagnostics.caches.summary.size)} cached · {formatCount(diagnostics.caches.summary.pending)} pending</span></div>
						{/if}
						{#if diagnostics.caches.embedding}
							<div class="cache-row"><span>embedding</span><span>{formatCount(diagnostics.caches.embedding.size)} cached</span></div>
						{/if}
						{#if diagnostics.caches.rerank}
							<div class="cache-row"><span>rerank</span><span>{formatCount(diagnostics.caches.rerank.size)} cached</span></div>
						{/if}
						{#if diagnostics.caches.latestProviderError}<div class="cache-error">{diagnostics.caches.latestProviderError}</div>{/if}
					</section>
				{/if}
			</aside>
		</main>
	{/if}
</div>

<style>
	.dash-shell {
		height: 100vh;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		overflow: hidden;
	}
	.dash-head {
		height: 56px;
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: var(--sp-4);
		padding: 0 var(--sp-4);
		border-bottom: 1px solid var(--line-soft);
		background: var(--panel);
	}
	.back,
	.dash-link {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		color: var(--muted);
		text-decoration: none;
		border: 1px solid var(--line);
		background: var(--panel-2);
		border-radius: var(--radius-sm);
		padding: 6px 10px;
		font-size: var(--fs-sm);
	}
	.title {
		min-width: 0;
		flex: 1;
	}
	.eyebrow,
	.card-label {
		font-size: var(--fs-2xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--faint);
		font-weight: 700;
	}
	h1,
	h2 {
		margin: 0;
	}
	h1 {
		font-size: var(--fs-lg);
	}
	h2 {
		font-size: var(--fs-sm);
	}
	.head-meta {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		color: var(--muted);
		font-size: var(--fs-xs);
	}
	.status {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--faint);
	}
	.status.connected { background: var(--ok); }
	.status.connecting { background: var(--warn); }
	.status.error { background: var(--danger); }
	.summary-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--sp-3);
		padding: var(--sp-4);
		flex: 0 0 auto;
	}
	.summary-card,
	.panel {
		border: 1px solid var(--line-soft);
		background: var(--panel);
		border-radius: var(--radius-sm);
	}
	.summary-card {
		padding: var(--sp-3);
	}
	.big {
		margin-top: var(--sp-1);
		font-family: var(--mono);
		font-size: var(--fs-xl);
		font-weight: 700;
		color: var(--text);
	}
	.sub,
	.empty,
	.faint {
		color: var(--faint);
		font-size: var(--fs-xs);
	}
	.verdict.green .big { color: var(--ok); }
	.verdict.yellow .big { color: var(--warn); }
	.verdict.red .big { color: var(--danger); }
	.dash-grid {
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		gap: var(--sp-3);
		padding: 0 var(--sp-4) var(--sp-4);
		overflow: hidden;
	}
	.panel {
		min-width: 0;
		min-height: 0;
		padding: var(--sp-3);
		overflow: hidden;
	}
	.trace-panel {
		display: flex;
		flex-direction: column;
	}
	.panel-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--sp-2);
		margin-bottom: var(--sp-2);
		color: var(--muted);
	}
	.table-wrap {
		min-height: 0;
		overflow: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-xs);
	}
	th,
	td {
		text-align: left;
		border-bottom: 1px solid var(--line-soft);
		padding: 7px 8px;
		vertical-align: top;
	}
	th {
		color: var(--faint);
		font-weight: 700;
		position: sticky;
		top: 0;
		background: var(--panel);
	}
	.unit-id,
	.reason {
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.side-stack {
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		overflow: auto;
	}
	.list-row,
	.cache-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: var(--sp-2);
		align-items: baseline;
		border-top: 1px solid var(--line-soft);
		padding: 7px 0;
		font-size: var(--fs-xs);
	}
	.list-row span:nth-child(2) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		color: var(--accent);
		font-weight: 700;
	}
	.cache-row {
		grid-template-columns: auto minmax(0, 1fr);
		color: var(--muted);
	}
	.cache-error,
	.warning {
		color: var(--danger);
		border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--line));
		background: color-mix(in srgb, var(--danger) 10%, var(--panel));
		border-radius: var(--radius-sm);
		padding: var(--sp-3);
		margin: var(--sp-4);
	}
	.empty-state {
		margin: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--sp-2);
		color: var(--muted);
		text-align: center;
	}
	@media (max-width: 900px) {
		.summary-grid,
		.dash-grid {
			grid-template-columns: 1fr;
			overflow: auto;
		}
		.dash-shell {
			overflow: auto;
		}
	}
</style>
