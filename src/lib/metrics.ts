export function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function msSince(t0: number) {
  const t1 = nowMs();
  return Math.max(0, Math.round(t1 - t0));
}
