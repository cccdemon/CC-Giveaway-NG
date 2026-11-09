<script lang="ts">
  // Aktionsleiste (NEW_DESIGN.md 11.1): genau eine Hauptaktion in Kupfer, gesperrte Aktionen mit Grund, Ablehnung als Text.
  import { ACTION_ICONS, ACTION_LABELS, type Action, type ActionsView } from '../status.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';
  import Confirm from './Confirm.svelte';

  interface Props {
    view: ActionsView;
    /** Beschriftungen der Kern-Befehle je Typ. */
    kernelLabels: Record<string, string>;
    busy: Action | null;
    error: string | null;
    onaction: (a: Action) => void;
  }

  let { view, kernelLabels, busy, error, onaction }: Props = $props();
  let confirming = $state<Action | null>(null);

  const labelOf = (a: Action): string => (a.startsWith('kernel:') ? (kernelLabels[a.slice('kernel:'.length)] ?? a) : ACTION_LABELS[a as keyof typeof ACTION_LABELS]);
  const iconOf = (a: Action) => (a.startsWith('kernel:') ? 'play' : ACTION_ICONS[a as keyof typeof ACTION_ICONS]);
  const needsConfirm = (a: Action) => a === 'cancel' || a === 'reopen';

  function click(a: Action) {
    if (needsConfirm(a)) {
      confirming = a;
      return;
    }
    onaction(a);
  }
  function confirmed() {
    const a = confirming;
    confirming = null;
    if (a) onaction(a);
  }
</script>

<section class="stack" aria-label={L.columns.actions}>
  <div class="row">
    {#if view.primary}
      <Button kind="primary" icon={iconOf(view.primary)} busy={busy === view.primary} disabled={busy !== null} onclick={() => click(view.primary!)}>{labelOf(view.primary)}</Button>
    {/if}
    {#each view.others as a (a)}
      <span class="with-hint">
        <Button kind={a === 'cancel' ? 'ghost' : 'default'} icon={iconOf(a)} busy={busy === a} disabled={busy !== null || view.hints[a] !== undefined} onclick={() => click(a)}>{labelOf(a)}</Button>
        {#if view.hints[a]}<span class="hint">{view.hints[a]}</span>{/if}
      </span>
    {/each}
    {#if view.primary === null && view.hints.complete}
      <span class="with-hint">
        <Button disabled>{L.actions.complete}</Button>
        <span class="hint">{view.hints.complete}</span>
      </span>
    {/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if confirming}
    <Confirm
      title={labelOf(confirming)}
      text={confirming === 'cancel' ? S.confirm.cancel : S.confirm.reopen}
      confirmLabel={labelOf(confirming)}
      danger={confirming === 'cancel'}
      onconfirm={confirmed}
      oncancel={() => (confirming = null)}
    />
  {/if}
</section>

<style>
  .with-hint {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
  }
  .with-hint .hint {
    font-size: 0.8125rem;
  }
</style>
