// Ein Durchlauf durch die Spec (NEW_DESIGN.md 12.2): Starten, Pausieren, Ziehen, Rückgängig, Löschen.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { L } from '../src/lib/texts/labels.js';
import { S } from '../src/lib/texts/sentences.js';

const API = 'http://127.0.0.1:3100';
const ALICE = { id: '1001', login: 'alice', displayName: 'Alice' };
const BOB = { id: '2002', login: 'bob', displayName: 'Bob' };

/** Erst nach der Hydration reagieren Knöpfe. Das Layout setzt den Marker in onMount. */
const ready = (page: Page) => page.locator('body[data-hydrated="1"]').waitFor();

async function become(page: Page, user: typeof ALICE) {
  const res = await page.request.post(`${API}/__e2e/user`, { data: user });
  expect(res.ok()).toBeTruthy();
}

async function login(browser: Browser, user: typeof ALICE, start: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await become(page, user);
  await page.goto(start);
  await ready(page);
  return { context, page };
}

test('Streamer startet, pausiert, zieht und macht rückgängig, Teilnehmer gewinnt und löscht sich', async ({ browser }) => {
  // Alice: Anmelden → Nutzungsbedingungen → Kanal → Rechtstexte
  const alice = await login(browser, ALICE, '/');
  const a = alice.page;
  await a.getByRole('link', { name: L.actions.login }).first().click();
  await expect(a).toHaveURL(/\/terms/);
  await ready(a);
  await a.getByRole('button', { name: L.actions.accept }).click();
  await expect(a).toHaveURL(/\/giveaways$/);
  await ready(a);
  await expect(a.getByRole('heading', { name: L.nav.overview })).toBeVisible();

  await a.getByRole('link', { name: L.actions.connect }).click();
  await expect(a).toHaveURL(/\/giveaways$/);
  await ready(a);
  await expect(a.getByText(L.channel.offline)).toBeVisible();

  await a.goto('/legal');
  await ready(a);
  await a.getByLabel(L.fields.impressumUrl).fill('https://alice.example/impressum');
  await a.getByRole('textbox', { name: L.fields.terms, exact: true }).fill('Teilnahme ab 18. Eine Teilnahme je Person.');
  await a.getByLabel(L.fields.privacyUrl).fill('https://alice.example/datenschutz');
  await a.getByRole('button', { name: L.actions.save }).click();
  await expect(a.getByText(S.saved)).toBeVisible();

  // Start-Assistent: Kern B, Gewinn, Keyword, eigener Kanal, keine Bedingungen, Rechtstexte aus dem Profil, öffnen
  await a.goto('/giveaways/new');
  await ready(a);
  await a.getByRole('radio', { name: /Sofortverlosung/ }).click();
  await a.getByRole('button', { name: new RegExp(`^${L.actions.next}`) }).click();
  await a.getByLabel(L.fields.prize, { exact: true }).fill('E2E-Preis');
  await a.getByLabel(L.fields.keyword, { exact: true }).fill('!e2e');
  await a.getByRole('button', { name: new RegExp(`^${L.actions.next}`) }).click();
  await expect(a.getByRole('checkbox', { name: ALICE.displayName })).toBeChecked();
  await a.getByRole('button', { name: new RegExp(`^${L.actions.next}`) }).click();
  await a.getByRole('button', { name: new RegExp(`^${L.actions.next}`) }).click();
  await expect(a.getByRole('radio', { name: new RegExp(L.wizard.legalProfile) })).toBeChecked();
  await a.getByRole('button', { name: new RegExp(`^${L.actions.next}`) }).click();
  await a.getByRole('button', { name: L.actions.openNow }).click();
  await expect(a).toHaveURL(/\/giveaways\/[0-9a-f-]{36}$/);
  const giveawayId = a.url().split('/').pop()!;
  await expect(a.getByText(L.status.open, { exact: true }).first()).toBeVisible();

  // Anmeldefenster öffnen (Kern B)
  await a.getByRole('button', { name: 'Anmeldefenster öffnen' }).click();
  await expect(a.getByText(/Anmeldefenster offen bis/)).toBeVisible();

  // Bob: öffentliche Seite → Anmelden → Teilnehmen
  const bob = await login(browser, BOB, `/g/${giveawayId}`);
  const b = bob.page;
  await b.getByRole('link', { name: L.actions.loginAndJoin }).click();
  await expect(b).toHaveURL(new RegExp(`/portal/giveaways/${giveawayId}$`));
  await ready(b);
  await b.getByRole('button', { name: L.actions.join }).click();
  await expect(b.getByText(S.portal.inPool)).toBeVisible();

  // Alice: Pausieren, Fortsetzen, Schließen, Ziehen
  await a.reload();
  await ready(a);
  await a.getByRole('button', { name: L.actions.pause }).click();
  await expect(a.getByText(L.status.paused, { exact: true }).first()).toBeVisible();
  await a.getByRole('button', { name: L.actions.resume }).click();
  await expect(a.getByText(L.status.open, { exact: true }).first()).toBeVisible();
  await a.getByRole('button', { name: L.actions.close }).click();
  await expect(a.getByText(L.status.closed, { exact: true }).first()).toBeVisible();
  await a.getByRole('button', { name: L.actions.draw, exact: true }).click();
  await expect(a.getByText(L.status.drawn, { exact: true }).first()).toBeVisible();
  const proof = a.getByRole('region', { name: L.detail.proof });
  await expect(proof.getByText(BOB.displayName).first()).toBeVisible();

  // Gewinnerstatus setzen, dann Rückgängig mit Grund
  await proof.getByLabel(L.detail.winnerStatus).selectOption('reported');
  await expect(a.getByText(`Gewinn von ${BOB.displayName}: ${L.winner.reported}.`)).toBeVisible();
  await a.getByRole('button', { name: L.actions.revert }).first().click();
  await a.getByLabel(L.fields.reason).fill('Versehen');
  await a.getByRole('dialog').getByRole('button', { name: L.actions.revert }).click();
  await expect(a.getByText(L.reverted).first()).toBeVisible();
  await expect(proof.getByLabel(L.detail.winnerStatus)).toHaveValue('pending');

  // Streamermodus maskiert den Namen
  await a.getByLabel(L.streamerMode).check();
  await expect(a.getByText(/Teilnehmer ·[0-9a-f]{4}/).first()).toBeVisible();
  await a.getByLabel(L.streamerMode).uncheck();

  // Bob: Gewinn sehen, dann alles löschen
  await b.reload();
  await ready(b);
  await expect(b.getByText(S.portal.won)).toBeVisible();
  await b.goto('/portal/data');
  await ready(b);
  await b.getByRole('button', { name: L.actions.deleteAll }).click();
  await b.getByRole('dialog').getByRole('button', { name: L.actions.deleteAll }).click();
  await expect(b).toHaveURL(/\/$/);
  await expect(b.getByRole('link', { name: L.actions.login }).first()).toBeVisible();

  // Alice: der Gewinner ist jetzt ein gelöschter Teilnehmer
  await a.reload();
  await ready(a);
  await expect(a.getByText(new RegExp(L.participant.deleted)).first()).toBeVisible();

  // Abgelaufene Sitzung mitten in der Arbeit: keine Schleife, zurück zur Anmeldung mit Rücksprung
  await alice.context.clearCookies();
  await a.getByRole('link', { name: L.nav.team }).click();
  await expect(a).toHaveURL(/\/\?return=%2Fteams$/);
  await expect(a.getByRole('link', { name: L.actions.login }).first()).toBeVisible();

  await bob.context.close();
  await alice.context.close();
});
