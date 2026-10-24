# Credits

## The painting

Joseph Mallord William Turner, *Rain, Steam, and Speed – The Great Western Railway*, 1844. The National Gallery, London, NG538. A public-domain scan via Wikimedia Commons, used as `public/assets/turner-1920.jpg`.

Commons file page:

## Depth

Depth Anything V2 Small (`depth-anything/Depth-Anything-V2-Small-hf`), Apache-2.0. Only the Small checkpoint has this licence, so `tools/depth.py` uses only that one. The model runs once on the scan, offline, and writes `public/depth/turner-depth.png`.

## Type

All three faces are vendored through @fontsource 5.3.0 under the SIL Open Font License 1.1. Nothing is fetched from a font CDN at runtime.

- IM Fell English
- Libre Franklin
- JetBrains Mono

## Libraries

Each licence below is read from the package's own `package.json` in `node_modules`.

| Package | Version | Licence | Used in |
|---|---|---|---|
| three.js | 0.128.0 (r128) | MIT | host page |
| ws | 8.22.0 | MIT | hub |
| express | 4.22.3 | MIT | hub |
| qrcode-generator | 1.4.4 | MIT | host page (join QR) |
| nosleep.js | 0.12.0 | MIT | join page (wake lock fallback) |
| vite | 5.4.21 | MIT | build only |

## Sources

- J. Heyman, *The Masonry Arch* (1982): the thrust-line method behind Fig. 2 and `lib/heyman.js`.
- Grace's Guide to British Industrial History: card source.
- The National Gallery's entry for NG538: card source and wall label.

Each card's own source line is in `src/shared/cards.json`.

## AI tools

See "AI tools" in `README.md`.
