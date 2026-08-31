/**
 * Turns pasted text or an uploaded CSV into a list of candidate URLs.
 *
 * Splitting every line on commas and treating each cell as a URL is wrong the moment
 * a file has a second column: `url,note` would submit "note" and every note value as
 * URLs. The server rejects them, but silently — the user would just see fewer rows
 * than their file had, with no idea why. So pick one column deliberately:
 *
 *  - a header naming the URL column wins;
 *  - otherwise take the first cell in each row that actually looks like a URL.
 *
 * Final validation still belongs to the server (`normalizeUrls`); this only decides
 * which cells were ever meant to be URLs.
 */

const URL_HEADER = /^\s*(urls?|link|address|endpoint)\s*$/i;

/** Minimal RFC-4180 row split: handles quoted cells containing commas and "" escapes. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** Loose enough to accept bare hosts, strict enough to skip labels like "note". */
function looksLikeUrl(cell: string): boolean {
  if (!cell) return false;
  if (/^https?:\/\//i.test(cell)) return true;
  return /^[^\s/@]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(cell);
}

export function parseUrlList(text: string): string[] {
  const rows = text
    .replace(/^﻿/, '') // strip BOM, or the first header cell never matches
    .split(/\r?\n/)
    .map(splitRow)
    .filter((cells) => cells.some((c) => c !== ''));

  if (rows.length === 0) return [];

  const header = rows[0]!;
  const headerIndex = header.findIndex((c) => URL_HEADER.test(c));
  // A header row is only a header if none of its cells are themselves URLs.
  const hasHeader = headerIndex !== -1 && !header.some(looksLikeUrl);

  const body = hasHeader ? rows.slice(1) : rows;
  const out: string[] = [];

  for (const cells of body) {
    const picked = hasHeader ? cells[headerIndex] : cells.find(looksLikeUrl);
    const value = picked?.trim();
    if (value) out.push(value);
  }

  return out;
}
