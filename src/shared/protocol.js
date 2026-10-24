// Frozen contract shared by hub.js, the host page (TV) and the join page (phone).
// README "Protocol" documents every message; change both together or not at all.

export const MAX_PLAYERS = 6;            // six accent colours, six slots
export const MAX_SOCKETS = 12;           // slots + reconnect grace + strays
export const PLAYER_MAX_PAYLOAD = 1024;  // bytes; the host socket is exempt
export const MSGS_PER_SEC = 20;          // per player socket
export const SLOT_HOLD_MS = 20000;       // a sleeping phone keeps its colour this long
export const PING_MS = 15000;            // ws ping, below proxy idle closes
export const HB_MS = 2000;               // relay -> player {t:'hb', i} and host -> all {t:'hb', ts}
export const HB_WATCHDOG_MS = 5000;      // phone drops a silent socket after this
export const INPUT_HZ = 4;               // phone heartbeat while input is non-zero; each one is a Redis PUBLISH on Vercel
export const INPUT_STALE_MS = 1000;      // host zeroes a phone's non-zero input when that heartbeat stops this long
export const ORIGINAL_COOLDOWN_MS = 20000; // phones may trigger Show the original once per 20 s, globally
export const ORIGINAL_MS = 8000;         // Show the original lasts 8 s
export const ARTWORK_COOLDOWN_MS = 20000; // one artwork from each phone per 20 s (each is a Gemini call)

// Path-parameter units (t runs 0..1 along the ground path).
export const HOTSPOT_HALF_WIDTH = 0.03;  // |t - stop.t| <= this counts as "at the object"
export const MIN_T = 0.15;               // figures walk t MIN_T..1: at follow zoom 1.35 the camera pan cannot frame the bank below it

// Slot policy (B4). Idle = no non-zero input and no panel message.
export const PLAYER_IDLE_MS = 90000;      // any phone idle this long is released from the bank (kick, reason 'idle')
export const JUDGE_IDLE_MS = 30000;       // in judge mode, phones already on the bank when J was pressed are released after this idle
export const JUDGE_RESERVE = 2;           // J kicks the longest-idle phones until this many of the six slots are free

// Close codes
export const CLOSE_HOST_REPLACED = 4000;
export const CLOSE_EVICTED = 4001;       // phone clears its token and stops auto-reconnect
// Same token from a newer socket (a second tab): the old one stops and keeps its token. Not 1000, which proxies and
// Vercel's max-duration close can send for an ordinary drop that must reconnect.
export const CLOSE_REPLACED = 4002;
export const CLOSE_BAD_HOST_TOKEN = 4003;

// Vercel closes every WebSocket at the function's max duration (300 s on Hobby), so host and phones open a second
// socket and switch to it before then (make-before-break). ?roll=<ms> on either page shortens it for testing.
export const ROLLOVER_MS = 240000;
export const ROLLOVER_JITTER_MS = 30000;
export const ROLL_WAIT_MS = 5000;        // a rollover socket not welcomed this fast is dropped; the old one stays
export const HOST_SEEN_MS = 6000;        // a phone shows "The screen is resting" after this long without host traffic

// The relay's path everywhere: the Vercel function api/ws.js, the local hub (which also accepts /ws) and Vite's proxy.
export const WS_PATH = '/api/ws';

// The WebSocket URL for a page at `loc` (window.location). `override` is the ?hub= query value:
// 'localhost' | 'host:port' | 'ws://…' | 'wss://…' | 'http(s)://…'.
export function hubUrl(loc, override) {
  if (override) {
    if (/^wss?:\/\//.test(override)) return override;
    if (/^https?:\/\//.test(override)) return override.replace(/^http/, 'ws').replace(/\/?$/, '') + WS_PATH;
    return 'ws://' + override + WS_PATH;
  }
  return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + WS_PATH;
}
