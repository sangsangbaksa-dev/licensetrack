// licensetrack UI. 사용자 데이터는 전부 textContent 또는 DOM 노드로만 넣습니다 (innerHTML 사용 안 함).
import {
  CONSTANTS, todayStr, buildDashboard, dueReminders, normalizeLeads, normalizeItem, normalizeCredit,
  cycleStatus, deadlinesForItem, effectiveExpiry, BUCKET_LABEL, BUCKET_ORDER, buildIcs, icsDstamp,
  buildBackup, validateBackup, buildCreditsCsv, buildPrintRows, buildStatusCsv, newId, ValidationError,
  templatesWithOverrides, setTemplateOverride, resetTemplateOverride,
  holderOf, holderGroups, holderSummary, holderLabel, yearHeatmap,
  LEAD_PRESETS, leadPresetId, upcomingAlerts, duplicatesFor, findDuplicateGroups,
  importCreditsCsv, CSV_LIMITS, buildCertificates,
} from './logic.js';
import {
  AI_LIMITS, planEligibility, anonymizeForAi, buildPrompt, parsePlanReply, fallbackPlan,
  monthLabels, isPlausibleAnthropicKey,
} from './ai.js';
import { t, setLang, detectLang, applyI18n, langSelect, readSavedLang, writeSavedLang, localeTag } from './i18n.js';

setLang(detectLang(readSavedLang()));

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

const fmt = (n) => Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 2 });

function ddayText(d) {
  if (d === null || d === undefined) return t('a.dday.none');
  if (d < 0) return t('a.dday.past', { n: -d });
  if (d === 0) return t('a.dday.today');
  return t('a.dday.ahead', { n: d });
}

const STATUS_KEYS = {
  done: ['a.st.done', 's-done', 'is-done'],
  'on-track': ['a.st.on', 's-on', ''],
  'at-risk': ['a.st.risk', 's-risk', 'is-risk'],
  overdue: ['a.st.over', 's-over', 'is-over'],
  'no-req': ['a.st.none', 's-none', ''],
};
const statusLabel = (s) => t(STATUS_KEYS[s][0]);

function toast(msg) {
  const tn = $('#toast');
  tn.textContent = msg;
  tn.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { tn.hidden = true; }, 3200);
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
    toast(t('a.loadCorrupt'));
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
    toast(t('a.saveFail'));
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
  for (const tb of document.querySelectorAll('[role="tab"]')) {
    const on = tb.dataset.tab === name;
    tb.setAttribute('aria-selected', on ? 'true' : 'false');
    tb.tabIndex = on ? 0 : -1;
    if (on && focus) tb.focus();
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
  tabs.forEach((tb, i) => {
    tb.addEventListener('click', () => activateTab(tb.dataset.tab));
    tb.addEventListener('keydown', (e) => {
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
    el('option', { value: 'all', text: t('a.holderAll', { n: state.items.length }) }),
    ...groups.map((g) => el('option', { value: `h:${g.holder}`, text: t('a.holderOpt', { label: g.label, n: g.count }) })));
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
    el('span', { class: 'meta', text: t('a.hs.line', { total: s.total, expired: s.expired, d30: s.d30, d90: s.d90 }) + (s.atRisk ? t('a.hs.risk', { n: s.atRisk }) : '') }),
    el('span', { class: 'meta', text: s.next ? t('a.hs.next', { date: s.next.date, name: s.next.name }) : t('a.hs.none') })))));
}

