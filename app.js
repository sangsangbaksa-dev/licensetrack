// licensetrack UI. 사용자 데이터는 전부 textContent 또는 DOM 노드로만 넣습니다 (innerHTML 사용 안 함).
import {
  CONSTANTS, todayStr, buildDashboard, dueReminders, normalizeLeads, normalizeItem, normalizeCredit,
  cycleStatus, deadlinesForItem, effectiveExpiry, BUCKET_LABEL, BUCKET_ORDER, buildIcs, icsDstamp,
  buildBackup, validateBackup, buildCreditsCsv, buildPrintRows, newId, ValidationError,
  templatesWithOverrides, setTemplateOverride, resetTemplateOverride,
  holderOf, holderGroups, holderSummary, yearHeatmap,
  LEAD_PRESETS, leadPresetId, upcomingAlerts, duplicatesFor, findDuplicateGroups,
  importCreditsCsv, CSV_LIMITS, buildCertificates,
} from './logic.js';
import {
  AI_LIMITS, planEligibility, anonymizeForAi, buildPrompt, parsePlanReply, fallbackPlan,
  monthLabels, isPlausibleAnthropicKey,
} from './ai.js';

const DATA_KEY = 'licensetrack-data';
const AI_KEY = 'licensetrack-ai-key';
const NOTIFIED_KEY = 'licensetrack-notified';
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const state = {
  items: [],
  credits: [],
  leads: [...CONSTANTS.defaultLeadDays],
  templates: {},
  creditItemId: null,
  holderFilter: null, // null = 전체, '' = 미지정, 그 밖 = 보유자 이름
  csvPending: null, // 미리보기로 검증된 가져오기 대기 행
  heatYear: new Date().getFullYear(),
  plan: null,
  storageOk: true,
  busy: false,
};

/* ---------- DOM 헬퍼 ---------- */
const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

const fmt = (n) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 });

function ddayText(d) {
  if (d === null || d === undefined) return '만료일 없음';
  if (d < 0) return `만료 ${-d}일 지남`;
  if (d === 0) return '오늘 만료';
  return `D-${d}`;
}

const STATUS = {
  done: ['이수 완료', 's-done', 'is-done'],
  'on-track': ['페이스 순조', 's-on', ''],
  'at-risk': ['현재 페이스로 부족 예상', 's-risk', 'is-risk'],
  overdue: ['기한 지나 미달', 's-over', 'is-over'],
  'no-req': ['학점 기준 없음', 's-none', ''],
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function download(name, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function setError(id, msg) {
  const node = $(id);
  node.textContent = msg || '';
  node.hidden = !msg;
}

/* ---------- 저장소 ---------- */
function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(DATA_KEY);
  } catch {
    state.storageOk = false;
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const v = validateBackup(parsed);
    if (v.ok) {
      state.items = v.data.items;
      state.credits = v.data.credits;
      state.leads = v.data.leads;
      state.templates = v.data.templates;
    } else {
      throw new Error(v.errors[0]);
    }
  } catch {
    // 손상된 데이터는 지우지 않고 별도 키에 보관
    try { localStorage.setItem(`${DATA_KEY}-corrupt`, raw); } catch { /* 무시 */ }
    state.items = [];
    state.credits = [];
    toast('저장된 데이터를 읽지 못해 빈 상태로 시작합니다. 이전 내용은 보관되었습니다.');
  }
}

function saveState() {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(buildBackup({
      items: state.items, credits: state.credits, leads: state.leads, templates: state.templates, now: new Date(),
    })));
    state.storageOk = true;
    return true;
  } catch {
    state.storageOk = false;
    toast('브라우저 저장소에 쓸 수 없습니다. 백업 파일을 저장해 두세요.');
    return false;
  }
}

function getAiKey() {
  try { return localStorage.getItem(AI_KEY) || ''; } catch { return ''; }
}

/* ---------- 탭 ---------- */
const TABS = ['dashboard', 'items', 'credits', 'alerts', 'backup', 'ai'];

function activateTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) return;
  for (const t of document.querySelectorAll('[role="tab"]')) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  }
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${name}`;
  if (name === 'alerts') renderAlerts();
  if (name === 'credits') renderCredits();
  if (name === 'items') renderItemAdmin();
  if (name === 'backup') renderPrint();
  if (name === 'ai') renderAiKeyStatus();
  if (name === 'dashboard') renderDashboard();
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => activateTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = tabs.length - 1;
      if (j !== null) {
        e.preventDefault();
        activateTab(tabs[j].dataset.tab, { focus: true });
      }
    });
  });
  document.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => activateTab(b.dataset.goto));
  });
}

/* ---------- 대시보드 ---------- */
function renderHolderControls() {
  const groups = holderGroups(state.items);
  const hasHolders = groups.some((g) => g.holder !== '');
  $('#holder-bar').hidden = !hasHolders;
  $('#holder-summary').hidden = !hasHolders;
  if (state.holderFilter !== null && !groups.some((g) => g.holder === state.holderFilter)) state.holderFilter = null;
  const sel = $('#holder-filter');
  sel.replaceChildren(
    el('option', { value: 'all', text: `전체 (${state.items.length}개)` }),
    ...groups.map((g) => el('option', { value: `h:${g.holder}`, text: `${g.label} (${g.count}개)` })));
  sel.value = state.holderFilter === null ? 'all' : `h:${state.holderFilter}`;
  $('#holder-list').replaceChildren(...groups.filter((g) => g.holder !== '').map((g) => el('option', { value: g.holder })));
}

function renderHolderSummary(rows) {
  const list = $('#holder-summary');
  list.replaceChildren(...holderSummary(rows).map((s) => el('li', {},
    el('button', {
      class: 'holder-card',
      type: 'button',
      'aria-pressed': state.holderFilter === s.holder ? 'true' : 'false',
      onclick: () => { state.holderFilter = s.holder; renderDashboard(); },
    },
    el('strong', { text: s.label }),
    el('span', { class: 'meta', text: `자격 ${s.total}개 · 만료 ${s.expired} · 30일 이내 ${s.d30} · 90일 이내 ${s.d90}${s.atRisk ? ` · 기준 미달 예상 ${s.atRisk}` : ''}` }),
    el('span', { class: 'meta', text: s.next ? `다음 마감 ${s.next.date} · ${s.next.name}` : '오늘 이후 마감 없음' })))));
}

function renderDashboard() {
  const today = todayStr();
  renderHolderControls();
  const full = buildDashboard(state.items, state.credits, today);
  const dash = state.holderFilter === null
    ? full
    : buildDashboard(state.items.filter((i) => holderOf(i) === state.holderFilter), state.credits, today);
  renderHolderSummary(full.rows);
  $('#today-label').textContent = `오늘 ${today} 기준으로 계산합니다.`;

  $('#counts').replaceChildren(...BUCKET_ORDER.map((b) =>
    el('li', {}, el('span', { class: `badge b-${b}`, text: BUCKET_LABEL[b] }), el('strong', { text: String(dash.counts[b]) }))));

  const banner = $('#alert-banner');
  const due = dueReminders(dash.rows, state.leads);
  if (due.length) {
    banner.hidden = false;
    banner.className = 'alert' + (due.some((d) => d.expired) ? ' alert-danger' : '');
    banner.replaceChildren(
      el('strong', { text: `알림 기간 안에 든 항목이 ${due.length}개 있습니다.` }),
      el('ul', {}, due.map((d) => el('li', {
        text: d.expired
          ? `${d.name}: 만료일이 ${-d.daysLeft}일 지났습니다.`
          : `${d.name}: ${d.daysLeft === 0 ? '오늘 만료' : `${d.daysLeft}일 남음`}${d.lead ? ` (${d.lead}일 전 알림 구간)` : ''}`,
      }))),
    );
    notifyDue(due);
  } else {
    banner.hidden = true;
    banner.replaceChildren();
  }

  $('#item-list').replaceChildren(...dash.rows.map(renderItemCard));
  $('#empty-dashboard').hidden = dash.rows.length > 0;

  const tl = dash.timeline;
  $('#timeline').replaceChildren(...tl.map((t) => el('li', {},
    el('time', { datetime: t.date, text: t.date }),
    el('span', { text: t.name }),
    el('span', { class: 'dday', text: ddayText(t.daysLeft) }))));
  $('#timeline-empty').hidden = tl.length > 0;
  renderHeatmap();
}

function renderItemCard(row) {
  const { item, expiry, daysLeft, bucket, cycle } = row;
  const facts = [
    ['만료일', expiry || '-'],
    ['남은 기간', ddayText(daysLeft)],
  ];
  if (cycle && cycle.years) facts.push(['주기 기간', `${cycle.start} ~ ${cycle.end}`, true]);
  if (cycle && cycle.required !== null) {
    facts.push(['이수 / 필요', `${fmt(cycle.total)} / ${fmt(cycle.required)}${cycle.carry ? ` (이월 ${fmt(cycle.carry)} 포함)` : ''}`]);
  }
  if (cycle && cycle.remaining > 0 && cycle.neededPerMonth !== null) {
    facts.push(['남은 기간 월 필요량', `${fmt(cycle.neededPerMonth)} 학점/개월`]);
  }
  if (cycle && cycle.projectedShortfall > 0) facts.push(['예상 부족 (현재 페이스)', `${fmt(cycle.projectedShortfall)}`, true]);

  const st = cycle ? STATUS[cycle.status] : null;
  const hasProgress = cycle && cycle.required !== null;
  const progress = hasProgress
    ? el('div', {},
      el('div', {
        class: `progress ${st[2]}`,
        role: 'progressbar',
        'aria-label': `${item.name} 이수 진행률`,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.round(cycle.percent)),
      }, el('span', { style: `width:${cycle.percent}%` })),
      el('div', { class: 'progress-label' },
        el('span', { class: `status-tag ${st[1]}`, text: st[0] }),
        el('span', { text: `${Math.round(cycle.percent)}%` })))
    : null;

  return el('article', { class: 'card item-card' },
    el('div', { class: 'item-head' },
      el('div', { style: 'min-width:0' },
        el('h3', { text: item.name }),
        el('p', { text: [holderOf(item), item.issuer, item.cycleYears ? `${item.cycleYears}년 주기` : ''].filter(Boolean).join(' · ') || '발급 기관 미입력' })),
      el('span', { class: `badge b-${bucket}`, text: BUCKET_LABEL[bucket] })),
    el('dl', { class: 'facts' }, facts.map(([k, v, wide]) =>
      el('div', { class: wide ? 'wide' : '' }, el('dt', { text: k }), el('dd', { text: v })))),
    progress,
    el('div', { class: 'item-actions' },
      el('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => openCreditsFor(item.id), text: '학점 기록' }),
      el('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => startEditItem(item.id), text: '수정' })),
  );
}

/* ---------- 연간 달력 (SVG) ---------- */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const c of kids.flat()) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

function renderHeatmap() {
  const today = todayStr();
  const year = state.heatYear;
  const hm = yearHeatmap({ year, items: state.items, credits: state.credits, today });
  $('#heat-year').textContent = `${year}년`;
  $('#heat-summary').textContent = hm.creditDays
    ? `${year}년 이수 기록 ${hm.creditDays}일, 합계 ${fmt(hm.totalHours)}시간 · 마감 ${hm.deadlines.length}건`
    : `${year}년에 기록된 학점이 없습니다. 마감 ${hm.deadlines.length}건.`;

  const pad = 34, top = 20, pitch = 15, size = 12;
  const W = pad + hm.cols * pitch, H = top + 7 * pitch;
  const svg = svgNode('svg', {
    class: 'heat-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': `${year}년 달력. 학점 기록과 마감일은 아래 목록에도 있습니다.`,
  });
  for (const m of hm.monthMarks) {
    svg.append(svgNode('text', { x: pad + m.col * pitch, y: 12, class: 'heat-month' }, `${m.month}월`));
  }
  [[1, '월'], [3, '수'], [5, '금']].forEach(([r, t]) => {
    svg.append(svgNode('text', { x: 0, y: top + r * pitch + size - 2, class: 'heat-wd' }, t));
  });
  for (const d of hm.days) {
    const x = pad + d.col * pitch;
    const y = top + d.row * pitch;
    const label = `${d.date}: ${d.hours ? `학점 ${fmt(d.hours)}시간` : '기록 없음'}${d.deadlines.length ? ` · 마감 ${d.deadlines.map((x2) => x2.name).join(', ')}` : ''}`;
    const cls = `heat-cell h${d.level}${d.isToday ? ' is-today' : ''}`;
    svg.append(svgNode('rect', { x, y, width: size, height: size, rx: 2, class: cls }, svgNode('title', {}, label)));
    if (d.deadlines.length) {
      svg.append(svgNode('circle', { cx: x + size / 2, cy: y + size / 2, r: 2.6, class: 'heat-dot', 'pointer-events': 'none' }));
    }
  }
  const scroll = $('#heat-wrap');
  scroll.replaceChildren(svg);

  const dl = hm.deadlines;
  $('#heat-dl-list').replaceChildren(...dl.map((d) => el('li', {},
    el('time', { datetime: d.date, text: d.date }),
    el('span', { text: d.name }))));
  $('#heat-dl-empty').hidden = dl.length > 0;
}

function notifyDue(due) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}') || {}; } catch { seen = {}; }
    const ids = new Set(state.items.map((i) => i.id));
    let changed = false;
    for (const k of Object.keys(seen)) {
      if (!ids.has(k.split(':')[0])) { delete seen[k]; changed = true; }
    }
    for (const d of due) {
      const key = `${d.id}:${d.lead ?? 'x'}`;
      if (seen[key]) continue;
      seen[key] = todayStr();
      changed = true;
      try {
        new Notification('licensetrack 마감 알림', {
          body: d.expired ? `${d.name}: 만료일이 지났습니다.` : `${d.name}: ${d.daysLeft}일 남았습니다.`,
          tag: key,
        });
      } catch { /* 일부 모바일 브라우저는 생성자 호출을 막음 */ }
    }
    if (changed) localStorage.setItem(NOTIFIED_KEY, JSON.stringify(seen));
  } catch { /* 알림은 부가 기능 */ }
}

/* ---------- 자격 관리 ---------- */
function effectiveTemplates() {
  return templatesWithOverrides(state.templates);
}

function renderTemplateOptions() {
  const sel = $('#tpl');
  const keep = sel.value || 'blank';
  sel.replaceChildren(
    el('option', { value: 'blank', text: '직접 입력' }),
    ...effectiveTemplates().map((t) => el('option', { value: t.id, text: `${t.label}${t.edited ? ' (수정됨)' : ''}` })));
  sel.value = keep;
}

function renderTemplateEditor() {
  $('#tpl-list').replaceChildren(...effectiveTemplates().map((t) => {
    const cy = `tpl-cy-${t.id}`;
    const rq = `tpl-rq-${t.id}`;
    return el('li', { class: 'tpl-row' },
      el('div', { class: 'tpl-head' },
        el('strong', { text: t.name }),
        el('span', { class: 'badge b-d90', text: '예시 · 확인 필요' }),
        t.edited ? el('span', { class: 'badge b-none', text: '사용자 수정값' }) : null),
      el('p', { class: 'meta', text: `기본 예시: ${t.cycleYears}년 주기 · ${t.requiredCredits === null ? '기준 없음' : `${t.requiredCredits}시간`}` }),
      el('div', { class: 'grid-2' },
        el('div', { class: 'field' },
          el('label', { for: cy, text: '갱신 주기 (년, 0이면 없음)' }),
          el('input', { id: cy, type: 'number', min: '0', max: String(CONSTANTS.limits.cycleYears), step: '1', inputmode: 'numeric', value: String(t.cycleYears) })),
        el('div', { class: 'field' },
          el('label', { for: rq, text: '주기당 필요 학점·시간 (빈 칸이면 기준 없음)' }),
          el('input', { id: rq, type: 'text', inputmode: 'decimal', value: t.requiredCredits === null ? '' : String(t.requiredCredits) }))),
      el('p', { class: 'form-error', id: `tpl-err-${t.id}`, role: 'alert', hidden: true }),
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-save': t.id, text: '이 값 저장' }),
        t.edited ? el('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-reset': t.id, text: '기본값으로' }) : null));
  }));
}

function onTemplateEditClick(e) {
  const btn = e.target.closest('button[data-save], button[data-reset]');
  if (!btn) return;
  const resetId = btn.dataset.reset;
  const id = resetId || btn.dataset.save;
  const errNode = $(`#tpl-err-${id}`);
  try {
    if (resetId) {
      state.templates = resetTemplateOverride(state.templates, id);
    } else {
      state.templates = setTemplateOverride(state.templates, id, {
        cycleYears: $(`#tpl-cy-${id}`).value,
        requiredCredits: $(`#tpl-rq-${id}`).value.trim(),
      });
    }
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    errNode.textContent = err.message;
    errNode.hidden = false;
    return;
  }
  saveState();
  renderTemplateOptions();
  renderTemplateEditor();
  toast(resetId ? '기본 예시 값으로 되돌렸습니다.' : '예시 값을 저장했습니다. 기관 기준으로 확인하세요.');
}

