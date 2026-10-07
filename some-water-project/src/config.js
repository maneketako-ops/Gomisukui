// 共通の寸法・定数（単位はすべてメートル / 秒）

export const TUB = {
  halfX: 0.75, // 浴槽内寸の半分（長辺）
  halfZ: 0.35, // 浴槽内寸の半分（短辺）
  cornerR: 0.18, // 平面形状の角の丸み
  floorY: 0.0, // 浴槽内の底
  rimY: 0.46, // 縁の上端
  wallT: 0.085, // 壁の厚み
  baseY: -0.1, // 浴室の床
  bottomFillet: 0.05, // 底と壁のつなぎ目の丸み
};

export const GRID = {
  dx: 0.0125, // 水面グリッドのセルサイズ
  NX: 120,
  NZ: 56,
  PAD: 6, // 畳み込みカーネル用の外周パディング
};

export const WATER = {
  initialDepth: 0.27,
  g: 9.81,
  overflowY: 0.41, // オーバーフロー穴の高さ
};

export const FLUID = {
  spacing: 0.008, // 粒子間隔（粒子 1 個 ≒ 0.5 mL）
  maxParticles: 4000,
};

export const ROOM = {
  backWallZ: -(TUB.halfZ + TUB.wallT) - 0.005,
  leftWallX: -(TUB.halfX + TUB.wallT) - 0.005,
  rightWallX: 2.6,
  frontWallZ: 3.2,
};

export const FAUCET_TIP = { x: -0.675, y: 0.555, z: 0.0 };

// 浴槽内寸の角丸長方形に対する符号付き距離（xz 平面、内側が負）
export function sdTub(x, z) {
  const r = TUB.cornerR;
  const qx = Math.abs(x) - TUB.halfX + r;
  const qz = Math.abs(z) - TUB.halfZ + r;
  const ox = Math.max(qx, 0);
  const oz = Math.max(qz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0) - r;
}

// sdTub の外向き法線（out に [nx, nz] を書き込む）
export function sdTubNormal(x, z, out) {
  const r = TUB.cornerR;
  const sx = x < 0 ? -1 : 1;
  const sz = z < 0 ? -1 : 1;
  const qx = Math.abs(x) - TUB.halfX + r;
  const qz = Math.abs(z) - TUB.halfZ + r;
  if (qx > 0 && qz > 0) {
    const l = Math.hypot(qx, qz) || 1;
    out[0] = (sx * qx) / l;
    out[1] = (sz * qz) / l;
  } else if (qx > qz) {
    out[0] = sx;
    out[1] = 0;
  } else {
    out[0] = 0;
    out[1] = sz;
  }
  return out;
}
