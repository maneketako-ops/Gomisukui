// Naive Surface Nets による SDF のメッシュ化。
// sdf(x, y, z, active) の active はプリミティブごとの有効フラグ（遠いものを省いて高速化）。
// boxes は各プリミティブの AABB。頂点は勾配に沿って面上へ投影し、法線も SDF の勾配から求める。

const CULL_MARGIN = 0.03;

export function buildSurfaceNets(sdf, boxes, bmin, bmax, step) {
  const nx = Math.ceil((bmax.x - bmin.x) / step) + 1;
  const ny = Math.ceil((bmax.y - bmin.y) / step) + 1;
  const nz = Math.ceil((bmax.z - bmin.z) / step) + 1;
  const field = new Float32Array(nx * ny * nz);
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  const np = boxes.length;
  const activeZ = new Uint8Array(np);
  const active = new Uint8Array(np);

  for (let k = 0; k < nz; k++) {
    const z = bmin.z + k * step;
    for (let p = 0; p < np; p++) {
      const b = boxes[p];
      activeZ[p] = z > b.min.z - CULL_MARGIN && z < b.max.z + CULL_MARGIN ? 1 : 0;
    }
    for (let j = 0; j < ny; j++) {
      const y = bmin.y + j * step;
      let any = 0;
      for (let p = 0; p < np; p++) {
        const b = boxes[p];
        active[p] = activeZ[p] && y > b.min.y - CULL_MARGIN && y < b.max.y + CULL_MARGIN ? 1 : 0;
        any |= active[p];
      }
      for (let i = 0; i < nx; i++) {
        field[idx(i, j, k)] = any ? sdf(bmin.x + i * step, y, z, active) : 1;
      }
    }
  }

  // セルごとの頂点
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cidx = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i;
  const positions = [];
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[idx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let cnt = 0;
        for (const [a, b] of EDGES) {
          const fa = corner[a];
          const fb = corner[b];
          if (fa < 0 === fb < 0) continue;
          const t = fa / (fa - fb);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          cnt++;
        }
        cellVert[cidx(i, j, k)] = positions.length / 3;
        positions.push(
          bmin.x + (i + sx / cnt) * step,
          bmin.y + (j + sy / cnt) * step,
          bmin.z + (k + sz / cnt) * step,
        );
      }
    }
  }

  // 面（符号が変わる格子辺ごとに、それを囲む 4 セルで四角形）
  const tris = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    tris.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f0 = field[idx(i, j, k)] < 0;
        if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1) {
          if (f0 !== field[idx(i + 1, j, k)] < 0) {
            quad(cellVert[cidx(i, j - 1, k - 1)], cellVert[cidx(i, j, k - 1)], cellVert[cidx(i, j, k)], cellVert[cidx(i, j - 1, k)]);
          }
        }
        if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1) {
          if (f0 !== field[idx(i, j + 1, k)] < 0) {
            quad(cellVert[cidx(i - 1, j, k - 1)], cellVert[cidx(i, j, k - 1)], cellVert[cidx(i, j, k)], cellVert[cidx(i - 1, j, k)]);
          }
        }
        if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
          if (f0 !== field[idx(i, j, k + 1)] < 0) {
            quad(cellVert[cidx(i - 1, j - 1, k)], cellVert[cidx(i, j - 1, k)], cellVert[cidx(i, j, k)], cellVert[cidx(i - 1, j, k)]);
          }
        }
      }
    }
  }

  // 頂点を面上へ投影し、法線を求める
  const pos = Float32Array.from(positions);
  const nrm = new Float32Array(pos.length);
  const e = step * 0.25;
  for (let v = 0; v < pos.length; v += 3) {
    let x = pos[v];
    let y = pos[v + 1];
    let z = pos[v + 2];
    let gx = 0;
    let gy = 0;
    let gz = 1;
    for (let it = 0; it < 3; it++) {
      const d = sdf(x, y, z, null);
      gx = sdf(x + e, y, z, null) - sdf(x - e, y, z, null);
      gy = sdf(x, y + e, z, null) - sdf(x, y - e, z, null);
      gz = sdf(x, y, z + e, null) - sdf(x, y, z - e, null);
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl;
      gy /= gl;
      gz /= gl;
      if (it < 2) {
        const s = Math.max(-step, Math.min(step, d));
        x -= gx * s;
        y -= gy * s;
        z -= gz * s;
      }
    }
    pos[v] = x;
    pos[v + 1] = y;
    pos[v + 2] = z;
    nrm[v] = gx;
    nrm[v + 1] = gy;
    nrm[v + 2] = gz;
  }

  // 三角形の向きを法線にそろえる
  const ind = Uint32Array.from(tris);
  for (let t = 0; t < ind.length; t += 3) {
    const a = ind[t] * 3;
    const b = ind[t + 1] * 3;
    const c = ind[t + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const nx2 = nrm[a] + nrm[b] + nrm[c];
    const ny2 = nrm[a + 1] + nrm[b + 1] + nrm[c + 1];
    const nz2 = nrm[a + 2] + nrm[b + 2] + nrm[c + 2];
    if (cx * nx2 + cy * ny2 + cz * nz2 < 0) {
      const tmp = ind[t + 1];
      ind[t + 1] = ind[t + 2];
      ind[t + 2] = tmp;
    }
  }

  return { positions: pos, normals: nrm, indices: ind };
}
