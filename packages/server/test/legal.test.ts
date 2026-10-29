import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { GIVEAWAY_EVENTS, giveawayStream } from '../src/framework/giveaway/state.js';
import { checkLegal, fetchHash, mergeLegal, missingLegal, type LegalFetcher, type LegalTexts } from '../src/framework/legal.js';
import { accountLegalSource } from '../src/identity/account/legal-source.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { readStream } from '../src/journal/journal.js';
import { GID, P1, STREAMER, TEAM, createOpen, must, run, setupGiveaway, state } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const FULL: LegalTexts = { impressumUrl: 'https://s.example/impressum', terms: { text: 'Ab 18.' }, privacyUrl: 'https://s.example/datenschutz' };
const STREAMER_PID = STREAMER.slice('user:'.length);

/** Fetcher-Stub: bekannte URLs liefern einen Hash, alles andere ist nicht erreichbar. */
function stubFetcher(known: Record<string, string>): LegalFetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    return url in known ? { ok: true as const, hash: known[url]! } : { ok: false as const };
  }) as LegalFetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

const codeOf = (r: CommandResult) => (r.ok ? 'ok' : r.rejection.code);

describe('checkLegal / mergeLegal / missingLegal', () => {
  it('accepts https urls and text, rejects javascript: and over-long text', () => {
    expect(checkLegal(FULL)).toEqual(FULL);
    expect(checkLegal({})).toEqual({ impressumUrl: null, terms: null, privacyUrl: null });
    expect(checkLegal({ impressumUrl: 'http://localhost:3000/i' })).toMatchObject({ impressumUrl: 'http://localhost:3000/i' });
    expect(checkLegal({ impressumUrl: 'javascript:alert(1)' })).toMatchObject({ code: 'invalid_url' });
    expect(checkLegal({ privacyUrl: 'ftp://x' })).toMatchObject({ code: 'invalid_url' });
    expect(checkLegal({ terms: { url: 'https://x' } })).toMatchObject({ terms: { url: 'https://x' } });
    expect(checkLegal({ terms: { url: 'x' } })).toMatchObject({ code: 'invalid_url' });
    expect(checkLegal({ terms: { text: 'x'.repeat(20_001) } })).toMatchObject({ code: 'terms_too_long' });
    expect(checkLegal({ terms: { text: '  ' } })).toMatchObject({ code: 'invalid_legal' });
    expect(checkLegal({ terms: 'text' })).toMatchObject({ code: 'invalid_legal' });
    expect(checkLegal(null)).toMatchObject({ code: 'invalid_legal' });
    expect(checkLegal({ impressumUrl: 'https://' + 'x'.repeat(500) })).toMatchObject({ code: 'invalid_url' });
  });

  it('mergeLegal takes giveaway fields first, profile fields second', () => {
    const profile: LegalTexts = { impressumUrl: 'https://p/i', terms: { url: 'https://p/t' }, privacyUrl: 'https://p/d' };
    expect(mergeLegal({ impressumUrl: 'https://g/i', terms: null, privacyUrl: null }, profile)).toEqual({
      impressumUrl: 'https://g/i', terms: { url: 'https://p/t' }, privacyUrl: 'https://p/d',
    });
    expect(mergeLegal(null, profile)).toEqual(profile);
    expect(mergeLegal(null, null)).toEqual({ impressumUrl: null, terms: null, privacyUrl: null });
    expect(missingLegal({ impressumUrl: null, terms: null, privacyUrl: 'https://x' })).toEqual(['Impressum', 'Teilnahmebedingungen']);
  });
});

