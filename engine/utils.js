export const money = (n) =>
  Number(n).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const pct = (n) => (n * 100).toFixed(2) + "%";

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

export async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json();
}

export function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}
