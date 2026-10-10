export function formatSegmentTime(seconds) {
  const value = Number(seconds);
  const totalMs = Number.isFinite(value) ? Math.max(0, Math.round(value * 1000)) : 0;
  const minutes = Math.floor(totalMs / 60_000);
  const wholeSeconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}
