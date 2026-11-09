import { describe, expect, it, vi } from 'vitest';
import { MAX_REPORTS_PER_PAGE, createErrorReporter } from './errors.js';

describe('Browser-Fehlerbericht', () => {
  it('posts message, stack and url to /api/errors without credentials and stops after the limit', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const report = createErrorReporter(fetchFn);
    await report(new Error('kaputt'), 'https://g.example/giveaways/1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/errors');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(calls[0]!.init.keepalive).toBe(true);
    const body = JSON.parse(String(calls[0]!.init.body)) as { message: string; stack?: string; url: string };
    expect(body.message).toBe('Error: kaputt');
    expect(body.stack).toContain('kaputt');
    expect(body.url).toBe('https://g.example/giveaways/1');
    await report('nur ein Text', 'https://g.example/');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ message: 'nur ein Text', url: 'https://g.example/' });
    for (let i = 0; i < MAX_REPORTS_PER_PAGE + 5; i++) await report(new Error(`n${i}`), 'https://g.example/');
    expect(calls).toHaveLength(MAX_REPORTS_PER_PAGE);
  });

  it('never throws, even when fetch fails', async () => {
    const report = createErrorReporter((async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch);
    await expect(report(new Error('x'), 'https://g.example/')).resolves.toBeUndefined();
  });
});
