// Frozen contract shared by hub.js, the host page (TV) and the join page (phone).
// README "Protocol" documents every message; change both together or not at all.

export const MAX_PLAYERS = 6;            // six accent colours, six slots
export const MAX_SOCKETS = 12;           // slots + reconnect grace + strays
export const PLAYER_MAX_PAYLOAD = 1024;  // bytes; the host socket is exempt
export const MSGS_PER_SEC = 20;          // per player socket
export const SLOT_HOLD_MS = 20000;       // a sleeping phone keeps its colour this long
export const PING_MS = 15000;            // ws ping, below Cloudflare/Fly idle closes
export const HB_MS = 2000;               // hub -> player {t:'hb'} and host -> all {t:'hb', ts}
export const HB_WATCHDOG_MS = 5000;      // phone drops a silent socket after this
export const STATS_MS = 5000;            // hub -> host {t:'stats'}
export const INPUT_HZ = 10;              // phone heartbeat while input is non-zero
export const INPUT_STALE_MS = 1000;      // host zeroes a phone's non-zero input when that heartbeat stops this long
export const AWAY_RELEASE_MS = 10000;    // host releases a plaque this long after {t:'away'}
export const ORIGINAL_COOLDOWN_MS = 20000; // phones may trigger Show the original once per 20 s, globally
export const ORIGINAL_MS = 8000;         // Show the original lasts 8 s

export const PLAQUES = ['loco', 'bridge', 'hare'];
export const MODES = ['walk', 'loco', 'bridge', 'hare', 'frozen', 'reset'];

// Hotspot constants in path-parameter units (t runs 0..1 along the bank).
export const HOTSPOT_HALF_WIDTH = 0.03;  // |t - plaque.t| <= this counts as "at the plaque"
export const WALK_OFF = 0.08;            // an owner farther than this ...
export const WALK_OFF_MS = 300;          // ... for this long releases the plaque
export const SNAP = 0.03;
export const MIN_T = 0.15;               // figures walk t MIN_T..1: at follow zoom 1.35 the camera pan cannot frame the bank below it

// Stage 3: phone panels. Phones send slider values at most PANEL_HZ; the host clamps every value (never trusts the phone).
export const PANEL_HZ = 10;
export const LEVER_MIN = 0, LEVER_MAX = 60;           // mph
export const SPAN_MIN = 90, SPAN_MAX = 160;           // ft
export const RISE_MIN = 10, RISE_MAX_PHONE = 48, RISE_MAX_KIOSK = 64; // ft; the demo beat: push the rise up until it fails (~34 ft), back down until it stands
export const EXPORT_COOLDOWN_MS = 10000;  // one STL download on the laptop per 10 s, globally

// Stage 3: ownership release rules (phone owners; the keyboard, pid 0, releases only on Esc, the panel's close button, walk-off or R).
export const OWNER_IDLE_MS = 20000;       // no panel input from the owner this long releases the plaque (off in judge mode)
export const OWNER_CAP_MS = 90000;        // nobody holds a plaque longer than this ...
export const OWNER_CAP_JUDGE_MS = 180000; // ... or this in judge mode

// Stage 3: slot policy (B4). Idle = no non-zero input and no panel message. Plaque owners are exempt from both idle releases.
export const PLAYER_IDLE_MS = 90000;      // any phone idle this long is released from the bank (kick, reason 'idle')
export const JUDGE_IDLE_MS = 30000;       // in judge mode, phones already on the bank when J was pressed are released after this idle
export const JUDGE_RESERVE = 2;           // J kicks the longest-idle phones until this many of the six slots are free

// Close codes
export const CLOSE_HOST_REPLACED = 4000;
export const CLOSE_EVICTED = 4001;       // phone clears its token and stops auto-reconnect
export const CLOSE_REPLACED = 1000;      // same token from a newer socket (a second tab): the old one stops, keeps its token
export const CLOSE_BAD_HOST_TOKEN = 4003;

export const FLY_WS = 'wss://toy-theatre-hub.fly.dev/ws';

// The WebSocket URL for a page at `loc` (window.location). `override` is the ?hub= query value:
// 'localhost' | 'host:port' | 'ws://…' | 'wss://…' | 'http(s)://…'.
export function hubUrl(loc, override) {
  if (override) {
    if (/^wss?:\/\//.test(override)) return override;
    if (/^https?:\/\//.test(override)) return override.replace(/^http/, 'ws').replace(/\/?$/, '') + '/ws';
    return 'ws://' + override + '/ws';
  }
  if (loc.hostname.endsWith('vercel.app')) return FLY_WS;
  return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws';
}
