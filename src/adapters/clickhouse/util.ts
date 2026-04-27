/** ClickHouse `DateTime64(3, 'UTC')` accepts the canonical
 *  "YYYY-MM-DD HH:MM:SS.mmm" format reliably across versions. ISO with `Z`
 *  is accepted as a Date, but parsed strictly inside JSONEachRow inserts
 *  on some CH versions, so we normalize to the canonical form. */
export function chDateNow(): string {
  return chDate(new Date());
}

export function chDate(d: Date): string {
  // toISOString → "2026-04-27T07:40:15.222Z"
  // canonical   → "2026-04-27 07:40:15.222"
  return d.toISOString().replace("T", " ").slice(0, -1);
}

/** RFC4122 v4 UUID via Web Crypto. */
export function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
