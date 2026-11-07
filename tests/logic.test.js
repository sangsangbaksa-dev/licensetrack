import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSTANTS, isDateStr, addDays, addYears, addMonths, diffDays, todayStr, daysInMonth,
  cycleWindow, effectiveExpiry, cycleStatus, urgencyBucket, buildDashboard,
  normalizeLeads, dueReminders, deadlinesForItem,
  foldLine, icsText, buildIcs, utf8Length,
  csvCell, buildCreditsCsv,
  normalizeItem, normalizeCredit, ValidationError,
  buildBackup, validateBackup, buildPrintRows,
  normalizeTemplateOverrides, templatesWithOverrides, setTemplateOverride, resetTemplateOverride,
  holderOf, holderGroups, filterRowsByHolder, holderSummary,
  heatLevel, dayOfWeek, deadlinesInYear, yearHeatmap,
} from '../logic.js';
import {
  monthsAvailable, anonymizeForAi, buildPrompt, parsePlanReply,
  fallbackPlan, isPlausibleAnthropicKey, planEligibility, AI_LIMITS,
} from '../ai.js';

const item = (over = {}) => ({
  id: 'it1', name: '테스트 자격', issuer: '기관', number: '', issuedOn: '',
  expiresOn: '2026-12-31', cycleYears: 3, requiredCredits: 30, carryover: 0,
  notes: '', createdAt: '2026-01-01T00:00:00.000Z', ...over,
});
const credit = (date, hours, over = {}) => ({
  id: `c-${date}-${hours}-${Math.random()}`, itemId: 'it1', date, hours,
  course: '과정', provider: '', category: '법정', memo: '', createdAt: '', ...over,
});