function renderDashboard() {
  const today = todayStr();
  renderHolderControls();
  const full = buildDashboard(state.items, state.credits, today);
  const dash = state.holderFilter === null
    ? full
    : buildDashboard(state.items.filter((i) => holderOf(i) === state.holderFilter), state.credits, today);
  renderHolderSummary(full.rows);
  $('#today-label').textContent = t('a.todayLabel', { d: today });

  $('#counts').replaceChildren(...BUCKET_ORDER.map((b) =>
    el('li', {}, el('span', { class: `badge b-${b}`, text: BUCKET_LABEL[b] }), el('strong', { text: String(dash.counts[b]) }))));

  const banner = $('#alert-banner');
  const due = dueReminders(dash.rows, state.leads);
  if (due.length) {
    banner.hidden = false;
    banner.className = 'alert' + (due.some((d) => d.expired) ? ' alert-danger' : '');
    banner.replaceChildren(
      el('strong', { text: t('a.dueBanner', { n: due.length }) }),
      el('ul', {}, due.map((d) => el('li', {
        text: d.expired
          ? t('a.dueExpired', { name: d.name, n: -d.daysLeft })
          : `${d.name}: ${d.daysLeft === 0 ? t('a.dday.today') : t('a.dueLeft', { n: d.daysLeft })}${d.lead ? t('a.dueLead', { n: d.lead }) : ''}`,
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
  $('#timeline').replaceChildren(...tl.map((x) => el('li', {},
    el('time', { datetime: x.date, text: x.date }),
    el('span', { text: x.name }),
    el('span', { class: 'dday', text: ddayText(x.daysLeft) }))));
  $('#timeline-empty').hidden = tl.length > 0;
  renderHeatmap();
}

function renderItemCard(row) {
  const { item, expiry, daysLeft, bucket, cycle } = row;
  const facts = [
    [t('a.f.expiry'), expiry || '-'],
    [t('a.f.left'), ddayText(daysLeft)],
  ];
  if (cycle && cycle.years) facts.push([t('a.f.cycle'), `${cycle.start} ~ ${cycle.end}`, true]);
  if (cycle && cycle.required !== null) {
    facts.push([t('a.f.progress'), `${fmt(cycle.total)} / ${fmt(cycle.required)}${cycle.carry ? t('a.f.carryIn', { n: fmt(cycle.carry) }) : ''}`]);
  }
  if (cycle && cycle.remaining > 0 && cycle.neededPerMonth !== null) {
    facts.push([t('a.f.monthly'), t('a.f.monthlyVal', { n: fmt(cycle.neededPerMonth) })]);
  }
  if (cycle && cycle.projectedShortfall > 0) facts.push([t('a.f.shortfall'), `${fmt(cycle.projectedShortfall)}`, true]);

  const st = cycle ? STATUS_KEYS[cycle.status] : null;
  const hasProgress = cycle && cycle.required !== null;
  const progress = hasProgress
    ? el('div', {},
      el('div', {
        class: `progress ${st[2]}`,
        role: 'progressbar',
        'aria-label': t('a.progressAria', { name: item.name }),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.round(cycle.percent)),
      }, el('span', { style: `width:${cycle.percent}%` })),
      el('div', { class: 'progress-label' },
        el('span', { class: `status-tag ${st[1]}`, text: statusLabel(cycle.status) }),
        el('span', { text: `${Math.round(cycle.percent)}%` })))
    : null;

  return el('article', { class: 'card item-card' },
    el('div', { class: 'item-head' },
      el('div', { style: 'min-width:0' },
        el('h3', { text: item.name }),
        el('p', { text: [holderOf(item), item.issuer, item.cycleYears ? t('a.cycleYears', { n: item.cycleYears }) : ''].filter(Boolean).join(' · ') || t('a.noIssuer') })),
      el('span', { class: `badge b-${bucket}`, text: BUCKET_LABEL[bucket] })),
    el('dl', { class: 'facts' }, facts.map(([k, v, wide]) =>
      el('div', { class: wide ? 'wide' : '' }, el('dt', { text: k }), el('dd', { text: v })))),
    progress,
    el('div', { class: 'item-actions' },
      el('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => openCreditsFor(item.id), text: t('a.btnCredits') }),
      el('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => startEditItem(item.id), text: t('common.edit') })),
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
  $('#heat-year').textContent = t('a.yearLabel', { y: year });
  $('#heat-summary').textContent = hm.creditDays
    ? t('a.heatSummary', { y: year, d: hm.creditDays, h: fmt(hm.totalHours), n: hm.deadlines.length })
    : t('a.heatEmpty', { y: year, n: hm.deadlines.length });

  const pad = 34, top = 20, pitch = 15, size = 12;
  const W = pad + hm.cols * pitch, H = top + 7 * pitch;
  const svg = svgNode('svg', {
    class: 'heat-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    role: 'img', 'aria-label': t('a.heatAria', { y: year }),
  });
  for (const m of hm.monthMarks) {
    svg.append(svgNode('text', { x: pad + m.col * pitch, y: 12, class: 'heat-month' }, t('a.monthShort', { m: m.month })));
  }
  [[1, 'wd1'], [3, 'wd3'], [5, 'wd5']].forEach(([r, key]) => {
    svg.append(svgNode('text', { x: 0, y: top + r * pitch + size - 2, class: 'heat-wd' }, t(`a.${key}`)));
  });
  for (const d of hm.days) {
    const x = pad + d.col * pitch;
    const y = top + d.row * pitch;
    const label = `${d.date}: ${d.hours ? t('a.cellHours', { h: fmt(d.hours) }) : t('a.cellNone')}${d.deadlines.length ? t('a.cellDeadline', { names: d.deadlines.map((x2) => x2.name).join(', ') }) : ''}`;
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
        new Notification(t('a.notifyTitle'), {
          body: d.expired ? t('a.notifyExpired', { name: d.name }) : t('a.notifyLeft', { name: d.name, n: d.daysLeft }),
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
    el('option', { value: 'blank', text: t('tpl.blank.label') }),
    ...effectiveTemplates().map((tp) => el('option', { value: tp.id, text: `${tp.label}${tp.edited ? t('a.tplEdited') : ''}` })));
  sel.value = keep;
}

function renderTemplateEditor() {
  $('#tpl-list').replaceChildren(...effectiveTemplates().map((tp) => {
    const cy = `tpl-cy-${tp.id}`;
    const rq = `tpl-rq-${tp.id}`;
    return el('li', { class: 'tpl-row' },
      el('div', { class: 'tpl-head' },
        el('strong', { text: tp.name }),
        el('span', { class: 'badge b-d90', text: t('a.tplBadge') }),
        tp.edited ? el('span', { class: 'badge b-none', text: t('a.tplUserEdited') }) : null),
      el('p', { class: 'meta', text: t('a.tplDefault', { y: tp.cycleYears, r: tp.requiredCredits === null ? t('a.noReq') : t('a.hoursOf', { n: tp.requiredCredits }) }) }),
      el('div', { class: 'grid-2' },
        el('div', { class: 'field' },
          el('label', { for: cy, text: t('a.tplCycleLabel') }),
          el('input', { id: cy, type: 'number', min: '0', max: String(CONSTANTS.limits.cycleYears), step: '1', inputmode: 'numeric', value: String(tp.cycleYears) })),
        el('div', { class: 'field' },
          el('label', { for: rq, text: t('a.tplReqLabel') }),
          el('input', { id: rq, type: 'text', inputmode: 'decimal', value: tp.requiredCredits === null ? '' : String(tp.requiredCredits) }))),
      el('p', { class: 'form-error', id: `tpl-err-${tp.id}`, role: 'alert', hidden: true }),
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-save': tp.id, text: t('a.tplSave') }),
        tp.edited ? el('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-reset': tp.id, text: t('a.tplReset') }) : null));
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
  toast(resetId ? t('a.tplResetDone') : t('a.tplSaved'));
}

function setupTemplates() {
  renderTemplateOptions();
  renderTemplateEditor();
  $('#tpl-list').addEventListener('click', onTemplateEditClick);
  $('#tpl').addEventListener('change', () => {
    const tp = effectiveTemplates().find((x) => x.id === $('#tpl').value);
    if (!tp) return;
    $('#f-name').value = tp.name;
    $('#f-issuer').value = tp.issuer;
    $('#f-cycle').value = String(tp.cycleYears);
    $('#f-required').value = tp.requiredCredits === null ? '' : String(tp.requiredCredits);
    $('#f-notes').value = tp.note;
    toast(t('a.tplFilled'));
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
  $('#item-form-title').textContent = t('a.newItemTitle');
  $('#item-save').textContent = t('common.save');
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
  $('#item-form-title').textContent = t('a.editItemTitle', { name: it.name });
  $('#item-save').textContent = t('a.saveEdit');
  $('#item-cancel').hidden = false;
  $('#f-name').focus();
  $('#item-form').scrollIntoView({ block: 'start' });
}

const reasonLabel = (r) => (r === 'name' ? t('a.reason.name') : t('a.reason.number'));

function renderDuplicateBanner() {
  const groups = findDuplicateGroups(state.items);
  const b = $('#dup-banner');
  b.hidden = groups.length === 0;
  b.replaceChildren(...(groups.length ? [
    el('strong', { text: t('a.dupTitle', { n: groups.length }) }),
    el('ul', { class: 'bullets' }, groups.map((g) => el('li', {
      text: t('a.dupLine', { names: g.names.join(' / '), reasons: g.reasons.map(reasonLabel).join(', ') }),
    }))),
  ] : []));
}

function renderItemAdmin() {
  renderDuplicateBanner();
  const list = $('#item-admin');
  if (!state.items.length) {
    list.replaceChildren(el('li', { class: 'muted', text: t('a.noItems') }));
    return;
  }
  list.replaceChildren(...state.items.map((it) => {
    const n = state.credits.filter((c) => c.itemId === it.id).length;
    const exp = effectiveExpiry(it) || t('a.noExpiry');
    const meta = [holderOf(it) ? t('a.metaHolder', { h: holderOf(it) }) : null, t('a.metaExpiry', { d: exp }), it.cycleYears ? t('a.cycleYears', { n: it.cycleYears }) : null, it.requiredCredits !== null ? t('a.metaRequired', { n: fmt(it.requiredCredits) }) : null, t('a.metaRecords', { n }) ]
      .filter(Boolean).join(' · ');
    return el('li', {},
      el('div', { class: 'main' }, el('strong', { text: it.name }), el('p', { class: 'meta', text: meta })),
      el('div', { class: 'item-actions' },
        el('button', { class: 'btn btn-secondary btn-small', type: 'button', text: t('common.edit'), onclick: () => startEditItem(it.id) }),
        el('button', { class: 'btn btn-danger btn-small', type: 'button', text: t('common.delete'), onclick: () => deleteItem(it.id) })));
  }));
}

function deleteItem(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  const n = state.credits.filter((c) => c.itemId === id).length;
  if (!confirm(t('a.confirmDeleteItem', { name: it.name, n }))) return;
  state.items = state.items.filter((x) => x.id !== id);
  state.credits = state.credits.filter((c) => c.itemId !== id);
  if (state.creditItemId === id) state.creditItemId = null;
  saveState();
  resetItemForm();
  renderItemAdmin();
  renderDashboard();
  toast(t('a.deletedToast'));
}

function onItemSubmit(e) {
  e.preventDefault();
  setError('#item-error', '');
  try {
    const existingId = $('#item-id').value;
    const existing = existingId ? state.items.find((x) => x.id === existingId) : null;
    if (!existing && state.items.length >= CONSTANTS.limits.items) {
      throw new ValidationError(t('a.maxItems', { n: CONSTANTS.limits.items }));
    }
    const input = readItemForm();
    if (existing) input.createdAt = existing.createdAt;
    const item = normalizeItem(input);
    const dups = duplicatesFor(item, state.items);
    if (dups.length && !confirm(t('a.confirmDup', { names: dups.map((d) => d.item.name).join(', ') }))) {
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
    toast(existing ? t('a.itemUpdated') : t('a.itemAdded'));
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
    $('#cycle-info').replaceChildren(el('p', { text: t('a.addItemFirst') }));
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
      el('p', { class: 'muted', text: t('a.needExpiry') }));
  } else {
    const st = STATUS_KEYS[cyc.status];
    const rows = [];
    rows.push(el('p', {}, el('strong', { text: t('a.cycleWindow') }), `${cyc.start ?? t('a.startUnknown')} ~ ${cyc.end}`));
    if (cyc.required !== null) {
      rows.push(el('p', {}, el('strong', { text: t('a.progressLabel') }), `${fmt(cyc.total)} / ${fmt(cyc.required)}`,
        cyc.carry ? t('a.f.carryIn', { n: fmt(cyc.carry) }) : ''));
      rows.push(el('div', { class: `progress ${st[2]}`, role: 'progressbar', 'aria-label': t('a.progressGeneric'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(cyc.percent)) },
        el('span', { style: `width:${cyc.percent}%` })));
      rows.push(el('p', { class: `status-tag ${st[1]}`, text: `${statusLabel(cyc.status)}${cyc.neededPerMonth && cyc.remaining > 0 ? t('a.needMonthly', { n: fmt(cyc.neededPerMonth) }) : ''}` }));
      if (cyc.projectedShortfall > 0) rows.push(el('p', { class: 'muted', text: t('a.projection', { p: fmt(cyc.pace), t: fmt(cyc.projectedTotal), s: fmt(cyc.projectedShortfall) }) }));
    }
    const cats = Object.entries(cyc.byCategory);
    if (cats.length) rows.push(el('p', { class: 'muted', text: t('a.byCategory', { list: cats.map(([k, v]) => `${k} ${fmt(v)}`).join(' · ') }) }));
    if (cyc.priorEarned) rows.push(el('p', { class: 'muted small', text: t('a.priorNote', { n: fmt(cyc.priorEarned) }) }));
    if (cyc.nextEarned) rows.push(el('p', { class: 'muted small', text: t('a.nextNote', { n: fmt(cyc.nextEarned) }) }));
    info.replaceChildren(el('h3', { text: it.name }), ...rows);
  }

  const list = state.credits
    .filter((c) => c.itemId === it.id)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  $('#credit-empty').hidden = list.length > 0;
  $('#credit-list').replaceChildren(...list.map((c) => {
    const tag = !cyc ? null
      : c.date < (cyc.start || '0000-00-00') ? t('a.tagPrior')
        : c.date > cyc.end ? t('a.tagNext') : null;
    const meta = [c.course, c.provider, c.category].filter(Boolean).join(' · ');
    return el('li', {},
      el('div', { class: 'main' },
        el('strong', {}, `${c.date} · ${t('a.hoursShort', { h: fmt(c.hours) })}`, tag ? ` · ${tag}` : ''),
        el('p', { class: 'meta', text: meta || t('a.noCourse') }),
        c.memo ? el('p', { class: 'meta', text: t('a.memoLine', { m: c.memo }) }) : null),
      el('button', { class: 'btn btn-danger btn-small', type: 'button', text: t('common.delete'), onclick: () => deleteCredit(c.id) }));
  }));
}

function onCreditSubmit(e) {
  e.preventDefault();
  setError('#credit-error', '');
  try {
    const itemId = $('#credit-item').value;
    if (!state.items.some((i) => i.id === itemId)) throw new ValidationError(t('a.pickItemFirst'));
    if (state.credits.length >= CONSTANTS.limits.credits) {
      throw new ValidationError(t('a.maxCredits', { n: CONSTANTS.limits.credits }));
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
    toast(t('a.creditAdded'));
  } catch (err) {
    if (err instanceof ValidationError) setError('#credit-error', err.message);
    else throw err;
  }
}

function deleteCredit(id) {
  if (!confirm(t('a.confirmDeleteCredit'))) return;
  state.credits = state.credits.filter((c) => c.id !== id);
  saveState();
  renderCredits();
  renderDashboard();
  toast(t('a.creditDeleted'));
}

/* ---------- 알림·달력 ---------- */
function renderAlerts() {
  $('#leads').value = state.leads.join(', ');
  const pid = leadPresetId(state.leads);
  for (const b of document.querySelectorAll('[data-preset]')) {
    b.setAttribute('aria-pressed', b.dataset.preset === pid ? 'true' : 'false');
  }
  $('#preset-status').textContent = pid
    ? t('a.presetCurrent', { label: LEAD_PRESETS.find((p) => p.id === pid).label })
    : t('a.presetCustom', { list: state.leads.join(', ') });
  const today = todayStr();
  const up = upcomingAlerts(buildDashboard(state.items, state.credits, today).rows, state.leads, today);
  $('#upcoming').replaceChildren(...up.map((u) => el('li', {},
    el('time', { datetime: u.alertOn, text: u.alertOn }),
    el('span', { text: t('a.upcomingLine', { name: u.name, n: u.lead, d: u.deadline }) }))));
  $('#upcoming-empty').hidden = up.length > 0;
  const ns = $('#notify-status');
  const btn = $('#notify-btn');
  if (!('Notification' in window)) {
    ns.textContent = t('a.notifyUnsupported');
    btn.disabled = true;
    return;
  }
  const p = Notification.permission;
  btn.disabled = p !== 'default';
  ns.textContent = p === 'granted' ? t('a.notifyGranted')
    : p === 'denied' ? t('a.notifyDenied')
      : t('a.notifyDefault');
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
  applyLeads(normalizeLeads(preset.leads), t('a.presetSaved', { label: preset.label }));
}

function onLeadSubmit(e) {
  e.preventDefault();
  setError('#lead-error', '');
  const raw = $('#leads').value.trim();
  const parts = raw === '' ? [] : raw.split(/[,\s]+/).filter(Boolean);
  try {
    const nums = parts.map((p) => {
      if (!/^\d{1,4}$/.test(p)) throw new Error(t('a.notNumber', { v: p.slice(0, 10) }));
      return Number(p);
    });
    state.leads = normalizeLeads(nums);
    saveState();
    renderAlerts();
    renderDashboard();
    toast(t('a.leadsSaved'));
  } catch (err) {
    setError('#lead-error', err.message);
  }
}

function onIcsClick() {
  const today = todayStr();
  const ics = buildIcs({ items: state.items, leads: state.leads, today, dtstamp: icsDstamp(new Date()) });
  const count = state.items.reduce((n, it) => n + deadlinesForItem(it, today).length, 0);
  if (count === 0) {
    toast(t('a.icsNone'));
    return;
  }
  download(`licensetrack-${today}.ics`, 'text/calendar;charset=utf-8', ics);
  toast(t('a.icsDone', { n: count }));
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

function onStatusCsvClick() {
  if (!state.items.length) {
    toast(t('a.noItemsToSave'));
    return;
  }
  download(`licensetrack-status-${todayStr()}.csv`, 'text/csv;charset=utf-8', buildStatusCsv(state.items, state.credits, todayStr()));
}

function onCsvClick() {
  if (!state.credits.length) {
    toast(t('a.noCreditsToSave'));
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
  if (file.size > CSV_LIMITS.maxBytes) { fail(t('a.csvTooBig')); return; }
  if (!state.items.length) { fail(t('a.csvAddFirst')); return; }
  let text;
  try {
    text = await file.text();
  } catch {
    fail(t('a.csvReadFail'));
    return;
  }
  const r = importCreditsCsv(text, { items: state.items, existing: state.credits });
  if (!r.ok) { fail(r.fatal); return; }
  state.csvPending = r.credits;
  const shown = r.errors.slice(0, 100);
  box.replaceChildren(
    el('p', { text: t('a.csvSummary', { total: r.total, ok: r.credits.length, err: r.errors.length, skip: r.skipped.length }) }),
    r.errors.length ? el('details', { class: 'csv-errors' },
      el('summary', { text: t('a.csvErrSummary', { n: r.errors.length }) }),
      el('ul', { class: 'bullets' }, shown.map((x) => el('li', { text: t('a.csvRowErr', { row: x.row, m: x.message }) }))),
      r.errors.length > shown.length ? el('p', { class: 'muted small', text: t('a.csvOmitted', { n: r.errors.length - shown.length }) }) : null) : null);
  const commit = $('#csv-commit');
  commit.textContent = t('a.csvCommit', { n: r.credits.length });
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
  $('#csv-result').replaceChildren(el('p', { text: t('a.csvImported', { n }) }));
  renderCredits();
  renderDashboard();
  toast(t('a.csvImportedToast', { n }));
}

async function onImportChange(e) {
  const file = e.target.files && e.target.files[0];
  const msg = $('#import-msg');
  msg.replaceChildren();
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    msg.append(el('p', { class: 'form-error', text: t('a.importTooBig') }));
    e.target.value = '';
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    msg.append(el('p', { class: 'form-error', text: t('a.importNotJson') }));
    e.target.value = '';
    return;
  }
  const v = validateBackup(parsed);
  if (!v.ok) {
    msg.append(el('p', { class: 'form-error', text: t('a.importBad') }),
      el('ul', { class: 'bullets' }, v.errors.map((x) => el('li', { text: x }))));
    e.target.value = '';
    return;
  }
  if (!confirm(t('a.importConfirm', { n: v.data.items.length, c: v.data.credits.length }))) {
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
  msg.append(el('p', { text: t('a.importDone', { n: v.data.items.length, c: v.data.credits.length }) }));
  renderTemplateOptions();
  renderTemplateEditor();
  renderItemAdmin();
  renderDashboard();
  renderPrint();
}

function renderCertificates(today) {
  const certs = buildCertificates(state.items, state.credits, today);
  $('#cert-list').replaceChildren(...certs.map((c) => el('article', { class: 'cert' },
    el('h3', { text: c.holder ? t('a.certHolder', { name: c.name, h: c.holder }) : c.name }),
    el('p', { class: 'cert-meta', text: t('a.certMeta', { i: c.issuer, s: c.cycleStart, e: c.cycleEnd, x: c.expiry }) }),
    el('p', { class: 'cert-meta', text: t('a.certMeta2', { r: c.required === null ? t('a.noReq') : fmt(c.required), c: fmt(c.carry), t: c.total === null ? '-' : fmt(c.total), s: STATUS_KEYS[c.status] ? statusLabel(c.status) : '-' }) }),
    c.lines.length
      ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, [t('a.th.date'), t('a.th.course'), t('a.th.provider'), t('a.th.category'), t('a.th.hours')].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, c.lines.map((l) => el('tr', {},
          el('td', { text: l.date }), el('td', { text: l.course }), el('td', { text: l.provider }),
          el('td', { text: l.category }), el('td', { class: 'num', text: fmt(l.hours) }))))))
      : el('p', { class: 'muted small', text: t('a.certNone') }),
    c.lines.length ? el('p', { class: 'cert-meta', text: t('a.certSum', { h: fmt(c.lineHours) }) }) : null)));
}

function renderPrint() {
  const today = todayStr();
  $('#print-meta').textContent = t('a.printMeta', { d: today });
  renderCertificates(today);
  const rows = buildPrintRows(state.items, state.credits, today);
  $('#print-body').replaceChildren(...(rows.length ? rows : [null]).map((r) => {
    if (!r) return el('tr', {}, el('td', { colspan: '8', text: t('a.printNone') }));
    return el('tr', {},
      el('td', { text: r.holder ? t('a.certHolder', { name: r.name, h: r.holder }) : r.name }),
      el('td', { text: r.issuer || '-' }),
      el('td', { text: r.expiry }),
      el('td', { text: r.daysLeft === null ? '-' : ddayText(r.daysLeft) }),
      el('td', { text: r.cycleStart }),
      el('td', { class: 'num', text: r.required === null ? '-' : fmt(r.required) }),
      el('td', { class: 'num', text: r.earned === null ? '-' : fmt(r.earned) }),
      el('td', { text: STATUS_KEYS[r.status] ? statusLabel(r.status) : '-' }));
  }));
}

function onResetClick() {
  if (!confirm(t('a.confirmReset'))) return;
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
  toast(t('a.resetDone'));
}

/* ---------- AI 계획 ---------- */
/** 버튼을 누르면 보낼 문장을 그대로 보여 줌 (같은 함수로 만들므로 실제 전송문과 같음) */
function renderAiPayloadPreview() {
  const today = todayStr();
  const elig = planEligibility(buildDashboard(state.items, state.credits, today).rows, today);
  const payload = anonymizeForAi(elig.items);
  $('#ai-payload').textContent = payload.items.length
    ? buildPrompt(payload)
    : t('a.aiNothingToSend');
}

function renderAiKeyStatus() {
  renderAiPayloadPreview();
  const key = getAiKey();
  $('#key-status').textContent = key
    ? t('a.keySaved', { last: key.slice(-4) })
    : t('a.keyNone');
}

function onKeySubmit(e) {
  e.preventDefault();
  setError('#key-error', '');
  const k = $('#ai-key').value.trim();
  if (!isPlausibleAnthropicKey(k)) {
    setError('#key-error', t('a.keyFormat'));
    return;
  }
  try {
    localStorage.setItem(AI_KEY, k);
  } catch {
    setError('#key-error', t('a.keyStoreFail'));
    return;
  }
  $('#ai-key').value = '';
  renderAiKeyStatus();
  toast(t('a.keySavedToast'));
}

function onKeyClear() {
  try { localStorage.removeItem(AI_KEY); } catch { /* 무시 */ }
  renderAiKeyStatus();
  toast(t('a.keyRemovedToast'));
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
    if (res.status === 401 || res.status === 403) throw new Error(t('a.errAuth'));
    if (res.status === 429) throw new Error(t('a.errRate'));
    if (!res.ok) throw new Error(t('a.errServer', { s: res.status }));
    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('');
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(t('a.errTimeout'));
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
      setError('#key-error', t('a.needKeyFirst'));
      return;
    }
    const payload = anonymizeForAi(elig.items);
    if (!payload.items.length) {
      notes.push(t('a.noAiItems'));
    } else {
      setBusy(true, t('a.aiWorking'));
      try {
        const text = await callClaude(key, buildPrompt(payload));
        const r = parsePlanReply(text, payload);
        aiPlans = r.plans;
        if (r.errors.length) notes.push(t('a.aiPartial', { e: r.errors.slice(0, 2).join(' / ') }));
      } catch (err) {
        notes.push(t('a.aiFailed', { m: err.message || t('a.unknownErr') }));
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
      name: item ? item.name : t('a.itemPlaceholder'),
      remaining: it.remaining,
      months: monthLabels(today, it.months),
      values,
      source: aiValues ? 'AI' : t('a.srcLocal'),
    });
  }
  state.plan = plan;
  renderPlan();
  if (useAi) $('#ai-status').textContent = t('a.aiDone');
}

function renderPlan() {
  const out = $('#plan-out');
  const p = state.plan;
  if (!p) { out.replaceChildren(); return; }
  if (!p.rows.length) {
    out.replaceChildren(el('div', { class: 'card' },
      el('h3', { text: t('a.planNoneTitle') }),
      el('p', { class: 'muted', text: p.skipped ? t('a.planSkipped') : t('a.planNoneBody') })));
    return;
  }
  const modeLabel = p.mode === 'front' ? t('a.modeFront') : t('a.modeEven');
  const cards = p.rows.map((r) => {
    const sum = Math.round(r.values.reduce((a, b) => a + b, 0) * 100) / 100;
    const chips = r.values
      .map((v, i) => (v > 0 ? el('span', { text: `${r.months[i]} · ${fmt(v)}` }) : null))
      .filter(Boolean);
    return el('li', {},
      el('strong', { text: r.name }),
      el('p', { class: 'meta source', text: t('a.planLine', { rem: fmt(r.remaining), sum: fmt(sum), n: r.months.length, src: r.source }) }),
      el('div', { class: 'plan-chips' }, chips));
  });
  out.replaceChildren(el('section', { class: 'card form' },
    el('h3', { text: t('a.planTitle', { src: p.source === 'ai' ? t('a.srcAi') : t('a.srcCalc'), mode: modeLabel }) }),
    p.notes.map((n) => el('p', { class: 'warn-note', text: n })),
    el('ul', { class: 'plan-list' }, cards),
    el('p', { class: 'hint', text: t('a.planHint') })));
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
  const r = CONSTANTS.rules;
  const lines = [CONSTANTS.기준, r.cycle, r.leapYear, r.urgency, r.pace, r.projection,
    t('a.ruleLeadDefault', { list: CONSTANTS.defaultLeadDays.join(', ') }),
    t('a.ruleUrgency', { a: CONSTANTS.urgency.soonDays, b: CONSTANTS.urgency.warnDays })];
  ul.replaceChildren(...lines.map((x) => el('li', { text: x })));
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
  applyI18n(document);
  langSelect($('#lang-select'), (l) => {
    setLang(l);
    writeSavedLang(l);
    applyI18n(document);
    renderTemplateOptions();
    renderTemplateEditor();
    renderRules();
    $('#tpl-asof').textContent = CONSTANTS.기준;
    renderAll();
    if (state.plan) renderPlan();
    renderAlerts();
    activateTab(document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab || 'dashboard');
  });

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
  $('#status-csv-btn').addEventListener('click', onStatusCsvClick);
  $('#import-file').addEventListener('change', onImportChange);
  $('#print-btn').addEventListener('click', () => { renderPrint(); window.print(); });
  $('#reset-btn').addEventListener('click', onResetClick);
  setupAi();

  if (!state.storageOk) toast(t('a.storageWarn'));

  // 날짜가 바뀐 뒤 탭을 다시 열어도 정확하도록 포커스 복귀 시 대시보드 갱신
  window.addEventListener('focus', () => renderDashboard());
  if (!('Notification' in window)) renderAlerts();
  activateTab('dashboard');
}

init();
