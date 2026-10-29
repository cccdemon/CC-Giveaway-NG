// Tests aus dem Review zu Teilprojekt 3: Netz-I/O außerhalb der Sperre, SSRF-Schutz, Rebuild des Aufräum-Projektors, legal nach dem Öffnen.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { GIVEAWAY_EVENTS, giveawayStream } from '../src/framework/giveaway/state.js';
import { fetchHash, isPrivateAddress } from '../src/framework/legal.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { REQUIRED_CHANNEL_SCOPES } from '../src/identity/twitch.js';
import { loadChannelToken } from '../src/identity/tokens.js';
import { PLATFORM_TERMS_VERSION } from '../src/identity/terms.js';
import { GID, P1, STREAMER, TEAM, createOpen, must, run, setupGiveaway, state } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const codeOf = (r: CommandResult) => (r.ok ? 'ok' : r.rejection.code);
const FULL = { impressumUrl: 'https://s.example/impressum', terms: { text: 'Ab 18.' }, privacyUrl: 'https://s.example/datenschutz' };

describe('Öffnen holt Rechtstexte außerhalb der Transaktion', () => {
  it('the fetcher runs while the stream is not locked', async () => {
    let lockedDuringFetch: boolean | null = null;
    const s = await setupGiveaway({
      legalSource: { profileOf: async () => null },
      fetcher: async (url) => {
        // Innerhalb der Transaktion wäre stream_heads gesperrt und NOWAIT scheitert mit 55P03.
        try {
          await s.pool.query('SELECT 1 FROM stream_heads WHERE stream = $1 FOR UPDATE NOWAIT', [giveawayStream(GID)]);
          lockedDuringFetch = false;
        } catch {
          lockedDuringFetch = true;
        }
        return { ok: true, hash: `h:${url}` };
      },
    });
    close = s.close;
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1], legal: FULL } });
    const events = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(events.map((e) => e.type)).toEqual([GIVEAWAY_EVENTS.legalFrozen, GIVEAWAY_EVENTS.statusChanged]);
    expect(lockedDuringFetch).toBe(false);
  });

  it('legal texts changed between fetch and transaction reject with legal_changed, nothing written', async () => {
    let first = true;
    const s = await setupGiveaway({
      legalSource: { profileOf: async () => null },
      fetcher: async (url) => {
        if (first) {
          first = false;
          // Während des Abrufs ändert jemand die Rechtstexte. Der Fetcher läuft außerhalb der Sperre, darum geht das.
          await must(s.rt, s.rt.handlers.changeSettings, { giveawayId: GID, settings: { legal: { ...FULL, privacyUrl: 'https://s.example/neu' } } });
        }
        return { ok: true, hash: `h:${url}` };
      },
    });
    close = s.close;
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1], legal: FULL } });
    const r = await run(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(r).toEqual({ ok: false, rejection: { rejected: true, code: 'legal_changed', message: 'Die Rechtstexte haben sich gerade geändert. Öffne erneut.' } });
    expect((await state(s.rt)).status).toBe('draft');
    const types = (await s.pool.query('SELECT type FROM events ORDER BY id')).rows.map((r) => r.type);
    expect(types).toEqual([GIVEAWAY_EVENTS.created, GIVEAWAY_EVENTS.settingsChanged]);
    // Zweiter Versuch mit den neuen Texten klappt.
    expect(codeOf(await run(s.rt, s.rt.handlers.open, { giveawayId: GID }))).toBe('ok');
  });
});