describe('날짜 계산', () => {
  test('유효한 날짜만 허용 (존재하지 않는 날짜 거부)', () => {
    assert.equal(isDateStr('2026-02-30'), false);
    assert.equal(isDateStr('2025-02-29'), false);
    assert.equal(isDateStr('2024-02-29'), true);
    assert.equal(isDateStr('2026-1-05'), false);
    assert.equal(isDateStr('2026-01-05T00:00:00Z'), false);
    assert.equal(isDateStr(null), false);
    assert.equal(isDateStr(20260105), false);
  });

  test('2월 29일 + 1년 = 2월 28일 (말일 보정)', () => {
    assert.equal(addYears('2024-02-29', 1), '2025-02-28');
    assert.equal(addYears('2024-02-29', 4), '2028-02-29');
    assert.equal(addYears('2028-02-29', -1), '2027-02-28');
  });

  test('1월 31일 + 1개월 = 2월 말일, 윤년 2월은 29일', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(daysInMonth(2028, 2), 29);
    assert.equal(daysInMonth(2100, 2), 28);
  });

  test('일 차이는 UTC 기반이라 시간대와 무관하며 연말 경계를 넘어도 정확', () => {
    assert.equal(diffDays('2027-01-01', '2026-12-31'), 1);
    assert.equal(diffDays('2026-03-01', '2026-02-28'), 1);
    assert.equal(diffDays('2028-03-01', '2028-02-28'), 2);
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  test('todayStr 은 로컬 날짜를 쓴다 (UTC 변환으로 하루 밀리지 않음)', () => {
    const d = new Date(2026, 4, 9, 0, 30); // 로컬 2026-05-09 00:30
    assert.equal(todayStr(d), '2026-05-09');
  });
});

describe('주기 / 만료 / 학점', () => {
  test('3년 주기 종료 2026-12-31 → 시작 2024-01-01', () => {
    assert.deepEqual(cycleWindow('2026-12-31', 3), { start: '2024-01-01', end: '2026-12-31' });
  });

  test('윤년 말일 근처 주기 시작일 계산', () => {
    assert.deepEqual(cycleWindow('2028-02-29', 1), { start: '2027-03-01', end: '2028-02-29' });
  });

  test('주기 없음이면 시작일 null', () => {
    assert.deepEqual(cycleWindow('2026-12-31', 0), { start: null, end: '2026-12-31' });
  });

  test('발급일 + 주기로 만료일 파생 (기념일 전날)', () => {
    assert.equal(effectiveExpiry({ issuedOn: '2024-03-01', expiresOn: '', cycleYears: 3 }), '2027-02-28');
    assert.equal(effectiveExpiry({ issuedOn: '', expiresOn: '', cycleYears: 3 }), null);
  });

  test('이전 주기 기록과 다음 주기 기록은 이번 주기 합계에서 제외', () => {
    const credits = [
      credit('2023-12-31', 10), // 이전 주기
      credit('2024-01-01', 5),  // 시작일 포함
      credit('2026-12-31', 5),  // 종료일 포함
      credit('2027-01-01', 7),  // 다음 주기
    ];
    const s = cycleStatus(item(), credits, '2026-11-06');
    assert.equal(s.earned, 10);
    assert.equal(s.priorEarned, 10);
    assert.equal(s.nextEarned, 7);
  });

  test('이월 학점은 합계에 더해지고 남은 학점을 줄인다', () => {
    const s = cycleStatus(item({ carryover: 6 }), [credit('2025-05-01', 20)], '2026-11-06');
    assert.equal(s.total, 26);
    assert.equal(s.remaining, 4);
  });

  test('부족 예상: 페이스가 낮으면 예상 부족이 0보다 큼', () => {
    // 시작 2024-01-01, 오늘 2026-07-01 → 경과 약 30개월, 이수 6학점 → 페이스 약 0.2/월
    const credits = [credit('2024-06-01', 6)];
    const s = cycleStatus(item(), credits, '2026-07-01');
    assert.equal(s.earned, 6);
    assert.ok(s.daysLeft > 0);
    assert.ok(s.projectedShortfall > 0, `shortfall ${s.projectedShortfall}`);
    assert.equal(s.status, 'at-risk');
    assert.ok(s.neededPerMonth > 0);
  });

  test('충분히 이수하면 done, 필요 학점 없으면 no-req', () => {
    assert.equal(cycleStatus(item(), [credit('2025-01-01', 30)], '2026-11-06').status, 'done');
    assert.equal(cycleStatus(item({ requiredCredits: null }), [], '2026-11-06').status, 'no-req');
  });

  test('만료 후 미달이면 overdue, 페이스/월 필요량은 계산하지 않음', () => {
    const s = cycleStatus(item(), [], '2027-01-05');
    assert.equal(s.status, 'overdue');
    assert.equal(s.neededPerMonth, null);
    assert.equal(s.projectedShortfall, null);
  });

  test('남은 기간이 1개월 미만이면 1개월로 계산', () => {
    const s = cycleStatus(item({ requiredCredits: 10 }), [], '2026-12-20');
    assert.equal(s.neededPerMonth, 10);
  });

  test('1개월 이상 남았을 때 월 필요량 = 남은 학점 / 남은 개월', () => {
    const it = item({ expiresOn: '2026-12-31', requiredCredits: 12 });
    const s = cycleStatus(it, [], '2026-11-01'); // 60일 남음 ≈ 1.97개월
    assert.ok(Math.abs(s.neededPerMonth - 12 / (60 / 30.4375)) < 0.02, `got ${s.neededPerMonth}`);
  });
});

describe('긴급도 버킷 경계', () => {
  test('만료일 당일은 30일 이내, 지난 날은 만료', () => {
    assert.equal(urgencyBucket(-1), 'expired');
    assert.equal(urgencyBucket(0), 'd30');
  });
  test('정확히 30일 = 30일 이내, 31일 = 90일 이내', () => {
    assert.equal(urgencyBucket(30), 'd30');
    assert.equal(urgencyBucket(31), 'd90');
  });
  test('정확히 90일 = 90일 이내, 91일 = 여유', () => {
    assert.equal(urgencyBucket(90), 'd90');
    assert.equal(urgencyBucket(91), 'ok');
  });
  test('만료일 없음', () => {
    assert.equal(urgencyBucket(null), 'none');
  });
  test('대시보드 정렬: 만료 → 30일 → 90일 → 여유 → 없음, 같은 버킷은 임박순', () => {
    const today = '2026-11-06';
    const items = [
      item({ id: 'a', name: '여유', expiresOn: '2027-12-31' }),
      item({ id: 'b', name: '만료', expiresOn: '2026-10-01' }),
      item({ id: 'c', name: '삼십일', expiresOn: '2026-11-20' }),
      item({ id: 'd', name: '삼십일2', expiresOn: '2026-11-10' }),
      item({ id: 'e', name: '없음', expiresOn: '', issuedOn: '', cycleYears: 0 }),
    ].map((x) => (x.id === 'e' ? { ...x, expiresOn: '' } : x));
    const dash = buildDashboard(items, [], today);
    assert.deepEqual(dash.rows.map((r) => r.item.name), ['만료', '삼십일2', '삼십일', '여유', '없음']);
    assert.equal(dash.counts.d30, 2);
    assert.equal(dash.counts.none, 1);
  });
});

describe('알림 기간', () => {
  test('180/90/30/7 기준: 남은 일수별로 가장 가까운 알림 기간 표시', () => {
    const leads = [180, 90, 30, 7];
    const mk = (days) => ({ item: item({ id: `x${days}`, name: `n${days}` }), daysLeft: days });
    const rows = [mk(91), mk(90), mk(8), mk(7), mk(200), mk(-3)];
    const out = dueReminders(rows, leads);
    const byDays = Object.fromEntries(out.map((o) => [o.daysLeft, o.lead]));
    assert.equal(byDays[91], 180);
    assert.equal(byDays[90], 90);
    assert.equal(byDays[8], 30);
    assert.equal(byDays[7], 7);
    assert.equal(byDays[-3], 7);
    assert.ok(!(200 in byDays));
    assert.equal(out[0].daysLeft, -3);
  });

  test('normalizeLeads: 중복 제거, 내림차순 정렬, 범위 검증', () => {
    assert.deepEqual(normalizeLeads([7, 30, 7, 180]), [180, 30, 7]);
    assert.deepEqual(normalizeLeads([]), []);
    assert.throws(() => normalizeLeads([0]), /1~730/);
    assert.throws(() => normalizeLeads([1.5]), /정수/);
    assert.throws(() => normalizeLeads(['30']), /정수/);
    assert.throws(() => normalizeLeads([731]), /1~730/);
    assert.throws(() => normalizeLeads(Array(9).fill(1).map((_, i) => i + 1)), /최대/);
  });

  test('마감일 목록: 오늘 이후 주기만 포함, 다음 주기 반복', () => {
    const it = item({ expiresOn: '2026-12-31', cycleYears: 3 });
    assert.deepEqual(deadlinesForItem(it, '2026-11-06', 2), ['2026-12-31', '2029-12-31', '2032-12-31']);
    assert.deepEqual(deadlinesForItem(item({ expiresOn: '2025-01-01', cycleYears: 0 }), '2026-11-06'), []);
  });
});

describe('ICS 생성', () => {
  const today = '2026-11-06';
  const dtstamp = '20261106T000000Z';

  test('CRLF 줄바꿈, 시작/끝 래퍼, 모든 줄 75옥텟 이하', () => {
    const items = [item({ name: '아주 긴 이름의 자격증 '.repeat(8) })];
    const ics = buildIcs({ items, leads: [30, 7], today, dtstamp });
    assert.ok(ics.endsWith('\r\n'));
    assert.ok(!/(^|[^\r])\n/.test(ics), 'bare LF 없어야 함');
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.includes('END:VCALENDAR\r\n'));
    for (const line of ics.split('\r\n')) {
      if (!line) continue;
      let bytes = 0;
      for (const ch of line) bytes += utf8Length(ch);
      assert.ok(bytes <= 75, `줄 길이 ${bytes}: ${line.slice(0, 40)}`);
    }
  });

  test('접기: 이어지는 줄은 공백으로 시작하고, 다중 바이트 문자는 쪼개지 않음', () => {
    const folded = foldLine('가'.repeat(60)); // 한 글자 3옥텟 → 첫 줄 25글자(75옥텟)
    const lines = folded.split('\r\n');
    assert.equal(lines[0].length, 25);
    assert.ok(lines.slice(1).every((l) => l.startsWith(' ')));
    // 복원하면 원문과 같아야 함
    assert.equal(lines.map((l, i) => (i ? l.slice(1) : l)).join(''), '가'.repeat(60));
    for (const l of lines) assert.ok([...l].reduce((a, c) => a + utf8Length(c), 0) <= 75);
  });

  test('TEXT 이스케이프: 쉼표, 세미콜론, 백슬래시, 줄바꿈', () => {
    assert.equal(icsText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  });

  test('UID는 항목·마감일 조합마다 유일, 항목 2개×주기 2회 = VEVENT 4개', () => {
    const items = [
      item({ id: 'p1', expiresOn: '2026-12-31', cycleYears: 3 }),
      item({ id: 'p2', expiresOn: '2027-06-30', cycleYears: 3 }),
    ];
    const ics = buildIcs({ items, leads: [180, 90, 30, 7], today, dtstamp, horizonCycles: 1 });
    const uids = [...ics.matchAll(/^UID:(.*)\r$/gm)].map((m) => m[1]);
    assert.equal(uids.length, 4);
    assert.equal(new Set(uids).size, 4);
    assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 4 * 4);
  });

  test('종일 이벤트 DATE 형식, DTEND는 다음 날, TRIGGER는 -PnD', () => {
    const ics = buildIcs({ items: [item()], leads: [30], today, dtstamp, horizonCycles: 0 });
    assert.ok(ics.includes('DTSTART;VALUE=DATE:20261231'));
    assert.ok(ics.includes('DTEND;VALUE=DATE:20270101'));
    assert.ok(ics.includes('TRIGGER:-P30D'));
    assert.ok(ics.includes('DTSTAMP:20261106T000000Z'));
  });

  test('자격번호는 ICS에 넣지 않음', () => {
    const ics = buildIcs({ items: [item({ number: 'SECRET-123' })], leads: [30], today, dtstamp });
    assert.ok(!ics.includes('SECRET-123'));
  });

  test('이름의 쉼표·세미콜론이 이스케이프됨', () => {
    const ics = buildIcs({ items: [item({ name: '가,나;다' })], leads: [7], today, dtstamp, horizonCycles: 0 });
    assert.ok(ics.includes('SUMMARY:가\\,나\\;다 갱신·학점 마감'));
  });
});

