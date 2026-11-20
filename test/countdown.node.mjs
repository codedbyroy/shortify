import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/redirect.js', import.meta.url), 'utf8');

function countdownPage() {
  const elements = new Map();
  const listeners = new Map();
  const destination = 'https://example.com/a?x=hello%20world&y=2#section';
  for (const id of ['countdown', 'countdown-progress', 'redirect-status', 'pause-redirect', 'continue-link', 'countdown-panel', 'countdown-label']) {
    elements.set(id, { hidden: id === 'countdown-panel', textContent: '', href: destination, focus() { this.focused = true; }, addEventListener(event, callback) { listeners.set(`${id}:${event}`, callback); } });
  }
  let now = 0;
  let tick;
  const navigations = [];
  runInNewContext(source, {
    document: { getElementById: (id) => elements.get(id) },
    performance: { now: () => now },
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval: () => { tick = undefined; },
    window: { location: { replace: (url) => navigations.push(url) }, addEventListener: (event, callback) => listeners.set(event, callback) },
  });
  return { elements, listeners, destination, navigations, advance(ms) { now += ms; tick?.(); } };
}

test('waits five full seconds and then opens the exact destination once', () => {
  const page = countdownPage();
  assert.equal(page.elements.get('countdown-panel').hidden, false);
  assert.equal(page.elements.get('continue-link').hidden, true);
  page.advance(1000);
  assert.equal(page.elements.get('countdown').textContent, '4');
  page.advance(3999);
  assert.deepEqual(page.navigations, []);
  assert.equal(page.elements.get('countdown').textContent, '1');
  page.advance(1);
  assert.deepEqual(page.navigations, [page.destination]);
  assert.equal(page.elements.get('continue-link').hidden, false);
  page.advance(5000);
  assert.equal(page.navigations.length, 1);
});

test('Stay here cancels the countdown and exposes a focused manual link', () => {
  const page = countdownPage();
  page.advance(2000);
  page.listeners.get('pause-redirect:click')();
  page.advance(10000);
  assert.deepEqual(page.navigations, []);
  assert.equal(page.elements.get('continue-link').hidden, false);
  assert.equal(page.elements.get('continue-link').focused, true);
  assert.equal(page.elements.get('pause-redirect').hidden, true);
  assert.match(page.elements.get('redirect-status').textContent, /paused/);
});

test('a restored page does not resume an old countdown', () => {
  const page = countdownPage();
  page.advance(2000);
  page.listeners.get('pagehide')();
  page.listeners.get('pageshow')({ persisted: true });
  page.advance(10000);
  assert.deepEqual(page.navigations, []);
  assert.equal(page.elements.get('continue-link').hidden, false);
  assert.equal(page.elements.get('pause-redirect').hidden, true);
});
