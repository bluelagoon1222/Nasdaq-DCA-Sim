#!/usr/bin/env python3
"""나스닥 적립매수 시뮬레이터 — 가변 적립 규칙 격자 탐색 (GitHub Actions 에서 실행)

js/engine.js 와 동일한 규칙을 numpy 로 벡터화해 수천 개 파라미터 조합을 한 번에 평가한다.
규칙을 바꾸면 두 파일을 함께 바꾼다.

입력 : data/prices.json  (scripts/collect.py 가 생성)
출력 : data/results.json (index.html 의 '최적화 결과' 표·히트맵)

평가 설계
  - 대상 QQQ, 월 1,000달러 유입형, 매수일 25일(비거래일 → 다음 거래일)
  - 전 기간 1999.4~현재 / 표본 내 1999.4~2015.12 / 표본 외 2016.1~현재
  - 롤링 10년(120개월) 창 전부: 정액 대비 승률·평균 초과수익·최악 초과수익
  - 기준(정액 DCA) 과의 비교는 '매월 1,000달러 유입' 동일 현금흐름 기준 (현금 잔액 포함 최종평가액)
  - 선정: 표본 내 초과 IRR 의 고원 점수(인접 파라미터 평균) 1차, 롤링 승률 50% 이상 조건, 롤링 평균 초과수익 2차
"""
import json, math, os, sys, itertools, datetime as dt
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRICES = os.path.join(ROOT, 'data', 'prices.json')
OUT = os.path.join(ROOT, 'data', 'results.json')

TARGET = 'QQQ'
AMOUNT = 1000.0
BUY_DAY = 25
IS_END = '2015-12-31'
OOS_START = '2016-01-01'
ROLL_MONTHS = 120
TOP_N = 15

EPOCH = dt.date(1970, 1, 1).toordinal()
def days(d):  # 'YYYY-MM-DD' → 1970-01-01 기준 일수
    return dt.date.fromisoformat(d).toordinal() - EPOCH
def ym_add(ym, n):
    y, m = int(ym[:4]), int(ym[5:7]) - 1 + n
    y += m // 12; m %= 12
    return f'{y:04d}-{m + 1:02d}'
def lower_bound(dates, d):
    return int(np.searchsorted(dates, d, side='left'))
def as_of_idx(dates, d):
    lb = lower_bound(dates, d)
    return lb if lb < len(dates) and dates[lb] == d else lb - 1
def is_cal_month_end(d):
    x = dt.date.fromisoformat(d)
    return (x + dt.timedelta(days=1)).month != x.month
def last_idx_of_month(dates, ym):
    lb = lower_bound(dates, ym_add(ym, 1) + '-01')
    idx = lb - 1
    return idx if idx >= 0 and dates[idx][:7] == ym else -1

# ---------- 스케줄 (engine.js monthlySchedule 와 동일) ----------
def monthly_schedule(dates, start_ym, end_ym, buy_day):
    out = []
    n = len(dates)
    ym = start_ym
    while ym <= end_ym:
        if buy_day == 'last':
            lb = lower_bound(dates, ym_add(ym, 1) + '-01')
            if lb < n:
                idx = lb - 1
            else:
                idx = n - 1
                if not is_cal_month_end(dates[idx]):
                    ym = ym_add(ym, 1); continue
            if idx < 0 or dates[idx][:7] != ym:
                ym = ym_add(ym, 1); continue
        else:
            d = f'{ym}-{int(buy_day):02d}'
            idx = lower_bound(dates, d)
            if idx >= n:
                ym = ym_add(ym, 1); continue
            if dates[idx][:7] != ym:
                idx = last_idx_of_month(dates, ym)
                if idx < 0:
                    ym = ym_add(ym, 1); continue
        if not out or out[-1] != idx:
            out.append(idx)
        ym = ym_add(ym, 1)
    return out

def latest_complete_ym(dates, buy_day):
    ym = dates[-1][:7]
    for _ in range(3):
        if monthly_schedule(dates, ym, ym, buy_day):
            return ym
        ym = ym_add(ym, -1)
    return ym

# ---------- 트리거 (engine.js computeTriggers 와 동일) ----------
WINDOWS = [10, 20, 30, 'all']