describe('CSV', () => {
  test('쉼표·따옴표·줄바꿈 이스케이프, 수식 주입 방지', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(3), '3');
  });

  test('학점 CSV: BOM과 헤더, 날짜순 정렬', () => {
    const items = [item()];
    const csv = buildCreditsCsv(items, [credit('2026-05-01', 2, { course: '보수,교육' }), credit('2025-01-01', 1)]);
    assert.ok(csv.startsWith('﻿자격명,날짜,이수시간'));
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[1].includes('2025-01-01'));
    assert.ok(lines[2].includes('"보수,교육"'));
  });
});

describe('입력 검증', () => {
  test('자격명 필수, 빈 값/숫자 이상 거부', () => {
    assert.throws(() => normalizeItem({ id: 'a', name: '  ', expiresOn: '2027-01-01' }), ValidationError);
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', expiresOn: '2027-01-01', requiredCredits: 'abc' }), /숫자/);
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', expiresOn: '2027-01-01', requiredCredits: -1 }), /0~10000/);
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', expiresOn: '2027-01-01', requiredCredits: 1e308 }), /0~10000/);
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', expiresOn: '2027-01-01', requiredCredits: 'Infinity' }), /숫자/);
  });

  test('만료일 또는 발급일+주기 필요', () => {
    assert.throws(() => normalizeItem({ id: 'a', name: 'x' }), /만료일을 입력/);
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', issuedOn: '2024-01-01' }), /만료일을 입력/);
    assert.doesNotThrow(() => normalizeItem({ id: 'a', name: 'x', issuedOn: '2024-01-01', cycleYears: 3 }));
  });

  test('발급일이 만료일보다 늦으면 거부, 존재하지 않는 날짜 거부', () => {
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', issuedOn: '2027-01-01', expiresOn: '2026-01-01' }), /빨라요/);
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', expiresOn: '2026-02-30' }), /실제 존재/);
  });

  test('주기는 정수 0~50, 소수 거부', () => {
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', expiresOn: '2027-01-01', cycleYears: 2.5 }), /정수/);
    assert.throws(() => normalizeItem({ id: 'a', name: 'x', expiresOn: '2027-01-01', cycleYears: 51 }), /0~50/);
  });

  test('학점 기록: 시간 0 이하 거부, 소수 셋째 자리 거부, 날짜 필수', () => {
    assert.throws(() => normalizeCredit({ itemId: 'it1', date: '2026-01-01', hours: 0 }), /0.01~500/);
    assert.throws(() => normalizeCredit({ itemId: 'it1', date: '2026-01-01', hours: 1.234 }), /소수점 2자리/);
    assert.throws(() => normalizeCredit({ itemId: 'it1', date: '', hours: 1 }), /이수일/);
    assert.throws(() => normalizeCredit({ itemId: '../x', date: '2026-01-01', hours: 1 }), /형식/);
  });

  test('글자 수 제한과 제어문자 제거', () => {
    const n = normalizeItem({ id: 'a', name: 'ab\u0007c', expiresOn: '2027-01-01' });
    assert.equal(n.name, 'abc');
    assert.throws(() => normalizeItem({ id: 'a', name: 'x'.repeat(101), expiresOn: '2027-01-01' }), /100자/);
  });
});

