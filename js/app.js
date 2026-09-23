/* 나스닥 적립매수 시뮬레이터 — 화면 로직 (계산은 js/engine.js) */
(function () {
  'use strict';
  const E = window.DCAEngine;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const DAYS = [1, 5, 10, 15, 20, 25, 'last'];
  const dayLabel = d => d === 'last' ? '말일' : d + '일';
  const WD = ['', '월요일', '화요일', '수요일', '목요일', '금요일'];
  const C = { o: '#F58220', b: '#043B72', s: '#FAB072', c: '#0086B8', t: '#AD624E', g: '#84888B', up: '#2E8540', down: '#C62828' };
  const FAMS = { a: '전월 대비 (μ 밴드)', b: '52주 고점 낙폭', c: '200일선 이격도', g: '장기 추세선', f: 'VIX' };

  const state = {
    data: null, results: null, target: 'QQQ', amount: 1000, months: 120, startYM: null, krw: false,
    buyDay: 25, weekday: 1, tab: 1, fam: 'overall',
    rule: { type: 'a', center: 'mu', muW: 30, fixedAnnual: 10, k1: 3, k2: 5, t1: 10, t2: 20, s: 2, v1: 25, v2: 35, w: 15, trendW: 30, u1: 1.3, u2: 1.6, d1: 0.7, d2: 0.5, shape: 'step' },
    budget: { mode: 'B', capMonths: 3, seedMonths: 0 },
    calcStart: null, calcCash: null, calcDone: 0,
  };
  const charts = {};
  const dirty = new Set([1, 2, 3, 4]);

  // ---------- 서식 ----------
  const S = () => state.data.series;
  const T = () => S()[state.target];
  const aux = () => ({ IXIC: S().IXIC, VIX: S().VIX });
  const isUSD = () => state.target === 'QQQ';
  const dispKRW = () => !isUSD() || (state.krw && !!S().USDKRW);
  const money = (v, krw) => {
    if (v == null || isNaN(v)) return '–';
    const k = krw == null ? dispKRW() : krw;
    return k ? Math.round(v).toLocaleString('ko-KR') + '원' : '$' + Math.round(v).toLocaleString('en-US');
  };
  const money2 = (v, krw) => { if (v == null || isNaN(v)) return '–'; const k = krw == null ? dispKRW() : krw; return k ? Math.round(v).toLocaleString('ko-KR') + '원' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const shortMoney = (v, krw) => {
    const k = krw == null ? dispKRW() : krw;
    if (k) return v >= 1e8 ? (v / 1e8).toFixed(1) + '억' : Math.round(v / 1e4).toLocaleString() + '만';
    return v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? '$' + Math.round(v / 1e3) + 'k' : '$' + Math.round(v);
  };
  const pct = (v, d) => (v == null || isNaN(v)) ? '–' : (v * 100).toFixed(d == null ? 1 : d) + '%';
  const pp = (v, d) => (v == null || isNaN(v)) ? '–' : v.toFixed(d == null ? 2 : d) + '%';
  const sgn = (v, f, inv) => { if (v == null || isNaN(v)) return '–'; if (Math.abs(v) < 0.005) v = 0; const s = f(v); const good = inv ? v < 0 : v > 0, bad = inv ? v > 0 : v < 0; return `<span class="${good ? 'pos' : bad ? 'neg' : ''}">${v > 0 ? '+' : ''}${s}</span>`; };
  const kpi = (l, v, s, cls) => `<div class="kpi"><div class="kpi-l">${l}</div><div class="kpi-v ${cls || ''}">${v}</div>${s ? `<div class="kpi-s">${s}</div>` : ''}</div>`;
  const table = (heads, rows, opts) => {
    const o = opts || {};
    const th = heads.map((h, i) => `<th class="${(o.num || []).includes(i) ? 'n' : ''}">${h}</th>`).join('');
    const tr = rows.map((r, ri) => `<tr class="${o.best === ri ? 'best' : ''}">` + r.map((c, i) => `<td class="${(o.num || []).includes(i) ? 'n' : ''}">${c}</td>`).join('') + '</tr>').join('');
    return `<table class="dt ${o.cls || ''}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  };
  const view = (r, valIdx) => {
    if (isUSD() && state.krw && S().USDKRW) { const k = E.krwView(r, T().dates, valIdx, S().USDKRW); if (k) return k; }
    return r;
  };
  function getWindow() {
    const tg = T();
    const endYM = E.latestCompleteYM(tg.dates, 'last');
    const first = E.firstFullYM(tg.dates);
    let startYM = state.startYM ? state.startYM : (state.months === 'all' ? first : E.ymAdd(endYM, -(state.months - 1)));
    if (startYM < first) startYM = first;
    if (startYM > endYM) startYM = endYM;
    return { startYM, endYM };
  }
  function chart(id, cfg) {
    if (charts[id]) charts[id].destroy();
    const el = $('#' + id); if (!el) return;
    charts[id] = new Chart(el, cfg);
  }
  const baseOpts = (yFmt, extra) => Object.assign({
    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12 } }, tooltip: { backgroundColor: '#1A1A1A' } },
    scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { grid: { color: '#E5E4E1' }, ticks: { callback: yFmt } } },
  }, extra || {});

  // ---------- 데이터 로드 ----------
  async function load() {
    try {
      const r = await fetch('data/prices.json?_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('prices.json ' + r.status);
      state.data = await r.json();
    } catch (e) {
      $('#status').textContent = '데이터 파일(data/prices.json)을 불러올 수 없습니다. GitHub Actions 첫 실행이 끝났는지 확인해 주세요. (' + e.message + ')';
      return;
    }
    try { const r2 = await fetch('data/results.json?_=' + Date.now(), { cache: 'no-store' }); if (r2.ok) state.results = await r2.json(); } catch (e) { /* 선택 */ }
    if (!S().QQQ) { $('#status').textContent = 'QQQ 데이터가 없습니다.'; return; }
    if (!S().TIGER) $('#target option[value=TIGER]').disabled = true;
    const q = S().QQQ;
    $('#meta').textContent = `데이터 기준일 ${q.dates[q.dates.length - 1]} · 갱신 ${(state.data.updated || '').replace('T', ' ').slice(0, 16)} UTC`;
    $('#status').style.display = 'none';
    initControls();
    showTab(1);
  }

  // ---------- 컨트롤 ----------
  function initControls() {
    $('#target').addEventListener('change', e => {
      state.target = e.target.value;
      state.amount = isUSD() ? 1000 : 1000000; $('#amount').value = state.amount; $('#amount').step = isUSD() ? 100 : 100000;
      $('#amountLabel').textContent = isUSD() ? '월 매수금액 (달러)' : '월 매수금액 (원)';
      $('#krwWrap').style.display = isUSD() ? '' : 'none';
      invalidate();
    });
    $('#amount').addEventListener('change', e => { state.amount = Math.max(1, +e.target.value || 1); invalidate(); });
    $$('#periodSeg button').forEach(b => b.addEventListener('click', () => {
      $$('#periodSeg button').forEach(x => x.classList.remove('on')); b.classList.add('on');
      state.months = b.dataset.m === 'all' ? 'all' : +b.dataset.m; state.startYM = null; $('#startYM').value = ''; invalidate();
    }));
    $('#startYM').addEventListener('change', e => { state.startYM = e.target.value || null; if (state.startYM) $$('#periodSeg button').forEach(x => x.classList.remove('on')); invalidate(); });
    $('#krw').addEventListener('change', e => { state.krw = e.target.checked; invalidate(); });
    for (const id of ['buyDay2', 'buyDay3']) {
      const sel = $('#' + id); sel.innerHTML = DAYS.map(d => `<option value="${d}" ${String(d) === String(state.buyDay) ? 'selected' : ''}>${dayLabel(d)}</option>`).join('');
      sel.addEventListener('change', e => { state.buyDay = e.target.value === 'last' ? 'last' : +e.target.value; $('#buyDay2').value = e.target.value; $('#buyDay3').value = e.target.value; invalidate(); });
    }
    $('#weekday').addEventListener('change', e => { state.weekday = +e.target.value; invalidate(); });
    $$('#tabs button').forEach(b => b.addEventListener('click', () => showTab(+b.dataset.t)));
    // 규칙 입력
    const map = { r_type: 'type', r_center: 'center', r_muW: 'muW', r_fixed: 'fixedAnnual', r_trendW: 'trendW', r_k1: 'k1', r_k2: 'k2', r_t1: 't1', r_t2: 't2', r_s: 's', r_v1: 'v1', r_v2: 'v2', r_w: 'w', r_u1: 'u1', r_u2: 'u2', r_d1: 'd1', r_d2: 'd2', r_shape: 'shape' };
    for (const id in map) {
      $('#' + id).addEventListener('change', e => {
        const k = map[id]; let v = e.target.value;
        if (['muW', 'trendW'].includes(k)) v = v === 'all' ? 'all' : +v;
        else if (['type', 'center', 'shape'].includes(k)) { /* 문자열 */ }
        else v = v === '' ? null : +v;
        state.rule[k] = v; syncRuleForm(); invalidate([3, 4]);
      });
    }
    $('#b_mode').addEventListener('change', e => { state.budget.mode = e.target.value; syncRuleForm(); invalidate([3, 4]); });
    $('#b_cap').addEventListener('change', e => { state.budget.capMonths = Math.max(0, +e.target.value || 0); invalidate([3, 4]); });
    $('#b_seed').addEventListener('change', e => { state.budget.seedMonths = Math.max(0, +e.target.value || 0); invalidate([3, 4]); });
    $('#calcStart').addEventListener('change', e => { state.calcStart = e.target.value || null; invalidate([4]); });
    $('#calcCash').addEventListener('change', e => { state.calcCash = e.target.value === '' ? null : +e.target.value; invalidate([4]); });
    $('#calcDone').addEventListener('change', e => { state.calcDone = +e.target.value; invalidate([4]); });
    $('#copyBtn').addEventListener('click', () => {
      const t = $('#calcSummary').textContent; if (!t) return;
      navigator.clipboard.writeText(t).then(() => { $('#copyBtn').textContent = '복사됨'; setTimeout(() => $('#copyBtn').textContent = '문구 복사', 1500); });
    });
    syncRuleForm();
  }
  function syncRuleForm() {
    const r = state.rule;
    const show = (cls, on) => $$('#ruleForm .' + cls).forEach(el => el.style.display = on ? '' : 'none');
    show('ra', r.type === 'a'); show('rb', r.type === 'b'); show('rc', r.type === 'c'); show('rg', r.type === 'g'); show('rf', r.type === 'f');
    if (r.type === 'a') { show('rmu', r.center === 'mu'); show('rfixed', r.center === 'fixed'); }
    $$('#ruleForm .rc.rg').forEach(el => el.style.display = ['a', 'c', 'g'].includes(r.type) ? '' : 'none');
    show('bB', state.budget.mode === 'B');
    $('#kHint').textContent = r.type === 'a' ? '전월 대비: 중심 ± k1 (%p)' : r.type === 'c' ? '200일선 대비 ± k1 (%)' : '추세선 대비 ± k1 (%)';
    const set = (id, v) => { const el = $('#' + id); if (el && document.activeElement !== el) el.value = v == null ? '' : v; };
    set('r_type', r.type); set('r_center', r.center); set('r_muW', r.muW); set('r_fixed', r.fixedAnnual); set('r_trendW', r.trendW);
    set('r_k1', r.k1); set('r_k2', r.k2); set('r_t1', r.t1); set('r_t2', r.t2); set('r_s', r.s); set('r_v1', r.v1); set('r_v2', r.v2); set('r_w', r.w);
    set('r_u1', r.u1); set('r_u2', r.u2); set('r_d1', r.d1); set('r_d2', r.d2); set('r_shape', r.shape);
    set('b_mode', state.budget.mode); set('b_cap', state.budget.capMonths); set('b_seed', state.budget.seedMonths);
  }
  function invalidate(tabs) { (tabs || [1, 2, 3, 4]).forEach(t => dirty.add(t)); render(state.tab); }
  function showTab(t) {
    state.tab = t;
    $$('#tabs button').forEach(b => b.classList.toggle('on', +b.dataset.t === t));
    [1, 2, 3, 4].forEach(k => $('#tab' + k).classList.toggle('hidden', k !== t));
    render(t);
  }
  function render(t) {
    if (!dirty.has(t)) return;
    try { ({ 1: renderTab1, 2: renderTab2, 3: renderTab3, 4: renderTab4 })[t](); dirty.delete(t); }
    catch (e) { console.error(e); $('#tab' + t).insertAdjacentHTML('afterbegin', `<p class="note neg">계산 중 오류: ${e.message}</p>`); }
  }
  const ruleText = () => {
    const r = state.rule, b = state.budget;
    const k2 = r.k2 == null ? '' : ` / ±${r.k2}`;
    let s;
    if (r.type === 'a') s = `전월 매수일 대비 등락률, 중심 ${r.center === 'mu' ? 'μ(' + (r.muW === 'all' ? '전 기간' : r.muW + '년') + ' 롤링 평균)' : r.center === 'fixed' ? '고정 연 ' + r.fixedAnnual + '%' : '0'} ± ${r.k1}${k2}%p`;
    else if (r.type === 'b') s = `52주 고점 대비 낙폭 −${r.t1}%${r.t2 != null ? ' / −' + r.t2 + '%' : ''} 증액, 고점 ${r.s}% 이내 감액`;
    else if (r.type === 'c') s = `200일 이동평균 이격도 ±${r.k1}${k2}%`;
    else if (r.type === 'g') s = `장기 추세선(${r.trendW === 'all' ? '전 기간' : r.trendW + '년'}) 이격도 ±${r.k1}${k2}%`;
    else s = `VIX ${r.v1} 이상${r.v2 != null ? ' / ' + r.v2 + ' 이상' : ''} 증액, ${r.w} 이하 감액`;
    return `${s} · 배수 ×${r.u1}/${r.u2} · ×${r.d1}/${r.d2} (${r.shape === 'step' ? '계단' : '경사'}) · 예산 ${b.mode === 'A' ? 'A 잔여예산 재배분' : 'B 현금풀 이월(상한 ' + b.capMonths + '개월)'}${b.seedMonths ? ' · 초기 현금 ' + b.seedMonths + '개월분' : ''}`;
  };

  // ---------- ① 매수일 ----------
  function renderTab1() {
    const tg = T(), { startYM, endYM } = getWindow(), valIdx = tg.dates.length - 1, A = state.amount;
    const study = E.dayOfMonthStudy(tg, startYM, endYM, A, valIdx, DAYS).filter(r => r.n > 0);
    const stab = E.dayStability(tg, A, DAYS, 120);
    const rows = study.map(r => ({ r, v: view(r, valIdx) }));
    let bi = 0, wi = 0; rows.forEach((x, i) => { if (x.v.fv > rows[bi].v.fv) bi = i; if (x.v.fv < rows[wi].v.fv) wi = i; });
    const spread = rows[bi].v.fv / rows[wi].v.fv - 1;
    let bestRatio = 0; study.forEach((r, i) => { if (r.monthRatio < study[bestRatio].monthRatio) bestRatio = i; });
    $('#k1').innerHTML =
      kpi('최종평가액 최고 매수일', dayLabel(study[bi].day), `최저(${dayLabel(study[wi].day)}) 대비 +${pct(spread, 2)}`, 'o') +
      kpi('월평균가 대비 가장 싸게 산 날', dayLabel(study[bestRatio].day), `${pp(study[bestRatio].monthRatio * 100, 2)} (그 달 평균 대비)`, 'b') +
      kpi('매수 횟수 · 기간', `${study[bi].n}회`, `${startYM} ~ ${endYM}, 평가 ${tg.dates[valIdx]}`) +
      kpi('총 투입', money(rows[bi].v.invested), `${money(rows[bi].v.fv)} (${dayLabel(study[bi].day)} 기준)`);
    chart('c1', { type: 'bar', data: { labels: study.map(r => dayLabel(r.day)), datasets: [{ label: '최종평가액', data: rows.map(x => x.v.fv), backgroundColor: rows.map((x, i) => i === bi ? C.b : C.o), borderRadius: 0 }] },
      options: baseOpts(v => shortMoney(v), { plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1A1A1A', callbacks: { label: c => money(c.raw) } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: '#E5E4E1' }, ticks: { callback: v => shortMoney(v) }, beginAtZero: false } } }) });
    const st = {}; (stab.stats || []).forEach(s => st[String(s.day)] = s);
    $('#t1').innerHTML = table(['매수일', '최종평가액', '총수익률', '연 IRR', '평균매입단가', '월평균가 대비 매수단가', `롤링 10년 상위2 비율 (${stab.windows || 0}개 창)`, '평균 순위'],
      rows.map(({ r, v }) => { const s = st[String(r.day)] || {}; return [dayLabel(r.day), money(v.fv), pct(v.ret, 1), pct(v.irr, 2), money2(v.avgCost), sgn(r.monthRatio * 100, x => x.toFixed(2) + '%', true), s.top2 != null ? pct(s.top2, 0) : '–', s.avgRank != null ? s.avgRank.toFixed(1) : '–']; }),
      { num: [1, 2, 3, 4, 5, 6, 7], best: bi });
  }

  // ---------- ② 매수 주기 ----------
  function renderTab2() {
    const tg = T(), { startYM, endYM } = getWindow(), valIdx = tg.dates.length - 1, A = state.amount;
    const sched = E.monthlySchedule(tg.dates, startYM, endYM, state.buyDay);
    if (sched.length < 2) { $('#k2').innerHTML = ''; $('#t2').innerHTML = '<p class="note">기간이 너무 짧습니다.</p>'; return; }
    const fs = E.frequencyStudy(tg, sched, A, valIdx, state.weekday);
    const wd = state.weekday;
    const rowsDef = [
      ['월 1회 (' + dayLabel(state.buyDay) + ')', fs.monthly, C.o],
      ['격주 (' + WD[wd] + ')', fs.biweekly[wd], C.s],
      ['주 1회 (' + WD[wd] + ')', fs.weekly[wd], C.b],
      ['연초 일시납 (12개월분)', fs.lumpYearly, C.c],
      ['최초 일시납 (전 기간분)', fs.lumpInitial, C.t],
    ];
    const rows = rowsDef.map(([l, r, col]) => ({ l, r, v: view(r, valIdx), col }));
    const m = rows[0].v, w = rows[2].v, bw = rows[1].v;
    $('#k2').innerHTML =
      kpi('월 1회', money(m.fv), `IRR ${pct(m.irr, 2)}`, 'o') +
      kpi('격주', money(bw.fv), `월 1회 대비 ${sgn(bw.fv / m.fv - 1, x => (x * 100).toFixed(2) + '%')}`) +
      kpi('주 1회', money(w.fv), `월 1회 대비 ${sgn(w.fv / m.fv - 1, x => (x * 100).toFixed(2) + '%')}`, 'b') +
      kpi('연초 일시납', money(rows[3].v.fv), `월 1회 대비 ${sgn(rows[3].v.fv / m.fv - 1, x => (x * 100).toFixed(2) + '%')}`) +
      kpi('총 투입 (모두 동일)', money(m.invested), `${fs.months}개월, ${startYM}~${endYM}`);
    $('#t2').innerHTML = table(['전략', '매수 횟수', '회당 금액', '최종평가액', '총수익률', '연 IRR', '평균매입단가'],
      rows.map(({ l, r, v }) => [l, r.n + '회', money(v.invested / r.n), money(v.fv), pct(v.ret, 1), pct(v.irr, 2), money2(v.avgCost)]), { num: [1, 2, 3, 4, 5, 6] });
    $('#t2w').innerHTML = table(['요일', '주 1회 최종평가액', '월 1회 대비', '격주 최종평가액', '월 1회 대비'],
      [1, 2, 3, 4, 5].map(d => { const a = view(fs.weekly[d], valIdx), b = view(fs.biweekly[d], valIdx); return [WD[d], money(a.fv), sgn(a.fv / m.fv - 1, x => (x * 100).toFixed(2) + '%'), money(b.fv), sgn(b.fv / m.fv - 1, x => (x * 100).toFixed(2) + '%')]; }), { num: [1, 2, 3, 4] });
    const labels = sched.map(i => tg.dates[i].slice(0, 7));
    const fx = (isUSD() && state.krw && S().USDKRW) ? sched.map(i => { const k = E.asOfIdx(S().USDKRW.dates, tg.dates[i]); return k >= 0 ? S().USDKRW.close[k] : null; }) : null;
    const conv = arr => fx ? arr.map((v, i) => fx[i] == null ? null : v * fx[i]) : arr;
    chart('c2', { type: 'line', data: { labels, datasets: [
      { label: '월 1회', data: conv(fs.paths.monthly), borderColor: C.o, backgroundColor: C.o, borderWidth: 2, pointRadius: 0, tension: 0 },
      { label: '격주', data: conv(fs.paths.biweekly), borderColor: C.s, backgroundColor: C.s, borderWidth: 1.5, pointRadius: 0, tension: 0 },
      { label: '주 1회', data: conv(fs.paths.weekly), borderColor: C.b, backgroundColor: C.b, borderWidth: 1.5, pointRadius: 0, tension: 0 },
      { label: '연초 일시납', data: conv(fs.paths.lumpYearly), borderColor: C.c, backgroundColor: C.c, borderWidth: 1.5, pointRadius: 0, tension: 0, borderDash: [4, 3] },
      { label: '최초 일시납', data: conv(fs.paths.lumpInitial), borderColor: C.t, backgroundColor: C.t, borderWidth: 1.5, pointRadius: 0, tension: 0, borderDash: [2, 3] },
    ] }, options: baseOpts(v => shortMoney(v), { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12 } }, tooltip: { backgroundColor: '#1A1A1A', callbacks: { label: c => c.dataset.label + ': ' + money(c.raw) } } } }) });
  }

  // ---------- ③ 가변 적립 ----------
  function rateSeries() { return isUSD() ? S().IRX : S().KR3M; }
  function renderTab3() {
    const tg = T(), { startYM, endYM } = getWindow(), valIdx = tg.dates.length - 1, A = state.amount;
    const sched = E.monthlySchedule(tg.dates, startYM, endYM, state.buyDay);
    if (sched.length < 2) { $('#k3').innerHTML = '<p class="note">기간이 너무 짧습니다.</p>'; return; }
    const TR = E.computeTriggers(tg, aux(), sched);
    const rates = E.ratesFor(rateSeries(), tg.dates, sched);
    const v = E.runVariable(tg, sched, valIdx, A, state.rule, TR, state.budget, rates);
    const d = E.runVariable(tg, sched, valIdx, A, { type: 'none' }, TR, { mode: 'B', capMonths: 0 }, rates);
    const vv = view(v, valIdx), dv = view(d, valIdx);
    const fxNow = (isUSD() && state.krw && S().USDKRW) ? (vv.fxVal || 1) : 1;
    const xup = v.buys.filter(b => b > A * 1.0001).length, xdown = v.buys.filter(b => b < A * 0.9999).length;
    $('#k3').innerHTML =
      kpi('가변 최종평가액', money(vv.fv), `정액 ${money(dv.fv)} · 차이 ${sgn(vv.fv / dv.fv - 1, x => (x * 100).toFixed(2) + '%')}`, 'o') +
      kpi('연 IRR (유입 기준)', pct(vv.irr, 2), `정액 ${pct(dv.irr, 2)} · ${sgn((vv.irr - dv.irr) * 100, x => x.toFixed(2) + '%p')}`, 'b') +
      kpi('평균매입단가', money2(vv.avgCost), `정액 ${money2(dv.avgCost)} · ${sgn(vv.avgCost / dv.avgCost - 1, x => (x * 100).toFixed(2) + '%')}`) +
      kpi('판정 개월 (목표 기준)', `${v.counts.up} / ${v.counts.down} / ${v.counts.neutral}`, `증액 / 감액 / 중립 · ${v.counts.n}개월`) +
      kpi('실제 집행', `${xup} / ${xdown}`, `증액 / 감액 · 평균 배수 ×${v.avgExec.toFixed(2)}`) +
      kpi('기말 현금풀 · 최대낙폭', money(v.cash * fxNow), `평가액 최대낙폭 ${pct(v.mdd, 1)} (정액 ${pct(d.mdd, 1)})`);
    const labels = sched.map(i => tg.dates[i].slice(0, 7));
    const px = sched.map(i => tg.adj[i]);
    const unit = isUSD() ? '$' : '원';
    chart('c3a', { type: 'bar', data: { labels, datasets: [
      { label: '실제 집행', data: v.buys, backgroundColor: C.o, borderRadius: 0, order: 2 },
      { label: '목표 금액', data: v.targets, backgroundColor: 'rgba(4,59,114,0)', borderColor: C.b, borderWidth: 1, borderRadius: 0, order: 1 },
      { label: '가격(수정종가)', data: px, type: 'line', yAxisID: 'y1', borderColor: C.g, borderWidth: 1.2, pointRadius: 0, borderDash: [3, 3], tension: 0, order: 0 },
    ] }, options: baseOpts(val => (isUSD() ? '$' : '') + Math.round(val).toLocaleString() + (isUSD() ? '' : '원'), {
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12 } }, tooltip: { backgroundColor: '#1A1A1A', callbacks: { label: c => c.dataset.type === 'line' ? '가격 ' + c.raw.toFixed(2) : c.dataset.label + ': ' + money(c.raw, !isUSD()) } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { grid: { color: '#E5E4E1' }, ticks: { callback: val => shortMoney(val, !isUSD()) } }, y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: val => val.toFixed(0) } } },
    }) });
    const fx = (isUSD() && state.krw && S().USDKRW) ? sched.map(i => { const k = E.asOfIdx(S().USDKRW.dates, tg.dates[i]); return k >= 0 ? S().USDKRW.close[k] : null; }) : null;
    const conv = arr => fx ? arr.map((x, i) => fx[i] == null ? null : x * fx[i]) : arr;
    chart('c3b', { type: 'line', data: { labels, datasets: [
      { label: '가변 적립 평가액(현금 포함)', data: conv(v.valPath), borderColor: C.o, backgroundColor: C.o, borderWidth: 2, pointRadius: 0, tension: 0 },
      { label: '정액 적립 평가액', data: conv(d.valPath), borderColor: C.b, backgroundColor: C.b, borderWidth: 1.5, pointRadius: 0, tension: 0 },
      { label: '현금풀', data: conv(v.cashPath), borderColor: C.s, backgroundColor: C.s, borderWidth: 1.2, pointRadius: 0, tension: 0, borderDash: [4, 3] },
    ] }, options: baseOpts(val => shortMoney(val), { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12 } }, tooltip: { backgroundColor: '#1A1A1A', callbacks: { label: c => c.dataset.label + ': ' + money(c.raw) } } } }) });
    $('#t3y').innerHTML = table(['예산 연도', '개월', '집행액', '정액 기준', '차이', '증액 / 감액 (실집행)'],
      v.yearly.map((y, k) => { const fixed = y.months * A; const bs = v.buys.slice(k * 12, k * 12 + y.months); return [`${y.from} ~ ${y.to}`, y.months, money(y.total, !isUSD()), money(fixed, !isUSD()), sgn(y.total - fixed, x => (x < 0 ? '−' : '') + money(Math.abs(x), !isUSD())), `${bs.filter(b => b > A * 1.0001).length} / ${bs.filter(b => b < A * 0.9999).length}`]; }), { num: [1, 2, 3, 4, 5] });
    renderOptimizer();
  }
  function famLabel(rec) {
    const k2 = rec.w2 == null ? '' : ` / ±${rec.w2}`;
    if (rec.family === 'a') { const c = rec.center === 'mu' ? `μ${rec.muW === 'all' ? '(전기간)' : rec.muW + '년'}` : rec.center === 'fixed' ? `고정 ${rec.muW}%` : '0'; return `전월 대비 · ${c} ± ${rec.w1}${k2}%p`; }
    if (rec.family === 'b') return `낙폭 −${rec.w1}%${rec.w2 != null ? ' / −' + rec.w2 + '%' : ''} 증액 · 고점 ${rec.uth}% 이내 감액`;
    if (rec.family === 'c') return `200일선 ±${rec.w1}${k2}%`;
    if (rec.family === 'g') return `추세선(${rec.trendW === 'all' ? '전기간' : rec.trendW + '년'}) ±${rec.w1}${k2}%`;
    return `VIX ≥${rec.w1}${rec.w2 != null ? ' / ≥' + rec.w2 : ''} 증액 · ≤${rec.uth} 감액`;
  }
  function applyRecord(rec) {
    const r = state.rule;
    r.type = rec.family; r.shape = rec.shape; r.u1 = rec.u1; r.u2 = rec.u2; r.d1 = rec.d1; r.d2 = rec.d2;
    if (rec.family === 'a') { r.center = rec.center; if (rec.center === 'mu') r.muW = rec.muW === 'all' ? 'all' : +rec.muW; if (rec.center === 'fixed') r.fixedAnnual = +rec.muW; r.k1 = rec.w1; r.k2 = rec.w2; }
    else if (rec.family === 'b') { r.t1 = rec.w1; r.t2 = rec.w2; r.s = rec.uth; }
    else if (rec.family === 'c') { r.k1 = rec.w1; r.k2 = rec.w2; }
    else if (rec.family === 'g') { r.trendW = rec.trendW === 'all' ? 'all' : +rec.trendW; r.k1 = rec.w1; r.k2 = rec.w2; }
    else if (rec.family === 'f') { r.v1 = rec.w1; r.v2 = rec.w2; r.w = rec.uth; }
    state.budget.mode = rec.mode;
    if (state.results && state.results.buy_day) { state.buyDay = state.results.buy_day; $('#buyDay2').value = state.buyDay; $('#buyDay3').value = state.buyDay; }
    syncRuleForm(); invalidate([3, 4]);
    window.scrollTo({ top: $('#tab3').offsetTop - 10, behavior: 'smooth' });
  }
  function renderOptimizer() {
    const R = state.results;
    if (!R) { $('#tOpt').innerHTML = '<p class="note">최적화 결과(data/results.json)가 아직 없습니다. GitHub Actions 첫 실행 뒤 표시됩니다.</p>'; $('#famSeg').innerHTML = ''; $('#tHeat').innerHTML = ''; return; }
    $('#optLead').insertAdjacentHTML('beforeend', $('#optLead').dataset.done ? '' : ` <span class="hint">계산 ${(R.updated || '').slice(0, 10)} · 전 기간 ${R.periods.full.from}~${R.periods.full.to} · 표본 내 ~${(R.periods.is || {}).to || '–'} · 롤링 ${R.n_windows}개 창 · 정액 IRR 전 기간 ${R.dca.full.irr}% / 표본 외 ${(R.dca.oos || {}).irr}%</span>`);
    $('#optLead').dataset.done = '1';
    const fams = ['overall', ...Object.keys(R.families)];
    $('#famSeg').innerHTML = fams.map(f => `<button data-f="${f}" class="${state.fam === f ? 'on' : ''}">${f === 'overall' ? '종합 상위' : FAMS[f] || f}</button>`).join('');
    $$('#famSeg button').forEach(b => b.addEventListener('click', () => { state.fam = b.dataset.f; renderOptimizer(); }));
    const recs = state.fam === 'overall' ? R.overall : R.families[state.fam].top;
    const rows = recs.map((rec, i) => [
      i + 1, famLabel(rec), `×${rec.u1}/${rec.u2} · ×${rec.d1}/${rec.d2} ${rec.shape === 'ramp' ? '경사' : ''}`, rec.mode,
      sgn(rec.eirr_is, x => x.toFixed(2) + '%p'), sgn(rec.eirr_oos, x => x.toFixed(2) + '%p'), sgn(rec.exc_full, x => x.toFixed(2) + '%'),
      rec.win != null ? rec.win.toFixed(0) + '%' : '–', `${rec.roll_mean != null ? (rec.roll_mean > 0 ? '+' : '') + rec.roll_mean.toFixed(2) : '–'} / ${rec.roll_min != null ? rec.roll_min.toFixed(2) : '–'}%`,
      `${rec.xups != null ? rec.xups : rec.ups} / ${rec.xdowns != null ? rec.xdowns : rec.downs}`, `<button class="btn sm ghost" data-i="${i}">적용</button>`]);
    $('#tOpt').innerHTML = table(['#', '규칙', '배수', '예산', '표본 내 초과 IRR', '표본 외 초과 IRR', '전 기간 초과수익', '롤링 10년 승률', '롤링 평균 / 최악', '증액 / 감액 (개월)', ''], rows, { num: [0, 4, 5, 6, 7, 8, 9], cls: 'opt' });
    $$('#tOpt button').forEach(b => b.addEventListener('click', () => applyRecord(recs[+b.dataset.i])));
    if (state.fam === 'overall') { $('#heatTitle').style.display = 'none'; $('#tHeat').innerHTML = ''; return; }
    const H = R.families[state.fam].heat; $('#heatTitle').style.display = '';
    $('#heatTitle').textContent = `히트맵 — 1단계 폭 × 증액 배수 (표본 내 초과 IRR %p, 감액 배수 ×${H.d1}, 상위 조합의 나머지 설정 고정)`;
    const vals = H.eirr_is.flat().filter(x => x != null); const mx = Math.max(0.01, ...vals.map(Math.abs));
    const cell = x => { if (x == null) return '<td>–</td>'; const a = Math.min(1, Math.abs(x) / mx); const bg = x >= 0 ? `rgba(245,130,32,${(0.12 + 0.6 * a).toFixed(2)})` : `rgba(4,59,114,${(0.12 + 0.6 * a).toFixed(2)})`; return `<td style="background:${bg};color:${a > 0.55 ? '#fff' : '#1A1A1A'}">${x > 0 ? '+' : ''}${x.toFixed(2)}</td>`; };
    const th = '<th>1단계 폭 \\ 증액 배수</th>' + H.u1.map(u => `<th class="n">×${u}</th>`).join('') + '<th class="n">표본 외 (×' + H.u1[0] + '…)</th><th class="n">승률</th>';
    const trs = H.w1.map((w, i) => `<tr><td>${w}${state.fam === 'a' ? '%p' : state.fam === 'f' ? '' : '%'}</td>` + H.u1.map((u, j) => cell(H.eirr_is[i][j])).join('') + `<td class="n">${H.eirr_oos[i].map(x => x == null ? '–' : (x > 0 ? '+' : '') + x.toFixed(2)).join(' · ')}</td><td class="n">${H.win[i].map(x => x == null ? '–' : x.toFixed(0)).join(' · ')}</td></tr>`).join('');
    $('#tHeat').innerHTML = `<table class="dt heat"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table><p class="hint">표본 외·승률 열은 증액 배수 순서대로 나열한 값입니다. 색이 넓게 고른 구간(고원)이 특정 칸만 튀는 봉우리보다 믿을 만합니다.</p>`;
  }

  // ---------- ④ 이번 달 매수금액 ----------
  function renderTab4() {
    const tg = T(), A = state.amount, D = tg.dates, valIdx = D.length - 1;
    const { startYM } = getWindow();
    if (!$('#calcStart').value) $('#calcStart').value = state.calcStart || startYM;
    const start = state.calcStart || startYM;
    $('#calcRuleText').textContent = '적용 규칙: ' + ruleText() + ' · 매수일 ' + dayLabel(state.buyDay) + ' (③에서 변경)';
    const endYM = E.latestCompleteYM(D, state.buyDay);
    let sched = E.monthlySchedule(D, start, endYM, state.buyDay);
    const lastYM = D[valIdx].slice(0, 7);
    // 이번 달 매수일이 이미 지났는데 '아직 매수 전'이면 이번 달을 계산 대상으로 되돌림
    let targetYM;
    if (sched.length && D[sched[sched.length - 1]].slice(0, 7) === lastYM && state.calcDone === 0) { sched = sched.slice(0, -1); targetYM = lastYM; }
    else targetYM = sched.length ? E.ymAdd(D[sched[sched.length - 1]].slice(0, 7), 1) : (start > lastYM ? start : lastYM);
    if (sched.length && D[sched[sched.length - 1]].slice(0, 7) >= targetYM) targetYM = E.ymAdd(D[sched[sched.length - 1]].slice(0, 7), 1);
    const n = sched.length, j = n % 12;
    let cash = (+state.budget.seedMonths || 0) * A, spentYear = 0, hist = null;
    if (n > 0) {
      const TR = E.computeTriggers(tg, aux(), sched);
      hist = E.runVariable(tg, sched, sched[n - 1], A, state.rule, TR, state.budget, E.ratesFor(rateSeries(), D, sched));
      cash = hist.cash; spentYear = hist.buys.slice(n - j).reduce((a, b) => a + b, 0);
    }
    if (state.calcCash != null) cash = state.calcCash;
    const lastBuyIdx = n > 0 ? sched[n - 1] : null;
    const now = E.triggersNow(tg, aux(), lastBuyIdx);
    const Tn = { mom: [now.mom], dd: [now.dd], dev200: [now.dev200], vix: [now.vix], mu: {}, trend: {} };
    for (const W of E.WINDOWS) { Tn.mu[W] = [now.mu[W]]; Tn.trend[W] = [now.trend[W]]; }
    const b = E.bandAt(state.rule, Tn, 0), mult = E.multiplier(b);
    const modeA = state.budget.mode === 'A';
    const avail = cash + A;
    const base = modeA ? (12 * A - spentYear) / (12 - j) : A;
    let buy = Math.min(base * mult, avail);
    if (modeA && j === 11) buy = avail;
    if (!modeA) { const cap = (+state.budget.capMonths || 0) * A; const after = avail - buy; if (after > cap) buy += after - cap; }
    buy = Math.max(0, Math.min(buy, avail));
    const fxK = (isUSD() && S().USDKRW) ? S().USDKRW.close[S().USDKRW.dates.length - 1] : null;
    const verdict = mult > 1 ? 'up' : mult < 1 ? 'down' : 'neutral';
    const vLabel = { up: '증액', down: '감액', neutral: '중립 (정액)' }[verdict];
    $('#calcAmt').textContent = money(buy, !isUSD());
    $('#calcAmtSub').textContent = (isUSD() && fxK ? `약 ${Math.round(buy * fxK).toLocaleString('ko-KR')}원 (환율 ${fxK.toLocaleString()}) · ` : '') + `${targetYM} 매수분, 기준 ${money(base, !isUSD())} × ${mult.toFixed(2)}`;
    const bandTxt = b.y == null ? '지표 값 없음 (정액 매수)' : `지표 ${b.y.toFixed(2)}${state.rule.type === 'f' ? ' (VIX ' + (-b.y).toFixed(1) + ')' : '%'} · 증액 기준 ≤ ${isFinite(b.L1) ? b.L1.toFixed(2) : '–'}${isFinite(b.L2) ? ' / ≤ ' + b.L2.toFixed(2) : ''} · 감액 기준 ≥ ${isFinite(b.U1) ? b.U1.toFixed(2) : '–'}${isFinite(b.U2) ? ' / ≥ ' + b.U2.toFixed(2) : ''}`;
    $('#calcBadge').innerHTML = `<span class="badge ${verdict}">${vLabel} ×${mult.toFixed(2)}</span> <span class="hint">${bandTxt}</span>`;
    const nextDate = state.buyDay === 'last' ? `${targetYM} 말일` : `${targetYM}-${String(state.buyDay).padStart(2, '0')}`;
    $('#calcFacts').innerHTML = [
      ['매수 예정일', nextDate + (state.buyDay !== 'last' ? ' (비거래일이면 다음 거래일)' : '')],
      ['개시 이후 매수 횟수', `${n}회 (${start}~)`],
      ['현금풀 잔액 → 이번 달 유입 후', `${money(cash, !isUSD())} → ${money(avail, !isUSD())}`],
      ['집행 후 현금풀', money(avail - buy, !isUSD())],
      ['예산 연도 내 순서', `${j + 1}번째 달` + (modeA ? ` · 누적 집행 ${money(spentYear, !isUSD())} / 잔여 ${money(12 * A - spentYear, !isUSD())}` : '')],
      state.calcCash != null ? ['현금풀', '직접 입력값 사용'] : (hist ? ['현금풀 근거', `규칙대로 집행 가정 (${n}회 시뮬레이션)`] : ['현금풀 근거', '초기값']),
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const r = state.rule;
    const mu = now.mu[r.type === 'a' && r.center === 'mu' ? r.muW : 30], tr = now.trend[r.type === 'g' ? r.trendW : 30];
    $('#calcMarket').innerHTML = [
      ['최근 종가', `${now.close.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${now.date})`],
      ['직전 매수일 대비', lastBuyIdx != null ? `${sgn(now.mom, x => x.toFixed(2) + '%')} (${D[lastBuyIdx]})` : '–'],
      ['52주 고점 대비', sgn(now.dd, x => x.toFixed(2) + '%')],
      ['200일 이동평균 이격도', now.dev200 != null ? sgn(now.dev200, x => x.toFixed(2) + '%') : '–'],
      ['VIX', now.vix != null ? now.vix.toFixed(2) : '–'],
      [`μ (나스닥 종합 ${r.type === 'a' && r.center === 'mu' ? (r.muW === 'all' ? '전 기간' : r.muW + '년') : '30년'} 롤링, 월)`, mu != null ? mu.toFixed(3) + '%' : '–'],
      [`장기 추세선 이격도 (${r.type === 'g' ? (r.trendW === 'all' ? '전 기간' : r.trendW + '년') : '30년'})`, tr != null ? sgn(tr, x => x.toFixed(2) + '%') : '–'],
      isUSD() && fxK ? ['원/달러 (최근)', fxK.toLocaleString()] : null,
    ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const name = isUSD() ? 'QQQ' : 'TIGER 미국나스닥100';
    const why = b.y == null ? '지표 값이 없어 정액 매수' : r.type === 'a' ? `직전 매수일 대비 ${now.mom > 0 ? '+' : ''}${now.mom.toFixed(2)}% (기준 ${b.c != null ? b.c.toFixed(2) : '0'}% ± ${r.k1}%p)` : r.type === 'b' ? `52주 고점 대비 ${now.dd.toFixed(2)}%` : r.type === 'c' ? `200일선 대비 ${now.dev200 > 0 ? '+' : ''}${now.dev200.toFixed(2)}%` : r.type === 'g' ? `장기 추세선 대비 ${tr > 0 ? '+' : ''}${tr.toFixed(2)}%` : `VIX ${now.vix.toFixed(1)}`;
    $('#calcSummary').textContent = `[${now.date} 종가 기준] ${name} ${targetYM} 매수금액: ${money(buy, !isUSD())}${isUSD() && fxK ? ` (약 ${Math.round(buy * fxK).toLocaleString('ko-KR')}원)` : ''}\n판정: ${vLabel} ×${mult.toFixed(2)} — ${why}\n현금풀: ${money(cash, !isUSD())} → 집행 후 ${money(avail - buy, !isUSD())} · 규칙: ${ruleText()}`;
  }

  window.addEventListener('resize', () => { for (const k in charts) charts[k].resize(); });
  Chart.defaults.font.family = "'Inter','Noto Sans KR',sans-serif";
  Chart.defaults.color = '#3D3D3D';
  load();
})();
