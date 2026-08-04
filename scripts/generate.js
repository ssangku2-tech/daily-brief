// 매일 미국 시장 브리핑을 Claude(웹 검색 포함)로 생성해 briefings/YYYY-MM-DD.json 으로 저장한다.
// GitHub Actions에서 실행됨. API 키는 ANTHROPIC_API_KEY 시크릿으로 주입.
//
// 2단계(4섹션) 버전: Cowork에서 매일 Notion으로 보내던 "데일리 마켓 브리핑" 리포트와
// 동일한 구조·검증 규칙을 이 파이프라인에 이식했다. 4개 섹션(지수 요약 / 글로벌 동향·뉴스 /
// 반도체 종목 / 앤트로픽·팔란티어)과, 거래일(T) 확정 → 수치 검증 → 자체 감사 흐름을 그대로 따른다.
//
// 3단계 개선(2026-08-01): 시장 데이터(지수·뉴스·반도체 종목)와 앤트로픽·팔란티어 뉴스를
// 한 요청에 같이 넣었더니, 반도체 종목 교차검증(위젯성 데이터라 소스가 자꾸 상충해 재검색이
// 반복됨)이 web_search 예산을 앞에서 다 써버려 순서상 맨 뒤인 aiNews가 "검색 자원 한도"로
// 통째로 비는 사고가 났다. 그래서 시장 데이터 요청과 aiNews 요청을 예산이 서로 침범할 수 없는
// 별도의 API 호출로 분리하고, 두 요청을 병렬로 실행해 결과만 합친다.
//
// 4단계 비용 절감(2026-08-01): 검색 예산을 market 24→18, aiNews 15→8→6으로 낮췄다(총 39→24).
// 스키마·검증 단계(0~3단계)와 요청 분리 구조는 그대로 유지한다 — 이 두 요청을 다시 하나로
// 합치면 위에서 고친 예산 잠식 문제가 재발하므로 절대 합치지 말 것. market은 지수·종목
// 교차검증에 필요한 최소치에 가까워 덜 줄였다. aiNews는 회사 2곳×2~3회 검색이면 충분해
// 예산 여유가 컸고, 숫자 검증처럼 깊은 추론이 필요 없는 작업이라 output_config.effort도
// medium→low로 낮췄다(비용의 주된 축은 검색 결과가 컨텍스트에 쌓이는 입력 토큰과 사고
// 토큰이라, effort를 낮추면 사고 토큰이 함께 줄어든다). market은 반복돼온 "거래일 혼동"
// 버그와 직결된 수치 검증 섹션이라 medium을 유지한다.
//
// 5단계 구조 변경(2026-08-04): 지수·종목의 price/changePct를 더 이상 Claude의 web_search로
// 찾고 검증하지 않는다. 대신 이 스크립트가 직접 Cloudflare Worker(다른 개인 프로젝트인
// "내 주식 현황" 포트폴리오 앱이 쓰는 stock-proxy.ssangku2.workers.dev — 이 레포에는 소스가
// 없고 외부 계약으로 취급한다. Yahoo Finance를 프록시한다)에서 실시간 시세를 받아와 그 값을
// 그대로 쓴다. 이유: 이 크론은 미국 정규장 마감 몇 시간 뒤(KST 06:30)에 도는데, 그 시점의
// Yahoo `regularMarketPrice`는 이미 그날 정규장 종가로 고정돼 시간외 거래로 더 움직이지
// 않는다 — 즉 "T일 정규장 마감가"와 "지금 이 순간 시세"가 이 타이밍에서는 같은 값이다.
// 이렇게 하면 (a) "확인 실패"가 나던 주된 원인(위젯성 스냅샷과 날짜 있는 기사 종가가 서로
// 상충하는 문제)이 구조적으로 사라지고, (b) market 요청의 web_search 예산이 숫자 교차검증
// 없이 "무슨 뉴스가 있었나" 조사에만 쓰이므로 크게 줄일 수 있다. Claude는 이제 sessionDate
// 확정·뉴스 조사·반도체 섹터 코멘트(정성적 한 줄, stockNotes)만 담당한다. Worker 호출이
// 실패하면(전부 또는 개별 종목) 기존 관례대로 해당 필드에 "확인 실패"를 넣는다 — 하루 4번
// 재시도 크론이 안전망이다.
const fs = require('fs');
const path = require('path');

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('ANTHROPIC_API_KEY 가 없습니다.'); process.exit(1); }

// 한국 시간(KST) 기준 오늘 날짜
function todayKST() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

