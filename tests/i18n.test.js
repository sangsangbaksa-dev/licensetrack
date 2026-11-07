import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as I from '../i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANG_CODES = ['ko', 'en', 'ja', 'es', 'zh'];
const slots = (s) => [...s.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((m) => m[1]).sort().join();
// 템플릿 항목의 blank 는 입력 칸을 비워 두는 값이라 빈 문자열이 맞다
const EMPTY_OK = /^tpl\.blank\.(name|issuer|note)$/;

test('지원 언어는 다섯 개이고 기본값은 ko', () => {
  assert.deepEqual(Object.keys(I.LANGS).sort(), [...LANG_CODES].sort());
  assert.equal(I.detectLang(null, []), 'ko');
  assert.equal(I.detectLang(null, ['de-DE', 'fr']), 'ko');
});

test('detectLang: 저장된 값 우선, 그다음 브라우저 언어(다섯 개 중 하나일 때만)', () => {
  assert.equal(I.detectLang('ja', ['ko-KR']), 'ja');
  assert.equal(I.detectLang('xx', ['ko-KR']), 'ko');
  assert.equal(I.detectLang(null, ['fr-FR', 'es-MX']), 'es');
  assert.equal(I.detectLang(null, ['zh-TW']), 'zh');
  assert.equal(I.detectLang(null, ['en-GB']), 'en');
});

test('모든 언어는 ko와 같은 키를 가진다 (누락 키가 있으면 실패)', () => {
  const ko = Object.keys(I.DICT.ko).sort();
  assert.ok(ko.length > 500, `key count ${ko.length}`);
  for (const l of LANG_CODES) {
    const missing = ko.filter((k) => I.DICT[l][k] === undefined);
    const extra = Object.keys(I.DICT[l]).filter((k) => I.DICT.ko[k] === undefined);
    assert.deepEqual(missing, [], `${l} missing keys`);
    assert.deepEqual(extra, [], `${l} has keys ko does not`);
  }
});

test('빈 번역이 없다 (빈 템플릿 칸 제외)', () => {
  for (const l of LANG_CODES) {
    for (const [k, v] of Object.entries(I.DICT[l])) {
      if (EMPTY_OK.test(k)) continue;
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${l}.${k} is empty`);
    }
  }
});

test('플레이스홀더 {x}는 모든 언어에서 보존된다', () => {
  for (const [k, v] of Object.entries(I.DICT.ko)) {
    for (const l of LANG_CODES) {
      assert.equal(slots(I.DICT[l][k]), slots(v), `${l}.${k}`);
    }
  }
});

test('번역되지 않은 키 이름이 값으로 새지 않는다', () => {
  for (const l of LANG_CODES) {
    for (const [k, v] of Object.entries(I.DICT[l])) {
      assert.notEqual(v, k, `${l}.${k} shows its own key`);
      assert.doesNotMatch(v, /\b(a|x|f|v|lic|ai|tpl|common|locale)\.[a-zA-Z]+\b/, `${l}.${k}`);
    }
  }
});

test('앱 코드와 HTML이 쓰는 모든 키는 사전에 있다', () => {
  const sources = ['app.js', 'logic.js', 'ai.js', 'index.html'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const used = new Set();
  for (const s of sources) {
    for (const m of s.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]\s*[,)]/g)) used.add(m[1]);
    for (const m of s.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]+)`\s*\)/g)) used.add(m[1]);
    for (const m of s.matchAll(/data-i18n(?:-ph|-aria|-value|-html)?="([^"]+)"/g)) used.add(m[1]);
  }
  // 동적 키: a.${key} (요일·월 라벨), tpl.${id}.* (예시 템플릿), STATUS_KEYS 문자열
  for (const k of ['a.wd1', 'a.wd3', 'a.wd5']) used.add(k);
  for (const id of ['blank', 'nurse', 'realtor', 'safety', 'social', 'cpe', 'construction', 'hazmat']) {
    for (const p of ['label', 'name', 'issuer', 'note']) used.add(`tpl.${id}.${p}`);
  }
  const missing = [...used].filter((k) => I.DICT.ko[k] === undefined);
  assert.deepEqual(missing, []);
  assert.ok(used.size > 400, `scanned ${used.size} keys`);
});

test('t(): 보간과 대체(fallback), 존재하지 않는 키는 키 이름을 돌려준다', () => {
  I.setLang('ko');
  assert.equal(I.t('v.required', { label: '자격명' }), '자격명을(를) 입력하세요.');
  I.setLang('en');
  assert.equal(I.t('v.required', { label: 'Credential name' }), 'Enter Credential name.');
  assert.equal(I.t('no.such.key'), 'no.such.key');
  I.setLang('ko');
});

test('저장된 언어는 try/catch로 읽고 쓴다 (저장소가 막혀도 던지지 않는다)', () => {
  const store = new Map();
  const ok = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  I.writeSavedLang('zh', ok);
  assert.equal(I.readSavedLang(ok), 'zh');
  assert.equal(store.get('licensetrack.lang'), 'zh');
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(I.readSavedLang(blocked), null);
  assert.doesNotThrow(() => I.writeSavedLang('en', blocked));
});

test('정렬 로캘은 언어를 따른다 (ko 기본)', () => {
  I.setLang('ko');
  assert.equal(I.localeTag(), 'ko-KR');
  assert.equal(I.t('locale.collate'), 'ko');
  I.setLang('en');
  assert.equal(I.localeTag(), 'en-US');
  I.setLang('ko');
});
