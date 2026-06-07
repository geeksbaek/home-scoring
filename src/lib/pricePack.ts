// 실거래 시계열 극한 압축 코덱 — 델타 + zigzag + base64 varint(5bit payload/char).
// 전체 기간(약 80만 거래, 직거래/1층 플래그 포함)을 raw ~2.4MB / gzip ~1.6MB로 패킹.
// 파이프라인(sync.ts) 인코딩 ↔ 프론트 디코딩 공용.
// 포맷: 거래를 날짜 오름차순 정렬 후, [날짜, pc]를 직전 거래 대비 델타로 인코딩.
//  - 날짜: PRICE_EPOCH 이후 일수
//  - pc = price01*4 + (직거래?1:0) + (1층?2:0)  — 가격(0.1억 단위)에 2비트 플래그를 접어넣음
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
  direct?: boolean; // 직거래
  firstFloor?: boolean; // 1층
}

export interface UnpackedTrade {
  date: string;
  price: number; // 억
  direct: boolean;
  firstFloor: boolean;
}

export function packPriceSeries(trades: PackTrade[]): string {
  const a = trades.slice().sort((x, y) => (x.date < y.date ? -1 : 1));
  let s = "";
  let pd = 0;
  let pc = 0;
  let first = true;
  for (const t of a) {
    const d = Math.round((Date.parse(t.date.slice(0, 10)) - PRICE_EPOCH) / DAY);
    const code = t.price01 * 4 + (t.direct ? 1 : 0) + (t.firstFloor ? 2 : 0);
    if (first) {
      s += encOne(zig(d)) + encOne(zig(code));
      first = false;
    } else {
      s += encOne(zig(d - pd)) + encOne(zig(code - pc));
    }
    pd = d;
    pc = code;
  }
  return s;
}

export function unpackPriceSeries(s: string): UnpackedTrade[] {
  const out: UnpackedTrade[] = [];
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
  let pc = 0;
  let first = true;
  while (i < s.length) {
    let d: number;
    let code: number;
    if (first) {
      d = read();
      code = read();
      first = false;
    } else {
      d = pd + read();
      code = pc + read();
    }
    pd = d;
    pc = code;
    const dt = new Date(PRICE_EPOCH + d * DAY);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const day = String(dt.getUTCDate()).padStart(2, "0");
    const price01 = Math.floor(code / 4);
    out.push({
      date: `${y}-${m}-${day}`,
      price: price01 / 10,
      direct: (code & 1) !== 0,
      firstFloor: (code & 2) !== 0,
    });
  }
  return out;
}
