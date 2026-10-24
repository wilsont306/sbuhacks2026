// The relay's bus on Vercel: Redis pub/sub (Upstash from the Vercel Marketplace), so phones and the host tab meet
// even when their sockets land on different Function instances. One connection publishes and one subscribes,
// because a Redis connection in subscribe mode cannot publish. Made once per instance, at module scope.
import { Redis } from 'ioredis';
import { CH } from './relay.js';

export function redisBus(url) {
  const opts = { maxRetriesPerRequest: 3, connectTimeout: 5000 };
  const pub = new Redis(url, opts), sub = new Redis(url, opts);
  for (const c of [pub, sub]) c.on('error', (err) => console.warn('redis:', err.message));
  const handlers = new Set();
  // A failed SUBSCRIBE (Redis down while this instance booted) is retried on the next ready(), not kept rejected
  // for the instance's whole life, which would refuse every upgrade with 503.
  let subscribed = null;
  const subscribe = () => (subscribed = sub.subscribe(CH.host, CH.phones, CH.ctl).catch((err) => {
    console.warn('redis subscribe:', err.message); subscribed = null; throw err;
  }));
  subscribe().catch(() => {});
  sub.on('message', (ch, raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    for (const h of handlers) h(ch, m);
  });
  return {
    publish(ch, m) { pub.publish(ch, JSON.stringify(m)).catch((err) => console.warn('redis publish:', err.message)); },
    subscribe(h) { handlers.add(h); },
    // Resolves once both connections answer; the upgrade waits for it so no early message is lost.
    ready: () => Promise.all([subscribed || subscribe(), pub.ping()]),
  };
}