const BRIEF_DIR = path.join(__dirname, '..', 'briefings');
fs.mkdirSync(BRIEF_DIR, { recursive: true });

const dateKey = process.argv[2] || todayKST();
const outFile = path.join(BRIEF_DIR, `${dateKey}.json`);

// 워크플로가 커밋 메시지에 쓸 수 있게 KST 기준 날짜를 넘겨준다.
// (워크플로에서 date -u 를 쓰면 새벽 실행 때 UTC 기준이라 하루가 어긋난다)
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `date=${dateKey}\n`);
}

if (fs.existsSync(outFile)) {
  console.log(`이미 존재: ${dateKey}.json — 건너뜀`);
  process.exit(0);
}

// dateKey(KST)가 토·일요일이면 미국 증시가 열리지 않아 새로 마감되는 거래일이 없다.
// (KST 토·일요일 아침 실행은 둘 다 같은 직전 금요일 세션을 중복 조사·과금하게 된다 —
// 실제로 이미 그렇게 생성된 사례가 있었다. 반대로 KST 월요일 아침은 아직 미국 동부
// 시간으로 일요일 밤이라 "지금이 미국 기준 무슨 요일인가"로 판단하면 월요일 실행까지
// 잘못 건너뛰게 되므로, 반드시 dateKey 자체의 요일로 판단해야 한다.)
const kstWeekday = new Date(`${dateKey}T00:00:00+09:00`).getDay(); // 0=일 ... 6=토
if (kstWeekday === 0 || kstWeekday === 6) {
  console.log(`${dateKey}은 ${kstWeekday === 0 ? '일' : '토'}요일이라 생성을 건너뜁니다 (미국 증시 휴장, 새 거래일 없음).`);
  process.exit(0);
}

// ── 관심 종목·지수 (Worker에서 직접 시세를 받아올 대상) ─────────────
const WATCH = [
  { name: '엔비디아',      ticker: 'NVDA' },
  { name: 'AMD',          ticker: 'AMD'  },
  { name: '인텔',          ticker: 'INTC' },
  { name: 'TSMC',         ticker: 'TSM'  },
  { name: '마이크론',      ticker: 'MU'   },
  { name: 'SK하이닉스 ADR', ticker: 'SKHY' }, // 실제 Yahoo 티커로 확인됨(코스피 000660과는 다른 미국 OTC ADR)
];
const watchList = WATCH.map(s => `${s.name}(${s.ticker})`).join(', ');

const INDICES = [
  { name: 'S&P 500',   symbol: '^GSPC' },
  { name: '나스닥종합', symbol: '^IXIC' },
  { name: '다우존스',   symbol: '^DJI'  },
];

// ── Worker에서 실시간 시세 받아오기 ──────────────────────────────
// stock-proxy.ssangku2.workers.dev/?symbol= 는 {price, prev, currency, source, realtime}을 반환한다.
// 소스가 없는 외부 API이므로 실패는 흔한 일로 취급하고 개별 심볼 단위로 조용히 "확인 실패" 처리한다.
const WORKER_URL = 'https://stock-proxy.ssangku2.workers.dev';

