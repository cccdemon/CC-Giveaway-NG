<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { apiOf, returnTo } from '#lib/api/client.js';
  import LiveDot from '#lib/components/LiveDot.svelte';
  import { liveState, stopLive } from '#lib/live.js';
  import { streamerMode } from '#lib/mask.js';
  import { L } from '#lib/texts/labels.js';
  import { applyTheme, theme, type Theme } from '#lib/theme.js';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  const NAV = [
    { href: '/giveaways', label: L.nav.overview },
    { href: '/teams', label: L.nav.team },
    { href: '/channel', label: L.nav.channel },
    { href: '/legal', label: L.nav.legal },
    { href: '/portal', label: L.nav.portal },
  ] as const;

  const isActive = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  const loginHref = $derived(`/api/auth/twitch/login?return=${encodeURIComponent(returnTo(page.url))}`);
  const THEMES: Theme[] = ['system', 'dark', 'light'];

  onMount(() => {
    // Marker für E2E-Tests: erst nach der Hydration reagieren Knöpfe.
    document.body.dataset.hydrated = '1';
    return theme.subscribe((t) => applyTheme(t));
  });

  async function logout() {
    stopLive();
    await apiOf(globalThis.fetch).post('/api/auth/logout');
    globalThis.location.href = '/';
  }
</script>

<svelte:head>
  <title>{L.brand}</title>
</svelte:head>

<header class="top">
  <div class="top-inner">
    <a class="display brand" href="/">{L.brand}</a>
    {#if data.me}
      <nav aria-label="Hauptnavigation" class="nav">
        {#each NAV as item (item.href)}
          <a href={item.href} class:active={isActive(item.href)} aria-current={isActive(item.href) ? 'page' : undefined}>{item.label}</a>
        {/each}
      </nav>
      <div class="tools">
        <label class="toggle" title={L.streamerMode}>
          <input type="checkbox" bind:checked={$streamerMode} />
          <span>{L.streamerMode}</span>
        </label>
        <label class="toggle">
          <span class="visually-hidden">{L.theme.label}</span>
          <select bind:value={$theme} aria-label={L.theme.label}>
            {#each THEMES as t (t)}
              <option value={t}>{L.theme[t]}</option>
            {/each}
          </select>
        </label>
        <LiveDot state={$liveState} />
        <span class="who hint">{data.me.displayName}</span>
        <button type="button" class="btn btn-ghost" onclick={logout}>{L.actions.logout}</button>
      </div>
    {:else}
      <div class="tools">
        <label class="toggle">
          <span class="visually-hidden">{L.theme.label}</span>
          <select bind:value={$theme} aria-label={L.theme.label}>
            {#each THEMES as t (t)}
              <option value={t}>{L.theme[t]}</option>
            {/each}
          </select>
        </label>
        <a class="btn" href={loginHref}>{L.actions.login}</a>
      </div>
    {/if}
  </div>
</header>

<main class="main">
  {@render children()}
</main>

<style>
  .top {
    border-bottom: 1px solid var(--border);
  }
  .top-inner {
    max-width: 1440px;
    margin: 0 auto;
    padding: 12px 16px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 24px;
  }
  @media (min-width: 900px) {
    .top-inner {
      padding: 14px 32px;
    }
  }
  .brand {
    font-size: 1rem;
    letter-spacing: 0.04em;
    text-decoration: none;
    text-transform: uppercase;
  }
  .nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    flex: 1 1 auto;
  }
  .nav a {
    text-decoration: none;
    padding: 8px 12px;
    font-size: 0.9375rem;
    border-bottom: 2px solid transparent;
  }
  .nav a.active {
    border-bottom-color: var(--accent-2);
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
    margin-left: auto;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.875rem;
  }
  .toggle select {
    min-height: 36px;
    font-size: 0.875rem;
  }
  .who {
    font-size: 0.875rem;
  }
  .main {
    max-width: 1440px;
    margin: 0 auto;
    padding: 24px 16px 48px;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }
  @media (min-width: 900px) {
    .main {
      padding: 32px 32px 64px;
    }
  }
</style>