def month_end_points(ix_dates, ix_close):
    pts = []
    n = len(ix_dates)
    for i in range(n):
        last = (i == n - 1) or ix_dates[i + 1][:7] != ix_dates[i][:7]
        if last:
            pts.append((ix_dates[i], days(ix_dates[i]) / 365.25, math.log(ix_close[i])))
    return pts

def mu_at(ix_dates, ix_close, d, W):
    i1 = as_of_idx(ix_dates, d)
    if i1 < 1: return np.nan
    i0 = 0
    if W != 'all':
        t0 = (dt.date.fromisoformat(d) - dt.timedelta(days=round(W * 365.25))).isoformat()
        i0 = max(0, as_of_idx(ix_dates, t0))
    years = (days(ix_dates[i1]) - days(ix_dates[i0])) / 365.25
    if years < 1: return np.nan
    cagr = (ix_close[i1] / ix_close[i0]) ** (1 / years) - 1
    return ((1 + cagr) ** (1 / 12) - 1) * 100

def trend_dev_at(ix_dates, ix_close, pts, d, W):
    t_now = days(d) / 365.25
    t_min = -math.inf if W == 'all' else t_now - W
    n = 0; sx = sy = sxx = sxy = 0.0
    for (pd_, t, lp) in pts:
        if pd_ > d: break
        if t < t_min: continue
        n += 1; sx += t; sy += lp; sxx += t * t; sxy += t * lp
    if n < 24: return np.nan
    b = (n * sxy - sx * sy) / (n * sxx - sx * sx); a = (sy - b * sx) / n
    i1 = as_of_idx(ix_dates, d)
    if i1 < 0: return np.nan
    return (ix_close[i1] / math.exp(a + b * t_now) - 1) * 100

Y_COLS = ['mom', 'dd', 'dev200', 'nvix', 'tr10', 'tr20', 'tr30', 'trall']
C_COLS = ['zero', 'mu10', 'mu20', 'mu30', 'muall', 'fixed8', 'fixed10', 'fixed12']

def compute_matrices(tg, ix, vx, sched):
    P = tg['adj']; D = tg['dates']; M = len(sched)
    Y = np.full((M, len(Y_COLS)), np.nan); C = np.zeros((M, len(C_COLS)))
    pts = month_end_points(ix['dates'], ix['close']) if ix else None
    for k, fixed in enumerate([8, 10, 12]):
        C[:, 5 + k] = ((1 + fixed / 100) ** (1 / 12) - 1) * 100
    for m, i in enumerate(sched):
        if m > 0: Y[m, 0] = (P[i] / P[sched[m - 1]] - 1) * 100
        hi = P[max(0, i - 251):i + 1].max(); Y[m, 1] = (P[i] / hi - 1) * 100
        if i >= 199: Y[m, 2] = (P[i] / P[i - 199:i + 1].mean() - 1) * 100
        if vx:
            kx = as_of_idx(vx['dates'], D[i])
            if kx >= 0: Y[m, 3] = -vx['close'][kx]
        if ix:
            for w, W in enumerate(WINDOWS):
                Y[m, 4 + w] = trend_dev_at(ix['dates'], ix['close'], pts, D[i], W)
                C[m, 1 + w] = mu_at(ix['dates'], ix['close'], D[i], W)
        else:
            C[m, 1:5] = np.nan
    return Y, C

# ---------- 배수 (engine.js multiplier 와 동일) ----------
def mult_vec(y, L1, L2, U1, U2, cb):
    u1, u2, d1, d2, ramp = cb['u1'], cb['u2'], cb['d1'], cb['d2'], cb['ramp']
    with np.errstate(invalid='ignore', divide='ignore'):
        below = y <= L1; above = y >= U1
        m_step = np.where(below, np.where(y <= L2, u2, u1), np.where(above, np.where(y >= U2, d2, d1), 1.0))
        fL = np.where(np.isfinite(L2), np.clip((L1 - y) / (L1 - L2), 0, 1), 0.0)
        fU = np.where(np.isfinite(U2), np.clip((y - U1) / (U2 - U1), 0, 1), 0.0)
        m_ramp = np.where(below, u1 + (u2 - u1) * fL, np.where(above, d1 + (d2 - d1) * fU, 1.0))
        m = np.where(ramp, m_ramp, m_step)
        m = np.where(np.isnan(y) | np.isnan(L1), 1.0, m)
    return m

