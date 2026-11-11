import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARIHANTPLUS_NAV, OPEN_DEMAT_URL, navLinks } from '../src/lib/arihantPlusNav.js';

test('the nav mirrors arihantplus.com: five top-level items in order', () => {
  assert.deepEqual(ARIHANTPLUS_NAV.map((i) => i.label), ['What we offer', 'Pricing', 'Learning', 'About', 'Partner']);
  const offer = ARIHANTPLUS_NAV[0]!;
  assert.ok('groups' in offer && offer.groups);
  assert.deepEqual(offer.groups!.map((g) => g.title), ['Invest', 'Trade']);
});

test('every nav link is an https ArihantPlus page', () => {
  const urls = [...navLinks().map((l) => l.href), OPEN_DEMAT_URL];
  assert.ok(urls.length >= 18, String(urls.length));
  for (const u of urls) {
    const host = new URL(u).hostname;
    assert.equal(new URL(u).protocol, 'https:', u);
    assert.ok(host === 'arihantplus.com' || host.endsWith('.arihantplus.com'), u);
  }
  assert.equal(new Set(urls).size, urls.length, 'no duplicate links');
});
