<script lang="ts">
  // Zeit-Korrektur (watch_corrected): Kanal, Teilnehmer, ±Minuten, Grund Pflicht.
  import type { ParticipantView } from '../api/types.js';
  import { maskName, streamerMode } from '../mask.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';
  import Button from './Button.svelte';
  import Field from './Field.svelte';

  interface Props {
    channels: { pid: string; displayName: string }[];
    rows: ParticipantView[];
    busy: boolean;
    error: string | null;
    onsubmit: (c: { channel: string; pid: string; sec: number; reason: string }) => void;
    oncancel: () => void;
  }

  let { channels, rows, busy, error, onsubmit, oncancel }: Props = $props();
  const id = $props.id();
  // Vorauswahl aus den Startwerten, danach wählt die Person.
  // svelte-ignore state_referenced_locally
  let channel = $state(channels[0]?.pid ?? '');
  // svelte-ignore state_referenced_locally
  let pid = $state(rows[0]?.pid ?? '');
  let minutes = $state(10);
  let reason = $state('');
  let problem = $state<string | null>(null);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (reason.trim() === '') {
      problem = S.reasonRequired;
      return;
    }
    problem = null;
    onsubmit({ channel, pid, sec: Math.round(minutes) * 60, reason: reason.trim() });
  }
</script>

<form class="panel" onsubmit={submit}>
  <div class="panel-body">
    <span class="lbl">{L.actions.correct}</span>
    <span class="hint">{S.detail.correctionHint}</span>
    <div class="row">
      <Field label={L.fields.channel} for="{id}-channel">
        <select id="{id}-channel" bind:value={channel} required>
          {#each channels as c (c.pid)}<option value={c.pid}>{c.displayName}</option>{/each}
        </select>
      </Field>
      <Field label={L.fields.participant} for="{id}-pid">
        <select id="{id}-pid" bind:value={pid} required>
          {#each rows as r (r.pid)}<option value={r.pid}>{$streamerMode ? maskName(r.pid) : r.displayName}</option>{/each}
        </select>
      </Field>
      <Field label={L.fields.minutes} for="{id}-minutes">
        <input id="{id}-minutes" type="number" min="-6000" max="6000" step="1" bind:value={minutes} required />
      </Field>
    </div>
    <Field label={L.fields.reason} for="{id}-reason" error={problem}>
      <input id="{id}-reason" type="text" bind:value={reason} maxlength="500" />
    </Field>
    <div class="row">
      <Button type="submit" {busy}>{L.actions.correct}</Button>
      <Button kind="ghost" onclick={oncancel}>{L.actions.abort}</Button>
      {#if error}<span class="error" role="alert">{error}</span>{/if}
    </div>
  </div>
</form>
