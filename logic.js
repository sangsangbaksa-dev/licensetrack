// licensetrack 순수 로직 (DOM 없음). 테스트는 tests/logic.test.js 에서 실행합니다.

/* ------------------------------------------------------------------ *
 * 상수 (한 곳에서 수정). 기준일이 바뀌면 아래 기준 라벨도 함께 바꾸세요.
 * ------------------------------------------------------------------ */
export const CONSTANTS = {
  기준: '기준: 앱 작성 시점(2026-11). 템플릿 주기·이수시간은 모두 예시이며 발급 기관과 최신 법령에서 반드시 확인하세요.',
  rules: {
    cycle: '주기 종료일 = 만료일. 주기 시작일 = 만료일 − 주기(년) + 1일.',
    leapYear: '말일 보정: 2월 29일 + 1년 = 2월 28일, 1월 31일 + 1개월 = 2월 말일.',
    urgency: '만료일 당일은 "30일 이내". 0~30일 남음 = 30일 이내, 31~90일 = 90일 이내, 91일 이상 = 여유, 만료일 지남 = 만료.',
    pace: '월 페이스 = 주기 시작일 이후 이수 학점 ÷ 경과 개월(최소 1개월). 남은 기간이 1개월 미만이면 1개월로 계산.',
    projection: '예상 합계 = 현재 합계 + 월 페이스 × 남은 개월. 예상 부족 = 필요 학점 − 예상 합계(0 이상).',
  },
  urgency: { soonDays: 30, warnDays: 90 },
  defaultLeadDays: [180, 90, 30, 7],
  monthDays: 30.4375,
  icsHorizonCycles: 3,
  limits: {
    items: 200,
    credits: 5000,
    name: 100,
    issuer: 100,
    number: 50,
    notes: 1000,
    course: 200,
    provider: 100,
    category: 40,
    memo: 500,
    hours: 500,
    requiredCredits: 10000,
    carryover: 1000,
    cycleYears: 50,
    leadDays: 730,
    leadCount: 8,
  },
  // 예시 템플릿: 폼에 미리 채워 넣는 값일 뿐이며 사용자가 수정해야 합니다.
  templates: [
    { id: 'blank', label: '직접 입력', name: '', issuer: '', cycleYears: 0, requiredCredits: null, note: '' },
    { id: 'nurse', label: '예시: 간호사 면허 보수교육', name: '간호사 면허 (예시)', issuer: '발급 기관 확인 필요', cycleYears: 3, requiredCredits: 8, note: '예시 값입니다. 보수교육 주기와 시간은 최신 법령에서 확인하세요.' },
    { id: 'realtor', label: '예시: 공인중개사 실무교육', name: '공인중개사 (예시)', issuer: '시·도지사 / 교육기관 확인 필요', cycleYears: 2, requiredCredits: 8, note: '예시 값입니다. 실무교육 대상 여부와 시간을 확인하세요.' },
    { id: 'safety', label: '예시: 안전관리자 보수교육', name: '산업안전 관리자 (예시)', issuer: '안전보건 교육기관 확인 필요', cycleYears: 2, requiredCredits: 24, note: '예시 값입니다. 직무교육 주기와 시간을 확인하세요.' },
    { id: 'social', label: '예시: 사회복지사 보수교육', name: '사회복지사 1급 (예시)', issuer: '한국사회복지사협회 등 확인 필요', cycleYears: 3, requiredCredits: 12, note: '예시 값입니다. 보수교육 기준을 확인하세요.' },
    { id: 'cpe', label: '예시: 세무·회계 CPE', name: '세무사 / 회계사 (예시)', issuer: '소속 협회 확인 필요', cycleYears: 1, requiredCredits: 15, note: '예시 값입니다. 연간 CPE 기준을 협회에서 확인하세요.' },
    { id: 'construction', label: '예시: 건설기술인 교육', name: '건설기술인 (예시)', issuer: '건설기술인협회 확인 필요', cycleYears: 5, requiredCredits: 32, note: '예시 값입니다. 교육 주기와 시간을 확인하세요.' },
    { id: 'hazmat', label: '예시: 위험물 안전관리자 실무교육', name: '위험물 안전관리자 (예시)', issuer: '한국소방안전원 확인 필요', cycleYears: 2, requiredCredits: 8, note: '예시 값입니다. 실무교육 주기와 시간을 확인하세요.' },
  ],
  appVersion: 1,
};

