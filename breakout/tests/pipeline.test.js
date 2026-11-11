import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanVideoIds, commentBlock, parseBullets, parseIdeas, secondsToQuotaReset } from '../public/js/pipeline.js';

test('pain points: bullets in any style, intro lines dropped', () => {
  assert.deepEqual(parseBullets('Here are the top 3:\n\n* One\n• **Two**\n3) Three'), ['One', 'Two', 'Three']);
  assert.deepEqual(parseBullets('No bullets at all\nSecond line'), ['No bullets at all', 'Second line']);
});

test('ideas: the asked-for format and the variations small models produce', () => {
  assert.deepEqual(parseIdeas('1. TITLE: I Tried It | THUMBNAIL: Shocked face'), [{ title: 'I Tried It', thumbnail: 'Shocked face' }]);
  assert.deepEqual(parseIdeas('**1. "Fix Your Mornings"** - Thumbnail concept: Alarm clock on fire'), [{ title: 'Fix Your Mornings', thumbnail: 'Alarm clock on fire' }]);
  assert.deepEqual(parseIdeas('Title: Week One Results\nThumbnail: Before and after split'), [{ title: 'Week One Results', thumbnail: 'Before and after split' }]);
  assert.equal(parseIdeas([1, 2, 3, 4, 5, 6].map((n) => `${n}. TITLE: T${n} | THUMBNAIL: C`).join('\n')).length, 5);
});

test('comments: every video gets a turn, most-liked first, within the size limit', () => {
  const a = [{ text: 'a-low', likes: 1 }, { text: 'a-top', likes: 50 }];
  const b = [{ text: 'b-top', likes: 9 }];
  assert.equal(commentBlock([a, b]).text, '- a-top\n- b-top\n- a-low');
  const small = commentBlock([a, b], { maxChars: 18 });
  assert.deepEqual([small.used, small.total], [2, 3]);
});

test('video IDs are checked, deduplicated and capped', () => {
  const ids = Array.from({ length: 14 }, (_, i) => `abcdefghij${i % 10}`);
  assert.equal(cleanVideoIds([...ids, 'bad', 'tinyhit0001', 'tinyhit0001']).length, 10);
  assert.deepEqual(cleanVideoIds('nope'), []);
});

test('the YouTube quota resets at midnight Pacific', () => {
  // 23:00 in Los Angeles (PST, UTC−8) → one hour left
  assert.equal(secondsToQuotaReset(Date.parse('2026-11-12T07:00:00Z')), 3600);
});
