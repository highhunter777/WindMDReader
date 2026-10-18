/**
 * 生成 WindMD 应用图标源图(1024×1024 PNG)。
 *
 * 为什么是脚本而不是一张二进制图:图标需要可复现、可改参(配色/圆角/字徽位置),
 * 且不依赖任何外部工具或网络 —— Node 自带 zlib,PNG 编码手写即可。
 *
 * 设计:圆角方形徽章(靛蓝→天蓝对角渐变 + 左上柔光),中央白色 Markdown 字徽
 * (粗壮 M + 下箭头,即官方 Markdown 标志的核心图形),扁平、高对比、无文字,
 * 缩小到 32px 仍可辨认。
 *
 * 用法:node scripts/make-icon.mjs [输出路径]
 * 生成后用 `npx tauri icon src-tauri/icons/app-icon.png` 派生各平台尺寸。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const S = 1024; // 画布边长
const SS = 3; // 超采样倍数(抗锯齿)

/* ---------------- 调色板 ---------------- */
const C_TL = [0x31, 0x2e, 0x81]; // 左上:indigo-900
const C_MID = [0x4f, 0x46, 0xe5]; // 中间:indigo-600
const C_BR = [0x0e, 0xa5, 0xe9]; // 右下:sky-500
const RADIUS = 228; // 徽章圆角(iOS 风大圆角)
const GLYPH = [0xff, 0xff, 0xff]; // 字徽纯白

/* ---------------- 几何工具 ---------------- */

/** 点到线段距离 */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 点在三角形内(重心符号法) */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ---------------- 像素求值:坐标均为设计空间(0..S),返回 [r,g,b,a] ---------------- */

function sample(cx, cy) {
  /* --- 徽章:圆角矩形(中央十字必在,角区看圆心距) --- */
  const r = RADIUS;
  const cornerX = cx < r || cx > S - r;
  const cornerY = cy < r || cy > S - r;
  let inside;
  if (cornerX && cornerY) {
    const ox = cx < r ? r : S - r;
    const oy = cy < r ? r : S - r;
    inside = Math.hypot(cx - ox, cy - oy) <= r;
  } else {
    inside = true; // 十字区域:画布内必在圆角矩形内
  }
  if (!inside) return [0, 0, 0, 0];

  /* --- 背景:三段对角渐变(左上→中间→右下) --- */
  const t = Math.min(1, Math.max(0, (cx + cy) / (2 * S)));
  let base;
  if (t < 0.5) {
    const k = t / 0.5;
    base = C_TL.map((v, i) => v + (C_MID[i] - v) * k);
  } else {
    const k = (t - 0.5) / 0.5;
    base = C_MID.map((v, i) => v + (C_BR[i] - v) * k);
  }

  /* 左上柔光(径向,白 14% → 0),增加一点立体感 */
  const sheen = Math.max(0, 1 - Math.hypot(cx - S * 0.22, cy - S * 0.18) / (S * 0.85));
  const sk = sheen * sheen * 0.14;
  base = base.map((v, i) => v + (255 - v) * sk);

  /* --- 字徽:M(双腿 + V)+ 下箭头(约占画布 53%,垂直居中) --- */
  const legW = 74; // 腿宽
  const mTop = 232;
  const mBot = 636;
  const mLeft = 240;
  const mRight = 784 - legW; // 右腿左沿
  const vBotY = 492; // V 的最低点(中线)
  const thick = 74; // V 与箭杆的粗细

  let glyph = false;
  // 左右腿
  if (cx >= mLeft && cx <= mLeft + legW && cy >= mTop && cy <= mBot) glyph = true;
  if (cx >= mRight && cx <= mRight + legW && cy >= mTop && cy <= mBot) glyph = true;
  // V:两段粗线(左上→谷底→右上)
  if (
    distToSeg(cx, cy, mLeft + legW, mTop + 8, (mLeft + mRight + legW) / 2, vBotY) <= thick / 2 ||
    distToSeg(cx, cy, (mLeft + mRight + legW) / 2, vBotY, mRight, mTop + 8) <= thick / 2
  ) {
    glyph = true;
  }
  // 箭头:竖杆 + 等边朝向下的三角
  const aTop = 584;
  const aBot = 740;
  const aCx = (mLeft + mRight + legW) / 2; // 与 M 中线对齐
  if (cx >= aCx - thick / 2 && cx <= aCx + thick / 2 && cy >= aTop && cy <= aBot) glyph = true;
  const headW = 138;
  const headTop = 632;
  const headBot = 800;
  if (
    inTriangle(
      cx,
      cy,
      aCx - headW,
      headTop,
      aCx + headW,
      headTop,
      aCx,
      headBot,
    )
  ) {
    glyph = true;
  }

  if (glyph) return [...GLYPH, 255];
  return [...base.map(Math.round), 255];
}

/* ---------------- 渲染(超采样 + 盒式降采样) ---------------- */
const W = S * SS;
const out = Buffer.alloc(S * S * 4);

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        // 超采样点换算回设计空间(像素中心)
        const [pr, pg, pb, pa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        // 预乘 alpha 累加,避免透明边缘与背景混色发灰
        r += pr * pa;
        g += pg * pa;
        b += pb * pa;
        a += pa;
      }
    }
    const n = SS * SS;
    const o = (y * S + x) * 4;
    if (a > 0) {
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / n);
    }
  }
}

/* ---------------- PNG 编码(手写,零依赖) ---------------- */
const crcTable = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); // width
ihdr.writeUInt32BE(S, 4); // height
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// 每行前置 filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  out.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = process.argv[2] ?? 'src-tauri/icons/app-icon.png';
writeFileSync(target, png);
console.log(`icon written: ${target} (${(png.length / 1024).toFixed(1)} KB, ${S}x${S})`);
