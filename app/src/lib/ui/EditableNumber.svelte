<script lang="ts">
  import { tick } from 'svelte';

  let { value, format, label, oncommit }: {
    value: number;
    format: (n: number) => string;
    label?: string;
    oncommit: (n: number) => void;
  } = $props();

  let editing = $state(false);
  let inputValue = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  function toEditString(n: number): string {
    const k = n / 1000;
    if (Number.isInteger(k)) return String(k);
    const s = k.toPrecision(4);
    return parseFloat(s).toString();
  }

  async function startEdit(e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    inputValue = toEditString(value);
    editing = true;
    await tick();
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  }

  function commit() {
    if (!editing) return;
    editing = false;
    const raw = inputValue.replace(/,/g, '').trim();
    if (!raw) return;
    const n = parseFloat(raw);
    if (isNaN(n) || !isFinite(n) || n < 0) return;
    oncommit(Math.round(n * 1000));
  }

  function cancel() {
    editing = false;
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }
</script>

{#if editing}
  <span class="edit-wrap">
    <input
      bind:this={inputEl}
      bind:value={inputValue}
      class="edit-input mono tnum"
      inputmode="decimal"
      aria-label={label}
      style:width="{Math.max(2, inputValue.length) + 1}ch"
      onkeydown={onkeydown}
      onblur={commit}
    /><span class="edit-suffix">k</span>
  </span>
{:else}
  <button
    class="mono tnum kl-val clickable"
    type="button"
    onclick={(e) => startEdit(e)}
  >{format(value)}</button>
{/if}

<style>
  .edit-wrap {
    display: inline-flex;
    align-items: baseline;
    gap: 0;
  }
  .edit-input {
    background: transparent;
    border: none;
    border-bottom: 1.5px solid var(--accent);
    outline: none;
    padding: 0;
    margin: 0;
    color: var(--muted);
    font-weight: 600;
    font-size: inherit;
    font-family: inherit;
    text-transform: none;
    letter-spacing: 0;
    line-height: inherit;
    min-width: 2ch;
  }
  .edit-suffix {
    color: var(--faint);
    font-size: inherit;
    font-family: inherit;
    font-weight: 500;
    pointer-events: none;
    user-select: none;
    margin-left: 1px;
  }
  .kl-val {
    color: var(--muted);
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
  }
  .clickable {
    all: unset;
    cursor: text;
    font: inherit;
    color: inherit;
    font-weight: 600;
    color: var(--muted);
  }
  .clickable:focus-visible {
    outline: 1.5px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
</style>