# ---------- 시뮬레이션 (engine.js runVariable 와 동일, 조합 축 벡터화) ----------
def simulate(P, sched, dd, m0, m1, val_idx, A, cb, Y, C, rates, count=False):
    N = cb['u1'].size
    cash = cb['seed'] * A
    shares = np.zeros(N); spent = np.zeros(N)
    ups = np.zeros(N, dtype=np.int32); downs = np.zeros(N, dtype=np.int32)
    xups = np.zeros(N, dtype=np.int32); xdowns = np.zeros(N, dtype=np.int32)
    modeA = cb['modeA']; modeB = ~modeA; capv = cb['cap'] * A
    inf = np.inf
    for k, m in enumerate(range(m0, m1 + 1)):
        j = k % 12
        i = sched[m]
        if k > 0 and rates is not None and not np.isnan(rates[m - 1]):
            cash = cash * (1 + rates[m - 1] / 100 * (dd[i] - dd[sched[m - 1]]) / 365)
        cash = cash + A
        y = Y[m][cb['yid']]; c = C[m][cb['cid']]
        L1 = c - cb['w1']; L2 = c - cb['w2']
        U1 = np.where(cb['sym'], c + cb['w1'], cb['uth']); U2 = np.where(cb['sym'], c + cb['w2'], inf)
        mult = mult_vec(y, L1, L2, U1, U2, cb)
        if count:
            ups += mult > 1; downs += mult < 1
        base = np.where(modeA, (12 * A - spent) / (12 - j), A)
        buy = np.minimum(base * mult, cash)
        if j == 11: buy = np.where(modeA, cash, buy)
        after = cash - buy
        buy = np.where(modeB & (after > capv), buy + (after - capv), buy)
        buy = np.clip(buy, 0, cash)
        if count:
            xups += buy > A * 1.0001; xdowns += buy < A * 0.9999
        shares = shares + buy / P[i]; cash = cash - buy; spent = spent + buy
        if j == 11: spent = np.zeros(N)
    fv = shares * P[val_idx] + cash
    return (fv, ups, downs, xups, xdowns) if count else fv

# ---------- IRR (유입 현금흐름 동일 → FV 단조함수, 격자 보간) ----------
def irr_from_fv(fv, t_days, t_val, A):
    fv = np.asarray(fv, dtype=float)
    lo_v, hi_v = float(np.nanmin(fv)), float(np.nanmax(fv))
    if not np.isfinite(lo_v) or hi_v <= 0:
        return np.full(fv.shape, np.nan)
    grid = np.linspace(max(lo_v * 0.999, 1e-6), hi_v * 1.001, 400)
    tm = np.asarray(t_days) / 365.0; tv = t_val / 365.0
    lo = np.full(grid.shape, -0.95); hi = np.full(grid.shape, 5.0)
    for _ in range(70):
        mid = (lo + hi) / 2
        f = grid * (1 + mid) ** (-tv) - A * ((1 + mid[:, None]) ** (-tm[None, :])).sum(axis=1)
        pos = f > 0        # f 는 r 에 대해 감소 → f>0 이면 r 을 키워야 함
        lo = np.where(pos, mid, lo); hi = np.where(pos, hi, mid)
    irr = (lo + hi) / 2
    return np.interp(fv, grid, irr)

# ---------- 조합 생성 ----------
U1 = [1.1, 1.2, 1.3, 1.5, 2.0]
D1 = [0.5, 0.6, 0.7, 0.8, 0.9]
def u2_of(u1): return min(2.0, 1 + 2 * (u1 - 1))
def d2_of(d1): return max(0.5, 1 - 2 * (1 - d1))

