<script lang="ts">
  // Kanäle (NEW_DESIGN.md 9.3): Team wählen, Kanäle sind eine Teilmenge der Team-Kanäle.
  import type { TeamList } from '../api/types.js';
  import { L } from '../texts/labels.js';
  import { S } from '../texts/sentences.js';

  interface Props {
    teams: TeamList;
    soloTeamId: string;
    /** Mitglieder je Team (Solo-Team: die eigene Person). */
    members: Record<string, { pid: string; displayName: string }[]>;
    teamId: string | null;
    channels: string[];
    onteam: (teamId: string) => void;
    onchannels: (pids: string[]) => void;
    error?: string | null;
  }

  let { teams, soloTeamId, members, teamId, channels, onteam, onchannels, error = null }: Props = $props();
  const id = $props.id();
  const options = $derived(members[teamId ?? ''] ?? []);

  function toggle(pid: string, on: boolean) {
    onchannels(on ? [...channels.filter((c) => c !== pid), pid] : channels.filter((c) => c !== pid));
  }
</script>

<div class="stack">
  <span class="hint">{S.wizard.channelsIntro}</span>
  <fieldset class="group">
    <legend class="lbl">{L.fields.team}</legend>
    <label class="row"><input type="radio" name="{id}-team" value={soloTeamId} checked={teamId === soloTeamId} onchange={() => onteam(soloTeamId)} /> {L.solo}</label>
    {#each teams.teams.filter((t) => t.active) as t (t.teamId)}
      <label class="row"><input type="radio" name="{id}-team" value={t.teamId} checked={teamId === t.teamId} onchange={() => onteam(t.teamId)} /> {t.name}</label>
    {/each}
  </fieldset>
  <fieldset class="group">
    <legend class="lbl">{L.fields.channels}</legend>
    {#each options as m (m.pid)}
      <label class="row"><input type="checkbox" checked={channels.includes(m.pid)} onchange={(e) => toggle(m.pid, (e.currentTarget as HTMLInputElement).checked)} /> {m.displayName}</label>
    {/each}
    {#if options.length === 0}<span class="hint">{S.wizard.noMembers}</span>{/if}
  </fieldset>
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</div>

<style>
  .group {
    border: 1px solid var(--border);
    padding: 12px 16px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  legend {
    padding: 0 6px;
    color: var(--accent-2);
  }
</style>
