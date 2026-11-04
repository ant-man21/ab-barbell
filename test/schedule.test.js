import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextReminder } from '../worker/src/schedule.js';

const rem = { days: [1, 3, 5], time: '07:00', tz: 'America/New_York' };
const at = s => new Date(s).getTime();

test('Tuesday evening -> Wednesday 7:00 local', () => {
  const n = nextReminder(rem, at('2026-11-03T23:00:00Z'));
  assert.equal(n.date, '2026-11-04');
  assert.equal(new Date(n.at).toISOString(), '2026-11-04T12:00:00.000Z'); // EST = UTC-5
});
test('skips a day that is already logged', () => {
  const n = nextReminder({ ...rem, lastDate: '2026-11-04' }, at('2026-11-04T05:00:00Z'));
  assert.equal(n.date, '2026-11-06');
});
test('handles the DST change (EDT before Nov 1)', () => {
  const n = nextReminder(rem, at('2026-10-27T00:00:00Z'));
  assert.equal(new Date(n.at).toISOString(), '2026-10-28T11:00:00.000Z'); // EDT = UTC-4
});
test('no days -> no reminder', () => assert.equal(nextReminder({ ...rem, days: [] }, Date.now()), null));