async function fetchWorkerQuote(symbol) {
  try {
    const res = await fetch(`${WORKER_URL}/?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.price == null || data.prev == null) return null;
    return data;
  } catch (e) {
    console.warn(`[worker] ${symbol} 조회 실패: ${e.message}`);
    return null;
  }
}

function formatPrice(price, currency) {
  const num = price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${num}` : num;
}

function formatChangePct(price, prev) {
  const pct = ((price - prev) / prev) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

async function fetchLiveIndicesAndStocks() {
  const [indexQuotes, stockQuotes] = await Promise.all([
    Promise.all(INDICES.map(i => fetchWorkerQuote(i.symbol))),
    Promise.all(WATCH.map(s => fetchWorkerQuote(s.ticker))),
  ]);

  const indices = INDICES.map((i, idx) => {
    const q = indexQuotes[idx];
    if (!q) return { name: i.name, price: '확인 실패', changePct: '확인 실패', up: null };
    return {
      // 지수는 기존 관례상 "$" 표기 없이 지수 값 그대로 표시한다(종목만 통화 기호를 붙인다).
      name: i.name,
      price: formatPrice(q.price, null),
      changePct: formatChangePct(q.price, q.prev),
      up: q.price >= q.prev,
    };
  });

  const stocks = WATCH.map((s, idx) => {
    const q = stockQuotes[idx];
    if (!q) return { name: s.name, ticker: s.ticker, price: '확인 실패', changePct: '확인 실패', up: null, note: 'Worker 조회 실패' };
    return {
      name: s.name,
      ticker: s.ticker,
      price: formatPrice(q.price, q.currency),
      changePct: formatChangePct(q.price, q.prev),
      up: q.price >= q.prev,
    };
  });

  return { indices, stocks };
}

// ── 신선도 기준: 직전 브리핑 날짜 이후만 (없으면 24시간 이내) ──────
const indexFile = path.join(BRIEF_DIR, 'index.json');
const priorDates = fs.existsSync(indexFile)
  ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter(d => d < dateKey).sort()
  : [];
const lastDate = priorDates[priorDates.length - 1];
const freshnessRule = lastDate
  ? `직전 브리핑 날짜는 ${lastDate} 이다. 그 이후에 새로 나온 뉴스·발언·이벤트만 포함하라. ${lastDate} 이전에 있었던 일은 직전 브리핑에서 이미 다뤘을 수 있으니, 그 이후 새로 보도된 게 아니면 제외하라.`
  : `최근 24시간 이내에 새로 나온 뉴스·발언·이벤트만 포함하라.`;

// ── 프롬프트 1: 시장 데이터(거래일 확정/뉴스/반도체 섹터 코멘트) ────
// 지수·종목의 price/changePct는 더 이상 여기서 다루지 않는다 — main()이 Worker에서 직접
// 받아온다(5단계 구조 변경, 위 주석 참고). 그래서 예전의 "1단계 수치 검증 규칙"과
// indices/stocks JSON 필드는 빠졌고, Claude는 거래일 확정 → 뉴스 조사 → 반도체 섹터
// 정성적 코멘트(stockNotes) → 자체 감사만 담당한다.
const marketPrompt = `너는 한국인 개인투자자를 위한 "데일리 마켓 브리핑" 생성기다. 오늘은 한국 시간(KST) 기준 ${dateKey} 아침이다.

## 0단계. 대상 거래일(T) 확정 — 가장 먼저, 생략 금지
- T = 직전에 정규장이 마감된 미국 거래일이다. KST 새벽 실행이면 보통 T는 미국 기준 전일, 토·일·월요일이면 직전 금요일, 미국 공휴일이면 그 전 영업일이다.
- 결과 JSON의 sessionDate(T의 ISO 날짜, 예 "2026-07-31")와 sessionDateLabel("YYYY년 M월 D일(요일) 미국 동부시간 정규장 마감" 형식의 한국어 문장)에 반드시 명시하라.

## 1단계. 뉴스 검증 규칙 — 가격은 다루지 않으니 날짜만 신경 쓰면 된다
- "today"/"Friday"/"this week"/"오늘"/"이번 주" 같은 상대적 시간 표현은 무효로 간주하고, 기사의 절대 날짜(YYYY-MM-DD)로 환산하라. 환산이 안 되면 그 소스는 폐기하라.
- 1~2주 전 사건을 T일 사건으로 옮겨 적지 마라.
- 검색 예산은 넉넉하지만 무한하지 않다. 한 주제에서 소스가 계속 상충하면 2~3회 재검색 후에도 안 맞으면 다음 항목으로 넘어가라.

## 조사 대상
1. T일 미국·글로벌 증시에 영향을 준 핵심 뉴스 2~4개 (유가·금리·지정학 등 원인 포함)
2. 다음 반도체 관련 종목들의 T일 주가 흐름과 그 이유를 조사해 종목별로 한 줄 코멘트(stockNotes)를 남겨라 — 정확한 가격은 이미 확보돼 있으니 정확한 수치를 조사할 필요는 없고, "왜 그렇게 움직였는가"만 파악하면 된다: ${watchList}. 섹터 전반 동향도 한 줄(semiconductorNote)로 남겨라.

뉴스 신선도 기준: ${freshnessRule}

## 2단계. 순수 JSON 출력
조사가 끝나면 그 실제 데이터로만 아래 형식의 JSON 객체 하나만 출력하라. 설명·코드블록·마크다운 없이 JSON만. stockNotes는 위 종목 리스트의 티커를 key로 쓰고, 코멘트가 없으면 빈 문자열로 둔다.

{
  "sessionDate": "T의 ISO 날짜",
  "sessionDateLabel": "YYYY년 M월 D일(요일) 미국 동부시간 정규장 마감",
  "summary": "한 줄 총평 — 지수 동향과 주요 변동 원인을 압축한 한국어 한 문장",
  "news": [{"title":"","body":"2~3문장 한국어 요약","date":"YYYY-MM-DD"}],
  "semiconductorNote": "반도체 섹터 전반 동향 한 줄",
  "stockNotes": {"NVDA":"","AMD":"","INTC":"","TSM":"","MU":"","SKHY":""}
}

## 3단계. 출력 전 자체 감사 — 생략 금지
JSON을 확정하기 전 스스로 확인하라(하나라도 "아니오"면 재조사하거나 수정할 것):
- sessionDate/sessionDateLabel이 실제로 정규장이 마감된 거래일을 가리키는가?
- news 의 date 가 실제 사건 발생일인가(T일 근처 상대 표현을 그대로 옮기지 않았는가)?
- stockNotes의 각 코멘트가 실제로 조사한 내용에 근거하는가(추측으로 지어내지 않았는가)?
감사에서 고친 내용은 최종 JSON에만 조용히 반영하고, 별도로 설명하지 마라.`;

// ── 프롬프트 2: 앤트로픽·팔란티어 뉴스 ──────────────────────────────
// 반도체 종목 검증과 검색 예산을 공유하면 뒤 순서인 이 섹션이 예산 고갈로 통째로
// 비어버리는 사고가 실제로 있었다(2026-08-01). 그래서 완전히 독립된 요청·예산으로 조사한다.
const aiNewsPrompt = `너는 한국인 개인투자자를 위한 "데일리 마켓 브리핑"의 앤트로픽(Anthropic)·팔란티어(Palantir, PLTR) 뉴스 섹션 담당자다. 오늘은 한국 시간(KST) 기준 ${dateKey} 아침이다. 이 요청은 오직 이 섹션만 담당하며, 검색 예산은 이 작업 전용으로 확보돼 있다 — 다른 섹션 걱정 없이 충분히 검색해도 된다.

## 0단계. 조사 기준 시점
${freshnessRule}
날짜 계산은 위 기준을 그대로 따르고, "최근"/"이번 주" 같은 상대 표현은 절대 날짜(YYYY-MM-DD)로 환산해서만 date 필드에 채워라.

## 1단계. 검증 규칙
- 앤트로픽(Anthropic), 팔란티어(Palantir) 각각에 대해 위 기준 시점 이후 새로 보도된 뉴스·주가 동향·주요 발표를 찾아라(회사당 최대 2개).
- 뉴스 본문에 날짜가 명시된 기사만 사용하라. 날짜 미상 기사, 상대 시간 표현만 있는 기사는 폐기하라.
- 기준 시점 이전 사건을 날짜만 바꿔서 새 사건인 것처럼 쓰지 마라.
- 두 회사 모두 검색했는데도 기준 시점 이후의 신뢰 가능한 뉴스가 없다면, 없는 대로 두는 게 맞다(억지로 지어내지 마라) — 다만 실제로 검색을 충분히 시도한 뒤에만 그렇게 결론 내려라(회사당 최소 2~3회 검색 없이 "확인 실패"로 넘어가지 마라).
- 확인 못 한 항목은 title/date에 "확인 실패"라고 쓰고 body에 사유(정말 뉴스가 없었는지, 날짜 특정이 안 됐는지)를 남겨라.

## 2단계. 순수 JSON 출력
조사가 끝나면 그 실제 데이터로만 아래 형식의 JSON 객체 하나만 출력하라. 설명·코드블록·마크다운 없이 JSON만.

{
  "aiNews": [{"company":"Anthropic 또는 Palantir","title":"","body":"2~3문장 한국어 요약","date":"YYYY-MM-DD"}]
}

## 3단계. 출력 전 자체 감사 — 생략 금지
- 각 항목의 company가 Anthropic/Palantir 중 정확한 쪽인가?
- date가 실제 사건 발생일인가(상대 표현을 그대로 옮기지 않았는가)?
- 기준 시점 이전 사건은 아닌가?
- "확인 실패"로 처리한 항목이 있다면, 정말 충분히 검색한 뒤인가(단순히 검색을 안 해보고 넘어간 것은 아닌가)?
감사에서 고친 내용은 최종 JSON에만 조용히 반영하고, 별도로 설명하지 마라.`;

// ── 스트리밍으로 호출한다 ────────────────────────────────────────
async function streamOnce(prompt, maxUses, label, effort) {
  const abort = new AbortController();
  const guard = setTimeout(() => abort.abort(), 20 * 60 * 1000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        stream: true,
        max_tokens: 20000,
        output_config: { effort },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`[${label}] API 오류 ${res.status}: ${body}`);
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }

    let txt = '';
    let searchCount = 0;
    let stopReason = null;
    let usage = null;
    let buf = '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;

        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }

        if (ev.type === 'content_block_start') {
          const b = ev.content_block || {};
          if (b.type === 'server_tool_use' && b.name === 'web_search') searchCount++;
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta && ev.delta.type === 'text_delta') txt += ev.delta.text;
        } else if (ev.type === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.usage) usage = ev.usage;
        } else if (ev.type === 'error') {
          const err = new Error(`[${label}] 스트림 오류: ${JSON.stringify(ev.error)}`);
          err.retryable = true;
          throw err;
        }
      }
    }

    console.log(`[${label}] 웹 검색 실행 횟수: ${searchCount}/${maxUses}, 종료 사유: ${stopReason}, 토큰 사용량: ${JSON.stringify(usage)}`);

    txt = txt.replace(/```json|```/g, '').trim();
    const start = txt.indexOf('{');
    const end = txt.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      const err = new Error(`[${label}] 응답에서 JSON을 찾지 못했습니다 (종료 사유: ${stopReason}, 받은 텍스트 ${txt.length}자)`);
      err.retryable = true;
      throw err;
    }
    return JSON.parse(txt.slice(start, end + 1));
  } finally {
    clearTimeout(guard);
  }
}

