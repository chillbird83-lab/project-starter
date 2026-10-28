import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLanguage, detectLanguage, matchesLanguage, normalizeLang, videoLanguage } from '../public/js/lang.js';
import { scanNiche } from '../public/js/discover.js';
import { mapVideo, ytClient } from '../public/js/youtube.js';
import { NOW, fakeYouTube } from './fake-youtube.js';

test('language codes', () => {
  assert.equal(normalizeLang('en-GB'), 'en');
  assert.equal(normalizeLang('zh-Hans'), 'zh');
  assert.equal(normalizeLang('iw'), 'he');
  assert.equal(normalizeLang('zxx'), null);
  assert.equal(normalizeLang(''), null);
  assert.equal(defaultLanguage('es-MX'), 'es');
  assert.equal(defaultLanguage('xx-YY'), 'any');
});

test('detects the language of titles and descriptions', () => {
  assert.equal(detectLanguage('How the Battle of Stalingrad was won — and why it changed the war for the Allies'), 'en');
  assert.equal(detectLanguage('La batalla de Stalingrado: por qué fue el punto de inflexión de la guerra'), 'es');
  assert.equal(detectLanguage('Die Schlacht um Stalingrad und warum sie den Krieg für die Wehrmacht entschied'), 'de');
  assert.equal(detectLanguage('A batalha de Stalingrado: por que mudou a guerra e o que você não sabe'), 'pt');
  assert.equal(detectLanguage('La bataille de Stalingrad et pourquoi elle a changé la guerre pour les Alliés'), 'fr');
  assert.equal(detectLanguage('Сталинградская битва: как это было'), 'ru');
  assert.equal(detectLanguage('Сталінградська битва: як це було і її значення'), 'uk');
  assert.equal(detectLanguage('第二次世界大戦の真実'), 'ja');
  assert.equal(detectLanguage('제2차 세계대전의 진실'), 'ko');
  assert.equal(detectLanguage('二战的真相'), 'zh');
  assert.equal(detectLanguage('द्वितीय विश्व युद्ध का इतिहास'), 'hi');
  assert.equal(detectLanguage('الحرب العالمية الثانية'), 'ar');
  assert.equal(detectLanguage('WW2 #shorts'), null); // can't tell
});

test('YouTube’s own language field wins; the feed hides only clear mismatches', () => {
  const v = mapVideo({ id: 'x', snippet: { title: 'Stalingrad', defaultAudioLanguage: 'es-419' }, statistics: {}, contentDetails: {} });
  assert.equal(v.lang, 'es-419');
  assert.equal(videoLanguage(v), 'es');
  assert.equal(matchesLanguage(v, 'en'), false);
  assert.equal(matchesLanguage(v, 'es'), true);
  assert.equal(matchesLanguage(v, 'any'), true);
  assert.equal(matchesLanguage({ title: 'WW2 #shorts' }, 'en'), true); // unknown stays visible
  assert.equal(matchesLanguage({ title: 'Как выиграли войну' }, 'en'), false);
});

test('niche searches favour the chosen language', async () => {
  const { fetchImpl, calls } = fakeYouTube();
  await scanNiche(ytClient('KEY', fetchImpl), 'ww2', { now: NOW, settings: { threshold: 3, minViews: 1000, includeShorts: true, language: 'de' } });
  assert.equal(calls.find((u) => u.pathname.endsWith('/search')).searchParams.get('relevanceLanguage'), 'de');
  const second = fakeYouTube();
  await scanNiche(ytClient('KEY', second.fetchImpl), 'ww2', { now: NOW, settings: { threshold: 3, minViews: 1000, includeShorts: true, language: 'any' } });
  assert.equal(second.calls.find((u) => u.pathname.endsWith('/search')).searchParams.get('relevanceLanguage'), null);
});