function setupTemplates() {
  renderTemplateOptions();
  renderTemplateEditor();
  $('#tpl-list').addEventListener('click', onTemplateEditClick);
  $('#tpl').addEventListener('change', () => {
    const t = effectiveTemplates().find((x) => x.id === $('#tpl').value);
    if (!t) return;
    $('#f-name').value = t.name;
    $('#f-issuer').value = t.issuer;
    $('#f-cycle').value = String(t.cycleYears);
    $('#f-required').value = t.requiredCredits === null ? '' : String(t.requiredCredits);
    $('#f-notes').value = t.note;
    toast('예시 값을 채웠습니다. 기관 기준에 맞게 고쳐 주세요.');
  });
}

function readItemForm() {
  const v = (id) => $(id).value;
  return {
    id: $('#item-id').value || undefined,
    name: v('#f-name'),
    issuer: v('#f-issuer'),
    holder: v('#f-holder'),
    number: v('#f-number'),
    issuedOn: v('#f-issued'),
    expiresOn: v('#f-expires'),
    cycleYears: v('#f-cycle'),
    requiredCredits: v('#f-required'),
    carryover: v('#f-carry'),
    notes: v('#f-notes'),
  };
}

function resetItemForm() {
  $('#item-form').reset();
  $('#item-id').value = '';
  $('#tpl').value = 'blank';
  $('#item-form-title').textContent = '새 자격 추가';
  $('#item-save').textContent = '저장';
  $('#item-cancel').hidden = true;
  setError('#item-error', '');
}

