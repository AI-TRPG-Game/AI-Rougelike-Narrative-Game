export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