async function callModel(prompt, maxUses, label, effort) {
  const MAX_TRIES = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await streamOnce(prompt, maxUses, label, effort);
    } catch (e) {
      const retryable = e.retryable !== false;
      if (!retryable || attempt >= MAX_TRIES) throw e;
      const waitSec = 30 * attempt;
      console.error(`[${label}] 시도 ${attempt}/${MAX_TRIES} 실패: ${e.message}`);
      console.error(`[${label}] ${waitSec}초 후 재시도합니다.`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }
}

async function main() {
  // 시장 데이터(뉴스·코멘트)와 aiNews를 예산이 서로 침범할 수 없는 별도 요청으로 병렬 실행하고,
  // 지수·종목 시세는 Claude와 별개로 Worker에서 직접 받아온다.
  const [market, aiNewsResult, liveQuotes] = await Promise.all([
    callModel(marketPrompt, 10, 'market', 'medium'),
    callModel(aiNewsPrompt, 6, 'aiNews', 'low'),
    fetchLiveIndicesAndStocks(),
  ]);

  const brief = market;
  brief.aiNews = aiNewsResult.aiNews;
  brief.indices = liveQuotes.indices;
  // 시세 조회 자체가 실패한 항목은 "Worker 조회 실패" 사유를 그대로 두고, 성공한 항목만
  // Claude가 조사한 정성적 코멘트로 note를 채운다.
  brief.stocks = liveQuotes.stocks.map(s => s.price === '확인 실패'
    ? s
    : { ...s, note: (market.stockNotes && market.stockNotes[s.ticker]) || '' });
  delete brief.stockNotes;

  // 최소 형식 검증
  if (!Array.isArray(brief.news)) brief.news = [];
  if (!Array.isArray(brief.aiNews)) brief.aiNews = [];
  if (!brief.sessionDate || !brief.sessionDateLabel) {
    console.warn('⚠️  sessionDate/sessionDateLabel 이 비어 있습니다 — 거래일 확정 단계가 누락됐을 수 있습니다.');
  }
  const failedSymbols = [...brief.indices, ...brief.stocks].filter(x => x.price === '확인 실패').map(x => x.name);
  if (failedSymbols.length) {
    console.warn(`⚠️  Worker에서 시세를 못 받아온 항목: ${failedSymbols.join(', ')}`);
  }

  brief.generatedAt = new Date(Date.now() + 9 * 3600 * 1000)
    .toISOString().slice(0, 16).replace('T', ' ');
  brief.date = dateKey;

  fs.writeFileSync(outFile, JSON.stringify(brief, null, 2), 'utf8');
  console.log(`생성 완료: ${dateKey}.json (지수 ${brief.indices.length} · 종목 ${brief.stocks.length} · 뉴스 ${brief.news.length} · aiNews ${brief.aiNews.length})`);

  const dates = fs.readdirSync(BRIEF_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();
  fs.writeFileSync(path.join(BRIEF_DIR, 'index.json'), JSON.stringify(dates, null, 2), 'utf8');
  console.log(`index.json 갱신: ${dates.length}일치`);
}

main().catch(e => { console.error(e); process.exit(1); });