function startEditItem(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  activateTab('items');
  $('#item-id').value = it.id;
  $('#f-name').value = it.name;
  $('#f-issuer').value = it.issuer;
  $('#f-holder').value = it.holder;
  $('#f-number').value = it.number;
  $('#f-issued').value = it.issuedOn;
  $('#f-expires').value = it.expiresOn;
  $('#f-cycle').value = it.cycleYears ? String(it.cycleYears) : '';
  $('#f-required').value = it.requiredCredits === null ? '' : String(it.requiredCredits);
  $('#f-carry').value = it.carryover ? String(it.carryover) : '';
  $('#f-notes').value = it.notes;
  $('#item-form-title').textContent = `자격 수정: ${it.name}`;
  $('#item-save').textContent = '수정 저장';
  $('#item-cancel').hidden = false;
  $('#f-name').focus();
  $('#item-form').scrollIntoView({ block: 'start' });
}

const REASON_LABEL = { name: '이름', number: '자격 번호' };

function renderDuplicateBanner() {
  const groups = findDuplicateGroups(state.items);
  const b = $('#dup-banner');
  b.hidden = groups.length === 0;
  b.replaceChildren(...(groups.length ? [
    el('strong', { text: `중복 의심 자격 ${groups.length}묶음` }),
    el('ul', { class: 'bullets' }, groups.map((g) => el('li', {
      text: `${g.names.join(' / ')} (${g.reasons.map((r) => REASON_LABEL[r]).join(', ')} 같음). 같은 자격이면 하나만 남기세요.`,
    }))),
  ] : []));
}

function renderItemAdmin() {
  renderDuplicateBanner();
  const list = $('#item-admin');
  if (!state.items.length) {
    list.replaceChildren(el('li', { class: 'muted', text: '등록된 자격이 없습니다.' }));
    return;
  }
  list.replaceChildren(...state.items.map((it) => {
    const n = state.credits.filter((c) => c.itemId === it.id).length;
    const exp = effectiveExpiry(it) || '만료일 없음';
    const meta = [holderOf(it) ? `보유 ${holderOf(it)}` : null, `만료 ${exp}`, it.cycleYears ? `${it.cycleYears}년 주기` : null, it.requiredCredits !== null ? `필요 ${fmt(it.requiredCredits)}` : null, `기록 ${n}건`]
      .filter(Boolean).join(' · ');
    return el('li', {},
      el('div', { class: 'main' }, el('strong', { text: it.name }), el('p', { class: 'meta', text: meta })),
      el('div', { class: 'item-actions' },
        el('button', { class: 'btn btn-secondary btn-small', type: 'button', text: '수정', onclick: () => startEditItem(it.id) }),
        el('button', { class: 'btn btn-danger btn-small', type: 'button', text: '삭제', onclick: () => deleteItem(it.id) })));
  }));
}

function deleteItem(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  const n = state.credits.filter((c) => c.itemId === id).length;
  if (!confirm(`'${it.name}' 항목과 학점 기록 ${n}건을 삭제할까요?`)) return;
  state.items = state.items.filter((x) => x.id !== id);
  state.credits = state.credits.filter((c) => c.itemId !== id);
  if (state.creditItemId === id) state.creditItemId = null;
  saveState();
  resetItemForm();
  renderItemAdmin();
  renderDashboard();
  toast('삭제했습니다.');
}

function onItemSubmit(e) {
  e.preventDefault();
  setError('#item-error', '');
  try {
    const existingId = $('#item-id').value;
    const existing = existingId ? state.items.find((x) => x.id === existingId) : null;
    if (!existing && state.items.length >= CONSTANTS.limits.items) {
      throw new ValidationError(`자격 항목은 최대 ${CONSTANTS.limits.items}개입니다.`);
    }
    const input = readItemForm();
    if (existing) input.createdAt = existing.createdAt;
    const item = normalizeItem(input);
    const dups = duplicatesFor(item, state.items);
    if (dups.length && !confirm(`비슷한 자격이 이미 있습니다: ${dups.map((d) => d.item.name).join(', ')}. 그래도 저장할까요?`)) {
      return;
    }
    if (existing) {
      state.items = state.items.map((x) => (x.id === item.id ? item : x));
    } else {
      state.items = [...state.items, item];
    }
    saveState();
    resetItemForm();
    renderItemAdmin();
    renderDashboard();
    toast(existing ? '수정했습니다.' : '자격을 추가했습니다.');
  } catch (err) {
    if (err instanceof ValidationError) setError('#item-error', err.message);
    else throw err;
  }
}

/* ---------- 학점 기록 ---------- */
function openCreditsFor(itemId) {
  state.creditItemId = itemId;
  activateTab('credits');
}

function renderCreditSelect() {
  const sel = $('#credit-item');
  if (!state.items.some((i) => i.id === state.creditItemId)) {
    state.creditItemId = state.items[0]?.id ?? null;
  }
  sel.replaceChildren(...state.items.map((it) => el('option', { value: it.id, text: it.name })));
  if (state.creditItemId) sel.value = state.creditItemId;
}