export const MONTH_DAYS = CONSTANTS.monthDays;

/* ------------------------------------------------------------------ *
 * 날짜 (모든 날짜는 로컬 YYYY-MM-DD 문자열, 계산은 UTC 일수로 수행)
 * ------------------------------------------------------------------ */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function fmtDate(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isDateStr(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12) return false;
  return d >= 1 && d <= daysInMonth(y, mo);
}

export function toDayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 864e5);
}

export function fromDayNum(n) {
  const dt = new Date(n * 864e5);
  return fmtDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(s, n) {
  return fromDayNum(toDayNum(s) + n);
}

/** a - b, 일 단위 */
export function diffDays(a, b) {
  return toDayNum(a) - toDayNum(b);
}

/** 말일 보정 포함 개월 더하기: 1월 31일 + 1개월 = 2월 말일 */
export function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12);
  const nm = t - ny * 12 + 1;
  return fmtDate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** 2월 29일 + 1년 = 2월 28일 (말일 보정) */
export function addYears(s, n) {
  return addMonths(s, n * 12);
}

/** 로컬 시각 기준 오늘 날짜 (toISOString 사용 금지: UTC로 밀려 날짜가 틀어짐) */
export function todayStr(date = new Date()) {
  return fmtDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** 같은 달 기준 '월 수' 차이를 센 개수 (달력 월, 양 끝 포함) */
export function calendarMonthsInclusive(fromStr, toStr) {
  const [y1, m1] = fromStr.split('-').map(Number);
  const [y2, m2] = toStr.split('-').map(Number);
  return (y2 * 12 + m2) - (y1 * 12 + m1) + 1;
}

/* ------------------------------------------------------------------ *
 * 주기 / 만료 / 학점 계산
 * ------------------------------------------------------------------ */
export function cycleWindow(endDate, cycleYears, k = 0) {
  const end = k === 0 ? endDate : addYears(endDate, -k * cycleYears);
  if (!cycleYears) return { start: null, end };
  const start = addDays(addYears(end, -cycleYears), 1);
  return { start, end };
}

/** 만료일이 있으면 그것, 없으면 발급일 + 주기 − 1일 (기념일 전날) */
export function effectiveExpiry(item) {
  if (item.expiresOn) return item.expiresOn;
  if (item.issuedOn && item.cycleYears) return addDays(addYears(item.issuedOn, item.cycleYears), -1);
  return null;
}

const round2 = (x) => Math.round(x * 100) / 100;
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * 현재 주기 상태. 학점 기록은 주기 시작일~종료일 사이의 것만 이번 주기로 집계.
 * 반환값 null 이면 만료일을 계산할 수 없는 항목.
 */
export function cycleStatus(item, credits, today) {
  const expiry = effectiveExpiry(item);
  if (!expiry) return null;
  const years = item.cycleYears || 0;
  const win = cycleWindow(expiry, years, 0);
  const end = win.end;
  const start = years ? win.start : (item.issuedOn || null);
  const hasReq = item.requiredCredits != null;
  const required = hasReq ? Number(item.requiredCredits) : null;
  const carry = Number(item.carryover) || 0;

  let earned = 0, priorEarned = 0, nextEarned = 0;
  const byCategory = {};
  for (const c of credits) {
    if (c.itemId !== item.id) continue;
    if (start && c.date < start) { priorEarned += c.hours; continue; }
    if (c.date > end) { nextEarned += c.hours; continue; }
    earned += c.hours;
    const k = c.category || '기타';
    byCategory[k] = round2((byCategory[k] || 0) + c.hours);
  }
  earned = round2(earned);
  const total = round2(earned + carry);
  const daysLeft = diffDays(end, today);
  const remaining = hasReq ? Math.max(0, round2(required - total)) : null;
  const monthsLeft = daysLeft >= 0 ? daysLeft / MONTH_DAYS : 0;

  let neededPerMonth = null;
  let pace = null, projectedTotal = null, projectedShortfall = null;
  if (daysLeft >= 0) {
    if (hasReq && remaining > 0) neededPerMonth = round2(remaining / Math.max(1, monthsLeft));
    else neededPerMonth = 0;
    if (start) {
      const elapsed = Math.max(1, diffDays(today, start) / MONTH_DAYS);
      pace = round2(earned / elapsed);
      projectedTotal = round2(total + pace * monthsLeft);
      projectedShortfall = hasReq ? Math.max(0, round2(required - projectedTotal)) : null;
    }
  }

  let status;
  if (!hasReq) status = 'no-req';
  else if (remaining === 0) status = 'done';
  else if (daysLeft < 0) status = 'overdue';
  else if (projectedShortfall > 0) status = 'at-risk';
  else status = 'on-track';

  const percent = hasReq ? (required > 0 ? Math.min(100, round1((total / required) * 100)) : 100) : null;

  return {
    start, end, years, required, carry, earned, priorEarned, nextEarned, total, remaining,
    daysLeft, monthsLeft: round1(monthsLeft), neededPerMonth, pace, projectedTotal,
    projectedShortfall, status, percent, byCategory,
  };
}

/** 만료일까지 남은 날 기준 긴급도 버킷 */
export function urgencyBucket(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return 'none';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= CONSTANTS.urgency.soonDays) return 'd30';
  if (daysLeft <= CONSTANTS.urgency.warnDays) return 'd90';
  return 'ok';
}

