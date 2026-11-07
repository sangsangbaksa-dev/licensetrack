// licensetrack 순수 로직 (DOM 없음). 테스트는 tests/logic.test.js 에서 실행합니다.
// 사용자에게 보이는 문구는 i18n.js 의 t() 로 가져옵니다. 기본 언어는 ko 입니다.
// CSV 머리글(열 이름)은 파일 형식이므로 한국어로 고정합니다 (가져오기 호환).

import { t } from './i18n.js';

/* ------------------------------------------------------------------ *
 * 상수 (한 곳에서 수정). 기준일이 바뀌면 아래 기준 라벨도 함께 바꾸세요.
 * ------------------------------------------------------------------ */
const tplItem = (id, cycleYears, requiredCredits) => Object.freeze({
  id,
  cycleYears,
  requiredCredits,
  get label() { return t(`tpl.${id}.label`); },
  get name() { return t(`tpl.${id}.name`); },
  get issuer() { return t(`tpl.${id}.issuer`); },
  get note() { return t(`tpl.${id}.note`); },
});

export const CONSTANTS = {
  get 기준() { return t('lic.basis'); },
  get rules() {
    return {
      cycle: t('lic.rule.cycle'),
      leapYear: t('lic.rule.leapYear'),
      urgency: t('lic.rule.urgency'),
      pace: t('lic.rule.pace'),
      projection: t('lic.rule.projection'),
    };
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
    holder: 40,
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
    tplItem('blank', 0, null),
    tplItem('nurse', 3, 8),
    tplItem('realtor', 2, 8),
    tplItem('safety', 2, 24),
    tplItem('social', 3, 12),
    tplItem('cpe', 1, 15),
    tplItem('construction', 5, 32),
    tplItem('hazmat', 2, 8),
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
  const t0 = y * 12 + (m - 1) + n;
  const ny = Math.floor(t0 / 12);
  const nm = t0 - ny * 12 + 1;
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
  get expired() { return t('lic.bucket.expired'); },
  get d30() { return t('lic.bucket.d30'); },
  get d90() { return t('lic.bucket.d90'); },
  get ok() { return t('lic.bucket.ok'); },
  get none() { return t('lic.bucket.none'); },
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
    a.item.name.localeCompare(b.item.name, t('locale.collate')));
  const counts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  for (const r of rows) counts[r.bucket]++;
  const timeline = rows
    .filter((r) => r.expiry && r.daysLeft <= 365)
    .map((r) => ({ id: r.item.id, name: r.item.name, date: r.expiry, daysLeft: r.daysLeft }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, counts, timeline };
}

/* ------------------------------------------------------------------ *
 * 보유자(가족 구분). 빈 문자열 = 미지정. 필터 값: null = 전체, '' = 미지정, 그 밖 = 이름
 * ------------------------------------------------------------------ */
export function holderOf(item) {
  return typeof item.holder === 'string' ? item.holder.trim() : '';
}

/** 보유자 이름순, 미지정('')은 맨 뒤 */
function sortHolderKeys(keys) {
  const named = keys.filter((k) => k !== '').sort((a, b) => a.localeCompare(b, t('locale.collate')));
  return keys.includes('') ? [...named, ''] : named;
}

export function holderLabel(h) {
  return h || t('lic.holderNone');
}

/** 필터 선택지: 보유자별 항목 수 (항목이 없으면 빈 목록) */
export function holderGroups(items) {
  const count = new Map();
  for (const it of items) {
    const h = holderOf(it);
    count.set(h, (count.get(h) || 0) + 1);
  }
  return sortHolderKeys([...count.keys()]).map((h) => ({ holder: h, label: holderLabel(h), count: count.get(h) }));
}

/** 대시보드 행을 보유자로 거름. holder 가 null/undefined 면 전체 */
export function filterRowsByHolder(rows, holder) {
  if (holder === null || holder === undefined) return rows;
  return rows.filter((r) => holderOf(r.item) === holder);
}

/** 보유자별 요약: 항목 수, 만료·30일·90일 개수, 기준 미달 예상 수, 가장 가까운 미래 마감 */
export function holderSummary(rows) {
  const by = new Map();
  for (const r of rows) {
    const h = holderOf(r.item);
    if (!by.has(h)) {
      by.set(h, { holder: h, label: holderLabel(h), total: 0, expired: 0, d30: 0, d90: 0, atRisk: 0, next: null });
    }
    const s = by.get(h);
    s.total++;
    if (r.bucket === 'expired') s.expired++;
    else if (r.bucket === 'd30') s.d30++;
    else if (r.bucket === 'd90') s.d90++;
    if (r.cycle && (r.cycle.status === 'at-risk' || r.cycle.status === 'overdue')) s.atRisk++;
    if (r.expiry && r.daysLeft >= 0 && (!s.next || r.expiry < s.next.date)) {
      s.next = { date: r.expiry, name: r.item.name };
    }
  }
  return sortHolderKeys([...by.keys()]).map((h) => by.get(h));
}

/* ------------------------------------------------------------------ *
 * 알림: 리드타임 기준으로 "지금 알려야 할" 항목
 * ------------------------------------------------------------------ */
export function normalizeLeads(v) {
  if (!Array.isArray(v)) throw new Error(t('lic.err.leadType'));
  if (v.length > CONSTANTS.limits.leadCount) throw new Error(t('lic.err.leadMax', { n: CONSTANTS.limits.leadCount }));
  const out = new Set();
  for (const x of v) {
    if (!Number.isInteger(x) || x < 1 || x > CONSTANTS.limits.leadDays) {
      throw new Error(t('lic.err.leadRange', { max: CONSTANTS.limits.leadDays }));
    }
    out.add(x);
  }
  return [...out].sort((a, b) => b - a);
}

/** 알림 기간 프리셋. 직접 입력값이 프리셋과 같으면 그 이름을 표시 */
export const LEAD_PRESETS = [
  Object.freeze({ id: 'standard', leads: [180, 90, 30, 7], get label() { return t('lic.lead.standard'); } }),
  Object.freeze({ id: 'short', leads: [30, 14, 7, 1], get label() { return t('lic.lead.short'); } }),
  Object.freeze({ id: 'long', leads: [365, 180, 90, 30, 14, 7], get label() { return t('lic.lead.long'); } }),
];

const leadKey = (arr) => [...arr].sort((a, b) => b - a).join(',');

/** 현재 알림 기간이 프리셋 중 하나와 같으면 그 id, 아니면 null (직접 설정) */
export function leadPresetId(leads) {
  const key = leadKey(leads);
  const p = LEAD_PRESETS.find((x) => leadKey(x.leads) === key);
  return p ? p.id : null;
}

/**
 * 앞으로 울릴 알림 날짜 목록: 마감일 L일 전 (오늘 이전 날짜는 제외, 날짜순).
 * 만료된 항목은 제외합니다. 주기 반복 마감은 현재 만료일만 봅니다.
 */
export function upcomingAlerts(rows, leads, today, limit = 30) {
  const out = [];
  for (const r of rows) {
    if (!r.expiry || r.daysLeft < 0) continue;
    for (const L of leads) {
      const alertOn = addDays(r.expiry, -L);
      if (diffDays(alertOn, today) < 0) continue;
      out.push({ id: r.item.id, name: r.item.name, deadline: r.expiry, alertOn, lead: L });
    }
  }
  out.sort((a, b) => (a.alertOn < b.alertOn ? -1 : a.alertOn > b.alertOn ? 1 : b.lead - a.lead));
  return out.slice(0, limit);
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
 * 연간 달력 히트맵 데이터: 날짜별 이수 학점 단계와 마감일 목록
 * 단계 기준(하루 이수 시간): 0 = 기록 없음, 1 = 2 미만, 2 = 5 미만, 3 = 10 미만, 4 = 10 이상
 * ------------------------------------------------------------------ */
export function heatLevel(hours) {
  if (!(hours > 0)) return 0;
  if (hours < 2) return 1;
  if (hours < 5) return 2;
  if (hours < 10) return 3;
  return 4;
}

/** 0 = 일요일 ... 6 = 토요일 (1970-01-01 은 목요일) */
export function dayOfWeek(s) {
  return (((toDayNum(s) + 4) % 7) + 7) % 7;
}

/** 해당 연도의 마감일 목록 (주기마다 반복된 날짜 포함, 날짜순) */
export function deadlinesInYear(items, year) {
  const prefix = `${year}-`;
  const out = [];
  for (const item of items) {
    const exp = effectiveExpiry(item);
    if (!exp) continue;
    const Y = item.cycleYears || 0;
    if (!Y) {
      if (exp.startsWith(prefix)) out.push({ date: exp, id: item.id, name: item.name });
      continue;
    }
    const kmax = Math.ceil(Math.abs(year - Number(exp.slice(0, 4))) / Y) + 2;
    for (let k = -kmax; k <= kmax; k++) {
      const d = addYears(exp, k * Y);
      if (d.startsWith(prefix)) out.push({ date: d, id: item.id, name: item.name });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 한 해의 날짜 격자. col = 주 번호(일요일 시작, 0부터), row = 요일(0 = 일).
 * 같은 날짜에 학점 기록이 여러 건이면 합산합니다.
 */
export function yearHeatmap({ year, items, credits, today }) {
  const prefix = `${year}-`;
  const start = `${year}-01-01`;
  const hoursBy = new Map();
  for (const c of credits) {
    if (c.date.startsWith(prefix)) hoursBy.set(c.date, round2((hoursBy.get(c.date) || 0) + c.hours));
  }
  const deadlines = deadlinesInYear(items, year);
  const dlBy = new Map();
  for (const d of deadlines) {
    if (!dlBy.has(d.date)) dlBy.set(d.date, []);
    dlBy.get(d.date).push(d);
  }
  const startDow = dayOfWeek(start);
  const days = [];
  for (let i = 0; i < 366; i++) {
    const d = addDays(start, i);
    if (!d.startsWith(prefix)) break;
    const hours = hoursBy.get(d) || 0;
    days.push({
      date: d,
      col: Math.floor((i + startDow) / 7),
      row: dayOfWeek(d),
      hours,
      level: heatLevel(hours),
      deadlines: dlBy.get(d) || [],
      isToday: d === today,
    });
  }
  const monthMarks = [];
  for (const d of days) {
    if (d.date.endsWith('-01')) monthMarks.push({ month: Number(d.date.slice(5, 7)), col: d.col });
  }
  const creditDays = days.filter((d) => d.hours > 0).length;
  const totalHours = round2(days.reduce((s, d) => s + d.hours, 0));
  return {
    year,
    days,
    cols: days.length ? days[days.length - 1].col + 1 : 0,
    monthMarks,
    creditDays,
    totalHours,
    deadlines,
  };
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
    `X-WR-CALNAME:${icsText(t('lic.ics.calName'))}`,
  ];
  const sortedLeads = [...leads].sort((a, b) => b - a);
  for (const item of items) {
    for (const d of deadlinesForItem(item, today, horizonCycles)) {
      const ymd = d.replace(/-/g, '');
      const next = addDays(d, 1).replace(/-/g, '');
      const name = icsText(item.name);
      const req = item.requiredCredits == null ? t('lic.ics.noReq') : `${item.requiredCredits}`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${item.id}-${ymd}@licensetrack.local`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${ymd}`,
        `DTEND;VALUE=DATE:${next}`,
        `SUMMARY:${icsText(t('lic.ics.summary', { name: item.name }))}`,
        `DESCRIPTION:${icsText(t('lic.ics.desc', { name: item.name, d, req, issuer: item.issuer || '-' }))}`,
        'TRANSP:TRANSPARENT',
      );
      for (const L of sortedLeads) {
        lines.push(
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${icsText(t('lic.ics.alarm', { L, name: item.name }))}`,
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

// 학점 기록 CSV 머리글: 파일 형식이므로 한국어로 고정합니다.
export function buildCreditsCsv(items, credits) {
  const names = new Map(items.map((i) => [i.id, i.name]));
  const header = ['자격명', '날짜', '이수시간', '과정명', '제공기관', '분류', '메모'];
  const rows = [...credits]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((c) => [names.get(c.itemId) ?? t('lic.csv.deleted'), c.date, c.hours, c.course, c.provider, c.category, c.memo]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * CSV 가져오기 (학점 기록). 행마다 오류를 따로 보고하고, 정상 행만 가져올 수 있음.
 * 내보내기 형식(buildCreditsCsv)을 그대로 읽습니다.
 * ------------------------------------------------------------------ */
export const CSV_LIMITS = { maxBytes: 1024 * 1024, maxRows: 2000 };
export const CREDIT_CSV_HEADER = ['자격명', '날짜', '이수시간', '과정명', '제공기관', '분류', '메모'];
const CSV_REQUIRED = ['자격명', '날짜', '이수시간'];

/** RFC 4180 수준 파서: 따옴표 안의 쉼표·줄바꿈, "" 이스케이프, CRLF/LF, BOM 제거, 빈 줄 제거 */
export function parseCsv(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inQuote) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuote = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') { inQuote = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuote) throw new ValidationError(t('lic.csv.unclosed'));
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** csvCell 이 수식 주입 방지를 위해 앞에 붙인 ' 를 되돌림 (= + - @ 탭 CR 로 시작하는 경우만) */
export function unescapeCsvCell(v) {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

/**
 * 학점 기록 CSV 를 검증하고 행별 결과를 돌려줌. 저장하지 않음 (호출 측이 ok 행만 추가).
 * - items: 현재 자격 목록. 자격명은 정확히 일치해야 하며, 같은 이름이 둘이면 오류.
 * - existing: 현재 학점 기록. 자격·날짜·시간·과정·기관이 같은 행은 중복으로 건너뜀.
 * - limit: 학점 기록 최대 개수. 넘는 행은 오류로 보고.
 * row 는 시트와 같은 번호(1행 = 머리글)입니다. 칸 안에 줄바꿈이 있으면 실제 줄 번호와 다를 수 있습니다.
 */
export function importCreditsCsv(text, { items, existing = [], limit = CONSTANTS.limits.credits } = {}) {
  const fail = (fatal) => ({ ok: false, fatal, total: 0, credits: [], errors: [], skipped: [] });
  if (typeof text !== 'string' || !text.trim()) return fail(t('lic.csv.empty'));
  if (text.length > CSV_LIMITS.maxBytes) return fail(t('lic.csv.tooBig'));
  let rows;
  try {
    rows = parseCsv(text);
  } catch (e) {
    return fail(e.message);
  }
  if (!rows.length) return fail(t('lic.csv.noRows'));
  const header = rows[0].map((h) => h.trim());
  const col = Object.fromEntries(CREDIT_CSV_HEADER.map((h) => [h, header.indexOf(h)]));
  const missing = CSV_REQUIRED.filter((h) => col[h] < 0);
  if (missing.length) return fail(t('lic.csv.missingCols', { cols: missing.join(', ') }));
  const data = rows.slice(1);
  if (data.length > CSV_LIMITS.maxRows) return fail(t('lic.csv.tooManyRows', { n: CSV_LIMITS.maxRows }));

  const byName = new Map();
  for (const it of items) {
    const k = it.name.trim();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(it);
  }
  const keyOf = (c) => [c.itemId, c.date, c.hours, c.course, c.provider].join('\u0001');
  const seen = new Set(existing.map(keyOf));
  let capacity = limit - existing.length;

  const credits = [];
  const errors = [];
  const skipped = [];
  data.forEach((r, k) => {
    const row = k + 2;
    const get = (name) => (col[name] >= 0 ? unescapeCsvCell(String(r[col[name]] ?? '')) : '');
    const name = get('자격명').trim();
    const hits = byName.get(name) || [];
    if (!name) { errors.push({ row, message: t('lic.csv.noName') }); return; }
    if (hits.length === 0) { errors.push({ row, message: t('lic.csv.unknownName', { name: name.slice(0, 30) }) }); return; }
    if (hits.length > 1) { errors.push({ row, message: t('lic.csv.dupName', { n: hits.length, name: name.slice(0, 30) }) }); return; }
    let c;
    try {
      c = normalizeCredit({
        itemId: hits[0].id,
        date: get('날짜').trim(),
        hours: get('이수시간').trim(),
        course: get('과정명'),
        provider: get('제공기관'),
        category: get('분류'),
        memo: get('메모'),
      });
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      errors.push({ row, message: e.message });
      return;
    }
    const key = keyOf(c);
    if (seen.has(key)) { skipped.push({ row, message: t('lic.csv.skipDup') }); return; }
    if (capacity <= 0) { errors.push({ row, message: t('lic.csv.limit', { n: limit }) }); return; }
    seen.add(key);
    capacity -= 1;
    credits.push(c);
  });
  return { ok: true, fatal: null, total: data.length, credits, errors, skipped };
}

/* ------------------------------------------------------------------ *
 * 입력 정규화 / 검증 (폼 입력과 백업 가져오기에 공통 사용)
 * ------------------------------------------------------------------ */
export class ValidationError extends Error {}

const NUM_RE = /^-?\d+(\.\d+)?$/;

function numField(v, label, { min, max, allowEmpty = false, int = false, decimals = 2 }) {
  if (v === '' || v === null || v === undefined) {
    if (allowEmpty) return null;
    throw new ValidationError(t('v.required', { label }));
  }
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && NUM_RE.test(v.trim())) n = Number(v.trim());
  else throw new ValidationError(t('v.numType', { label }));
  if (!Number.isFinite(n)) throw new ValidationError(t('v.finite', { label }));
  if (n < min || n > max) throw new ValidationError(t('v.range', { label, min, max }));
  if (int && !Number.isInteger(n)) throw new ValidationError(t('v.int', { label }));
  if (Math.round(n * 10 ** decimals) / 10 ** decimals !== n) {
    throw new ValidationError(t('v.decimals', { label, n: decimals }));
  }
  return n;
}

function textField(v, label, max, { required = false } = {}) {
  if (v === null || v === undefined) v = '';
  if (typeof v !== 'string') throw new ValidationError(t('v.textType', { label }));
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && !s) throw new ValidationError(t('v.required', { label }));
  if (s.length > max) throw new ValidationError(t('v.maxLen', { label, max }));
  return s;
}

function dateField(v, label) {
  if (v === null || v === undefined || v === '') return '';
  if (!isDateStr(v)) throw new ValidationError(t('v.date', { label }));
  return v;
}

function idField(v, label = 'ID') {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new ValidationError(t('v.id', { label }));
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
  if (!input || typeof input !== 'object') throw new ValidationError(t('v.item'));
  const L = CONSTANTS.limits;
  const item = {
    id: input.id ? idField(input.id) : newId(),
    name: textField(input.name, t('f.name'), L.name, { required: true }),
    issuer: textField(input.issuer, t('f.issuer'), L.issuer),
    holder: textField(input.holder, t('f.holder'), L.holder),
    number: textField(input.number, t('f.number'), L.number),
    issuedOn: dateField(input.issuedOn, t('f.issuedOn')),
    expiresOn: dateField(input.expiresOn, t('f.expiresOn')),
    cycleYears: numField(input.cycleYears ?? '', t('f.cycleYears'), { min: 0, max: L.cycleYears, allowEmpty: true, int: true }) ?? 0,
    requiredCredits: numField(input.requiredCredits ?? '', t('f.requiredCredits'), { min: 0, max: L.requiredCredits, allowEmpty: true }),
    carryover: numField(input.carryover ?? '', t('f.carryover'), { min: 0, max: L.carryover, allowEmpty: true }) ?? 0,
    notes: textField(input.notes, t('f.notes'), L.notes),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt.slice(0, 40) : new Date().toISOString(),
  };
  if (!item.expiresOn && !(item.issuedOn && item.cycleYears > 0)) {
    throw new ValidationError(t('v.expiryOrCycle'));
  }
  if (item.issuedOn && item.expiresOn && item.issuedOn > item.expiresOn) {
    throw new ValidationError(t('v.expiryBeforeIssue'));
  }
  return item;
}

export function normalizeCredit(input) {
  if (!input || typeof input !== 'object') throw new ValidationError(t('v.credit'));
  const L = CONSTANTS.limits;
  const date = dateField(input.date, t('f.date'));
  if (!date) throw new ValidationError(t('v.dateRequired'));
  return {
    id: input.id ? idField(input.id) : newId(),
    itemId: idField(input.itemId, t('v.itemId')),
    date,
    hours: numField(input.hours, t('f.hours'), { min: 0.01, max: L.hours }),
    course: textField(input.course, t('f.course'), L.course),
    provider: textField(input.provider, t('f.provider'), L.provider),
    category: textField(input.category, t('f.category'), L.category) || t('lic.defaultCategory'),
    memo: textField(input.memo, t('f.certMemo'), L.memo),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt.slice(0, 40) : new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 예시 템플릿 편집 (주기·필요 학점만 사용자가 바꿀 수 있음)
 * 기본값은 CONSTANTS.templates. 사용자가 바꾼 값만 overrides 에 저장하고,
 * 기본값과 같아지면 저장하지 않습니다. 라벨의 "예시" 표기는 항상 유지됩니다.
 * ------------------------------------------------------------------ */
export function templateDefaults() {
  return CONSTANTS.templates.filter((x) => x.id !== 'blank');
}

/** 사용자 수정값 검증. 기본값과 같은 항목은 버리고, 알 수 없는 템플릿 ID 는 거부 */
export function normalizeTemplateOverrides(v) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(t('v.templateObj'));
  const known = new Map(templateDefaults().map((x) => [x.id, x]));
  const out = {};
  for (const id of Object.keys(v)) {
    const base = known.get(id);
    if (!base) throw new ValidationError(t('v.templateUnknown', { id: String(id).slice(0, 20) }));
    const o = v[id];
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ValidationError(t('v.templateShape', { name: base.name }));
    const cycleYears = numField(o.cycleYears ?? base.cycleYears, t('f.tplCycle', { name: base.name }),
      { min: 0, max: CONSTANTS.limits.cycleYears, int: true });
    const rq = 'requiredCredits' in o ? o.requiredCredits : base.requiredCredits;
    const requiredCredits = rq === null || rq === '' ? null
      : numField(rq, t('f.tplRequired', { name: base.name }), { min: 0, max: CONSTANTS.limits.requiredCredits });
    if (cycleYears !== base.cycleYears || requiredCredits !== base.requiredCredits) {
      out[id] = { cycleYears, requiredCredits };
    }
  }
  return out;
}

/** 기본값에 사용자 수정값을 덮어쓴 템플릿 목록. edited 는 수정 여부 */
export function templatesWithOverrides(overrides = {}) {
  return templateDefaults().map((x) => {
    const o = overrides[x.id];
    return {
      id: x.id,
      label: x.label,
      name: x.name,
      issuer: x.issuer,
      note: x.note,
      cycleYears: o ? o.cycleYears : x.cycleYears,
      requiredCredits: o ? o.requiredCredits : x.requiredCredits,
      edited: Boolean(o),
    };
  });
}

/** 한 템플릿의 값을 바꾼 새 overrides 객체를 돌려줌 (검증 포함, 입력 객체는 바꾸지 않음) */
export function setTemplateOverride(overrides, id, values) {
  return normalizeTemplateOverrides({ ...overrides, [id]: values });
}

/** 한 템플릿을 기본값으로 되돌린 새 overrides 객체 */
export function resetTemplateOverride(overrides, id) {
  const next = { ...overrides };
  delete next[id];
  return next;
}

/* ------------------------------------------------------------------ *
 * 백업 (JSON) 생성 / 검증
 * ------------------------------------------------------------------ */
export function buildBackup({ items, credits, leads, templates = {}, now = new Date() }) {
  return {
    app: 'licensetrack',
    schema: CONSTANTS.appVersion,
    exportedAt: now.toISOString(),
    settings: { leads, templates },
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(t('lic.backup.notObj'));
  if (raw.app !== 'licensetrack' || raw.schema !== CONSTANTS.appVersion) {
    return fail(t('lic.backup.notLic'));
  }
  const L = CONSTANTS.limits;
  if (!Array.isArray(raw.items)) return fail(t('lic.backup.noItems'));
  if (!Array.isArray(raw.credits)) return fail(t('lic.backup.noCredits'));
  if (raw.items.length > L.items) return fail(t('lic.backup.maxItems', { n: L.items }));
  if (raw.credits.length > L.credits) return fail(t('lic.backup.maxCredits', { n: L.credits }));

  let leads = CONSTANTS.defaultLeadDays;
  try {
    if (raw.settings && raw.settings.leads !== undefined) leads = normalizeLeads(raw.settings.leads);
  } catch (e) {
    errors.push(t('lic.backup.leads', { e: e.message }));
  }
  let templates = {};
  try {
    if (raw.settings && raw.settings.templates !== undefined) templates = normalizeTemplateOverrides(raw.settings.templates);
  } catch (e) {
    errors.push(t('lic.backup.tpl', { e: e.message }));
  }

  const items = [];
  const ids = new Set();
  raw.items.forEach((it, i) => {
    try {
      const n = normalizeItem(it);
      if (ids.has(n.id)) throw new ValidationError(t('v.dupId'));
      ids.add(n.id);
      items.push(n);
    } catch (e) {
      errors.push(t('lic.backup.item', { i: i + 1, e: e.message }));
    }
  });

  const credits = [];
  raw.credits.forEach((c, i) => {
    try {
      const n = normalizeCredit(c);
      if (!ids.has(n.itemId)) throw new ValidationError(t('v.noItemRef'));
      credits.push(n);
    } catch (e) {
      errors.push(t('lic.backup.credit', { i: i + 1, e: e.message }));
    }
  });

  if (errors.length) return { ok: false, errors: errors.slice(0, 20), data: null };
  return { ok: true, errors: [], data: { items, credits, leads, templates } };
}

/* ------------------------------------------------------------------ *
 * 중복 의심 자격: 이름(공백·대소문자·"(예시)" 표기 무시) 또는 자격 번호(하이픈·공백 무시)가 같으면 의심
 * ------------------------------------------------------------------ */
const EXAMPLE_TAG_RE = /\((예시|example|ejemplo|例|示例)\)/g;

export function normalizeLicenseName(s) {
  return String(s ?? '').normalize('NFC')
    .replace(EXAMPLE_TAG_RE, '')
    .replace(/[\s\-·.,()[\]]/g, '')
    .toLowerCase();
}

export function normalizeLicenseNumber(s) {
  return String(s ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** 두 항목의 중복 이유: 'both' | 'name' | 'number' | null */
export function duplicateReason(a, b) {
  const na = normalizeLicenseName(a.name);
  const sameName = na !== '' && na === normalizeLicenseName(b.name);
  const ca = normalizeLicenseNumber(a.number);
  const sameNumber = ca !== '' && ca === normalizeLicenseNumber(b.number);
  if (sameName && sameNumber) return 'both';
  if (sameNumber) return 'number';
  if (sameName) return 'name';
  return null;
}

/** 후보 항목과 기존 항목(같은 ID 제외)의 중복 의심 목록 */
export function duplicatesFor(candidate, items) {
  const out = [];
  for (const x of items) {
    if (x.id === candidate.id) continue;
    const reason = duplicateReason(candidate, x);
    if (reason) out.push({ item: x, reason });
  }
  return out;
}

/** 전체 목록에서 중복 의심 묶음(서로 연결된 항목끼리 한 묶음). 두 항목 이상만 반환 */
export function findDuplicateGroups(items) {
  const parent = items.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const linked = new Set();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!duplicateReason(items[i], items[j])) continue;
      parent[find(j)] = find(i);
      linked.add(i);
      linked.add(j);
    }
  }
  const byRoot = new Map();
  for (const i of linked) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(i);
  }
  const groups = [];
  for (const members of byRoot.values()) {
    members.sort((a, b) => a - b);
    const rs = new Set();
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const r = duplicateReason(items[members[a]], items[members[b]]);
        if (r) rs.add(r);
      }
    }
    const kinds = rs.has('both') || (rs.has('name') && rs.has('number')) ? ['name', 'number']
      : rs.has('number') ? ['number'] : ['name'];
    groups.push({ ids: members.map((i) => items[i].id), names: members.map((i) => items[i].name), reasons: kinds });
  }
  return groups;
}

/* ------------------------------------------------------------------ *
 * 요약 인쇄용 데이터
 * ------------------------------------------------------------------ */

/**
 * 자격별 증명 요약 (인쇄용). 이번 주기 기간 안의 기록만 줄로 넣습니다.
 * 자격 번호와 메모는 넣지 않습니다 (인쇄물에 남기지 않는 것이 기본).
 */
export function buildCertificates(items, credits, today) {
  return buildDashboard(items, credits, today).rows.map((r) => {
    const c = r.cycle;
    const start = c ? c.start : (r.item.issuedOn || null);
    const end = c ? c.end : (r.expiry || null);
    const lines = credits
      .filter((x) => x.itemId === r.item.id && (!start || x.date >= start) && (!end || x.date <= end))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((x) => ({ date: x.date, hours: x.hours, course: x.course || '-', provider: x.provider || '-', category: x.category || '-' }));
    return {
      name: r.item.name,
      holder: holderOf(r.item),
      issuer: r.item.issuer || '-',
      expiry: r.expiry || '-',
      cycleStart: start || '-',
      cycleEnd: end || '-',
      required: c ? c.required : null,
      carry: c ? c.carry : 0,
      total: c ? c.total : null,
      status: c ? c.status : 'no-req',
      lines,
      lineHours: round2(lines.reduce((s, x) => s + x.hours, 0)),
    };
  });
}
export function buildPrintRows(items, credits, today) {
  return buildDashboard(items, credits, today).rows.map((r) => ({
    name: r.item.name,
    holder: holderOf(r.item),
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

/* ------------------------------------------------------------------ *
 * 자격 현황 CSV (항목별 한 줄). 인쇄용 행(buildPrintRows)과 같은 계산을 씁니다.
 * 수식 주입 방지는 csvCell이 맡고, BOM과 CRLF는 학점 CSV와 같습니다.
 * 머리글은 파일 형식이므로 한국어로 고정합니다.
 * ------------------------------------------------------------------ */
export const STATUS_CSV_HEADER = ['자격명', '보유자', '발급 기관', '만료일', '남은 일수', '상태', '주기 시작', '필요 학점', '이수 학점'];

export function buildStatusCsv(items, credits, today) {
  const rows = buildPrintRows(items, credits, today).map((r) => [
    r.name,
    r.holder || '미지정',
    r.issuer,
    r.expiry === '-' ? '' : r.expiry, // '-'는 수식 중화 대상이 되므로 빈 칸으로 쓴다
    r.daysLeft ?? '',
    r.bucketLabel,
    r.cycleStart === '-' ? '' : r.cycleStart,
    r.required ?? '',
    r.earned ?? '',
  ]);
  return '﻿' + [STATUS_CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