function renderCredits() {
  renderCreditSelect();
  const hasItems = state.items.length > 0;
  $('#credit-form').hidden = !hasItems;
  if (!hasItems) {
    $('#cycle-info').replaceChildren(el('p', { text: '먼저 자격 관리에서 자격을 등록하세요.' }));
    $('#credit-list').replaceChildren();
    $('#credit-empty').hidden = true;
    return;
  }
  if (!$('#c-date').value) $('#c-date').value = todayStr();
  const it = state.items.find((x) => x.id === state.creditItemId);
  const cyc = cycleStatus(it, state.credits, todayStr());
  const info = $('#cycle-info');
  if (!cyc) {
    info.replaceChildren(
      el('h3', { text: it.name }),
      el('p', { class: 'muted', text: '만료일 또는 발급일과 갱신 주기를 입력하면 주기 기간을 계산합니다.' }));
  } else {
    const st = STATUS[cyc.status];
    const rows = [];
    rows.push(el('p', {}, el('strong', { text: '주기 기간: ' }), `${cyc.start ?? '시작일 미정'} ~ ${cyc.end}`));
    if (cyc.required !== null) {
      rows.push(el('p', {}, el('strong', { text: '이수 / 필요: ' }), `${fmt(cyc.total)} / ${fmt(cyc.required)}`,
        cyc.carry ? ` (이월 ${fmt(cyc.carry)} 포함)` : ''));
      rows.push(el('div', { class: `progress ${st[2]}`, role: 'progressbar', 'aria-label': '이수 진행률', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(cyc.percent)) },
        el('span', { style: `width:${cyc.percent}%` })));
      rows.push(el('p', { class: `status-tag ${st[1]}`, text: `${st[0]}${cyc.neededPerMonth && cyc.remaining > 0 ? ` · 남은 기간 월 ${fmt(cyc.neededPerMonth)} 학점 필요` : ''}` }));
      if (cyc.projectedShortfall > 0) rows.push(el('p', { class: 'muted', text: `현재 월 페이스 ${fmt(cyc.pace)} 기준 예상 합계 ${fmt(cyc.projectedTotal)}, 예상 부족 ${fmt(cyc.projectedShortfall)}` }));
    }
    const cats = Object.entries(cyc.byCategory);
    if (cats.length) rows.push(el('p', { class: 'muted', text: `분류별: ${cats.map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}` }));
    if (cyc.priorEarned) rows.push(el('p', { class: 'muted small', text: `이전 주기 기록 ${fmt(cyc.priorEarned)}은(는) 이번 주기 합계에서 제외했습니다.` }));
    if (cyc.nextEarned) rows.push(el('p', { class: 'muted small', text: `다음 주기 기록 ${fmt(cyc.nextEarned)}은(는) 이번 합계에서 제외했습니다.` }));
    info.replaceChildren(el('h3', { text: it.name }), ...rows);
  }

  const list = state.credits
    .filter((c) => c.itemId === it.id)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  $('#credit-empty').hidden = list.length > 0;
  $('#credit-list').replaceChildren(...list.map((c) => {
    const tag = !cyc ? null
      : c.date < (cyc.start || '0000-00-00') ? '이전 주기'
        : c.date > cyc.end ? '다음 주기' : null;
    const meta = [c.course, c.provider, c.category].filter(Boolean).join(' · ');
    return el('li', {},
      el('div', { class: 'main' },
        el('strong', {}, `${c.date} · ${fmt(c.hours)}시간`, tag ? ` · ${tag}` : ''),
        el('p', { class: 'meta', text: meta || '과정명 미입력' }),
        c.memo ? el('p', { class: 'meta', text: `메모: ${c.memo}` }) : null),
      el('button', { class: 'btn btn-danger btn-small', type: 'button', text: '삭제', onclick: () => deleteCredit(c.id) }));
  }));
}

function onCreditSubmit(e) {
  e.preventDefault();
  setError('#credit-error', '');
  try {
    const itemId = $('#credit-item').value;
    if (!state.items.some((i) => i.id === itemId)) throw new ValidationError('자격을 먼저 선택하세요.');
    if (state.credits.length >= CONSTANTS.limits.credits) {
      throw new ValidationError(`학점 기록은 최대 ${CONSTANTS.limits.credits}건입니다.`);
    }
    const c = normalizeCredit({
      itemId,
      date: $('#c-date').value,
      hours: $('#c-hours').value,
      course: $('#c-course').value,
      provider: $('#c-provider').value,
      category: $('#c-category').value,
      memo: $('#c-memo').value,
    });
    state.credits = [...state.credits, c];
    state.creditItemId = itemId;
    saveState();
    $('#c-hours').value = '';
    $('#c-course').value = '';
    $('#c-memo').value = '';
    renderCredits();
    renderDashboard();
    toast('이수 기록을 추가했습니다.');
  } catch (err) {
    if (err instanceof ValidationError) setError('#credit-error', err.message);
    else throw err;
  }
}

function deleteCredit(id) {
  if (!confirm('이 학점 기록을 삭제할까요?')) return;
  state.credits = state.credits.filter((c) => c.id !== id);
  saveState();
  renderCredits();
  renderDashboard();
  toast('기록을 삭제했습니다.');
}

/* ---------- 알림·달력 ---------- */
function renderAlerts() {
  $('#leads').value = state.leads.join(', ');
  const pid = leadPresetId(state.leads);
  for (const b of document.querySelectorAll('[data-preset]')) {
    b.setAttribute('aria-pressed', b.dataset.preset === pid ? 'true' : 'false');
  }
  $('#preset-status').textContent = pid
    ? `현재 프리셋: ${LEAD_PRESETS.find((p) => p.id === pid).label}`
    : `직접 설정: ${state.leads.join(', ')}일 전`;
  const today = todayStr();
  const up = upcomingAlerts(buildDashboard(state.items, state.credits, today).rows, state.leads, today);
  $('#upcoming').replaceChildren(...up.map((u) => el('li', {},
    el('time', { datetime: u.alertOn, text: u.alertOn }),
    el('span', { text: `${u.name} · ${u.lead}일 전 (마감 ${u.deadline})` }))));
  $('#upcoming-empty').hidden = up.length > 0;
  const ns = $('#notify-status');
  const btn = $('#notify-btn');
  if (!('Notification' in window)) {
    ns.textContent = '이 브라우저는 알림을 지원하지 않습니다. 달력 파일을 사용하세요.';
    btn.disabled = true;
    return;
  }
  const p = Notification.permission;
  btn.disabled = p !== 'default';
  ns.textContent = p === 'granted' ? '알림이 허용되어 있습니다. 앱을 열면 알림 기간 안의 항목을 알려 드립니다.'
    : p === 'denied' ? '브라우저 설정에서 알림이 차단되어 있습니다. 설정에서 허용해 주세요.'
      : '아직 허용하지 않았습니다.';
}

function applyLeads(leads, message) {
  state.leads = leads;
  saveState();
  renderAlerts();
  renderDashboard();
  toast(message);
}

