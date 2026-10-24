// Binary STL from indexed triangles. Default scale 0.762 mm per ft = 1:400.
export function writeStl(positions, indices, { scale = 0.762, name = 'arch' } = {}) {
  const count = indices.length / 3, buf = new ArrayBuffer(84 + 50 * count), dv = new DataView(buf);
  for (let i = 0; i < Math.min(80, name.length); i++) dv.setUint8(i, name.charCodeAt(i) & 0x7f);
  dv.setUint32(80, count, true);
  const v = (j, c) => positions[indices[j] * 3 + c] * scale;
  for (let t = 0, o = 84; t < count; t++, o += 50) {
    const j = t * 3;
    const ux = v(j + 1, 0) - v(j, 0), uy = v(j + 1, 1) - v(j, 1), uz = v(j + 1, 2) - v(j, 2);
    const wx = v(j + 2, 0) - v(j, 0), wy = v(j + 2, 1) - v(j, 1), wz = v(j + 2, 2) - v(j, 2);
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, len = Math.hypot(nx, ny, nz) || 1;
    [nx / len, ny / len, nz / len].forEach((x, c) => dv.setFloat32(o + c * 4, x, true));
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) dv.setFloat32(o + 12 + k * 12 + c * 4, v(j + k, c), true);
    dv.setUint16(o + 48, 0, true);
  }
  return buf;
}

export function readStl(arrayBuffer) {
  const dv = new DataView(arrayBuffer), count = dv.getUint32(80, true), positions = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) for (let i = 0; i < 9; i++) positions[t * 9 + i] = dv.getFloat32(84 + t * 50 + 12 + i * 4, true);
  return { count, positions };
}
