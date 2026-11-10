<script lang="ts">
  // Zusammenfassung des Entwurfs (Festlegung 9): steht neben dem Assistenten und auf dem letzten Schritt.
  import type { KernelInfo, LegalTexts } from '../api/types.js';
  import { duration } from '../format.js';
  import { gateText } from '../gate-text.js';
  import { L } from '../texts/labels.js';
  import type { WizardDraft } from '../wizard.js';

  interface Props {
    draft: WizardDraft;
    kernel: KernelInfo | null;
    channelNames: Record<string, string>;
    profileLegal: LegalTexts;
    teamName: string;
  }

  let { draft, kernel, channelNames, profileLegal, teamName }: Props = $props();
  const channels = $derived(draft.channels.map((pid) => ({ pid, displayName: channelNames[pid] ?? pid })));
  const legal = $derived(draft.legal === 'profile' ? profileLegal : draft.legal);
  const configLine = (key: string, v: unknown): string => {
    const f = kernel?.configSchema[key];
    if (!f) return String(v);
    if (f.kind === 'int' && f.unit === 'sec') return duration(Number(v));
    if (f.kind === 'bool') return v ? L.wizard.yes : L.wizard.no;
    return String(v);
  };
</script>

<aside class="summary" aria-label={L.columns.summary}>
  <span class="lbl">{L.columns.summary}</span>
  <dl>
    <dt>{L.columns.kernel}</dt>
    <dd>{kernel ? kernel.label : '–'}</dd>
    <dt>{L.fields.prize}</dt>
    <dd>{draft.prize.trim() || '–'}{#if draft.sponsor.trim()} · {L.fields.sponsor}: {draft.sponsor}{/if}</dd>
    <dt>{L.fields.winnersCount} · {L.fields.claimDays}</dt>
    <dd>{draft.winnersCount} · {draft.claimDays}</dd>
    {#if draft.keyword.trim()}
      <dt>{L.fields.keyword}</dt>
      <dd><code>{draft.keyword}</code></dd>
    {/if}
    {#if kernel}
      {#each Object.entries(draft.config) as [key, v] (key)}
        <dt>{kernel.configSchema[key]?.label ?? key}</dt>
        <dd>{configLine(key, v)}</dd>
      {/each}
    {/if}
    <dt>{L.fields.counting}</dt>
    <dd>{draft.counting === 'registered' ? L.fields.countingRegistered : `${L.fields.countingFirstSeen} · ${L.fields.purgeDays}: ${draft.purgeDays}`}</dd>
    <dt>{L.fields.team} · {L.fields.channels}</dt>
    <dd>{teamName} · {channels.length === 0 ? '–' : channels.map((c) => c.displayName).join(', ')}</dd>
    <dt>{L.announcements.title}</dt>
    <dd>{draft.announcements.muted ? L.announcements.off : L.announcements.on} · {draft.announcements.links ? L.announcements.withLink : L.announcements.withoutLink}</dd>
    <dt>{L.fields.gates}</dt>
    <dd>{draft.gates.length === 0 ? L.gates.none : draft.gates.map((g) => gateText(g, channels)).join(' · ')}</dd>
    <dt>{L.fields.legal}</dt>
    <dd>
      {draft.legal === 'profile' ? L.legal.fromProfile : L.legal.own} ·
      {L.legal.impressum} {legal.impressumUrl ? L.legal.present : L.legal.missing} ·
      {L.legal.terms} {legal.terms ? L.legal.present : L.legal.missing} ·
      {L.legal.privacy} {legal.privacyUrl ? L.legal.present : L.legal.missing}
    </dd>
    {#if draft.contact.trim()}
      <dt>{L.fields.contact}</dt>
      <dd>{draft.contact}</dd>
    {/if}
  </dl>
</aside>

<style>
  .summary {
    border: 1px solid var(--border);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 2px 0;
    font-size: 0.9375rem;
  }
  dt {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--accent-2);
    margin-top: 8px;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
