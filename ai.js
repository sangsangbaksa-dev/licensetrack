// AI 보수교육 계획 도우미: 입력 최소화, 프롬프트, 응답 검증, 로컬 폴백. 네트워크 호출은 app.js 에서 합니다.
// 사용자 문구는 t() 로 가져옵니다. AI 프롬프트는 응답 언어를 현재 언어로 지정합니다.
import { diffDays, addMonths, calendarMonthsInclusive } from './logic.js';
import { t, getLang, LANGS } from './i18n.js';

export const AI_LIMITS = {
  model: 'claude-haiku-5-5',
  maxTokens: 700,
  maxItems: 8,      // AI 에 보내는 항목 수 상한
  maxMonths: 12,    // 이 개월 수를 넘는 마감 항목은 AI 대신 로컬 계획만 사용
  timeoutMs: 30000,
};

const round2 = (x) => Math.round(x * 100) / 100;

/** 오늘이 속한 달부터 마감이 속한 달까지 개월 수 (최소 1). 마감이 지났으면 0 */
export function monthsAvailable(today, end) {
  if (diffDays(end, today) < 0) return 0;
  return Math.max(1, calendarMonthsInclusive(today, end));
}

/** 계획 대상: 남은 학점이 있고 마감이 지나지 않은 항목. 필요 학점이 없으면 제외 */
export function planEligibility(rows, today) {
  const items = [];
  const skipped = [];
  for (const r of rows) {
    const c = r.cycle;
    if (!c || c.remaining == null || c.remaining <= 0) continue;
    if (c.daysLeft < 0) {
      skipped.push({ id: r.item.id, reason: 'expired' });
      continue;
    }
    const months = monthsAvailable(today, c.end);
    items.push({
      internalId: r.item.id,
      key: `A${items.length + 1}`,
      remaining: c.remaining,
      months,
      categories: c.byCategory,
      aiOk: months <= AI_LIMITS.maxMonths,
    });
  }
  return { items, skipped };
}

/** 달력 월 라벨 YYYY-MM 목록 (오늘 달부터 n개월) */
export function monthLabels(today, n) {
  const first = today.slice(0, 7) + '-01';
  return Array.from({ length: n }, (_, i) => addMonths(first, i).slice(0, 7));
}

/**
 * AI 로 보내는 데이터: 익명 기호, 남은 학점, 개월 수, 분류별 이수 학점(숫자).
 * 자격명, 발급기관, 자격번호, 메모, 과정명, 제공기관, 내부 ID 는 보내지 않음.
 */
export function anonymizeForAi(items) {
  const picked = items.filter((x) => x.aiOk).slice(0, AI_LIMITS.maxItems);
  return {
    unit: t('ai.unit'),
    items: picked.map((x) => ({
      id: x.key,
      remaining: x.remaining,
      months: x.months,
      categories: Object.fromEntries(
        Object.entries(x.categories || {})
          .slice(0, 6)
          .map(([k, v]) => [String(k).slice(0, 20), round2(Number(v) || 0)]),
      ),
    })),
  };
}

export function buildPrompt(payload) {
  const language = LANGS[getLang()]?.name ?? 'English';
  return [
    t('ai.prompt.l1'),
    t('ai.prompt.l2'),
    t('ai.prompt.l3'),
    t('ai.prompt.l4', { language }),
    '{"A1":[2,2,2]}',
    t('ai.prompt.input'),
    JSON.stringify(payload),
  ].join('\n');
}

/**
 * AI 응답 검증. 잘못된 항목은 plans 에 넣지 않고 errors 에 이유를 남김.
 * 호출 측은 빠진 항목을 로컬 폴백으로 채운다.
 */
export function parsePlanReply(text, payload) {
  const errors = [];
  const plans = {};
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return { plans, errors: [t('ai.err.noJson')] };
  let obj;
  try {
    obj = JSON.parse(s.slice(a, b + 1));
  } catch {
    return { plans, errors: [t('ai.err.badJson')] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { plans, errors: [t('ai.err.topObj')] };
  }
  const byId = new Map(payload.items.map((x) => [x.id, x]));
  for (const key of Object.keys(obj)) {
    const meta = byId.get(key);
    if (!meta) {
      errors.push(t('ai.err.unknownId', { id: key.slice(0, 10) }));
      continue;
    }
    const arr = obj[key];
    if (!Array.isArray(arr)) { errors.push(t('ai.err.notArray', { key })); continue; }
    if (arr.length !== meta.months) { errors.push(t('ai.err.length', { key, m: meta.months })); continue; }
    if (arr.some((v) => typeof v !== 'number' || !Number.isFinite(v))) { errors.push(t('ai.err.notNumber', { key })); continue; }
    if (arr.some((v) => v < 0 || v > meta.remaining + 0.01)) { errors.push(t('ai.err.range', { key })); continue; }
    const sum = arr.reduce((p, v) => p + v, 0);
    if (Math.abs(sum - meta.remaining) > 0.05) { errors.push(t('ai.err.sum', { key, r: meta.remaining })); continue; }
    plans[key] = arr.map(round2);
  }
  return { plans, errors };
}

/** 누적 반올림(0.5 단위)으로 n개 칸에 나눔. 합계는 정확히 total */
function spread(total, n) {
  const out = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const cum = i === n - 1 ? total : Math.min(total, Math.round((total * (i + 1)) / n * 2) / 2);
    out.push(round2(Math.max(0, cum - prev)));
    prev = cum;
  }
  return out;
}

/** 로컬 폴백: even = 전 기간 균등, front = 앞쪽 절반에 몰아서 */
export function fallbackPlan(item, mode = 'even') {
  const N = Math.max(0, Math.floor(item.months || 0));
  const out = new Array(N).fill(0);
  if (N === 0 || !(item.remaining > 0)) return out;
  const active = mode === 'front' ? Math.ceil(N / 2) : N;
  const seg = spread(round2(item.remaining), active);
  seg.forEach((v, i) => { out[i] = v; });
  return out;
}

/** Anthropic API 키 형식만 확인 (네트워크 확인 아님). 명백한 오입력만 거른다 */
export function isPlausibleAnthropicKey(key) {
  if (typeof key !== 'string') return false;
  return /^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(key.trim());
}