FAMILIES = {
    'a': {'label': '전월 매수일 대비 등락률 (μ 중심 밴드)', 'sym': True,
          'w1': [2, 3, 4, 5], 'w2': lambda w: [w + 2, w + 4, np.inf], 'shapes': ['step', 'ramp'],
          'variants': [('mu', 10, 1), ('mu', 20, 2), ('mu', 30, 3), ('mu', 'all', 4), ('fixed', 8, 5), ('fixed', 10, 6), ('fixed', 12, 7), ('zero', None, 0)],
          'yid': 0},
    'b': {'label': '52주 고점 대비 낙폭', 'sym': False,
          'w1': [5, 10, 15, 20], 'w2': lambda w: [w + 10, w + 20, np.inf], 'shapes': ['step'],
          'uth': [0, 2, 5], 'yid': 1},
    'c': {'label': '200일 이동평균 이격도', 'sym': True,
          'w1': [5, 10, 15, 20], 'w2': lambda w: [w + 5, w + 10, np.inf], 'shapes': ['step', 'ramp'], 'yid': 2},
    'f': {'label': 'VIX 수준 (공포·탐욕형)', 'sym': False,
          'w1': [20, 25, 30], 'w2': lambda w: [w + 10, np.inf], 'shapes': ['step'],
          'uth': [12, 15, 18], 'yid': 3},
    'g': {'label': '장기 추세선 이격도', 'sym': True,
          'w1': [10, 20, 30, 40], 'w2': lambda w: [w + 15, w + 30, np.inf], 'shapes': ['step', 'ramp'],
          'trendW': [(10, 4), (20, 5), (30, 6), ('all', 7)]},
}

def build_combos(fam_key):
    F = FAMILIES[fam_key]
    rows = []
    if fam_key == 'a':
        variants = [(('center', v[0], 'muW', v[1]), v[2], F['yid']) for v in F['variants']]
    elif fam_key == 'g':
        variants = [(('trendW', tw[0]), 0, tw[1]) for tw in F['trendW']]
    else:
        variants = [((), 0, F['yid'])]
    uths = F.get('uth', [None])
    for (meta, cid, yid), uth, shape, mode in itertools.product(variants, uths, F['shapes'], ['A', 'B']):
        for iw, w1 in enumerate(F['w1']):
            for iw2, w2 in enumerate(F['w2'](w1)):
                for iu, u1 in enumerate(U1):
                    for idd, d1 in enumerate(D1):
                        rows.append(dict(meta=meta, cid=cid, yid=yid, uth=(-uth if uth is not None else np.nan),
                                         sym=F['sym'], w1=w1, w2=w2, iw2=iw2, iw=iw, iu=iu, idd=idd,
                                         u1=u1, u2=u2_of(u1), d1=d1, d2=d2_of(d1), shape=shape, modeA=(mode == 'A'),
                                         group=(meta, cid, yid, uth, shape, mode, iw2)))
    cb = {k: np.array([r[k] for r in rows]) for k in ['cid', 'yid', 'uth', 'sym', 'w1', 'w2', 'u1', 'u2', 'd1', 'd2', 'modeA']}
    cb['ramp'] = np.array([r['shape'] == 'ramp' for r in rows])
    cb['cap'] = np.full(len(rows), 3.0); cb['seed'] = np.zeros(len(rows))
    cb['uth'] = np.where(np.isnan(cb['uth'].astype(float)), 0.0, cb['uth'].astype(float))
    return rows, cb

# ---------- 고원 점수: (w1, u1, d1) 3차원 인접 평균 ----------
def plateau_scores(rows, metric):
    groups = {}
    for idx, r in enumerate(rows):
        groups.setdefault(r['group'], []).append(idx)
    out = np.full(len(rows), np.nan)
    for g, idxs in groups.items():
        nw = max(r['iw'] for r in (rows[i] for i in idxs)) + 1
        cube = np.full((nw, len(U1), len(D1)), np.nan)
        for i in idxs:
            r = rows[i]; cube[r['iw'], r['iu'], r['idd']] = metric[i]
        pad = np.pad(cube, 1, constant_values=np.nan)
        acc = np.zeros_like(cube); cnt = np.zeros_like(cube)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    s = pad[1 + dx:1 + dx + nw, 1 + dy:1 + dy + len(U1), 1 + dz:1 + dz + len(D1)]
                    ok = ~np.isnan(s); acc += np.where(ok, s, 0); cnt += ok
        pl = acc / np.where(cnt == 0, np.nan, cnt)
        for i in idxs:
            r = rows[i]; out[i] = pl[r['iw'], r['iu'], r['idd']]
    return out