describe('백업 JSON 가져오기 검증', () => {
  const today = '2026-11-06';
  const base = () => buildBackup({
    items: [normalizeItem({ id: 'it1', name: '간호', expiresOn: '2027-12-31', cycleYears: 3, requiredCredits: 8 })],
    credits: [normalizeCredit({ id: 'c1', itemId: 'it1', date: '2026-03-01', hours: 2.5, course: '교육' })],
    leads: [90, 30],
    now: new Date('2026-11-06T00:00:00Z'),
  });

  test('내보낸 백업은 그대로 검증 통과 (왕복)', () => {
    const r = validateBackup(JSON.parse(JSON.stringify(base())));
    assert.equal(r.ok, true, r.errors.join(' | '));
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.credits[0].hours, 2.5);
    assert.deepEqual(r.data.leads, [90, 30]);
  });

  test('알 수 없는 키는 버려짐 (프로토타입 오염 방지 포함)', () => {
    const raw = base();
    raw.items[0].evil = 'x';
    raw.items[0].__proto__ = { polluted: true };
    const r = validateBackup(JSON.parse(JSON.stringify(raw)));
    assert.equal(r.ok, true);
    assert.equal('evil' in r.data.items[0], false);
    assert.equal({}.polluted, undefined);
  });

  test('잘못된 schema/app 거부', () => {
    assert.equal(validateBackup({ app: 'other', schema: 1, items: [], credits: [] }).ok, false);
    assert.equal(validateBackup({ app: 'licensetrack', schema: 2, items: [], credits: [] }).ok, false);
    assert.equal(validateBackup([]).ok, false);
    assert.equal(validateBackup(null).ok, false);
  });

  test('중복 ID, 없는 항목을 가리키는 학점, 잘못된 날짜를 모두 보고', () => {
    const raw = base();
    raw.items.push({ ...raw.items[0] });
    raw.credits.push({ id: 'c2', itemId: 'nope', date: '2026-01-01', hours: 1 });
    raw.credits.push({ id: 'c3', itemId: 'it1', date: '2026-02-31', hours: 1 });
    const r = validateBackup(raw);
    assert.equal(r.ok, false);
    const text = r.errors.join(' | ');
    assert.match(text, /중복/);
    assert.match(text, /존재하지 않는 자격/);
    assert.match(text, /실제 존재/);
  });

  test('목록 크기 제한과 잘못된 알림 설정', () => {
    const raw = base();
    raw.settings = { leads: [0] };
    const r = validateBackup(raw);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /알림 설정/);
    const big = { app: 'licensetrack', schema: 1, items: Array(201).fill({}), credits: [] };
    assert.equal(validateBackup(big).ok, false);
  });

  test('인쇄 요약 행: 학점 합계와 상태 포함', () => {
    const items = [normalizeItem({ id: 'it1', name: '간호', expiresOn: '2027-12-31', cycleYears: 3, requiredCredits: 8 })];
    const rows = buildPrintRows(items, [credit('2026-03-01', 2.5, { itemId: 'it1' })], today);
    assert.equal(rows[0].earned, 2.5);
    assert.equal(rows[0].required, 8);
    assert.equal(rows[0].status, 'at-risk'); // 2.5/8 학점, 남은 약 14개월: 현재 페이스로는 부족
  });
});