describe('Öffnen friert Rechtstexte ein', () => {
  it('open without legal texts is rejected with legal_required naming the missing ones, giveaway stays draft', async () => {
    const s = await setupGiveaway({ legalSource: { profileOf: async () => null }, fetcher: stubFetcher({}) });
    close = s.close;
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } });
    const r = await run(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(r).toEqual({ ok: false, rejection: { rejected: true, code: 'legal_required', message: 'Hinterlege zuerst: Impressum, Teilnahmebedingungen, Datenschutzhinweis.' } });
    expect((await state(s.rt)).status).toBe('draft');
    const partial = await run(s.rt, s.rt.handlers.changeSettings, { giveawayId: GID, settings: { legal: { impressumUrl: 'https://s.example/impressum', terms: null, privacyUrl: null } } });
    expect(codeOf(partial)).toBe('ok');
    const r2 = await run(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(r2).toMatchObject({ ok: false, rejection: { code: 'legal_required', message: 'Hinterlege zuerst: Teilnahmebedingungen, Datenschutzhinweis.' } });
  });

  it('open with giveaway legal texts freezes hashes and text, writes legal_frozen before status_changed', async () => {
    const fetcher = stubFetcher({ 'https://s.example/impressum': 'h-imp', 'https://s.example/datenschutz': 'h-ds' });
    const s = await setupGiveaway({ legalSource: { profileOf: async () => null }, fetcher });
    close = s.close;
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1], legal: FULL } });
    const events = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(events.map((e) => e.type)).toEqual([GIVEAWAY_EVENTS.legalFrozen, GIVEAWAY_EVENTS.statusChanged]);
    expect(events[0]!.payload).toEqual({
      impressum: { url: 'https://s.example/impressum', hash: 'h-imp' },
      terms: { text: 'Ab 18.' },
      privacy: { url: 'https://s.example/datenschutz', hash: 'h-ds' },
      frozenAt: '2026-10-15T12:00:00.000Z',
    });
    expect(fetcher.calls.sort()).toEqual(['https://s.example/datenschutz', 'https://s.example/impressum']);
    const st = await state(s.rt);
    expect(st.status).toBe('open');
    expect(st.legal).toEqual(events[0]!.payload);
    expect(st.legalEventId).toBe(events[0]!.id);
    expect((await s.pool.query('SELECT status FROM giveaways WHERE id = $1', [GID])).rows[0]).toEqual({ status: 'open' });
  });

  it('terms as url are fetched and hashed too', async () => {
    const fetcher = stubFetcher({ 'https://s.example/impressum': 'h-imp', 'https://s.example/datenschutz': 'h-ds', 'https://s.example/agb': 'h-agb' });
    const s = await setupGiveaway({ legalSource: { profileOf: async () => null }, fetcher });
    close = s.close;
    await must(s.rt, s.rt.handlers.create, {
      giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1], legal: { ...FULL, terms: { url: 'https://s.example/agb' } } },
    });
    const [frozen] = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(frozen!.payload).toMatchObject({ terms: { url: 'https://s.example/agb', hash: 'h-agb' } });
  });

  it('open takes missing fields from the actor profile (accountLegalSource)', async () => {
    const fetcher = stubFetcher({ 'https://s.example/impressum': 'h-imp', 'https://p.example/datenschutz': 'h-pds' });
    const s = await setupGiveaway({ legalSource: accountLegalSource(), fetcher });
    close = s.close;
    const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
    await must(s.rt, accounts.signIn, { pid: STREAMER_PID, soloTeamId: TEAM, user: { id: '1', login: 'a', displayName: 'A' } }, { actor: 'system:twitch' });
    await must(s.rt, accounts.updateProfile, { pid: STREAMER_PID, legal: { terms: { text: 'Profil-Regeln' }, privacyUrl: 'https://p.example/datenschutz' } });
    await must(s.rt, s.rt.handlers.create, {
      giveawayId: GID, teamId: TEAM, kernelId: 'instant',
      settings: { prize: 'Key', channels: [P1], legal: { impressumUrl: 'https://s.example/impressum', terms: null, privacyUrl: null } },
    });
    const [frozen] = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(frozen!.payload).toMatchObject({
      impressum: { url: 'https://s.example/impressum', hash: 'h-imp' },
      terms: { text: 'Profil-Regeln' },
      privacy: { url: 'https://p.example/datenschutz', hash: 'h-pds' },
    });
    // Systemakteur ohne Profil: nur die Giveaway-Angaben zählen.
    await must(s.rt, s.rt.handlers.create, { giveawayId: '66666666-6666-4666-8666-666666666667', teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } });
    expect(codeOf(await run(s.rt, s.rt.handlers.open, { giveawayId: '66666666-6666-4666-8666-666666666667' }, { actor: 'system:scheduler' }))).toBe('legal_required');
  });

  it('unreachable url rejects with legal_unreachable naming the url, nothing written', async () => {
    const fetcher = stubFetcher({ 'https://s.example/impressum': 'h-imp' });
    const s = await setupGiveaway({ legalSource: { profileOf: async () => null }, fetcher });
    close = s.close;
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1], legal: FULL } });
    const r = await run(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(r).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'legal_unreachable', message: 'Die Seite https://s.example/datenschutz ist nicht erreichbar. Prüfe den Link.' },
    });
    const events = await readStream(s.pool, s.rt.registry, giveawayStream(GID));
    expect(events.map((e) => e.type)).toEqual([GIVEAWAY_EVENTS.created]);
  });

  it('registration after opening records the legalEventId in state', async () => {
    const s = await setupGiveaway();
    close = s.close;
    await createOpen(s.rt);
    await must(s.rt, s.rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } });
    await must(s.rt, s.rt.handlers.register, { giveawayId: GID, pid: P1 }, { actor: `user:${P1}` });
    const st = await state(s.rt);
    expect(st.legalEventId).not.toBeNull();
    expect(st.registered[P1]!.legalEventId).toBe(st.legalEventId);
  });

  it('reopen after close does not freeze again, revert of legal_frozen is not possible, revert of open leaves the freeze', async () => {
    const s = await setupGiveaway();
    close = s.close;
    await createOpen(s.rt);
    const before = await readStream(s.pool, s.rt.registry, giveawayStream(GID));
    const frozen = before.find((e) => e.type === GIVEAWAY_EVENTS.legalFrozen)!;
    const opened = before.find((e) => e.type === GIVEAWAY_EVENTS.statusChanged)!;
    await must(s.rt, s.rt.handlers.close, { giveawayId: GID });
    await must(s.rt, s.rt.handlers.reopen, { giveawayId: GID });
    const after = await readStream(s.pool, s.rt.registry, giveawayStream(GID));
    expect(after.filter((e) => e.type === GIVEAWAY_EVENTS.legalFrozen)).toHaveLength(1);
    const r = await run(s.rt, s.rt.handlers.revert, { stream: giveawayStream(GID), eventId: frozen.id, reason: 'x' });
    expect(r).toMatchObject({ ok: false, rejection: { code: 'not_reversible', message: 'Eingefrorene Rechtstexte sind ein Nachweis und bleiben.' } });
    await must(s.rt, s.rt.handlers.close, { giveawayId: GID });
    // Rückgängig bis zum Entwurf: Übergänge in umgekehrter Reihenfolge, das Einfrieren bleibt stehen.
    const all = await readStream(s.pool, s.rt.registry, giveawayStream(GID));
    const transitions = all.filter((e) => e.type === GIVEAWAY_EVENTS.statusChanged).reverse();
    for (const t of transitions) await must(s.rt, s.rt.handlers.revert, { stream: giveawayStream(GID), eventId: t.id, reason: 'zurück' });
    const st = await state(s.rt);
    expect(st.status).toBe('draft');
    expect(st.legalEventId).toBe(frozen.id);
    expect(opened.payload).toEqual({ from: 'draft', to: 'open' });
    // Erneutes Öffnen friert erneut ein (neuer Nachweis).
    const again = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(again.map((e) => e.type)).toEqual([GIVEAWAY_EVENTS.legalFrozen, GIVEAWAY_EVENTS.statusChanged]);
  });

  it('settings.legal is validated like the profile', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const r = await run(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1], legal: { impressumUrl: 'nope' } as never } });
    expect(codeOf(r)).toBe('invalid_url');
  });
});

describe('fetchHash', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('hashes the body of a local http server and reports a 404 as unreachable', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/impressum') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p>Impressum</p>');
      } else {
        res.writeHead(404);
        res.end('nein');
      }
    });
    expect(await fetchHash(`${base}/impressum`, { allowPrivate: true })).toEqual({ ok: true, hash: createHash('sha256').update('<p>Impressum</p>').digest('hex') });
    expect(await fetchHash(`${base}/fehlt`, { allowPrivate: true })).toEqual({ ok: false });
    expect(await fetchHash('http://127.0.0.1:1/zu', { allowPrivate: true })).toEqual({ ok: false });
  });

  it('gives up after the timeout', async () => {
    const base = await serve(() => undefined);
    expect(await fetchHash(`${base}/haengt`, { timeoutMs: 200, allowPrivate: true })).toEqual({ ok: false });
  });
});