function onPresetClick(e) {
  const btn = e.target.closest('[data-preset]');
  if (!btn) return;
  const preset = LEAD_PRESETS.find((p) => p.id === btn.dataset.preset);
  if (!preset) return;
  setError('#lead-error', '');
  applyLeads(normalizeLeads(preset.leads), `${preset.label} 프리셋을 저장했습니다.`);
}

function onLeadSubmit(e) {
  e.preventDefault();
  setError('#lead-error', '');
  const raw = $('#leads').value.trim();
  const parts = raw === '' ? [] : raw.split(/[,\s]+/).filter(Boolean);
  try {
    const nums = parts.map((p) => {
      if (!/^\d{1,4}$/.test(p)) throw new Error(`'${p.slice(0, 10)}'은(는) 숫자가 아닙니다.`);
      return Number(p);
    });
    state.leads = normalizeLeads(nums);
    saveState();
    renderAlerts();
    renderDashboard();
    toast('알림 기간을 저장했습니다.');
  } catch (err) {
    setError('#lead-error', err.message);
  }
}

function onIcsClick() {
  const today = todayStr();
  const ics = buildIcs({ items: state.items, leads: state.leads, today, dtstamp: icsDstamp(new Date()) });
  const count = state.items.reduce((n, it) => n + deadlinesForItem(it, today).length, 0);
  if (count === 0) {
    toast('오늘 이후 마감일이 있는 항목이 없어 파일을 만들지 않았습니다.');
    return;
  }
  download(`licensetrack-${today}.ics`, 'text/calendar;charset=utf-8', ics);
  toast(`마감 ${count}건이 담긴 달력 파일을 받았습니다.`);
}

async function onNotifyClick() {
  if (!('Notification' in window)) return;
  try {
    await Notification.requestPermission();
  } catch { /* 무시 */ }
  renderAlerts();
  renderDashboard();
}

/* ---------- 백업·인쇄 ---------- */
function onBackupClick() {
  const data = buildBackup({ items: state.items, credits: state.credits, leads: state.leads, now: new Date() });
  download(`licensetrack-backup-${todayStr()}.json`, 'application/json;charset=utf-8', JSON.stringify(data, null, 2));
}

function onCsvClick() {
  if (!state.credits.length) {
    toast('저장할 학점 기록이 없습니다.');
    return;
  }
  download(`licensetrack-credits-${todayStr()}.csv`, 'text/csv;charset=utf-8', buildCreditsCsv(state.items, state.credits));
}

function resetCsvImport() {
  state.csvPending = null;
  $('#csv-result').replaceChildren();
  $('#csv-commit').hidden = true;
}

async function onCsvFileChange(e) {
  resetCsvImport();
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const box = $('#csv-result');
  const fail = (msg) => {
    box.replaceChildren(el('p', { class: 'form-error', text: msg }));
    e.target.value = '';
  };
  if (file.size > CSV_LIMITS.maxBytes) { fail('파일이 1MB보다 큽니다.'); return; }
  if (!state.items.length) { fail('먼저 자격을 등록하세요. 자격명이 맞아야 기록을 넣을 수 있습니다.'); return; }
  let text;
  try {
    text = await file.text();
  } catch {
    fail('파일을 읽을 수 없습니다.');
    return;
  }
  const r = importCreditsCsv(text, { items: state.items, existing: state.credits });
  if (!r.ok) { fail(r.fatal); return; }
  state.csvPending = r.credits;
  const shown = r.errors.slice(0, 100);
  box.replaceChildren(
    el('p', { text: `${r.total}행을 읽었습니다. 가져올 수 있는 행 ${r.credits.length}개, 오류 ${r.errors.length}개, 같은 기록이 있어 건너뜀 ${r.skipped.length}개.` }),
    r.errors.length ? el('details', { class: 'csv-errors' },
      el('summary', { text: `오류 행 보기 (${r.errors.length}개)` }),
      el('ul', { class: 'bullets' }, shown.map((x) => el('li', { text: `${x.row}행: ${x.message}` }))),
      r.errors.length > shown.length ? el('p', { class: 'muted small', text: `${r.errors.length - shown.length}개는 생략했습니다.` }) : null) : null);
  const commit = $('#csv-commit');
  commit.textContent = `정상 ${r.credits.length}행 가져오기`;
  commit.hidden = r.credits.length === 0;
}

function onCsvCommit() {
  const add = state.csvPending || [];
  if (!add.length) return;
  state.credits = [...state.credits, ...add];
  saveState();
  const n = add.length;
  resetCsvImport();
  $('#csv-file').value = '';
  $('#csv-result').replaceChildren(el('p', { text: `${n}건을 가져왔습니다.` }));
  renderCredits();
  renderDashboard();
  toast(`학점 기록 ${n}건을 가져왔습니다.`);
}

async function onImportChange(e) {
  const file = e.target.files && e.target.files[0];
  const msg = $('#import-msg');
  msg.replaceChildren();
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    msg.append(el('p', { class: 'form-error', text: '파일이 2MB보다 큽니다. licensetrack 백업 파일인지 확인하세요.' }));
    e.target.value = '';
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    msg.append(el('p', { class: 'form-error', text: 'JSON 형식을 읽을 수 없습니다.' }));
    e.target.value = '';
    return;
  }
  const v = validateBackup(parsed);
  if (!v.ok) {
    msg.append(el('p', { class: 'form-error', text: '가져올 수 없는 파일입니다. 현재 데이터는 바뀌지 않았습니다.' }),
      el('ul', { class: 'bullets' }, v.errors.map((x) => el('li', { text: x }))));
    e.target.value = '';
    return;
  }
  if (!confirm(`현재 데이터를 모두 지우고 자격 ${v.data.items.length}개, 학점 기록 ${v.data.credits.length}건으로 바꿉니다. 계속할까요?`)) {
    e.target.value = '';
    return;
  }
  state.items = v.data.items;
  state.credits = v.data.credits;
  state.leads = v.data.leads;
  state.templates = v.data.templates;
  state.creditItemId = null;
  saveState();
  e.target.value = '';
  msg.append(el('p', { text: `불러왔습니다: 자격 ${v.data.items.length}개, 학점 기록 ${v.data.credits.length}건.` }));
  renderTemplateOptions();
  renderTemplateEditor();
  renderItemAdmin();
  renderDashboard();
  renderPrint();
}

