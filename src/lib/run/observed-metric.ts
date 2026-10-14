export type UsageSource = 'reported' | 'partial' | 'unavailable';
/** Legacy zeros are unknown; a reported zero remains a real zero. */
export function formatObservedMetric(value: number, source: UsageSource | undefined, format: (value: number) => string): string {
  if (source === 'unavailable' || (!source && !value)) return '未知';
  return `${format(value)}${source === 'partial' ? '（部分）' : ''}`;
}
