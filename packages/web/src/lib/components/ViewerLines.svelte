<script lang="ts">
  // Kern-Zeilen der eigenen Sicht (viewerView.lines): Zeit je Kanal, Coins, Tickets.
  let { lines, title }: { lines: { label: string; value: string }[]; title: string } = $props();
</script>

{#if lines.length > 0}
  <div class="lines">
    <span class="lbl">{title}</span>
    {#each lines as l, i (i)}
      <div class="row between"><span>{l.label}</span><span class="mono">{l.value}</span></div>
    {/each}
  </div>
{/if}

<style>
  .lines {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.9375rem;
  }
  .between {
    justify-content: space-between;
  }
</style>
