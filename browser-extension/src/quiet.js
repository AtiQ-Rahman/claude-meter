// Quiet hours: "HH:MM" start and end, wrapping past midnight when start > end.

function minutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function inQuietHours(s, date) {
  if (!s.quietHours) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const start = minutes(s.quietStart);
  const end = minutes(s.quietEnd);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