describe('AI 입력 최소화와 폴백 계획', () => {
  const today = '2026-11-06';

  test('AI 페이로드에는 자격명·기관·번호·메모가 들어가지 않음', () => {
    const items = [normalizeItem({ id: 'it1', name: '비밀자격명', issuer: '비밀기관', number: 'LIC-99887766', expiresOn: '2027-06-30', cycleYears: 3, requiredCredits: 20, notes: '메모비밀' })];
    const credits = [normalizeCredit({ itemId: 'it1', date: '2026-02-01', hours: 3, course: '과정비밀', provider: '업체비밀', category: '법정', memo: '인증서비밀' })];
    const rows = buildDashboard(items, credits, today).rows;
    const elig = planEligibility(rows, today);
    const payload = anonymizeForAi(elig.items);
    const text = JSON.stringify(payload) + buildPrompt(payload);
    for (const secret of ['비밀자격명', '비밀기관', 'LIC-99887766', '메모비밀', '과정비밀', '업체비밀', '인증서비밀', 'it1']) {
      assert.ok(!text.includes(secret), `leak: ${secret}`);
    }
    assert.ok(text.includes('법정'), '분류는 전송 가능');
    assert.equal(payload.items[0].remaining, 17);
  });

  test('개월 수: 같은 달이면 1, 만료 지난 항목은 계획 제외', () => {
    assert.equal(monthsAvailable('2026-11-06', '2026-11-30'), 1);
    assert.equal(monthsAvailable('2026-11-06', '2027-02-01'), 4);
    const items = [normalizeItem({ id: 'it1', name: 'x', expiresOn: '2026-01-01', cycleYears: 0, requiredCredits: 5 })];
    assert.equal(planEligibility(buildDashboard(items, [], today).rows, today).items.length, 0);
  });

  test('균등 계획 합계는 남은 학점과 같고 음수 없음', () => {
    const plan = fallbackPlan({ remaining: 10, months: 6 }, 'even');
    assert.equal(plan.length, 6);
    assert.equal(Math.round(plan.reduce((a, b) => a + b, 0) * 100) / 100, 10);
    assert.ok(plan.every((x) => x >= 0));
  });

  test('앞당김 계획은 앞쪽 절반 달에 몰리고 합계 일치', () => {
    const plan = fallbackPlan({ remaining: 8, months: 8 }, 'front');
    assert.equal(plan.slice(4).reduce((a, b) => a + b, 0), 0);
    assert.equal(Math.round(plan.reduce((a, b) => a + b, 0) * 100) / 100, 8);
  });

  test('AI 응답 검증: 정상 JSON 통과, 합계 불일치/길이 불일치/문자열 숫자 거부', () => {
    const payload = { items: [{ id: 'A1', remaining: 6, months: 3 }] };
    const ok = parsePlanReply('```json\n{"A1":[2,2,2]}\n```', payload);
    assert.equal(ok.plans.A1.reduce((a, b) => a + b, 0), 6);
    assert.equal(ok.errors.length, 0);

    const bad1 = parsePlanReply('{"A1":[1,1,1]}', payload);
    assert.equal(bad1.plans.A1, undefined);
    assert.match(bad1.errors[0], /합계/);

    const bad2 = parsePlanReply('{"A1":[2,2]}', payload);
    assert.match(bad2.errors[0], /길이/);

    const bad3 = parsePlanReply('{"A1":["2",2,2]}', payload);
    assert.match(bad3.errors[0], /숫자/);

    const bad4 = parsePlanReply('{"ZZ":[6,0,0]}', payload);
    assert.match(bad4.errors[0], /알 수 없는/);

    const bad5 = parsePlanReply('그냥 텍스트', payload);
    assert.match(bad5.errors[0], /JSON/);
  });

  test('AI 응답 검증: 음수, 남은 학점 초과 거부', () => {
    const payload = { items: [{ id: 'A1', remaining: 4, months: 2 }] };
    assert.match(parsePlanReply('{"A1":[-1,5]}', payload).errors[0], /0 이상|범위/);
  });

  test('키 형식 확인: 명백히 잘못된 값만 거부 (네트워크 호출 없음)', () => {
    assert.equal(isPlausibleAnthropicKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'), true);
    assert.equal(isPlausibleAnthropicKey('sk-ant-short'), false);
    assert.equal(isPlausibleAnthropicKey('Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), false);
    assert.equal(isPlausibleAnthropicKey('sk-ant-api03-has space abcdefghijklmnop'), false);
    assert.equal(isPlausibleAnthropicKey(''), false);
    assert.equal(isPlausibleAnthropicKey(null), false);
    assert.ok(AI_LIMITS.maxTokens <= 700);
  });
});

describe('설정 상수', () => {
  test('기준 라벨과 템플릿 예시 표기', () => {
    assert.match(CONSTANTS.기준, /기준/);
    for (const t of CONSTANTS.templates.slice(1)) {
      assert.match(t.label, /예시/);
    }
  });
});

describe('예시 템플릿 편집', () => {
  test('기본값과 같은 값은 저장하지 않고, 다른 값만 overrides 에 남긴다', () => {
    const r = normalizeTemplateOverrides({
      nurse: { cycleYears: 3, requiredCredits: 8 },
      cpe: { cycleYears: 1, requiredCredits: 20 },
    });
    assert.deepEqual(Object.keys(r), ['cpe']);
    assert.deepEqual(r.cpe, { cycleYears: 1, requiredCredits: 20 });
  });

  test('알 수 없는 템플릿 ID, 범위 밖 주기, 소수 주기, 음수 학점 거부', () => {
    assert.throws(() => normalizeTemplateOverrides({ nope: { cycleYears: 2 } }), /알 수 없는 템플릿/);
    assert.throws(() => normalizeTemplateOverrides({ nurse: { cycleYears: 51, requiredCredits: 8 } }), ValidationError);
    assert.throws(() => normalizeTemplateOverrides({ nurse: { cycleYears: 2.5, requiredCredits: 8 } }), ValidationError);
    assert.throws(() => normalizeTemplateOverrides({ nurse: { cycleYears: 3, requiredCredits: -1 } }), ValidationError);
    assert.throws(() => normalizeTemplateOverrides([]), ValidationError);
  });

  test('필요 학점을 비우면 null (기준 없음)으로 저장', () => {
    const r = normalizeTemplateOverrides({ nurse: { cycleYears: 3, requiredCredits: '' } });
    assert.deepEqual(r.nurse, { cycleYears: 3, requiredCredits: null });
  });

  test('템플릿 목록: 수정 여부 표시, 라벨의 "예시" 표기는 유지', () => {
    const list = templatesWithOverrides({ nurse: { cycleYears: 4, requiredCredits: 10 } });
    const nurse = list.find((t) => t.id === 'nurse');
    assert.equal(nurse.cycleYears, 4);
    assert.equal(nurse.requiredCredits, 10);
    assert.equal(nurse.edited, true);
    assert.equal(list.find((t) => t.id === 'cpe').edited, false);
    for (const t of list) assert.match(t.label, /예시/);
    assert.equal(list.some((t) => t.id === 'blank'), false);
  });

  test('setTemplateOverride 는 입력 객체를 바꾸지 않고, 기본값으로 되돌리면 항목이 사라짐', () => {
    const before = { };
    const after = setTemplateOverride(before, 'safety', { cycleYears: 2, requiredCredits: 30 });
    assert.deepEqual(before, {});
    assert.deepEqual(after.safety, { cycleYears: 2, requiredCredits: 30 });
    const back = setTemplateOverride(after, 'safety', { cycleYears: 2, requiredCredits: 24 });
    assert.deepEqual(back, {});
    assert.deepEqual(resetTemplateOverride(after, 'safety'), {});
  });

  test('백업 왕복에 템플릿 수정값이 포함되고, 잘못된 값은 템플릿 설정 오류로 보고', () => {
    const items = [normalizeItem({ id: 'it1', name: '간호', expiresOn: '2027-12-31', cycleYears: 4, requiredCredits: 10 })];
    const raw = buildBackup({
      items, credits: [], leads: [30], templates: { nurse: { cycleYears: 4, requiredCredits: 10 } },
      now: new Date('2026-11-06T00:00:00Z'),
    });
    const ok = validateBackup(JSON.parse(JSON.stringify(raw)));
    assert.equal(ok.ok, true, ok.errors.join(' | '));
    assert.deepEqual(ok.data.templates, { nurse: { cycleYears: 4, requiredCredits: 10 } });

    raw.settings.templates = { nurse: { cycleYears: 'many' } };
    const bad = validateBackup(raw);
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0], /템플릿 설정/);
  });

  test('이전 버전 백업(templates 키 없음)도 그대로 가져옴', () => {
    const raw = { app: 'licensetrack', schema: 1, settings: { leads: [30] }, items: [], credits: [] };
    const r = validateBackup(raw);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.templates, {});
  });
});