export const BUCKET_ORDER = ['expired', 'd30', 'd90', 'ok', 'none'];

export const BUCKET_LABEL = {
  expired: '만료',
  d30: '30일 이내',
  d90: '90일 이내',
  ok: '여유',
  none: '만료일 없음',
};

/** 대시보드용 행 목록, 버킷 집계, 타임라인 */
export function buildDashboard(items, credits, today) {
  const rows = items.map((item) => {
    const expiry = effectiveExpiry(item);
    const daysLeft = expiry ? diffDays(expiry, today) : null;
    return { item, expiry, daysLeft, bucket: urgencyBucket(daysLeft), cycle: cycleStatus(item, credits, today) };
  });
  const rank = Object.fromEntries(BUCKET_ORDER.map((b, i) => [b, i]));
  rows.sort((a, b) =>
    rank[a.bucket] - rank[b.bucket] ||
    (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) ||
    a.item.name.localeCompare(b.item.name, 'ko'));
  const counts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  for (const r of rows) counts[r.bucket]++;
  const timeline = rows
    .filter((r) => r.expiry && r.daysLeft <= 365)
    .map((r) => ({ id: r.item.id, name: r.item.name, date: r.expiry, daysLeft: r.daysLeft }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, counts, timeline };
}

/* ------------------------------------------------------------------ *
 * 알림: 리드타임 기준으로 "지금 알려야 할" 항목
 * ------------------------------------------------------------------ */
export function normalizeLeads(v) {
  if (!Array.isArray(v)) throw new Error('알림 기간은 숫자 목록이어야 합니다.');
  if (v.length > CONSTANTS.limits.leadCount) throw new Error(`알림 기간은 최대 ${CONSTANTS.limits.leadCount}개입니다.`);
  const out = new Set();
  for (const x of v) {
    if (!Number.isInteger(x) || x < 1 || x > CONSTANTS.limits.leadDays) {
      throw new Error(`알림 기간은 1~${CONSTANTS.limits.leadDays}일 사이 정수여야 합니다.`);
    }
    out.add(x);
  }
  return [...out].sort((a, b) => b - a);
}

/**
 * 리드타임 안에 들어온 항목 목록. 각 항목은 "가장 가까운 알림 기간"으로 표시.
 * 만료된 항목도 포함(expired: true).
 */
export function dueReminders(rows, leads) {
  const maxLead = leads.length ? Math.max(...leads) : 0;
  const out = [];
  for (const r of rows) {
    if (r.daysLeft === null || r.daysLeft > maxLead) continue;
    const crossed = leads.filter((L) => r.daysLeft <= L).sort((a, b) => a - b)[0] ?? null;
    out.push({ id: r.item.id, name: r.item.name, daysLeft: r.daysLeft, lead: crossed, expired: r.daysLeft < 0 });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** 달력 알림용 마감일 목록: 현재 만료일 + 다음 주기들, 오늘 이후만 */
export function deadlinesForItem(item, today, horizonCycles = CONSTANTS.icsHorizonCycles) {
  const exp = effectiveExpiry(item);
  if (!exp) return [];
  const years = item.cycleYears || 0;
  const n = years ? horizonCycles + 1 : 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    const d = years ? addYears(exp, k * years) : exp;
    if (diffDays(d, today) >= 0) out.push(d);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ICS (RFC 5545)
 * ------------------------------------------------------------------ */
export function utf8Length(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** 75옥텟 기준 줄 접기. 다중 바이트 문자는 쪼개지 않음. 이어지는 줄은 공백으로 시작. */
export function foldLine(line) {
  const parts = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = utf8Length(ch);
    // 첫 줄은 75옥텟, 이어지는 줄은 선행 공백(1옥텟) 포함 75옥텟
    if (bytes + b > 75) {
      parts.push(cur);
      cur = ' ' + ch;
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  parts.push(cur);
  return parts.join('\r\n');
}

/** TEXT 값 이스케이프: \ ; , 와 줄바꿈 */
export function icsText(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

export function icsDstamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

/**
 * 항목별 마감일 VEVENT(종일) + 알림 기간마다 VALARM.
 * UID = 항목ID-마감일(YYYYMMDD)@licensetrack.local : 항목/마감일 조합마다 유일.
 * 자격번호는 달력에 넣지 않음.
 */
export function buildIcs({ items, leads, today, dtstamp, horizonCycles = CONSTANTS.icsHorizonCycles }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//licensetrack//KO//KR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText('자격·면허 마감')}`,
  ];
  const sortedLeads = [...leads].sort((a, b) => b - a);
  for (const item of items) {
    for (const d of deadlinesForItem(item, today, horizonCycles)) {
      const ymd = d.replace(/-/g, '');
      const next = addDays(d, 1).replace(/-/g, '');
      const name = icsText(item.name);
      const req = item.requiredCredits == null ? '기준 없음' : `${item.requiredCredits}`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${item.id}-${ymd}@licensetrack.local`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${ymd}`,
        `DTEND;VALUE=DATE:${next}`,
        `SUMMARY:${icsText(`${item.name} 갱신·학점 마감`)}`,
        `DESCRIPTION:${icsText(`${item.name}\n마감일 ${d}\n필요 학점: ${req}\n발급기관: ${item.issuer || '-'}`)}`,
        'TRANSP:TRANSPARENT',
      );
      for (const L of sortedLeads) {
        lines.push(
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${icsText(`${L}일 전 알림: ${name}`)}`,
          `TRIGGER:-P${L}D`,
          'END:VALARM',
        );
      }
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 수식 주입 방지
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildCreditsCsv(items, credits) {
  const names = new Map(items.map((i) => [i.id, i.name]));
  const header = ['자격명', '날짜', '이수시간', '과정명', '제공기관', '분류', '메모'];
  const rows = [...credits]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((c) => [names.get(c.itemId) ?? '(삭제된 항목)', c.date, c.hours, c.course, c.provider, c.category, c.memo]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * 입력 정규화 / 검증 (폼 입력과 백업 가져오기에 공통 사용)
 * ------------------------------------------------------------------ */
export class ValidationError extends Error {}

const NUM_RE = /^-?\d+(\.\d+)?$/;

function numField(v, label, { min, max, allowEmpty = false, int = false, decimals = 2 }) {
  if (v === '' || v === null || v === undefined) {
    if (allowEmpty) return null;
    throw new ValidationError(`${label}을(를) 입력하세요.`);
  }
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && NUM_RE.test(v.trim())) n = Number(v.trim());
  else throw new ValidationError(`${label}은(는) 숫자여야 합니다.`);
  if (!Number.isFinite(n)) throw new ValidationError(`${label}은(는) 유한한 숫자여야 합니다.`);
  if (n < min || n > max) throw new ValidationError(`${label}은(는) ${min}~${max} 사이여야 합니다.`);
  if (int && !Number.isInteger(n)) throw new ValidationError(`${label}은(는) 정수여야 합니다.`);
  if (Math.round(n * 10 ** decimals) / 10 ** decimals !== n) {
    throw new ValidationError(`${label}은(는) 소수점 ${decimals}자리까지 입력할 수 있습니다.`);
  }
  return n;
}

function textField(v, label, max, { required = false } = {}) {
  if (v === null || v === undefined) v = '';
  if (typeof v !== 'string') throw new ValidationError(`${label}은(는) 글자여야 합니다.`);
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && !s) throw new ValidationError(`${label}을(를) 입력하세요.`);
  if (s.length > max) throw new ValidationError(`${label}은(는) ${max}자 이하여야 합니다.`);
  return s;
}

function dateField(v, label) {
  if (v === null || v === undefined || v === '') return '';
  if (!isDateStr(v)) throw new ValidationError(`${label}은(는) 실제 존재하는 YYYY-MM-DD 날짜여야 합니다.`);
  return v;
}

function idField(v, label = 'ID') {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new ValidationError(`${label} 형식이 올바르지 않습니다.`);
  return v;
}

export function newId() {
  const g = globalThis.crypto;
  const raw = g && typeof g.randomUUID === 'function'
    ? g.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  return raw.replace(/[^A-Za-z0-9_-]/g, '');
}

/** 자격 항목 입력 정규화. input.id 가 없으면 새 ID 를 부여. */
export function normalizeItem(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('항목 데이터가 올바르지 않습니다.');
  const L = CONSTANTS.limits;
  const item = {
    id: input.id ? idField(input.id) : newId(),
    name: textField(input.name, '자격명', L.name, { required: true }),
    issuer: textField(input.issuer, '발급 기관', L.issuer),
    number: textField(input.number, '자격번호', L.number),
    issuedOn: dateField(input.issuedOn, '발급일'),
    expiresOn: dateField(input.expiresOn, '만료일'),
    cycleYears: numField(input.cycleYears ?? '', '갱신 주기(년)', { min: 0, max: L.cycleYears, allowEmpty: true, int: true }) ?? 0,
    requiredCredits: numField(input.requiredCredits ?? '', '필요 학점', { min: 0, max: L.requiredCredits, allowEmpty: true }),
    carryover: numField(input.carryover ?? '', '이월 학점', { min: 0, max: L.carryover, allowEmpty: true }) ?? 0,
    notes: textField(input.notes, '메모', L.notes),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt.slice(0, 40) : new Date().toISOString(),
  };
  if (!item.expiresOn && !(item.issuedOn && item.cycleYears > 0)) {
    throw new ValidationError('만료일을 입력하거나, 발급일과 갱신 주기(년)를 함께 입력하세요.');
  }
  if (item.issuedOn && item.expiresOn && item.issuedOn > item.expiresOn) {
    throw new ValidationError('만료일이 발급일보다 빨라요.');
  }
  return item;
}

export function normalizeCredit(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('학점 기록 데이터가 올바르지 않습니다.');
  const L = CONSTANTS.limits;
  const date = dateField(input.date, '이수일');
  if (!date) throw new ValidationError('이수일을 입력하세요.');
  return {
    id: input.id ? idField(input.id) : newId(),
    itemId: idField(input.itemId, '자격 ID'),
    date,
    hours: numField(input.hours, '이수 시간(학점)', { min: 0.01, max: L.hours }),
    course: textField(input.course, '과정명', L.course),
    provider: textField(input.provider, '제공기관', L.provider),
    category: textField(input.category, '분류', L.category) || '일반',
    memo: textField(input.memo, '인증서 메모', L.memo),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt.slice(0, 40) : new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 백업 (JSON) 생성 / 검증
 * ------------------------------------------------------------------ */
export function buildBackup({ items, credits, leads, now = new Date() }) {
  return {
    app: 'licensetrack',
    schema: CONSTANTS.appVersion,
    exportedAt: now.toISOString(),
    settings: { leads },
    items,
    credits,
  };
}

/**
 * 백업 JSON 검증. 알 수 없는 키는 버리고, 알려진 키만 새 객체로 복사.
 * 반환: { ok, errors, data: { items, credits, leads } }
 */
export function validateBackup(raw) {
  const errors = [];
  const fail = (msg) => ({ ok: false, errors: [msg], data: null });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('백업 파일 형식이 올바르지 않습니다.');
  if (raw.app !== 'licensetrack' || raw.schema !== CONSTANTS.appVersion) {
    return fail('licensetrack 백업 파일(schema 1)이 아닙니다.');
  }
  const L = CONSTANTS.limits;
  if (!Array.isArray(raw.items)) return fail('items 목록이 없습니다.');
  if (!Array.isArray(raw.credits)) return fail('credits 목록이 없습니다.');
  if (raw.items.length > L.items) return fail(`자격 항목은 최대 ${L.items}개까지 가져올 수 있습니다.`);
  if (raw.credits.length > L.credits) return fail(`학점 기록은 최대 ${L.credits}개까지 가져올 수 있습니다.`);

  let leads = CONSTANTS.defaultLeadDays;
  try {
    if (raw.settings && raw.settings.leads !== undefined) leads = normalizeLeads(raw.settings.leads);
  } catch (e) {
    errors.push(`알림 설정: ${e.message}`);
  }

  const items = [];
  const ids = new Set();
  raw.items.forEach((it, i) => {
    try {
      const n = normalizeItem(it);
      if (ids.has(n.id)) throw new ValidationError('중복된 ID입니다.');
      ids.add(n.id);
      items.push(n);
    } catch (e) {
      errors.push(`항목 ${i + 1}: ${e.message}`);
    }
  });

  const credits = [];
  raw.credits.forEach((c, i) => {
    try {
      const n = normalizeCredit(c);
      if (!ids.has(n.itemId)) throw new ValidationError('존재하지 않는 자격 항목을 가리킵니다.');
      credits.push(n);
    } catch (e) {
      errors.push(`학점 기록 ${i + 1}: ${e.message}`);
    }
  });

  if (errors.length) return { ok: false, errors: errors.slice(0, 20), data: null };
  return { ok: true, errors: [], data: { items, credits, leads } };
}

/* ------------------------------------------------------------------ *
 * 요약 인쇄용 데이터
 * ------------------------------------------------------------------ */
export function buildPrintRows(items, credits, today) {
  return buildDashboard(items, credits, today).rows.map((r) => ({
    name: r.item.name,
    issuer: r.item.issuer,
    expiry: r.expiry || '-',
    daysLeft: r.daysLeft,
    bucketLabel: BUCKET_LABEL[r.bucket],
    required: r.cycle?.required ?? null,
    earned: r.cycle ? r.cycle.total : null,
    cycleStart: r.cycle?.start || '-',
    status: r.cycle?.status || 'no-req',
  }));
}
