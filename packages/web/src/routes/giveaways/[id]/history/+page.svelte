<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { Action } from '#lib/action.svelte.js';
  import type { HistoryEntry, HistoryPage } from '#lib/api/types.js';
  import Button from '#lib/components/Button.svelte';
  import Confirm from '#lib/components/Confirm.svelte';
  import History from '#lib/components/History.svelte';
  import { watchStreams } from '#lib/live.js';
  import { L } from '#lib/texts/labels.js';
  import { S } from '#lib/texts/sentences.js';
  import { HISTORY_PAGE } from '#lib/history-limits.js';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const base = $derived(`/api/giveaways/${data.detail.id}`);
  const dep = $derived(`api:stream:giveaway:${data.detail.id}`);
  const more = new Action();
  const revertCmd = new Action();
  let reverting = $state<HistoryEntry | null>(null);
  // Ältere Seiten hängt die Oberfläche an die erste Seite aus load an. Ein Neuladen setzt auf die erste Seite zurück.
  let older = $state<HistoryEntry[]>([]);
  let olderNames = $state<Record<string, string>>({});
  let next = $state<number | null | undefined>(undefined);

  const entries = $derived([...data.history.entries, ...older]);
  const names = $derived({ ...olderNames, ...data.history.names });
  const nextBefore = $derived(next === undefined ? data.history.nextBeforeSeq : next);

  $effect(() => watchStreams([`giveaway:${data.detail.id}`]));

  const loadMore = () =>
    more.run(
      (api) => api.get<HistoryPage>(`${base}/history?limit=${HISTORY_PAGE}&beforeSeq=${nextBefore}`),
      (page) => {
        older = [...older, ...page.entries];
        olderNames = { ...olderNames, ...page.names };
        next = page.nextBeforeSeq;
      },
    );
  const revert = (reason?: string) => {
    const e = reverting;
    reverting = null;
    if (!e) return;
    void revertCmd.run(
      (api) => api.post(`${base}/revert`, { eventId: e.id, reason }),
      async () => {
        older = [];
        next = undefined;
        await invalidate(dep);
      },
    );
  };
</script>

<svelte:head><title>{L.columns.history} · {data.detail.settings.prize} · {L.brand}</title></svelte:head>

<section class="stack tight">
  <a href="/giveaways/{data.detail.id}" class="hint">{L.actions.toDetail}</a>
  <span class="lbl">{data.detail.settings.prize}</span>
  <h1>{L.columns.history}</h1>
</section>

{#if reverting}
  <Confirm title={L.actions.revert} text={S.confirm.revert} reason confirmLabel={L.actions.revert} busy={revertCmd.busy} onconfirm={revert} oncancel={() => (reverting = null)} />
{/if}
{#if revertCmd.error}<p class="error" role="alert">{revertCmd.error}</p>{/if}

<History {entries} {names} onrevert={(e) => (reverting = e)} />

{#if nextBefore !== null}
  <div class="row">
    <Button busy={more.busy} onclick={loadMore}>{L.actions.older}</Button>
    {#if more.error}<span class="error" role="alert">{more.error}</span>{/if}
  </div>
{/if}

<style>
  .tight {
    gap: 6px;
  }
</style>
