// 时间与随机性可注入：测试里用 setClock/setRng 固定，不依赖真实等待。
let clockFn: () => number = () => Date.now();
let rngFn: () => number = Math.random;

export const now = (): number => clockFn();
export const isoNow = (): string => new Date(clockFn()).toISOString();
export const rand = (): number => rngFn();

export function setClock(fn: (() => number) | null): void {
  clockFn = fn ?? (() => Date.now());
}
export function setRng(fn: (() => number) | null): void {
  rngFn = fn ?? Math.random;
}
// mulberry32 确定性伪随机
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
