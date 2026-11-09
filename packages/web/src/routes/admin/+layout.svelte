<script lang="ts">
  import { page } from '$app/state';
  import { L } from '#lib/texts/labels.js';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
  const NAV = [
    { href: '/admin', label: L.admin.ops },
    { href: '/admin/streamers', label: L.admin.streamers },
    { href: '/admin/terms', label: L.terms.title },
    { href: '/admin/feedback', label: L.admin.feedback },
  ] as const;
  const isActive = (href: string) => (href === '/admin' ? page.url.pathname === href : page.url.pathname.startsWith(href));
</script>

<section class="stack tight">
  <span class="lbl">{L.nav.admin}</span>
  <nav aria-label={L.nav.admin} class="sub">
    {#each NAV as item (item.href)}
      <a href={item.href} class:active={isActive(item.href)} aria-current={isActive(item.href) ? 'page' : undefined}>{item.label}</a>
    {/each}
  </nav>
</section>

{@render children()}

<style>
  .tight {
    gap: 6px;
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .sub a {
    text-decoration: none;
    padding: 6px 12px;
    font-size: 0.9375rem;
    border-bottom: 2px solid transparent;
  }
  .sub a.active {
    border-bottom-color: var(--accent-2);
  }
</style>
