// Break at a clock change so both occurrences of a repeated hour use their correct wall time.
export function clockRanges(start: number, end: number): { start: number; end: number; offset: number }[] {
  const offset = new Date(start).getTimezoneOffset();
  const lastOffset = new Date(end - 1).getTimezoneOffset();
  if (offset === lastOffset) return [{ start, end, offset }];
  let low = start;
  let high = end - 1;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (new Date(mid).getTimezoneOffset() === offset) low = mid;
    else high = mid;
  }
  return [
    { start, end: high, offset },
    { start: high, end, offset: lastOffset },
  ];
}