function renderCertificates(today) {
  const certs = buildCertificates(state.items, state.credits, today);
  $('#cert-list').replaceChildren(...certs.map((c) => el('article', { class: 'cert' },
    el('h3', { text: c.holder ? `${c.name} (${c.holder})` : c.name }),
    el('p', { class: 'cert-meta', text: `발급 기관 ${c.issuer} · 주기 ${c.cycleStart} ~ ${c.cycleEnd} · 만료 ${c.expiry}` }),
    el('p', { class: 'cert-meta', text: `필요 ${c.required === null ? '기준 없음' : fmt(c.required)} · 이월 ${fmt(c.carry)} · 이수 합계 ${c.total === null ? '-' : fmt(c.total)} · ${STATUS[c.status] ? STATUS[c.status][0] : '-'}` }),
    c.lines.length
      ? el('table', {},
        el('thead', {}, el('tr', {}, ['이수일', '과정명', '제공 기관', '분류', '시간'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, c.lines.map((l) => el('tr', {},
          el('td', { text: l.date }), el('td', { text: l.course }), el('td', { text: l.provider }),
          el('td', { text: l.category }), el('td', { class: 'num', text: fmt(l.hours) })))))
      : el('p', { class: 'muted small', text: '이번 주기 안의 이수 기록이 없습니다.' }),
    c.lines.length ? el('p', { class: 'cert-meta', text: `기록 합계 ${fmt(c.lineHours)}시간` }) : null)));
}

function renderPrint() {
  const today = todayStr();
  $('#print-meta').textContent = `기준일 ${today} · 학점은 주기 기간 안의 기록만 합산`;
  renderCertificates(today);
  const rows = buildPrintRows(state.items, state.credits, today);
  $('#print-body').replaceChildren(...(rows.length ? rows : [null]).map((r) => {
    if (!r) return el('tr', {}, el('td', { colspan: '8', text: '등록된 자격이 없습니다.' }));
    const st = STATUS[r.status];
    return el('tr', {},
      el('td', { text: r.holder ? `${r.name} (${r.holder})` : r.name }),
      el('td', { text: r.issuer || '-' }),
      el('td', { text: r.expiry }),
      el('td', { text: r.daysLeft === null ? '-' : ddayText(r.daysLeft) }),
      el('td', { text: r.cycleStart }),
      el('td', { class: 'num', text: r.required === null ? '-' : fmt(r.required) }),
      el('td', { class: 'num', text: r.earned === null ? '-' : fmt(r.earned) }),
      el('td', { text: st ? st[0] : '-' }));
  }));
}

function onResetClick() {
  if (!confirm('이 브라우저에 저장된 모든 자격과 학점 기록을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
  state.items = [];
  state.credits = [];
  state.leads = [...CONSTANTS.defaultLeadDays];
  state.templates = {};
  state.creditItemId = null;
  try { localStorage.removeItem(DATA_KEY); } catch { /* 무시 */ }
  renderTemplateOptions();
  renderTemplateEditor();
  resetItemForm();
  renderAll();
  toast('모든 데이터를 삭제했습니다.');
}

/* ---------- AI 계획 ---------- */
function renderAiKeyStatus() {
  const key = getAiKey();
  $('#key-status').textContent = key
    ? `키가 이 브라우저에 저장되어 있습니다 (끝 4자리 …${key.slice(-4)}).`
    : '저장된 키가 없습니다. 키 없이도 로컬 계획을 쓸 수 있습니다.';
}

function onKeySubmit(e) {
  e.preventDefault();
  setError('#key-error', '');
  const k = $('#ai-key').value.trim();
  if (!isPlausibleAnthropicKey(k)) {
    setError('#key-error', 'Anthropic 키 형식이 맞지 않습니다. sk-ant- 로 시작하는 키인지 확인하세요.');
    return;
  }
  try {
    localStorage.setItem(AI_KEY, k);
  } catch {
    setError('#key-error', '브라우저 저장소에 키를 저장할 수 없습니다.');
    return;
  }
  $('#ai-key').value = '';
  renderAiKeyStatus();
  toast('키를 저장했습니다.');
}

function onKeyClear() {
  try { localStorage.removeItem(AI_KEY); } catch { /* 무시 */ }
  renderAiKeyStatus();
  toast('키를 삭제했습니다.');
}

async function callClaude(key, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_LIMITS.timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: AI_LIMITS.model,
        max_tokens: AI_LIMITS.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) throw new Error('키가 거부되었습니다 (인증 오류)');
    if (res.status === 429) throw new Error('요청이 너무 많습니다. 잠시 후 다시 시도하세요');
    if (!res.ok) throw new Error(`서버 응답 오류 (${res.status})`);
    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('');
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('응답 시간이 초과되었습니다');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function setBusy(on, text) {
  state.busy = on;
  $('#ai-run').disabled = on;
  $('#local-run').disabled = on;
  $('#ai-status').textContent = text || '';
}

async function runPlan(useAi) {
  if (state.busy) return;
  const today = todayStr();
  const mode = document.querySelector('input[name="plan-mode"]:checked')?.value === 'front' ? 'front' : 'even';
  const rows = buildDashboard(state.items, state.credits, today).rows;
  const elig = planEligibility(rows, today);
  const notes = [];
  const plan = { mode, source: useAi ? 'ai' : 'local', rows: [], notes, skipped: elig.skipped.length };

  if (!elig.items.length) {
    state.plan = plan;
    renderPlan();
    return;
  }

  let aiPlans = {};
  if (useAi) {
    const key = getAiKey();
    if (!key) {
      setError('#key-error', '먼저 API 키를 저장하세요. 키 없이는 로컬 계획을 보실 수 있습니다.');
      return;
    }
    const payload = anonymizeForAi(elig.items);
    if (!payload.items.length) {
      notes.push('AI로 보낼 항목이 없어 로컬 계획만 만들었습니다 (마감 12개월 이내, 최대 8개 항목만 AI 대상).');
    } else {
      setBusy(true, 'AI가 계획을 만드는 중입니다… 최대 30초 걸릴 수 있습니다.');
      try {
        const text = await callClaude(key, buildPrompt(payload));
        const r = parsePlanReply(text, payload);
        aiPlans = r.plans;
        if (r.errors.length) notes.push(`AI 응답 일부를 검증하지 못해 로컬 계획으로 채웠습니다. (${r.errors.slice(0, 2).join(' / ')})`);
      } catch (err) {
        notes.push(`AI 호출에 실패해 로컬 계획으로 대신했습니다: ${err.message || '알 수 없는 오류'}`);
      } finally {
        setBusy(false, '');
      }
    }
  }

  for (const it of elig.items) {
    const aiValues = aiPlans[it.key];
    const values = aiValues ?? fallbackPlan(it, mode);
    const item = state.items.find((x) => x.id === it.internalId);
    plan.rows.push({
      name: item ? item.name : '(항목)',
      remaining: it.remaining,
      months: monthLabels(today, it.months),
      values,
      source: aiValues ? 'AI' : '로컬',
    });
  }
  state.plan = plan;
  renderPlan();
  if (useAi) $('#ai-status').textContent = '계획을 만들었습니다. 참고용으로만 사용하세요.';
}

function renderPlan() {
  const out = $('#plan-out');
  const p = state.plan;
  if (!p) { out.replaceChildren(); return; }
  if (!p.rows.length) {
    out.replaceChildren(el('div', { class: 'card' },
      el('h3', { text: '계획할 남은 학점이 없습니다' }),
      el('p', { class: 'muted', text: p.skipped ? '만료된 항목은 계획하지 않습니다. 기록을 확인하거나 새 주기를 등록하세요.' : '필요 학점을 채운 항목이 없거나 모두 이수 완료 상태입니다.' })));
    return;
  }
  const modeLabel = p.mode === 'front' ? '앞당김' : '균등';
  const cards = p.rows.map((r) => {
    const sum = Math.round(r.values.reduce((a, b) => a + b, 0) * 100) / 100;
    const chips = r.values
      .map((v, i) => (v > 0 ? el('span', { text: `${r.months[i]} · ${fmt(v)}` }) : null))
      .filter(Boolean);
    return el('li', {},
      el('strong', { text: r.name }),
      el('p', { class: 'meta source', text: `남은 ${fmt(r.remaining)} · 계획 합계 ${fmt(sum)} · ${r.months.length}개월 · 출처 ${r.source}` }),
      el('div', { class: 'plan-chips' }, chips));
  });
  out.replaceChildren(el('section', { class: 'card form' },
    el('h3', { text: `월별 계획 (${p.source === 'ai' ? 'AI 제안' : '로컬 계산'} · ${modeLabel})` }),
    p.notes.map((n) => el('p', { class: 'warn-note', text: n })),
    el('ul', { class: 'plan-list' }, cards),
    el('p', { class: 'hint', text: '합계가 남은 학점과 같도록 맞춘 계획입니다. 실제 과정 일정과 기관 규정에 맞게 조정하세요.' })));
}

function setupAi() {
  $('#key-form').addEventListener('submit', onKeySubmit);
  $('#key-clear').addEventListener('click', onKeyClear);
  $('#local-run').addEventListener('click', () => runPlan(false));
  $('#ai-run').addEventListener('click', () => runPlan(true));
}

/* ---------- 전체 ---------- */
function renderRules() {
  const ul = $('#rules');
  const lines = [CONSTANTS.기준, ...Object.values(CONSTANTS.rules),
    `알림 기간 기본값: ${CONSTANTS.defaultLeadDays.join(', ')}일 전 (설정에서 변경)`,
    `긴급도: 30일 이내 ≤ ${CONSTANTS.urgency.soonDays}일, 90일 이내 ≤ ${CONSTANTS.urgency.warnDays}일`];
  ul.replaceChildren(...lines.map((t) => el('li', { text: t })));
}

function renderAll() {
  renderDashboard();
  renderItemAdmin();
  renderCredits();
  renderPrint();
  renderAiKeyStatus();
}

function init() {
  // 토스트 영역
  document.body.append(el('div', { id: 'toast', class: 'toast', role: 'status', hidden: true }));

  loadState();
  renderRules();
  $('#tpl-asof').textContent = CONSTANTS.기준;
  setupTabs();
  setupTemplates();
  renderAll();

  $('#item-form').addEventListener('submit', onItemSubmit);
  $('#item-cancel').addEventListener('click', resetItemForm);
  $('#credit-form').addEventListener('submit', onCreditSubmit);
  $('#credit-item').addEventListener('change', (e) => {
    state.creditItemId = e.target.value;
    renderCredits();
  });
  $('#csv-btn').addEventListener('click', onCsvClick);
  $('#csv-file').addEventListener('change', onCsvFileChange);
  $('#csv-commit').addEventListener('click', onCsvCommit);
  $('#heat-prev').addEventListener('click', () => { state.heatYear -= 1; renderHeatmap(); });
  $('#heat-next').addEventListener('click', () => { state.heatYear += 1; renderHeatmap(); });
  $('#holder-filter').addEventListener('change', (e) => {
    const v = e.target.value;
    state.holderFilter = v === 'all' ? null : v.slice(2);
    renderDashboard();
  });
  $('#lead-form').addEventListener('submit', onLeadSubmit);
  $('#panel-alerts').addEventListener('click', onPresetClick);
  $('#ics-btn').addEventListener('click', onIcsClick);
  $('#notify-btn').addEventListener('click', onNotifyClick);
  $('#json-btn').addEventListener('click', onBackupClick);
  $('#import-file').addEventListener('change', onImportChange);
  $('#print-btn').addEventListener('click', () => { renderPrint(); window.print(); });
  $('#reset-btn').addEventListener('click', onResetClick);
  setupAi();

  if (!state.storageOk) toast('이 브라우저에서 저장소를 쓸 수 없습니다. 데이터는 이 화면이 열려 있는 동안만 유지됩니다.');

  // 날짜가 바뀐 뒤 탭을 다시 열어도 정확하도록 포커스 복귀 시 대시보드 갱신
  window.addEventListener('focus', () => renderDashboard());
  if (!('Notification' in window)) renderAlerts();
  activateTab('dashboard');
}

init();