describe('보유자(가족) 구분', () => {
  const today = '2026-11-06';
  const mk = (id, name, holder, over = {}) => normalizeItem({
    id, name, holder, expiresOn: '2027-06-30', cycleYears: 3, requiredCredits: 10, ...over,
  });

  test('보유자 입력은 앞뒤 공백을 자르고 40자 이하, 없으면 빈 문자열', () => {
    assert.equal(normalizeItem({ name: '가', expiresOn: '2027-01-01', holder: '  엄마  ' }).holder, '엄마');
    assert.equal(normalizeItem({ name: '가', expiresOn: '2027-01-01' }).holder, '');
    assert.throws(() => normalizeItem({ name: '가', expiresOn: '2027-01-01', holder: 'x'.repeat(41) }), ValidationError);
    assert.equal(holderOf({ holder: undefined }), '');
  });

  test('선택지: 이름순, 미지정은 맨 뒤, 항목 수 집계', () => {
    const items = [mk('a', 'A', '아들'), mk('b', 'B', ''), mk('c', 'C', '엄마'), mk('d', 'D', '아들')];
    const g = holderGroups(items);
    assert.deepEqual(g.map((x) => x.holder), ['아들', '엄마', '']);
    assert.deepEqual(g.map((x) => x.count), [2, 1, 1]);
    assert.equal(g[2].label, '보유자 미지정');
  });

  test('필터: null 은 전체, 빈 문자열은 미지정, 이름은 해당 보유자만', () => {
    const rows = buildDashboard([mk('a', 'A', '아들'), mk('b', 'B', ''), mk('c', 'C', '엄마')], [], today).rows;
    assert.equal(filterRowsByHolder(rows, null).length, 3);
    assert.deepEqual(filterRowsByHolder(rows, '').map((r) => r.item.id), ['b']);
    assert.deepEqual(filterRowsByHolder(rows, '엄마').map((r) => r.item.id), ['c']);
  });

  test('보유자별 요약: 버킷 개수, 기준 미달 예상, 가장 가까운 미래 마감', () => {
    const items = [
      mk('a', 'A', '엄마', { expiresOn: '2026-11-20' }), // 30일 이내
      mk('b', 'B', '엄마', { expiresOn: '2026-10-01' }), // 만료
      mk('c', 'C', '아들', { expiresOn: '2027-06-30', requiredCredits: 100 }), // 예상 부족
    ];
    const credits = [normalizeCredit({ itemId: 'c', date: '2026-01-10', hours: 1 })];
    const rows = buildDashboard(items, credits, today).rows;
    const s = holderSummary(rows);
    assert.deepEqual(s.map((x) => x.holder), ['아들', '엄마']);
    const mom = s[1];
    assert.equal(mom.total, 2);
    assert.equal(mom.expired, 1);
    assert.equal(mom.d30, 1);
    assert.deepEqual(mom.next, { date: '2026-11-20', name: 'A' });
    assert.equal(s[0].atRisk, 1);
  });

  test('AI 페이로드에 보유자 이름이 들어가지 않음', () => {
    const items = [mk('a', 'A', '비밀보유자', { expiresOn: '2027-06-30', requiredCredits: 20 })];
    const rows = buildDashboard(items, [], today).rows;
    const payload = anonymizeForAi(planEligibility(rows, today).items);
    assert.equal((JSON.stringify(payload) + buildPrompt(payload)).includes('비밀보유자'), false);
  });

  test('이전 백업(보유자 없음)의 항목은 미지정으로 읽힘', () => {
    const r = validateBackup({ app: 'licensetrack', schema: 1, items: [{ name: '구형', expiresOn: '2027-01-01' }], credits: [] });
    assert.equal(r.ok, true, r.errors.join(' | '));
    assert.equal(holderOf(r.data.items[0]), '');
  });
});

