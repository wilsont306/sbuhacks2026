// node tools/export-arch.mjs --span 128 --rise 24.25 [--out arch_128ft_24ft3in.stl]  ->  binary STL at 1:400
import { writeFileSync } from 'node:fs';
import { archGeometry } from '../lib/archGeometry.js';
import { checkArch } from '../lib/heyman.js';
import { writeStl } from '../lib/stl.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 1 ? process.argv[i + 1] : d; };
const span = +arg('span', 128), rise = +arg('rise', 24.25);
if (!(span > 0 && rise > 0)) { console.error('usage: node tools/export-arch.mjs --span <ft> --rise <ft> [--out file.stl]'); process.exit(1); }
const fmtFt = x => { let ft = Math.floor(x), inch = Math.round((x - ft) * 12); if (inch === 12) { ft++; inch = 0; } return inch ? `${ft}ft${inch}in` : `${ft}ft`; };
const out = arg('out', `arch_${span}ft_${fmtFt(rise)}.stl`), SCALE = 0.762;

const g = archGeometry(span, rise), buf = writeStl(g.positions, g.indices, { scale: SCALE, name: `arch ${span} x ${rise} ft, 1:400` });
writeFileSync(out, new Uint8Array(buf));
const mm = v => (v * SCALE).toFixed(1), A = checkArch(span, rise);
console.log(`${out}: ${g.indices.length / 3} triangles, ${buf.byteLength} bytes`);
console.log(`bbox mm: x ${mm(g.bbox.min[0])}..${mm(g.bbox.max[0])}, y ${mm(g.bbox.min[1])}..${mm(g.bbox.max[1])}, z ${mm(g.bbox.min[2])}..${mm(g.bbox.max[2])}` +
  ` (${g.bbox.max.map((v, i) => mm(v - g.bbox.min[i])).join(' x ')})`);
console.log(A.stands ? `stands, thrust inside the ring by ${A.marginMm} mm` : `would fail near joint ${A.worstJoint} of ${A.N} (margin ${A.marginMm} mm)`);
