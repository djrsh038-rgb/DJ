// 배당 포트폴리오 트래커 - 선택형 백엔드 (Cloudflare Workers)
//
// 브라우저에서 Yahoo/Naver 공개 엔드포인트를 직접 호출하면 CORS 정책 때문에
// 실패할 수 있습니다. 서버(Worker)는 브라우저가 아니므로 CORS 제약이 없어,
// 같은 무료 공개 엔드포인트를 대신 호출해 결과만 중계합니다. API 키는
// 전혀 필요 없습니다 - 배포만 하면 바로 동작합니다.
//
// 배포 방법은 저장소 루트 README.md의 "백엔드(선택)" 섹션을 참고하세요.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    try {
      if (url.pathname === '/quote') return await handleQuote(url);
      if (url.pathname === '/price') return await handlePrice(url);
      if (url.pathname === '/fundamentals') return await handleFundamentals(url);
      if (url.pathname === '/search') return await handleSearch(url);
      if (url.pathname === '/fx') return await handleFx();
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function yahooSymbol(market, ticker, exchange) {
  if (market === 'KR') return ticker.trim() + '.' + (exchange || 'KS');
  return ticker.trim().toUpperCase();
}

async function fetchYahooPrice(market, ticker, exchange) {
  const sym = yahooSymbol(market, ticker, exchange);
  const res = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error('yahoo price HTTP ' + res.status);
  const data = await res.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  const p = result && result.meta && result.meta.regularMarketPrice;
  if (typeof p !== 'number') throw new Error('가격 정보 없음');
  return p;
}

async function fetchYahooFundamentals(market, ticker, exchange) {
  const sym = yahooSymbol(market, ticker, exchange);
  const res = await fetch(
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
      encodeURIComponent(sym) +
      '?modules=summaryDetail,defaultKeyStatistics,financialData,balanceSheetHistory',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error('yahoo fundamentals HTTP ' + res.status);
  const data = await res.json();
  const result = data && data.quoteSummary && data.quoteSummary.result && data.quoteSummary.result[0];
  if (!result) throw new Error('데이터 없음');
  const raw = (o) => (o && typeof o.raw === 'number' ? o.raw : null);
  const summary = result.summaryDetail || {};
  const stats = result.defaultKeyStatistics || {};
  const fin = result.financialData || {};
  const bsRows = result.balanceSheetHistory && result.balanceSheetHistory.balanceSheetStatements;

  const out = {};
  const per = raw(summary.trailingPE) != null ? raw(summary.trailingPE) : raw(stats.trailingPE);
  if (per != null) out.per = per;
  const pbr = raw(stats.priceToBook);
  if (pbr != null) out.pbr = pbr;
  const payout = raw(summary.payoutRatio);
  if (payout != null) out.payoutRatio = payout * 100;
  const dps = raw(summary.dividendRate);
  if (dps != null) out.dps = dps;
  const debtToEquity = raw(fin.debtToEquity);
  if (debtToEquity != null) out.debtRatio = debtToEquity;
  const totalAssets = bsRows && bsRows[0] ? raw(bsRows[0].totalAssets) : null;
  if (totalAssets != null) out.totalAssets = totalAssets;
  return out;
}

async function fetchNaverFundamentals(ticker) {
  const res = await fetch(
    'https://api.finance.naver.com/service/itemSummary.naver?itemcode=' + encodeURIComponent(ticker.trim()),
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error('naver HTTP ' + res.status);
  const data = await res.json();
  const out = {};
  if (typeof data.per === 'number') out.per = data.per;
  if (typeof data.pbr === 'number') out.pbr = data.pbr;
  if (typeof data.dvv === 'number' && data.dvv > 0) out.dps = data.dvv;
  return out;
}

function paramsFrom(url) {
  return {
    market: url.searchParams.get('market') === 'KR' ? 'KR' : 'US',
    ticker: url.searchParams.get('ticker') || '',
    exchange: url.searchParams.get('exchange') || 'KS',
  };
}

async function handlePrice(url) {
  const { market, ticker, exchange } = paramsFrom(url);
  if (!ticker) return json({ error: 'ticker required' }, 400);
  const price = await fetchYahooPrice(market, ticker, exchange);
  return json({ price });
}

async function handleFundamentals(url) {
  const { market, ticker, exchange } = paramsFrom(url);
  if (!ticker) return json({ error: 'ticker required' }, 400);
  const data = market === 'KR' ? await fetchNaverFundamentals(ticker) : await fetchYahooFundamentals(market, ticker, exchange);
  return json(data);
}

// 시세 + 재무지표를 한 번에 취합해서 반환 (왕복 1회)
async function handleQuote(url) {
  const { market, ticker, exchange } = paramsFrom(url);
  if (!ticker) return json({ error: 'ticker required' }, 400);
  const [priceResult, fundResult] = await Promise.allSettled([
    fetchYahooPrice(market, ticker, exchange),
    market === 'KR' ? fetchNaverFundamentals(ticker) : fetchYahooFundamentals(market, ticker, exchange),
  ]);
  const out = {};
  if (priceResult.status === 'fulfilled') out.price = priceResult.value;
  else out.priceError = String(priceResult.reason);
  if (fundResult.status === 'fulfilled') Object.assign(out, fundResult.value);
  else out.fundError = String(fundResult.reason);
  return json(out);
}

async function handleSearch(url) {
  const q = url.searchParams.get('q') || '';
  if (!q) return json({ quotes: [] });
  const res = await fetch(
    'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=8&newsCount=0',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error('search HTTP ' + res.status);
  const data = await res.json();
  const quotes = (data && data.quotes) || [];
  const out = quotes
    .filter((x) => x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF'))
    .map((x) => ({
      symbol: x.symbol,
      name: x.shortname || x.longname || x.symbol,
      quoteType: x.quoteType,
      typeDisp: x.typeDisp || '',
    }));
  return json({ quotes: out });
}

async function handleFx() {
  const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=KRW');
  if (!res.ok) throw new Error('fx HTTP ' + res.status);
  const data = await res.json();
  return json({ rate: data && data.rates && data.rates.KRW });
}