describe('연간 달력 히트맵', () => {
  const today = '2026-11-06';

  test('단계 경계: 0 = 기록 없음, 2 미만 = 1, 5 미만 = 2, 10 미만 = 3, 10 이상 = 4', () => {
    assert.equal(heatLevel(0), 0);
    assert.equal(heatLevel(0.5), 1);
    assert.equal(heatLevel(2), 2);
    assert.equal(heatLevel(4.5), 2);
    assert.equal(heatLevel(5), 3);
    assert.equal(heatLevel(10), 4);
    assert.equal(heatLevel(undefined), 0);
  });

  test('요일: 2026-01-01 은 목요일(4), 1970-01-01 은 목요일', () => {
    assert.equal(dayOfWeek('2026-01-01'), 4);
    assert.equal(dayOfWeek('1970-01-01'), 4);
    assert.equal(dayOfWeek('2026-11-08'), 0);
  });

  test('격자 크기: 평년 365칸, 윤년 366칸, 53주 열', () => {
    const h = yearHeatmap({ year: 2026, items: [], credits: [], today });
    assert.equal(h.days.length, 365);
    assert.equal(h.cols, 53);
    assert.deepEqual(h.days[0], { date: '2026-01-01', col: 0, row: 4, hours: 0, level: 0, deadlines: [], isToday: false });
    assert.equal(h.days[364].date, '2026-12-31');
    assert.equal(h.days[364].col, 52);
    assert.equal(yearHeatmap({ year: 2028, items: [], credits: [], today }).days.length, 366);
  });

  test('같은 날 학점은 합산하고, 다른 해 기록은 무시, 단계에 반영', () => {
    const credits = [
      normalizeCredit({ itemId: 'x', date: '2026-03-01', hours: 2 }),
      normalizeCredit({ itemId: 'x', date: '2026-03-01', hours: 1 }),
      normalizeCredit({ itemId: 'x', date: '2025-03-01', hours: 9 }),
    ];
    const h = yearHeatmap({ year: 2026, items: [], credits, today });
    const mar1 = h.days.find((d) => d.date === '2026-03-01');
    assert.equal(mar1.hours, 3);
    assert.equal(mar1.level, 2);
    assert.equal(h.creditDays, 1);
    assert.equal(h.totalHours, 3);
  });

  test('마감일: 만료일 1회, 주기 반복 날짜 포함, 윤년 말일 보정', () => {
    const cyc = normalizeItem({ id: 'a', name: '주기형', expiresOn: '2026-12-31', cycleYears: 3, requiredCredits: 8 });
    assert.deepEqual(deadlinesInYear([cyc], 2026).map((d) => d.date), ['2026-12-31']);
    assert.deepEqual(deadlinesInYear([cyc], 2029).map((d) => d.date), ['2029-12-31']);
    assert.deepEqual(deadlinesInYear([cyc], 2027), []);
    // 2028-02-29 만료, 1년 주기: 2026-02-28 이 마감
    const leap = normalizeItem({ id: 'b', name: '윤년', expiresOn: '2028-02-29', cycleYears: 1, requiredCredits: 8 });
    assert.deepEqual(deadlinesInYear([leap], 2026).map((d) => d.date), ['2026-02-28']);
    const once = normalizeItem({ id: 'c', name: '주기없음', expiresOn: '2026-05-05' });
    assert.equal(deadlinesInYear([once], 2026).length, 1);
    const hm = yearHeatmap({ year: 2026, items: [once], credits: [], today });
    const may5 = hm.days.find((d) => d.date === '2026-05-05');
    assert.equal(may5.deadlines.length, 1);
    assert.equal(hm.deadlines.length, 1);
  });

  test('만료일이 없고 발급일+주기만 있으면 파생 만료일을 마감으로 사용', () => {
    const derived = normalizeItem({ id: 'd', name: '파생', issuedOn: '2020-03-01', cycleYears: 3 });
    // 발급 2020-03-01 + 3년 - 1일 = 2023-02-28, 다음 2026-02-28
    assert.deepEqual(deadlinesInYear([derived], 2026).map((d) => d.date), ['2026-02-28']);
  });
});
