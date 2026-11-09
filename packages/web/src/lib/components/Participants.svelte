<script lang="ts">
  // Teilnehmerliste (NEW_DESIGN.md 11.1): Name (maskierbar), Status als Wort + Icon, Gewicht, Chance, Kern-Zeilen als Spalten.
  import type { ParticipantView } from '../api/types.js';
  import { number, percent } from '../format.js';
  import { maskName, streamerMode } from '../mask.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.js';
  import Name from './Name.svelte';

  let { rows, unit }: { rows: ParticipantView[]; unit: string | null } = $props();
  let query = $state('');
  const id = $props.id();

  const columns = $derived.by(() => {
    const seen: string[] = [];
    for (const r of rows) for (const l of r.lines) if (!seen.includes(l.label)) seen.push(l.label);
    return seen;
  });
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return rows;
    return rows.filter((r) => ($streamerMode ? maskName(r.pid) : r.displayName).toLowerCase().includes(q));
  });

  const statusOf = (r: ParticipantView): { text: string; icon: IconName; tone: string } => {
    if (r.winnerStatus) return { text: `${L.participant.winner} · ${L.winner[r.winnerStatus]}`, icon: 'star', tone: 'tone-ok' };
    if (r.inPool) return { text: L.participant.inPool, icon: 'check', tone: 'tone-ok' };
    if (r.registered) return { text: L.participant.registered, icon: 'circle', tone: 'tone-muted' };
    return { text: L.participant.seen, icon: 'dot', tone: 'tone-muted' };
  };
  const lineOf = (r: ParticipantView, label: string) => r.lines.find((l) => l.label === label)?.value ?? '–';
</script>

<section class="stack" aria-label={L.columns.participants}>
  <div class="row between">
    <h2>{L.columns.participants}</h2>
    <label class="row search">
      <span class="hint" id="{id}-search">{L.fields.search}</span>
      <input type="search" bind:value={query} aria-labelledby="{id}-search" />
    </label>
  </div>
  {#if rows.length === 0}
    <p class="hint">{S.detail.noParticipants}</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{L.columns.participant}</th>
            <th>{L.columns.status}</th>
            <th class="num">{L.columns.weight}</th>
            <th class="num">{L.columns.chance}</th>
            {#each columns as c (c)}<th>{c}</th>{/each}
          </tr>
        </thead>
        <tbody>
          {#each shown as r (r.pid)}
            {@const st = statusOf(r)}
            <tr>
              <td><Name pid={r.pid} displayName={r.displayName} /></td>
              <td><span class="state {st.tone}"><Icon name={st.icon} size={14} stroke={2.5} /><span>{st.text}</span></span></td>
              <td class="num">{unit ? `${number(r.weight)} ${unit}` : number(r.weight)}</td>
              <td class="num">{percent(r.chance)}</td>
              {#each columns as c (c)}<td>{lineOf(r, c)}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <span class="hint">{S.chanceHint}</span>
</section>

<style>
  .between {
    justify-content: space-between;
    align-items: baseline;
  }
  .search input {
    min-height: 36px;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
</style>
