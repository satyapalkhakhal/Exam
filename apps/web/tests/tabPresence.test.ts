import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabPresence, type ChannelLike } from '../src/lib/tabPresence.js';

/** An in-memory BroadcastChannel: delivers asynchronously to every *other* member. */
function bus() {
  const members = new Set<ChannelLike>();
  return () => {
    const ch: ChannelLike = {
      onmessage: null,
      postMessage(data: unknown) {
        for (const m of members) if (m !== ch) queueMicrotask(() => m.onmessage?.({ data: structuredClone(data) }));
      },
      close() {
        members.delete(ch);
      },
    };
    members.add(ch);
    return ch;
  };
}

test('probe: no other tab -> false', async () => {
  const open = bus();
  const me = createTabPresence({ channel: open(), tabId: 'me' });
  assert.equal(await me.probe(30), false);
});

test('probe: a live exam tab answers -> true (this tab is a duplicate)', async () => {
  const open = bus();
  const live = createTabPresence({ channel: open(), tabId: 'live' });
  live.setAnswering(true);
  const dup = createTabPresence({ channel: open(), tabId: 'dup' });
  assert.equal(await dup.probe(200), true);
});

test('probe: a tab that is not running the exam does not answer', async () => {
  const open = bus();
  createTabPresence({ channel: open(), tabId: 'dashboard' });
  const me = createTabPresence({ channel: open(), tabId: 'me' });
  assert.equal(await me.probe(30), false);
});

test('announceTakeover tells the other tabs they were superseded, and they stop answering', async () => {
  const open = bus();
  const old = createTabPresence({ channel: open(), tabId: 'old' });
  old.setAnswering(true);
  let superseded = 0;
  old.onTakenOver(() => superseded++);
  const fresh = createTabPresence({ channel: open(), tabId: 'fresh' });
  fresh.announceTakeover();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(superseded, 1);
  const third = createTabPresence({ channel: open(), tabId: 'third' });
  assert.equal(await third.probe(30), false, 'the superseded tab no longer claims the exam');
});

test('without BroadcastChannel the probe is simply false', async () => {
  const me = createTabPresence({ channel: null, tabId: 'me' });
  assert.equal(await me.probe(30), false);
  me.announceTakeover();
});