def main():
    with open(PRICES, encoding='utf-8') as f:
        data = json.load(f)
    S = data['series']
    if TARGET not in S:
        print('no target series'); sys.exit(1)
    tg = {'dates': np.array(S[TARGET]['dates']), 'adj': np.array(S[TARGET]['adj'], dtype=float)}
    ix = S.get('IXIC'); vx = S.get('VIX'); irx = S.get('IRX')
    if ix: ix = {'dates': np.array(ix['dates']), 'close': np.array(ix['close'], dtype=float)}
    if vx: vx = {'dates': np.array(vx['dates']), 'close': np.array(vx['close'], dtype=float)}
    D = tg['dates']; P = tg['adj']
    dd = np.array([days(d) for d in D])

    start_ym = ym_add(D[0][:7], 1)
    end_ym = latest_complete_ym(D, BUY_DAY)
    sched = monthly_schedule(D, start_ym, end_ym, BUY_DAY)
    M = len(sched)
    print(f'target={TARGET} months={M} {D[sched[0]]}~{D[sched[-1]]}')
    Y, C = compute_matrices(tg, ix, vx, sched)
    rates = None
    if irx:
        rd = np.array(irx['dates']); rc = np.array(irx['close'], dtype=float)
        rates = np.array([rc[as_of_idx(rd, D[i])] if as_of_idx(rd, D[i]) >= 0 else np.nan for i in sched])

    val_full = len(D) - 1
    is_m1 = max(m for m in range(M) if D[sched[m]] <= IS_END) if D[sched[0]] <= IS_END else None
    val_is = as_of_idx(D, IS_END)
    oos_m0 = min((m for m in range(M) if D[sched[m]] >= OOS_START), default=None)

    def dca_combo():
        return {'cid': np.array([0]), 'yid': np.array([0]), 'uth': np.array([0.0]), 'sym': np.array([True]),
                'w1': np.array([np.inf]), 'w2': np.array([np.inf]), 'u1': np.array([1.0]), 'u2': np.array([1.0]),
                'd1': np.array([1.0]), 'd2': np.array([1.0]), 'modeA': np.array([False]), 'ramp': np.array([False]),
                'cap': np.array([3.0]), 'seed': np.array([0.0])}
    dca = dca_combo()
    t_days_full = dd[sched] - dd[sched[0]]
    def period_pack(m0, m1, val_idx):
        return dict(m0=m0, m1=m1, val=val_idx, t=dd[sched[m0:m1 + 1]] - dd[sched[m0]], tval=dd[val_idx] - dd[sched[m0]])
    periods = {'full': period_pack(0, M - 1, val_full)}
    if is_m1 is not None and is_m1 >= 60: periods['is'] = period_pack(0, is_m1, val_is)
    if oos_m0 is not None and M - oos_m0 >= 24: periods['oos'] = period_pack(oos_m0, M - 1, val_full)
    dca_res = {}
    for name, pp in periods.items():
        fv = simulate(P, sched, dd, pp['m0'], pp['m1'], pp['val'], AMOUNT, dca, Y, C, rates)[0]
        irr = irr_from_fv(np.array([fv]), pp['t'], pp['tval'], AMOUNT)[0]
        dca_res[name] = {'fv': round(float(fv), 2), 'irr': round(float(irr) * 100, 3), 'invested': (pp['m1'] - pp['m0'] + 1) * AMOUNT,
                         'from': D[sched[pp['m0']]], 'to': D[pp['val']], 'months': pp['m1'] - pp['m0'] + 1}
    # 롤링 창 정액 기준
    n_win = M - ROLL_MONTHS + 1
    dca_roll = np.array([simulate(P, sched, dd, s, s + ROLL_MONTHS - 1, sched[s + ROLL_MONTHS - 1], AMOUNT, dca, Y, C, rates)[0]
                         for s in range(n_win)]) if n_win > 0 else np.array([])

    results = {'updated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'target': TARGET, 'amount': AMOUNT,
               'buy_day': BUY_DAY, 'months': M, 'roll_months': ROLL_MONTHS, 'n_windows': int(max(n_win, 0)),
               'periods': {k: {'from': v['from'], 'to': v['to'], 'months': v['months']} for k, v in dca_res.items()},
               'dca': dca_res, 'families': {}, 'overall': [],
               'method': '표본 내 초과 IRR 고원 점수(인접 파라미터 평균) 1차 · 롤링 10년 승률 50% 이상 · 롤링 평균 초과수익 2차'}
    all_records = []
    for fam in FAMILIES:
        rows, cb = build_combos(fam)
        N = len(rows)
        print(f'family {fam}: {N} combos')
        met = {}
        for name, pp in periods.items():
            if name == 'full':
                fv, ups, downs, xups, xdowns = simulate(P, sched, dd, pp['m0'], pp['m1'], pp['val'], AMOUNT, cb, Y, C, rates, count=True)
                met['ups'] = ups; met['downs'] = downs; met['xups'] = xups; met['xdowns'] = xdowns
            else:
                fv = simulate(P, sched, dd, pp['m0'], pp['m1'], pp['val'], AMOUNT, cb, Y, C, rates)
            irr = irr_from_fv(fv, pp['t'], pp['tval'], AMOUNT)
            met['fv_' + name] = fv; met['exc_' + name] = (fv / dca_res[name]['fv'] - 1) * 100
            met['eirr_' + name] = (irr - dca_res[name]['irr'] / 100) * 100
        if n_win > 0:
            exc = np.zeros((n_win, N))
            for s in range(n_win):
                fv = simulate(P, sched, dd, s, s + ROLL_MONTHS - 1, sched[s + ROLL_MONTHS - 1], AMOUNT, cb, Y, C, rates)
                exc[s] = (fv / dca_roll[s] - 1) * 100
            met['win'] = (exc > 0).mean(axis=0) * 100; met['roll_mean'] = exc.mean(axis=0); met['roll_min'] = exc.min(axis=0)
        else:
            met['win'] = np.full(N, np.nan); met['roll_mean'] = np.full(N, np.nan); met['roll_min'] = np.full(N, np.nan)
        basis = met['eirr_is'] if 'eirr_is' in met else met['eirr_full']
        met['plateau'] = plateau_scores(rows, basis)
        score = np.where(np.isnan(met['win']) | (met['win'] >= 50), met['plateau'], -np.inf)
        order = np.lexsort((-np.nan_to_num(met['roll_mean'], nan=-1e9), -np.nan_to_num(score, nan=-1e9)))
        def rec(i):
            r = rows[i]; meta = dict(zip(r['meta'][0::2], r['meta'][1::2])) if r['meta'] else {}
            out = {'family': fam, 'type': fam, 'w1': float(r['w1']), 'w2': (None if not np.isfinite(r['w2']) else float(r['w2'])),
                   'uth': (None if r['sym'] else float(-r['uth'] if not np.isnan(r['uth']) else 0)),
                   'u1': r['u1'], 'u2': round(r['u2'], 3), 'd1': r['d1'], 'd2': round(r['d2'], 3), 'shape': r['shape'], 'mode': 'A' if r['modeA'] else 'B'}
            out.update({k: (None if v is None else v) for k, v in meta.items()})
            for k in met:
                v = met[k][i]
                out[k] = None if (isinstance(v, float) and not np.isfinite(v)) else (round(float(v), 3) if isinstance(v, (float, np.floating)) else int(v))
            return out
        top, seen = [], set()
        for i in order:
            key = (round(float(met['fv_full'][i]), 2), round(float(met['win'][i]), 3) if np.isfinite(met['win'][i]) else None)
            if key in seen: continue
            seen.add(key); top.append(rec(i))
            if len(top) >= TOP_N: break
        # 히트맵: 최상위 조합의 그룹에서 (w1 × u1), d1 은 최상위 값 고정
        best = rows[order[0]]
        heat = {'w1': FAMILIES[fam]['w1'], 'u1': U1, 'd1': best['d1'], 'group': str(best['group']),
                'eirr_is': [[None] * len(U1) for _ in FAMILIES[fam]['w1']], 'eirr_oos': [[None] * len(U1) for _ in FAMILIES[fam]['w1']],
                'win': [[None] * len(U1) for _ in FAMILIES[fam]['w1']]}
        for i, r in enumerate(rows):
            if r['group'] == best['group'] and r['idd'] == best['idd']:
                for key in ['eirr_is', 'eirr_oos', 'win']:
                    src = met.get(key)
                    if src is not None and np.isfinite(src[i]): heat[key][r['iw']][r['iu']] = round(float(src[i]), 3)
        results['families'][fam] = {'label': FAMILIES[fam]['label'], 'n': N, 'top': top, 'heat': heat}
        all_records += [((t['plateau'] if t['plateau'] is not None else -1e9), (t['roll_mean'] if t['roll_mean'] is not None else -1e9), t) for t in top[:5]]
    all_records.sort(key=lambda x: (-x[0], -x[1]))
    results['overall'] = [r for _, _, r in all_records[:10]]
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', OUT, os.path.getsize(OUT), 'bytes')

if __name__ == '__main__':
    main()
