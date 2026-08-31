/** Deterministic on server and client: locale formatting would break hydration. */
export function formatTimestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
