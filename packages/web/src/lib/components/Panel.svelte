<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface Props {
    title?: string;
    tone?: 'plain' | 'warn' | 'error' | 'info';
    /** Warnstreifen: Rolle alert, Icon vorne. */
    alert?: boolean;
    children: Snippet;
  }

  let { title, tone = 'plain', alert = false, children }: Props = $props();
</script>

<section class="panel panel-{tone}" class:panel-alert={alert} role={alert ? 'alert' : undefined}>
  {#if alert}
    <span class="panel-icon"><Icon name={tone === 'error' ? 'x' : tone === 'info' ? 'info' : 'warn'} size={20} /></span>
  {/if}
  <div class="panel-body">
    {#if title}<span class="lbl">{title}</span>{/if}
    {@render children()}
  </div>
</section>
