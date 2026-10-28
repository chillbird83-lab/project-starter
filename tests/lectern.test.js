import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classNow, classesOn, courseStats, fileNameFor, formatBytes, formatClock, formatLength, groupByMonth, inProgress,
  nextClass, nextTitle, parseStamps, parseTime, sanitizeData, sanitizeSlot, searchLectures, startOfWeek, weekPlan,
} from '../lectern/js/logic.js';
import { crc32, makeZip, readZip } from '../lectern/js/zip.js';

const course = (id, slots = [], extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), emoji: '📘', color: '#007aff', lecturer: '', room: '', slots, archived: false, ...extra });
const lec = (id, extra = {}) => ({
  id, courseId: 'calc', title: 'Lecture 1', date: '2026-10-26', startedAt: 1, durationMs: 3_600_000, size: 1, mime: 'audio/webm',
  hasAudio: true, bookmarks: [], notes: '', reviewed: false, starred: false, position: 0, playedAt: 0, ...extra,
});
// 2026-10-26 is a Monday (day 1), 2026-10-27 a Tuesday.
const at = (iso, hhmm) => { const [y, m, d] = iso.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return new Date(y, m - 1, d, h, mi); };
const calc = course('calc', [{ day: 1, start: '10:15', end: '11:45' }, { day: 3, start: '08:30', end: '10:00' }]);
const phys = course('physics', [{ day: 1, start: '14:00', end: '15:30' }]);

test('formatting', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65_000), '1:05');
  assert.equal(formatClock(725_999), '12:05');
  assert.equal(formatClock(3_723_000), '1:02:03');
  assert.equal(formatLength(20_000), '<1 min');
  assert.equal(formatLength(45 * 60_000), '45 min');
  assert.equal(formatLength(84 * 60_000), '1 h 24 min');
  assert.equal(formatLength(120 * 60_000), '2 h');
  assert.equal(formatBytes(14_400_000), '14 MB');
  assert.equal(formatBytes(2_300_000_000), '2.3 GB');
  assert.equal(parseTime('9:05'), 545);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('ab'), null);
  assert.equal(startOfWeek('2026-11-01'), '2026-10-26'); // Sunday belongs to the Monday week
});

test('timestamps typed into notes', () => {
  assert.deepEqual(parseStamps('see [12:30] and [1:02:03], again [12:30], not [99:99] or 12:00'), [750_000, 3_723_000]);
  assert.deepEqual(parseStamps(''), []);
});

test('timetable: classes on a day, class now / soon / later', () => {
  assert.deepEqual(classesOn([phys, calc], '2026-10-26').map((c) => c.course.id), ['calc', 'physics']);
  assert.equal(classesOn([course('x', [{ day: 1, start: '09:00', end: '10:00' }], { archived: true })], '2026-10-26').length, 0);

  assert.equal(classNow([calc, phys], at('2026-10-26', '10:30')).state, 'now');
  assert.equal(classNow([calc, phys], at('2026-10-26', '10:30')).course.id, 'calc');
  const soon = classNow([calc, phys], at('2026-10-26', '10:05'));
  assert.equal(soon.state, 'soon');
  assert.equal(soon.minutesTo, 10);
  const later = classNow([calc, phys], at('2026-10-26', '12:00'));
  assert.deepEqual([later.state, later.course.id, later.minutesTo], ['later', 'physics', 120]);
  assert.equal(classNow([calc, phys], at('2026-10-26', '16:00')), null);
  // A class that is running wins over one starting soon.
  const back2back = [course('a', [{ day: 1, start: '09:00', end: '10:00' }]), course('b', [{ day: 1, start: '10:00', end: '11:00' }])];
  assert.equal(classNow(back2back, at('2026-10-26', '09:50')).course.id, 'a');
  assert.equal(classNow(back2back, at('2026-10-26', '10:00')).course.id, 'b');
});

test('next class of a course', () => {
  assert.deepEqual(nextClass(calc, at('2026-10-26', '09:00')), { date: '2026-10-26', slot: calc.slots[0], start: 615, end: 705 });
  assert.equal(nextClass(calc, at('2026-10-26', '11:00')).date, '2026-10-26'); // still running
  assert.equal(nextClass(calc, at('2026-10-26', '12:00')).date, '2026-10-28'); // Wednesday
  assert.equal(nextClass(course('x'), at('2026-10-26', '12:00')), null);
});

test('week plan marks recorded classes', () => {
  const state = { courses: [calc, phys], lectures: [lec('a', { date: '2026-10-26' })] };
  const plan = weekPlan(state, '2026-10-26', '2026-10-27');
  assert.equal(plan.length, 7);
  assert.deepEqual(plan[0].classes.map((c) => [c.course.id, c.recorded]), [['calc', true], ['physics', false]]);
  assert.equal(plan[0].isPast, true);
  assert.equal(plan[1].isToday, true);
  assert.equal(plan[2].classes[0].course.id, 'calc');
});

test('next title numbering', () => {
  assert.equal(nextTitle([], 'calc'), 'Lecture 1');
  assert.equal(nextTitle([lec('a'), lec('b', { title: 'Intro' })], 'calc'), 'Lecture 3');
  assert.equal(nextTitle([lec('a', { title: 'Lecture 7' })], 'calc'), 'Lecture 8'); // after deletions
  assert.equal(nextTitle([lec('a')], 'physics'), 'Lecture 1');
});

