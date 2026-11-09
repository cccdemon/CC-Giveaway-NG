<script lang="ts">
  // Statusblock je Kanal (NEW_DESIGN.md 11.2): live/offline als Wort + Icon, letztes Signal, Zuschauer, Abdeckung, Warnung.
  import type { ChannelStatus } from '../api/types.js';
  import { number, percent, relative } from '../format.js';
  import { L } from '../texts/labels.js';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.js';
  import Panel from './Panel.svelte';

  interface Props {
    v: ChannelStatus;
    /** Kanalname (Streamer, nicht maskiert). */
    name?: string;
    now?: Date;
    /** Eine Zeile statt Block, ohne Warnstreifen. */
    compact?: boolean;
  }

  let { v, name, now = new Date(), compact = false }: Props = $props();

  const state = $derived.by((): { word: string; icon: IconName; tone: string } => {
    if (!v.connected) return { word: L.channel.notConnected, icon: 'offline', tone: 'tone-muted' };
    if (v.tokenStatus !== 'ok') return { word: L.channel.tokenInvalid, icon: 'x', tone: 'tone-err' };
    if (v.live) return { word: L.channel.live, icon: 'live', tone: 'tone-ok' };
    return { word: L.channel.offline, icon: 'offline', tone: 'tone-muted' };
  });
  const panelTone = $derived(v.warning?.level === 'rot' ? 'error' : v.warning?.level === 'gelb' ? 'warn' : 'info');
</script>

<div class="channel" class:compact>
  <div class="row head">
    {#if name}<span class="name">{name}</span>{/if}
    <span class="state {state.tone}"><Icon name={state.icon} size={14} stroke={2.5} /><span>{state.word}</span></span>
    {#if v.connected && v.lastSignalAt}
      <span class="meta"><span class="lbl">{L.channel.lastSignal}</span> <span class="mono">{relative(v.lastSignalAt, now)}</span></span>
    {/if}
    {#if v.live && v.viewers !== null}
      <span class="meta"><span class="lbl">{L.channel.viewers}</span> <span class="mono">{number(v.viewers)}</span></span>
    {/if}
    {#if v.live && v.coverage !== null}
      <span class="meta"><span class="lbl">{L.channel.coverage}</span> <span class="mono">{percent(v.coverage)}</span></span>
    {/if}
  </div>
  {#if v.warning && !compact}
    <Panel tone={panelTone} alert>
      <span>{v.warning.text}</span>
    </Panel>
  {/if}
</div>

<style>
  .channel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .head {
    gap: 8px 18px;
  }
  .name {
    font-weight: 600;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .meta {
    display: inline-flex;
    gap: 6px;
    align-items: baseline;
    font-size: 0.875rem;
  }
</style>
