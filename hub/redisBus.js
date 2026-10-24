// The relay's bus on Vercel: Redis pub/sub (Upstash from the Vercel Marketplace), so phones and the host tab meet
// even when their sockets land on different Function instances. One connection publishes and one subscribes,
// because a Redis connection in subscribe mode cannot publish. The relay subscribes to a room's channels while this
// instance holds a socket of that room (hub/relay.js), and ioredis subscribes again after a reconnect.
// Made once per instance, at module scope.
import { Redis } from 'ioredis';

export function redisBus(url) {
  const opts = { maxRetriesPerRequest: 3, connectTimeout: 5000 };
  const pub = new Redis(url, opts), sub = new Redis(url, opts);
  for (const c of [pub, sub]) c.on('error', (err) => console.warn('redis:', err.message));
  const handlers = new Set();
  sub.on('message', (ch, raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    for (const h of handlers) h(ch, m);
  });
  return {
    publish(ch, m) { pub.publish(ch, JSON.stringify(m)).catch((err) => console.warn('redis publish:', err.message)); },
    listen(h) { handlers.add(h); },
    // Resolves once Redis holds the subscription; the relay routes nothing for that room before then, and a rejection
    // closes the room's new sockets with 1013 so the pages retry.
    subscribe: (...chs) => sub.subscribe(...chs),
    unsubscribe(...chs) { sub.unsubscribe(...chs).catch((err) => console.warn('redis unsubscribe:', err.message)); },
    // Resolves once Redis answers; the upgrade waits for it. Only pub is pinged: PING on a subscriber connection is
    // allowed by Redis but unverified on Upstash, and each room's SUBSCRIBE already proves the sub connection.
    ready: () => pub.ping(),
  };
}
