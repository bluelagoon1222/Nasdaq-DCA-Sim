#!/usr/bin/env python3
"""나스닥 적립매수 시뮬레이터 — 데이터 수집 (GitHub Actions 에서 매일 실행)

수집 항목 → data/prices.json
  QQQ      Invesco QQQ (수정종가 = 배당 재투자 반영)          Yahoo Finance
  TIGER    TIGER 미국나스닥100 (133690.KS, 원화)              Yahoo Finance
  IXIC     나스닥 종합지수 (1971~, 기준수익률 μ·추세선용)      Yahoo Finance
  VIX      CBOE VIX (공포·탐욕형 트리거)                       Yahoo Finance
  IRX      미국 13주 국채 할인율 % (현금풀 이자, 달러)          Yahoo Finance
  KR3M     한국 3개월 금리 % (현금풀 이자, 원화; 월간)          FRED IR3TIB01KRM156N
  USDKRW   원/달러 환율 (원화 환산 토글)                       FRED DEXKOUS + Yahoo KRW=X (최근일 보충)
  FNG      CNN Fear & Greed (2020.9~, 참고 비교선)              CNN dataviz (실패해도 무시)

어느 한 항목이 실패하면 이전 파일의 값을 그대로 유지한다.
"""
import io, json, os, sys, time, datetime as dt
import numpy as np
import pandas as pd
import requests
import yfinance as yf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'prices.json')
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'Accept': 'application/json, text/plain, */*'}

YF = {
    'QQQ':   {'ticker': 'QQQ',       'start': '1999-01-01', 'name': 'Invesco QQQ',        'ccy': 'USD', 'adj': True},
    'TIGER': {'ticker': '133690.KS', 'start': '2010-10-01', 'name': 'TIGER 미국나스닥100', 'ccy': 'KRW', 'adj': True},
    'IXIC':  {'ticker': '^IXIC',     'start': '1971-01-01', 'name': 'NASDAQ Composite'},
    'VIX':   {'ticker': '^VIX',      'start': '1990-01-01', 'name': 'CBOE VIX'},
    'IRX':   {'ticker': '^IRX',      'start': '1990-01-01', 'name': 'US 13-week T-bill (%)'},
}

def log(*a):
    print(dt.datetime.now().strftime('%H:%M:%S'), *a, flush=True)

def yf_download(ticker, start, tries=4):
    last = None
    for k in range(tries):
        try:
            df = yf.download(ticker, start=start, auto_adjust=False, progress=False, threads=False)
            if df is not None and len(df):
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = df.columns.get_level_values(0)
                return df
            last = 'empty'
        except Exception as e:
            last = e
        time.sleep(5 * (k + 1))
    raise RuntimeError(f'{ticker}: {last}')

def series_from_df(df, want_adj):
    df = df[~df.index.duplicated(keep='last')].sort_index()
    close = df['Close'].astype(float)
    ok = close.notna() & (close > 0)
    df = df[ok]; close = close[ok]
    out = {'dates': [d.strftime('%Y-%m-%d') for d in df.index], 'close': [round(float(v), 4) for v in close]}
    if want_adj:
        adj = df['Adj Close'].astype(float) if 'Adj Close' in df.columns else close
        adj = adj.where(adj.notna() & (adj > 0), close)
        out['adj'] = [round(float(v), 4) for v in adj]
    return out

def fred_csv(series_id):
    url = f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}'
    r = requests.get(url, headers=UA, timeout=60); r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    df.columns = ['date', 'value']
    df = df[df['value'] != '.'].copy()
    df['value'] = df['value'].astype(float)
    df = df[df['value'] > 0]
    return {'dates': list(df['date'].astype(str)), 'close': [round(float(v), 4) for v in df['value']]}

def cnn_fng():
    url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2020-09-01'
    r = requests.get(url, headers=UA, timeout=60); r.raise_for_status()
    js = r.json()
    pts = js.get('fear_and_greed_historical', {}).get('data', [])
    rows = sorted({dt.datetime.fromtimestamp(p['x'] / 1000, tz=dt.timezone.utc).strftime('%Y-%m-%d'): float(p['y']) for p in pts}.items())
    return {'dates': [d for d, _ in rows], 'close': [round(v, 2) for _, v in rows]}

def main():
    old = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding='utf-8') as f:
                old = json.load(f).get('series', {})
        except Exception:
            old = {}
    series = {}
    failures = []
    for key, cfg in YF.items():
        try:
            df = yf_download(cfg['ticker'], cfg['start'])
            s = series_from_df(df, cfg.get('adj', False))
            s.update({k: v for k, v in cfg.items() if k in ('ticker', 'name', 'ccy')})
            series[key] = s
            log(key, len(s['dates']), 'rows', s['dates'][0], '~', s['dates'][-1])
        except Exception as e:
            failures.append(f'{key}: {e}')
            if key in old: series[key] = old[key]
    # 원/달러: FRED 주 시리즈 + Yahoo 로 최근일 보충
    try:
        fx = fred_csv('DEXKOUS')
        try:
            kdf = yf_download('KRW=X', (dt.date.today() - dt.timedelta(days=40)).isoformat())
            k = series_from_df(kdf, False)
            last = fx['dates'][-1]
            for d, v in zip(k['dates'], k['close']):
                if d > last and 500 < v < 3000:
                    fx['dates'].append(d); fx['close'].append(v)
        except Exception as e:
            failures.append(f'KRW=X: {e}')
        fx['name'] = 'USD/KRW'
        series['USDKRW'] = fx
        log('USDKRW', len(fx['dates']), 'rows', fx['dates'][0], '~', fx['dates'][-1])
    except Exception as e:
        failures.append(f'DEXKOUS: {e}')
        if 'USDKRW' in old: series['USDKRW'] = old['USDKRW']
    try:
        kr = fred_csv('IR3TIB01KRM156N'); kr['name'] = 'Korea 3M interbank (%)'
        series['KR3M'] = kr
        log('KR3M', len(kr['dates']), 'rows', kr['dates'][-1])
    except Exception as e:
        failures.append(f'KR3M: {e}')
        if 'KR3M' in old: series['KR3M'] = old['KR3M']
    try:
        fng = cnn_fng(); fng['name'] = 'CNN Fear & Greed'
        if len(fng['dates']) > 100:
            series['FNG'] = fng
            log('FNG', len(fng['dates']), 'rows', fng['dates'][0], '~', fng['dates'][-1])
        elif 'FNG' in old: series['FNG'] = old['FNG']
    except Exception as e:
        failures.append(f'FNG: {e}')
        if 'FNG' in old: series['FNG'] = old['FNG']

    if 'QQQ' not in series or 'IXIC' not in series:
        log('FATAL: QQQ 또는 IXIC 없음', failures); sys.exit(1)
    out = {'updated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'failures': failures, 'series': series}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    log('wrote', OUT, os.path.getsize(OUT), 'bytes; failures:', failures or 'none')

if __name__ == '__main__':
    main()
