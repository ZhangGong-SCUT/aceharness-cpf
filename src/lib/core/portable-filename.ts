const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** One file or directory name that Windows, macOS, and Linux can all create. */
export function portablePathSegment(value: string, fallback = 'item'): string {
  const cleaned = String(value || '').replace(ILLEGAL, '-').replace(/[. ]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..' || RESERVED.test(cleaned)) return fallback;
  return cleaned;
}

/**
 * History snapshot directory. ISO timestamps stay readable: `:` becomes `-`.
 * Characters outside the existing snapshot alphabet are still rejected.
 */
export function portableSnapshotTag(tag: string): string {
  const safe = portablePathSegment(tag, '');
  if (!safe || !/^[0-9A-Za-z_][0-9A-Za-z_.-]*$/.test(safe)) {
    throw new Error('非法快照尝试标识');
  }
  return safe;
}

/** Step summary file. The timestamp prefix stays `YYYY-MM-DDTHH-MM-SS`. */
export function portableSummaryFileName(when: Date, ...parts: string[]): string {
  const ts = when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const body = parts.map((part) => portablePathSegment(part, 'step')).join('-');
  return `${ts}-${body}.md`;
}