test('stats, progress and grouping', () => {
  const ls = [lec('a', { reviewed: true, bookmarks: [{ id: '1', t: 1, kind: 'exam', label: '' }] }), lec('b'), lec('c', { courseId: 'physics' })];
  assert.deepEqual(courseStats(ls, 'calc'), { count: 2, totalMs: 7_200_000, toReview: 1, bookmarks: 1 });
  assert.equal(inProgress(lec('a', { position: 60_000 })), true);
  assert.equal(inProgress(lec('a', { position: 3_595_000 })), false); // basically finished
  assert.equal(inProgress(lec('a', { position: 60_000, hasAudio: false })), false);
  const groups = groupByMonth([lec('a', { date: '2026-10-30' }), lec('b', { date: '2026-10-01' }), lec('c', { date: '2026-09-30' })], (l) => l.date);
  assert.deepEqual(groups.map((g) => [g.month, g.items.length]), [['2026-10', 2], ['2026-09', 1]]);
});

test('search across titles, courses, notes and bookmarks', () => {
  const state = {
    courses: [calc, phys],
    lectures: [
      lec('a', { title: 'Limits', startedAt: 1, notes: 'The epsilon-delta definition is on the exam.' }),
      lec('b', { title: 'Derivatives', startedAt: 2, bookmarks: [{ id: '1', t: 754_000, kind: 'exam', label: 'Chain rule proof' }], starred: true }),
      lec('c', { title: 'Waves', courseId: 'physics', startedAt: 3, reviewed: true }),
    ],
  };
  const ids = (r) => r.map((x) => x.lecture.id);
  assert.deepEqual(ids(searchLectures(state)), ['c', 'b', 'a']);
  assert.deepEqual(ids(searchLectures(state, '', 'review')), ['b', 'a']);
  assert.deepEqual(ids(searchLectures(state, '', 'starred')), ['b']);
  assert.deepEqual(ids(searchLectures(state, 'physics')), ['c']);
  const [hit] = searchLectures(state, 'chain rule');
  assert.equal(hit.lecture.id, 'b');
  assert.equal(hit.snippet, '12:34 · Chain rule proof');
  assert.equal(hit.at, 754_000);
  const [note] = searchLectures(state, 'EPSILON');
  assert.match(note.snippet, /epsilon-delta definition/);
  assert.deepEqual(ids(searchLectures(state, 'limits exam')), ['a']); // every word must match somewhere
  assert.deepEqual(ids(searchLectures(state, 'nothing here')), []);
});

test('sanitizing backups and slots', () => {
  assert.equal(sanitizeData(null), null);
  assert.equal(sanitizeData({ lectures: [] }), null);
  assert.deepEqual(sanitizeSlot({ day: 2, start: '9:00', end: '10:30' }), { day: 2, start: '09:00', end: '10:30' });
  assert.equal(sanitizeSlot({ day: 2, start: '11:00', end: '10:30' }), null);
  assert.equal(sanitizeSlot({ day: 7, start: '09:00', end: '10:30' }), null);
  const data = sanitizeData({
    courses: [{ id: 'calc', name: ' Calculus ', color: 'red', slots: [{ day: 1, start: '10:00', end: '09:00' }] }, { id: 'x' }],
    lectures: [
      { id: 'a', courseId: 'gone', date: '2026-10-26', title: '', bookmarks: [{ t: 5, kind: 'weird', label: 7 }, { t: -1 }], durationMs: 'x' },
      { id: 'b', date: 'yesterday' },
    ],
    settings: { quality: 'ultra', speed: 1.5 },
  });
  assert.equal(data.courses.length, 1);
  assert.equal(data.courses[0].name, 'Calculus');
  assert.equal(data.courses[0].color, '#007aff');
  assert.deepEqual(data.courses[0].slots, []);
  assert.equal(data.lectures.length, 1);
  const [l] = data.lectures;
  assert.equal(l.courseId, null);
  assert.equal(l.title, 'Recording');
  assert.equal(l.durationMs, 0);
  assert.deepEqual(l.bookmarks, [{ id: '5', t: 5, kind: 'note', label: '' }]);
  assert.deepEqual(data.settings, { theme: 'auto', quality: 'standard', noiseReduction: true, speed: 1.5 });
});

test('file names are safe and readable', () => {
  assert.equal(fileNameFor(lec('a', { title: 'Week 3: Limits / Continuity?' }), 'Calculus'), 'Calculus - Week 3 Limits Continuity - 2026-10-26.webm');
  assert.equal(fileNameFor(lec('a', { mime: 'audio/mp4' })), 'Lecture 1 - 2026-10-26.m4a');
});

test('zip backup round trip', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const audio = new Blob([new Uint8Array(70_000).map((_, i) => i % 251)], { type: 'audio/webm' });
  const zip = await makeZip([
    { name: 'lectern.json', data: '{"ok":true}' },
    { name: 'audio/Calculus – Lecture 1 – 2026-10-26.webm', data: audio, date: new Date(2026, 9, 26, 10, 15) },
  ]);
  const files = await readZip(zip);
  assert.deepEqual([...files.keys()], ['lectern.json', 'audio/Calculus – Lecture 1 – 2026-10-26.webm']);
  assert.equal(await files.get('lectern.json').text(), '{"ok":true}');
  const back = new Uint8Array(await files.get('audio/Calculus – Lecture 1 – 2026-10-26.webm').arrayBuffer());
  assert.deepEqual(back, new Uint8Array(await audio.arrayBuffer()));
  await assert.rejects(readZip(new Blob(['not a zip'])), /Not a ZIP/);
});
