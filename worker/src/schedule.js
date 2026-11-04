// Works out when the next training-day reminder is due, in the user's own time zone.

function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
function localToUtc(y, m, d, h, mi, tz) {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(guess, tz);
    guess += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  }
  return guess;
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function nextReminder(rem, fromMs) {
  if (!rem || !Array.isArray(rem.days) || !rem.days.length || !/^\d\d:\d\d$/.test(rem.time || '')) return null;
  const tz = rem.tz || 'UTC';
  const [hh, mm] = rem.time.split(':').map(Number);
  const p0 = tzParts(fromMs, tz);
  for (let i = 0; i < 9; i++) {
    const day = new Date(Date.UTC(p0.y, p0.m - 1, p0.d + i));
    if (!rem.days.includes(day.getUTCDay())) continue;
    const date = ymd(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    if (rem.lastDate && rem.lastDate >= date) continue; // already trained that day
    const at = localToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
    if (at > fromMs) return { at, date };
  }
  return null;
}

