/* 나스닥 적립매수 시뮬레이터 — 계산 엔진 (브라우저 / Node 공용)
 * scripts/backtest.py 와 동일한 규칙을 구현한다. 규칙을 바꾸면 두 파일을 함께 바꾼다.
 *
 * 데이터 형식: series = { dates: ['YYYY-MM-DD', ...], close: [...], adj: [...] }
 * 매수 스케줄: sched = [dates 인덱스, ...] (월 1회, 오름차순)
 */
(function (global) {
  'use strict';
  const E = {};
  const DAY = 86400000;

  // ---------- 날짜 ----------
  E.toTime = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  E.toStr = t => new Date(t).toISOString().slice(0, 10);
  E.ymAdd = (ym, n) => {
    let y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + String(m + 1).padStart(2, '0');
  };
  E.ymDiff = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
  // dates[idx] >= d 인 첫 인덱스
  E.lowerBound = (dates, d) => {
    let lo = 0, hi = dates.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < d) lo = mid + 1; else hi = mid; }
    return lo;
  };
  // dates[idx] <= d 인 마지막 인덱스 (없으면 -1)
  E.asOfIdx = (dates, d) => {
    const lb = E.lowerBound(dates, d);
    return (lb < dates.length && dates[lb] === d) ? lb : lb - 1;
  };
  E.isCalMonthEnd = d => E.toStr(E.toTime(d) + DAY).slice(0, 7) !== d.slice(0, 7);
  E.lastIdxOfMonth = (dates, ym) => {
    const lb = E.lowerBound(dates, E.ymAdd(ym, 1) + '-01');
    const idx = lb - 1;
    return (idx >= 0 && dates[idx].slice(0, 7) === ym) ? idx : -1;
  };

  // ---------- 월 1회 매수 스케줄 ----------
  // buyDay: 1..28 또는 'last'. 비거래일은 다음 거래일로 이월(같은 달 안에서), 'last' = 그 달 마지막 거래일.
  // 아직 도래하지 않은 달(데이터가 그 날짜에 못 미침)은 제외한다.
  E.monthlySchedule = function (dates, startYM, endYM, buyDay) {
    const out = [];
    const n = dates.length;
    for (let ym = startYM; ym <= endYM; ym = E.ymAdd(ym, 1)) {
      let idx;
      if (buyDay === 'last') {
        const lb = E.lowerBound(dates, E.ymAdd(ym, 1) + '-01');
        if (lb < n) idx = lb - 1;                       // 다음 달 데이터가 있음 → 이 달은 완결
        else { idx = n - 1; if (!E.isCalMonthEnd(dates[idx])) continue; }
        if (idx < 0 || dates[idx].slice(0, 7) !== ym) continue;
      } else {
        const d = ym + '-' + String(buyDay).padStart(2, '0');
        idx = E.lowerBound(dates, d);
        if (idx >= n) continue;                          // 아직 도래하지 않음
        if (dates[idx].slice(0, 7) !== ym) {             // 휴장으로 다음 달로 넘어간 경우 → 그 달 마지막 거래일
          idx = E.lastIdxOfMonth(dates, ym);
          if (idx < 0) continue;
        }
      }
      if (out.length === 0 || out[out.length - 1] !== idx) out.push(idx);
    }
    return out;
  };

  // 가장 최근 '완결된' 달 (모든 매수일 옵션에 공통으로 쓰기 위해 'last' 기준)
  E.latestCompleteYM = function (dates, buyDay) {
    let ym = dates[dates.length - 1].slice(0, 7);
    for (let k = 0; k < 3; k++) {
      if (E.monthlySchedule(dates, ym, ym, buyDay).length) return ym;
      ym = E.ymAdd(ym, -1);
    }
    return ym;
  };
  E.defaultWindow = function (dates, months, buyDay) {
    const endYM = E.latestCompleteYM(dates, buyDay || 'last');
    return { startYM: E.ymAdd(endYM, -(months - 1)), endYM };
  };
  // 데이터 시작 다음 달 (첫 달은 상장일 때문에 불완전할 수 있음)
  E.firstFullYM = dates => E.ymAdd(dates[0].slice(0, 7), 1);

  // 월 평균가 (수정종가) : { 'YYYY-MM': avg }
  E.monthAverages = function (series) {
    const out = {}; const cnt = {};
    for (let i = 0; i < series.dates.length; i++) {
      const ym = series.dates[i].slice(0, 7);
      out[ym] = (out[ym] || 0) + series.adj[i]; cnt[ym] = (cnt[ym] || 0) + 1;
    }
    for (const k in out) out[k] /= cnt[k];
    return out;
  };

  // ---------- 수익률 ----------
  // cfs: [{t: 일수, v: 금액}] → 연 수익률(소수). 해가 없으면 NaN
  E.xirr = function (cfs) {
    const f = r => { let s = 0; for (const c of cfs) s += c.v / Math.pow(1 + r, c.t / 365); return s; };
    let lo = -0.99, hi = 10, flo = f(lo), fhi = f(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return NaN;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (Math.abs(fm) < 1e-7 || hi - lo < 1e-10) return mid;
      if (fm * flo > 0) { lo = mid; flo = fm; } else hi = mid;
    }
    return (lo + hi) / 2;
  };
  E.maxDrawdown = function (path) {
    let peak = -Infinity, mdd = 0;
    for (const v of path) { if (v > peak) peak = v; if (peak > 0) mdd = Math.min(mdd, v / peak - 1); }
    return mdd;
  };

  // ---------- 정액 매수 (매수일·주기 비교용) ----------
  // purchases: [{i: dates 인덱스, amt}] → 결과
  E.runFixed = function (tg, purchases, valIdx) {
    const P = tg.adj, D = tg.dates;
    let shares = 0, invested = 0;
    for (const p of purchases) { shares += p.amt / P[p.i]; invested += p.amt; }
    const fv = shares * P[valIdx];
    const t0 = E.toTime(D[purchases[0].i]);
    const cfs = purchases.map(p => ({ t: (E.toTime(D[p.i]) - t0) / DAY, v: -p.amt }));
    cfs.push({ t: (E.toTime(D[valIdx]) - t0) / DAY, v: fv });
    return { fv, invested, shares, cash: 0, avgCost: invested / shares, ret: fv / invested - 1, irr: E.xirr(cfs), purchases, n: purchases.length };
  };
  // 표본 시점(sampleIdx 배열)마다 평가액 경로
  E.valuePath = function (tg, purchases, sampleIdx) {
    const P = tg.adj; const out = []; let k = 0, shares = 0;
    for (const s of sampleIdx) {
      while (k < purchases.length && purchases[k].i <= s) { shares += purchases[k].amt / P[purchases[k].i]; k++; }
      out.push(shares * P[s]);
    }
    return out;
  };

  // 주 1회 / 격주 스케줄 (weekday 1=월 .. 5=금, step 1=매주 2=격주). 첫 월 매수일이 속한 주부터 마지막 월 매수일까지.
  E.weeklySchedule = function (dates, startIdx, endIdx, weekday, step) {
    const out = [];
    const t0 = E.toTime(dates[startIdx]);
    const dow0 = (new Date(t0).getUTCDay() + 6) % 7;            // 0=월
    const tEnd = E.toTime(dates[endIdx]);
    for (let ws = t0 - dow0 * DAY; ws <= tEnd; ws += 7 * DAY * step) {
      const cand = E.toStr(ws + (weekday - 1) * DAY);
      const idx = E.lowerBound(dates, cand);
      if (idx >= dates.length || idx > endIdx) break;
      if (idx < startIdx) continue;
      if (out.length === 0 || out[out.length - 1] !== idx) out.push(idx);
    }
    return out;
  };

  // 1번: 매수일 비교. days = [1,5,10,15,20,25,'last']
  E.dayOfMonthStudy = function (tg, startYM, endYM, A, valIdx, days) {
    const mavg = E.monthAverages(tg);
    return days.map(day => {
      const sched = E.monthlySchedule(tg.dates, startYM, endYM, day);
      if (!sched.length) return { day, n: 0 };
      const r = E.runFixed(tg, sched.map(i => ({ i, amt: A })), valIdx);
      let ratio = 0;
      for (const i of sched) ratio += tg.adj[i] / mavg[tg.dates[i].slice(0, 7)] - 1;
      r.monthRatio = ratio / sched.length;       // 그 달 평균가 대비 매수단가 (음수 = 평균보다 싸게 매수)
      r.day = day; r.sched = sched;
      return r;
    });
  };
  // 1번 보조: 롤링 L개월 창마다 매수일별 순위 → 안정성
  E.dayStability = function (tg, A, days, L) {
    const startYM = E.firstFullYM(tg.dates), endYM = E.latestCompleteYM(tg.dates, 'last');
    const scheds = days.map(d => E.monthlySchedule(tg.dates, startYM, endYM, d));
    const M = Math.min(...scheds.map(s => s.length));
    if (M < L) return { windows: 0, stats: days.map(d => ({ day: d })) };
    const pre = scheds.map(s => { const p = [0]; for (let k = 0; k < M; k++) p.push(p[k] + 1 / tg.adj[s[k]]); return p; });
    const W = M - L + 1;
    const top = days.map(() => 0), rankSum = days.map(() => 0), first = days.map(() => 0);
    for (let s = 0; s < W; s++) {
      const fvs = days.map((d, k) => A * (pre[k][s + L] - pre[k][s]) * tg.adj[scheds[k][s + L - 1]]);
      const order = fvs.map((v, k) => k).sort((a, b) => fvs[b] - fvs[a]);
      order.forEach((k, rank) => { rankSum[k] += rank + 1; if (rank < 2) top[k]++; if (rank === 0) first[k]++; });
    }
    return { windows: W, months: M, stats: days.map((d, k) => ({ day: d, top2: top[k] / W, first: first[k] / W, avgRank: rankSum[k] / W })) };
  };

  // 2번: 매수 주기 비교 (연 총액 동일). monthlySched 기준 창.
  E.frequencyStudy = function (tg, monthlySched, A, valIdx, weekdayForChart) {
    const months = monthlySched.length, total = months * A;
    const s0 = monthlySched[0], s1 = monthlySched[months - 1];
    const out = {};
    out.monthly = E.runFixed(tg, monthlySched.map(i => ({ i, amt: A })), valIdx);
    out.weekly = {}; out.biweekly = {};
    for (let wd = 1; wd <= 5; wd++) {
      const w = E.weeklySchedule(tg.dates, s0, s1, wd, 1);
      out.weekly[wd] = E.runFixed(tg, w.map(i => ({ i, amt: total / w.length })), valIdx);
      const b = E.weeklySchedule(tg.dates, s0, s1, wd, 2);
      out.biweekly[wd] = E.runFixed(tg, b.map(i => ({ i, amt: total / b.length })), valIdx);
    }
    const yearly = [];
    for (let m = 0; m < months; m += 12) yearly.push({ i: monthlySched[m], amt: Math.min(12, months - m) * A });
    out.lumpYearly = E.runFixed(tg, yearly, valIdx);
    out.lumpInitial = E.runFixed(tg, [{ i: s0, amt: total }], valIdx);
    const wd = weekdayForChart || 1;
    out.paths = {
      monthly: E.valuePath(tg, out.monthly.purchases, monthlySched),
      weekly: E.valuePath(tg, out.weekly[wd].purchases, monthlySched),
      biweekly: E.valuePath(tg, out.biweekly[wd].purchases, monthlySched),
      lumpYearly: E.valuePath(tg, out.lumpYearly.purchases, monthlySched),
      lumpInitial: E.valuePath(tg, out.lumpInitial.purchases, monthlySched),
    };
    out.total = total; out.months = months;
    return out;
  };

  // ---------- 3번: 트리거 시계열 ----------
  // aux: { IXIC: series, VIX: series }  (없어도 동작)
  E.monthEndPoints = function (ix) {
    const pts = [];
    for (let i = 0; i < ix.dates.length; i++) {
      const last = (i === ix.dates.length - 1) || ix.dates[i + 1].slice(0, 7) !== ix.dates[i].slice(0, 7);
      if (last) pts.push({ d: ix.dates[i], t: E.toTime(ix.dates[i]) / DAY / 365.25, lp: Math.log(ix.close[i]) });
    }
    return pts;
  };
  // 그 시점까지의 과거 W년(또는 전 기간) 연평균 → 월 환산 수익률(%)
  E.muAt = function (ix, dateStr, W) {
    const i1 = E.asOfIdx(ix.dates, dateStr); if (i1 < 1) return null;
    let i0 = 0;
    if (W !== 'all') { const t0 = E.toStr(E.toTime(dateStr) - Math.round(W * 365.25) * DAY); i0 = Math.max(0, E.asOfIdx(ix.dates, t0)); }
    const years = (E.toTime(ix.dates[i1]) - E.toTime(ix.dates[i0])) / DAY / 365.25;
    if (years < 1) return null;
    const cagr = Math.pow(ix.close[i1] / ix.close[i0], 1 / years) - 1;
    return (Math.pow(1 + cagr, 1 / 12) - 1) * 100;
  };
  // 과거 W년 월말 로그가격 회귀 추세선 대비 현재 지수 괴리(%)
  E.trendDevAt = function (ix, pts, dateStr, W) {
    const tNow = E.toTime(dateStr) / DAY / 365.25;
    const tMin = W === 'all' ? -Infinity : tNow - W;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of pts) {
      if (p.d > dateStr) break;
      if (p.t < tMin) continue;
      n++; sx += p.t; sy += p.lp; sxx += p.t * p.t; sxy += p.t * p.lp;
    }
    if (n < 24) return null;
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
    const i1 = E.asOfIdx(ix.dates, dateStr); if (i1 < 0) return null;
    return (ix.close[i1] / Math.exp(a + b * tNow) - 1) * 100;
  };
  E.WINDOWS = [10, 20, 30, 'all'];
  E.computeTriggers = function (tg, aux, sched) {
    const n = sched.length, P = tg.adj, D = tg.dates;
    const T = { mom: [], dd: [], dev200: [], vix: [], mu: {}, trend: {} };
    for (const W of E.WINDOWS) { T.mu[W] = []; T.trend[W] = []; }
    const ix = aux && aux.IXIC, vx = aux && aux.VIX;
    const pts = ix ? E.monthEndPoints(ix) : null;
    for (let m = 0; m < n; m++) {
      const i = sched[m];
      T.mom.push(m > 0 ? (P[i] / P[sched[m - 1]] - 1) * 100 : null);
      let hi = 0; for (let j = Math.max(0, i - 251); j <= i; j++) if (P[j] > hi) hi = P[j];
      T.dd.push((P[i] / hi - 1) * 100);
      if (i >= 199) { let s = 0; for (let j = i - 199; j <= i; j++) s += P[j]; T.dev200.push((P[i] / (s / 200) - 1) * 100); } else T.dev200.push(null);
      if (vx) { const k = E.asOfIdx(vx.dates, D[i]); T.vix.push(k >= 0 ? vx.close[k] : null); } else T.vix.push(null);
      for (const W of E.WINDOWS) {
        T.mu[W].push(ix ? E.muAt(ix, D[i], W) : null);
        T.trend[W].push(ix ? E.trendDevAt(ix, pts, D[i], W) : null);
      }
    }
    return T;
  };
  // 최근 종가 시점의 트리거 값 (이번 달 계산기용). lastBuyIdx = 직전 매수일 인덱스
  E.triggersNow = function (tg, aux, lastBuyIdx) {
    const i = tg.dates.length - 1;
    const one = E.computeTriggers(tg, aux, lastBuyIdx != null && lastBuyIdx >= 0 ? [lastBuyIdx, i] : [i]);
    const m = one.mom.length - 1;
    const out = { date: tg.dates[i], close: tg.close ? tg.close[i] : tg.adj[i], mom: one.mom[m], dd: one.dd[m], dev200: one.dev200[m], vix: one.vix[m], mu: {}, trend: {} };
    for (const W of E.WINDOWS) { out.mu[W] = one.mu[W][m]; out.trend[W] = one.trend[W][m]; }
    return out;
  };

  // ---------- 3번: 규칙 → 밴드 ----------
  // rule: { type: 'a'|'b'|'c'|'f'|'g'|'none', center: 'mu'|'zero'|'fixed', muW, fixedAnnual,
  //         k1, k2(null=없음), t1, t2, s, v1, v2, w, trendW, u1, u2, d1, d2, shape: 'step'|'ramp' }
  // 반환 y와 밴드: y<=L1 증액(u1), y<=L2 증액 2단계(u2), y>=U1 감액(d1), y>=U2 감액 2단계(d2)
  E.bandAt = function (rule, T, m) {
    const inf = Infinity;
    const b = { y: null, L1: -inf, L2: -inf, U1: inf, U2: inf, u1: rule.u1, u2: rule.u2, d1: rule.d1, d2: rule.d2, shape: rule.shape || 'step' };
    const k2 = (rule.k2 == null || rule.k2 === '' ) ? inf : +rule.k2;
    switch (rule.type) {
      case 'a': {
        let c = 0;
        if (rule.center === 'mu') c = T.mu[rule.muW][m];
        else if (rule.center === 'fixed') c = (Math.pow(1 + (+rule.fixedAnnual) / 100, 1 / 12) - 1) * 100;
        if (c == null || T.mom[m] == null) return b;
        b.y = T.mom[m]; b.L1 = c - rule.k1; b.L2 = c - k2; b.U1 = c + rule.k1; b.U2 = c + k2; b.c = c;
        break;
      }
      case 'c': if (T.dev200[m] == null) return b; b.y = T.dev200[m]; b.L1 = -rule.k1; b.L2 = -k2; b.U1 = rule.k1; b.U2 = k2; break;
      case 'g': { const y = T.trend[rule.trendW][m]; if (y == null) return b; b.y = y; b.L1 = -rule.k1; b.L2 = -k2; b.U1 = rule.k1; b.U2 = k2; break; }
      case 'b': { const t2 = (rule.t2 == null || rule.t2 === '') ? inf : +rule.t2; b.y = T.dd[m]; b.L1 = -rule.t1; b.L2 = -t2; b.U1 = -(+rule.s); break; }
      case 'f': { if (T.vix[m] == null) return b; const v2 = (rule.v2 == null || rule.v2 === '') ? inf : +rule.v2; b.y = -T.vix[m]; b.L1 = -rule.v1; b.L2 = -v2; b.U1 = -rule.w; break; }
      default: break; // 'none' → 정액
    }
    return b;
  };
  E.multiplier = function (b) {
    const y = b.y;
    if (y == null || isNaN(y)) return 1;
    if (y <= b.L1) {
      if (b.shape === 'ramp' && isFinite(b.L2) && b.L2 < b.L1) { const f = Math.min(1, (b.L1 - y) / (b.L1 - b.L2)); return b.u1 + (b.u2 - b.u1) * f; }
      return y <= b.L2 ? b.u2 : b.u1;
    }
    if (y >= b.U1) {
      if (b.shape === 'ramp' && isFinite(b.U2) && b.U2 > b.U1) { const f = Math.min(1, (y - b.U1) / (b.U2 - b.U1)); return b.d1 + (b.d2 - b.d1) * f; }
      return y >= b.U2 ? b.d2 : b.d1;
    }
    return 1;
  };

  // ---------- 3번: 가변 적립 시뮬레이션 (매월 A 유입형) ----------
  // budget: { mode: 'A'|'B', capMonths, seedMonths }
  //   A = 잔여예산 재배분(연 12A 정확히 집행, 12번째 달 잔액 전량, 현금 0 리셋)
  //   B = 현금풀 이월(기준 A 고정, 미집행분 이월, 상한 초과분은 당월 매수에 추가)
  // rates: sched 각 시점의 연 이자율(%) 배열 (현금풀 이자, 없으면 null)
  E.runVariable = function (tg, sched, valIdx, A, rule, T, budget, rates) {
    const P = tg.adj, D = tg.dates, n = sched.length;
    const modeA = budget.mode === 'A';
    const cap = (budget.capMonths != null ? +budget.capMonths : 3) * A;
    let cash = (+budget.seedMonths || 0) * A, shares = 0, spentYear = 0;
    const buys = [], tgtMult = [], execMult = [], cashPath = [], valPath = [], ys = [], targets = [];
    let up = 0, down = 0, neutral = 0;
    for (let m = 0; m < n; m++) {
      const i = sched[m], j = m % 12;
      if (m > 0 && rates && rates[m - 1] != null) {
        const days = (E.toTime(D[i]) - E.toTime(D[sched[m - 1]])) / DAY;
        cash *= 1 + rates[m - 1] / 100 * days / 365;
      }
      cash += A;
      const b = E.bandAt(rule, T, m);
      const mult = E.multiplier(b);
      if (mult > 1) up++; else if (mult < 1) down++; else neutral++;
      const base = modeA ? (12 * A - spentYear) / (12 - j) : A;
      let buy = Math.min(base * mult, cash);
      if (modeA && j === 11) buy = cash;
      if (!modeA) { const after = cash - buy; if (after > cap) buy += after - cap; }
      buy = Math.max(0, Math.min(buy, cash));
      shares += buy / P[i]; cash -= buy; spentYear += buy;
      if (j === 11) spentYear = 0;
      buys.push(buy); tgtMult.push(mult); execMult.push(buy / A); cashPath.push(cash); valPath.push(shares * P[i] + cash); ys.push(b.y); targets.push(base * mult);
    }
    const fvStock = shares * P[valIdx], fv = fvStock + cash, invested = n * A;
    const t0 = E.toTime(D[sched[0]]);
    const cfs = sched.map(i => ({ t: (E.toTime(D[i]) - t0) / DAY, v: -A }));
    cfs.push({ t: (E.toTime(D[valIdx]) - t0) / DAY, v: fv });
    const totalBuy = buys.reduce((a, b) => a + b, 0);
    const purchases = sched.map((i, m) => ({ i, amt: buys[m] }));
    return {
      fv, fvStock, cash, invested, shares, ret: fv / invested - 1, irr: E.xirr(cfs),
      avgCost: shares > 0 ? totalBuy / shares : null, totalBuy,
      buys, tgtMult, execMult, cashPath, valPath, ys, targets, purchases,
      counts: { up, down, neutral, n }, avgExec: totalBuy / (n * A),
      yearly: E.yearlyTotals(sched, D, buys), mdd: E.maxDrawdown(valPath),
    };
  };
  E.yearlyTotals = function (sched, D, buys) {
    const out = [];
    for (let m = 0; m < sched.length; m += 12) {
      let s = 0; for (let k = m; k < Math.min(m + 12, sched.length); k++) s += buys[k];
      out.push({ from: D[sched[m]].slice(0, 7), to: D[sched[Math.min(m + 11, sched.length - 1)]].slice(0, 7), months: Math.min(12, sched.length - m), total: s });
    }
    return out;
  };
  // sched 각 시점의 이자율(연 %) : rate 시리즈를 as-of 로 붙임
  E.ratesFor = function (rateSeries, D, sched) {
    if (!rateSeries) return null;
    return sched.map(i => { const k = E.asOfIdx(rateSeries.dates, D[i]); return k >= 0 ? rateSeries.close[k] : null; });
  };

  // ---------- 원화 환산 (달러 종목용) ----------
  // res: runFixed/runVariable 결과, fx: 환율 시리즈 (USD/KRW)
  E.krwView = function (res, D, valIdx, fx) {
    if (!fx) return null;
    const fxAt = i => { const k = E.asOfIdx(fx.dates, D[i]); return k >= 0 ? fx.close[k] : null; };
    let invested = 0, buyKRW = 0;
    const t0 = E.toTime(D[res.purchases[0].i]);
    const cfs = [];
    const isVar = Array.isArray(res.buys);
    const contrib = isVar ? res.invested / res.purchases.length : null; // 가변형: 유입은 매월 A
    for (const p of res.purchases) {
      const f = fxAt(p.i); if (f == null) return null;
      const c = isVar ? contrib : p.amt;
      invested += c * f; buyKRW += p.amt * f;
      cfs.push({ t: (E.toTime(D[p.i]) - t0) / DAY, v: -c * f });
    }
    const fxVal = fxAt(valIdx); if (fxVal == null) return null;
    const fv = (res.fvStock != null ? res.fvStock : res.fv) * fxVal + (res.cash || 0) * fxVal;
    cfs.push({ t: (E.toTime(D[valIdx]) - t0) / DAY, v: fv });
    return { fv, invested, ret: fv / invested - 1, irr: E.xirr(cfs), avgCost: res.shares > 0 ? buyKRW / res.shares : null, fxVal };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  global.DCAEngine = E;
})(typeof window !== 'undefined' ? window : globalThis);
