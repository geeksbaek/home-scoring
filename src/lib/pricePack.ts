// 실거래 시계열 극한 압축 코덱 — 델타 + zigzag + base64 varint(5bit payload/char).
// 전체 기간(약 80만 거래)을 raw ~2.1MB / gzip ~1.4MB로 패킹. 파이프라인(sync.ts) 인코딩 ↔ 프론트 디코딩 공용.
// 포맷: 거래를 날짜 오름차순 정렬 후, [날짜, 가격]을 직전 거래 대비 델타로 인코딩.
//  - 날짜: PRICE_EPOCH 이후 일수
//  - 가격: 0.1억 단위 정수 (round(만원/1000))
//  - 각 정수는 zigzag(음수 대응) 후 base64 varint로 직렬화. 첫 거래만 절대값, 이후 델타.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const IDX: Record<string, number> = {};
for (let i = 0; i < 64; i++) IDX[B64[i]!] = i;

export const PRICE_EPOCH = Date.UTC(2015, 0, 1); // 데이터 최소일보다 앞선 기준일
const DAY = 86400000;

const zig = (n: number) => (n < 0 ? -n * 2 - 1 : n * 2);
const unzig = (n: number) => (n & 1 ? -((n + 1) / 2) : n / 2);

function encOne(n: number): string {
  // n: 음이 아닌 정수(zigzag 적용 후). 5bit payload + 1bit continuation.
  let s = "";
  do {
    let c = n & 31;
    n = Math.floor(n / 32);
    if (n > 0) c |= 32;
    s += B64[c];
  } while (n > 0);
  return s;
}

export interface PackTrade {
  date: string; // "yyyy-mm-dd..."
  price01: number; // 0.1억 단위 정수
}

export function packPriceSeries(trades: PackTrade[]): string {
  const a = trades.slice().sort((x, y) => (x.date < y.date ? -1 : 1));
  let s = "";
  let pd = 0;
  let pp = 0;
  let first = true;
  for (const t of a) {
    const d = Math.round((Date.parse(t.date.slice(0, 10)) - PRICE_EPOCH) / DAY);
    if (first) {
      s += encOne(zig(d)) + encOne(zig(t.price01));
      first = false;
    } else {
      s += encOne(zig(d - pd)) + encOne(zig(t.price01 - pp));
    }
    pd = d;
    pp = t.price01;
  }
  return s;
}

export function unpackPriceSeries(s: string): { date: string; price: number }[] {
  const out: { date: string; price: number }[] = [];
  let i = 0;
  const read = (): number => {
    let n = 0;
    let mul = 1;
    let c: number;
    do {
      c = IDX[s[i++]!]!;
      n += (c & 31) * mul;
      mul *= 32;
    } while (c & 32);
    return unzig(n);
  };
  let pd = 0;
  let pp = 0;
  let first = true;
  while (i < s.length) {
    let d: number;
    let p: number;
    if (first) {
      d = read();
      p = read();
      first = false;
    } else {
      d = pd + read();
      p = pp + read();
    }
    pd = d;
    pp = p;
    const dt = new Date(PRICE_EPOCH + d * DAY);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const day = String(dt.getUTCDate()).padStart(2, "0");
    out.push({ date: `${y}-${m}-${day}`, price: Math.round(p) / 10 });
  }
  return out;
}