describe('legal nach dem Öffnen', () => {
  it('changeSettings rejects legal changes outside draft with legal_locked, other settings still change', async () => {
    const s = await setupGiveaway();
    close = s.close;
    await createOpen(s.rt);
    const r = await run(s.rt, s.rt.handlers.changeSettings, { giveawayId: GID, settings: { legal: FULL } });
    expect(r).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'legal_locked', message: 'Die Rechtstexte sind seit dem Öffnen eingefroren. Für neue Texte lege ein neues Giveaway an.' },
    });
    expect(codeOf(await run(s.rt, s.rt.handlers.changeSettings, { giveawayId: GID, settings: { prize: 'Neu' } }))).toBe('ok');
    // Gleicher Wert wie bisher (null) ist keine Änderung.
    expect(codeOf(await run(s.rt, s.rt.handlers.changeSettings, { giveawayId: GID, settings: { legal: null } }))).toBe('ok');
    await must(s.rt, s.rt.handlers.pause, { giveawayId: GID });
    expect(codeOf(await run(s.rt, s.rt.handlers.changeSettings, { giveawayId: GID, settings: { legal: FULL } }))).toBe('legal_locked');
  });

  it('in draft legal changes freely', async () => {
    const s = await setupGiveaway();
    close = s.close;
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } });
    expect(codeOf(await run(s.rt, s.rt.handlers.changeSettings, { giveawayId: GID, settings: { legal: FULL } }))).toBe('ok');
    expect((await state(s.rt)).settings.legal).toEqual(FULL);
  });
});

describe('identity_cleanup beim Neuaufbau', () => {
  it('rebuild after connect → disconnect → connect keeps the current token', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const key = randomBytes(32);
    const accounts = attachAccounts(s.rt, { tokenKey: key });
    const pid = STREAMER.slice('user:'.length);
    const token = { accessToken: 'acc', refreshToken: 'ref', expiresIn: 3600, scopes: [...REQUIRED_CHANNEL_SCOPES] };
    await must(s.rt, accounts.signIn, { pid, soloTeamId: TEAM, user: { id: '1', login: 'a', displayName: 'A' } }, { actor: 'system:twitch' });
    await must(s.rt, accounts.acceptTerms, { pid, version: PLATFORM_TERMS_VERSION });
    await must(s.rt, accounts.connectChannel, { pid, twitchId: '1', token });
    await must(s.rt, accounts.disconnectChannel, { pid });
    await must(s.rt, accounts.connectChannel, { pid, twitchId: '1', token: { ...token, accessToken: 'acc2' } });
    await s.rt.projections.rebuild(s.pool, s.rt.registry, 'identity_cleanup');
    expect((await loadChannelToken(s.pool, pid, key))?.accessToken).toBe('acc2');
    // Löschung bleibt beim Neuaufbau wirksam.
    await must(s.rt, accounts.deleteAccount, { pid });
    await s.rt.projections.rebuild(s.pool, s.rt.registry, 'identity_cleanup');
    expect(await loadChannelToken(s.pool, pid, key)).toBeNull();
  });
});

describe('fetchHash blockt interne Ziele', () => {
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

  it('isPrivateAddress knows loopback, link-local, private and mapped ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses private hosts, non-standard ports and oversized bodies unless allowPrivate is set', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/gross') {
        res.writeHead(200);
        res.end(Buffer.alloc(3 * 1024 * 1024, 65));
      } else if (req.url === '/weiter') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/ziel' });
        res.end();
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
    expect(await fetchHash(`${base}/ok`)).toEqual({ ok: false });
    expect(await fetchHash(`${base}/ok`, { allowPrivate: true })).toMatchObject({ ok: true });
    expect(await fetchHash('http://169.254.169.254/latest/meta-data', { timeoutMs: 200 })).toEqual({ ok: false });
    expect(await fetchHash('http://localhost:2019/config', { timeoutMs: 200 })).toEqual({ ok: false });
    expect(await fetchHash('https://example.com:8443/', { timeoutMs: 200 })).toEqual({ ok: false });
    expect(await fetchHash(`${base}/gross`, { allowPrivate: true })).toEqual({ ok: false });
    expect(await fetchHash(`${base}/weiter`, { allowPrivate: true })).toEqual({ ok: false });
  });

  it('follows a redirect to an allowed target and hashes the final body', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/alt') {
        res.writeHead(301, { location: '/neu' });
        res.end();
      } else {
        res.writeHead(200);
        res.end('neu');
      }
    });
    const direct = await fetchHash(`${base}/neu`, { allowPrivate: true });
    expect(await fetchHash(`${base}/alt`, { allowPrivate: true })).toEqual(direct);
  });
});
