// 매일 미국 시장 브리핑을 생성해 briefings/YYYY-MM-DD.json 으로 저장한다.
// GitHub Actions에서 실행됨.
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
//
// 5단계 구조 변경(2026-08-04): 지수·종목의 price/changePct를 더 이상 Claude의 web_search로
// 찾고 검증하지 않는다. 대신 이 스크립트가 직접 Cloudflare Worker(다른 개인 프로젝트인
// "내 주식 현황" 포트폴리오 앱이 쓰는 stock-proxy.ssangku2.workers.dev — 이 레포에는 소스가
// 없고 외부 계약으로 취급한다. Yahoo Finance를 프록시한다)에서 실시간 시세를 받아와 그 값을
// 그대로 쓴다.
//
// 6단계 구조 변경(2026-08-05): marketPrompt/aiNewsPrompt(3~4단계에서 설명한 두 Claude
// 요청) 자체를 없앴다. 포트폴리오 앱(위 5단계와 동일한 레포)이 Claude를 전혀 호출하지 않고
// 순수 클라이언트/Worker 조합으로 API 비용이 0에 가깝다는 점에 착안해, 이 스크립트도 뉴스
// 섹션을 Claude 요약 대신 Google News RSS(news.google.com/rss/search — 키 불필요, 무료)에서
// 받아온 원문 제목·링크·출처·발행일 그대로 쓰도록 바꿨다. 그 결과:
//   - marketPrompt/aiNewsPrompt, streamOnce/callModel, ANTHROPIC_API_KEY 요구사항을 모두
//     삭제했다 — 이 스크립트는 이제 Claude API를 전혀 호출하지 않는다(3~4단계에서 다뤘던
//     "검색 예산 분리" 문제는 더 이상 이 스크립트에 적용되지 않는 역사적 기록이다).
//   - sessionDate/sessionDateLabel(T 확정)은 Claude 조사 대신 날짜 산수로 계산한다
//     (computeSessionDate). 미국 공휴일은 인지하지 못한다는 한계가 있지만, Worker가 주는
//     가격 자체는 항상 정확한 최신 종가라 틀려도 라벨 문구만 하루 어긋나는 정도다.
//   - semiconductorNote/stockNotes("왜 그렇게 움직였는가" 코멘트)는 AI 추론 없이는 만들 수
//     없으므로 완전히 제거했다. stocks에는 이제 Worker 시세만 있고 코멘트가 없다.
//   - news/aiNews의 각 항목은 더 이상 "2~3문장 한국어 요약"이 아니라 원문 title/link 그대로다
//     (한국어 번역·요약 없음) — 사용자가 이 트레이드오프(비용 0 vs AI 요약 포기)를 직접 선택했다.
//
// 7단계 화면 재구성(2026-08-05):
//   - 관심 종목마다 관련 뉴스 최대 2건(stocks[].news)을 붙인다 — 종목별 RSS 질의를 WATCH에
//     query 필드로 넣고 병렬로 받아온다(요청 수는 늘지만 RSS는 무료·무인증이라 비용은 0).
//   - 팔란티어는 aiNews에서 빼고 PLTR 종목 뉴스로만 나간다. aiNews는 앤트로픽 전용.
//   - summary(지수 등락률 한 줄 조합)는 삭제했다. 클라이언트가 접속 시점에 Worker에서 지수
//     시세를 직접 받아 헤더 아래 "지수 스트립"으로 항상 띄우므로, 06:30에 박제된 같은 숫자를
//     한 줄 문장으로 또 보여줄 이유가 없어졌다.
//   - indices/stocks의 price는 이 파일에도 계속 저장한다 — Worker가 접속 시점에 죽어 있거나
//     오프라인일 때 클라이언트가 되돌아갈 폴백 값이다.
const fs = require('fs');
const path = require('path');

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

// dateKey(KST)의 요일 — UTC 메서드로 고정 계산한다. `.getDay()`는 프로세스의 로컬
// 타임존을 따르는데, GitHub Actions 러너(UTC)에서는 `T00:00:00+09:00` 인스턴트가
// 전날 오후로 해석돼 요일이 하루 밀리는 버그가 있었다(로컬 KST 환경에서만 우연히 맞았다).
// `T00:00:00Z`+`getUTCDay()`는 러너의 타임존과 무관하게 dateKey 문자열 그대로의 요일을 준다.
function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=일 ... 6=토
}

const kstWeekday = weekdayOf(dateKey);
if (kstWeekday === 0 || kstWeekday === 6) {
  console.log(`${dateKey}은 ${kstWeekday === 0 ? '일' : '토'}요일이라 생성을 건너뜁니다 (미국 증시 휴장, 새 거래일 없음).`);
  process.exit(0);
}

// ── 관심 종목·지수 (Worker에서 직접 시세를 받아올 대상) ─────────────
// SKHY까지는 반도체 종목, 팔란티어(PLTR)는 반도체가 아니라 앤트로픽·팔란티어 뉴스 섹션과
// 연동되는 관심 종목이라 별도로 붙였다.
// query 는 종목별 뉴스(stocks[].news)를 뽑을 Google News RSS 검색어다. 티커만 넣으면
// 동음이의어(MU=대학, AMD=황반변성 등) 기사가 섞여 들어와서 회사명을 함께 넣는다.
const WATCH = [
  { name: '엔비디아',      ticker: 'NVDA', query: 'Nvidia NVDA stock' },
  { name: 'AMD',          ticker: 'AMD',  query: 'AMD "Advanced Micro Devices" stock' },
  { name: '인텔',          ticker: 'INTC', query: 'Intel INTC stock' },
  { name: 'TSMC',         ticker: 'TSM',  query: 'TSMC "Taiwan Semiconductor" stock' },
  { name: '마이크론',      ticker: 'MU',   query: 'Micron Technology MU stock' },
  { name: 'SK하이닉스 ADR', ticker: 'SKHY', query: '"SK Hynix" memory chip' }, // 실제 Yahoo 티커로 확인됨(코스피 000660과는 다른 미국 OTC ADR)
  { name: '팔란티어',      ticker: 'PLTR', query: 'Palantir Technologies PLTR' },
];

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

// ── 거래일(T) 계산 — Claude 조사 대신 날짜 산수 ─────────────────────
// 이 크론은 KST 06:30(미국 정규장 마감 몇 시간 뒤)에 도니, 대부분 T = dateKey - 1일이다.
// dateKey가 월요일이면 토·일요일은 거래일이 아니므로 지난 금요일이 T다. 미국 공휴일은
// 감안하지 못한다 — 위 6단계 주석 참고.
function computeSessionDate(dateKey) {
  const backDays = weekdayOf(dateKey) === 1 ? 3 : 1; // 월요일 → 지난 금요일, 그 외 → 하루 전
  const t = new Date(new Date(`${dateKey}T00:00:00Z`).getTime() - backDays * 86400000);
  return t.toISOString().slice(0, 10);
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
function sessionDateLabel(sessionDate) {
  const [y, mo, day] = sessionDate.split('-').map(Number);
  return `${y}년 ${mo}월 ${day}일(${WEEKDAY_KO[weekdayOf(sessionDate)]}) 미국 동부시간 정규장 마감`;
}

// ── Google News RSS (무료, API 키 불필요) ────────────────────────
// news.google.com/rss/search 는 인증 없이 쓸 수 있는 비공식 엔드포인트다. 이 레포는
// package.json이 없어(빌드 단계를 두지 않는다는 규칙) XML 파서 의존성을 추가하지 않고,
// RSS 아이템이 항상 <item><title>/<link>/<pubDate>/<source> 형태라는 점에 기대어
// 정규식으로 직접 뽑는다.
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const rawLink = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const rawPubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const rawSource = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    if (!rawTitle || !rawLink) continue;

    const source = rawSource ? decodeXmlEntities(rawSource).trim() : '';
    let title = decodeXmlEntities(rawTitle).trim();
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3)).trim(); // Google이 붙이는 " - 출처명" 접미사 제거
    }

    // pubDate는 Date 객체로 들고 있다가 신선도 비교에 쓰고, 마지막에만 YYYY-MM-DD로
    // 납작하게 편다 — 시각 정보를 버리면(문자열 비교) 신선도 컷오프가 어긋난다(아래 참고).
    const d = rawPubDate ? new Date(rawPubDate) : null;
    items.push({
      title,
      link: decodeXmlEntities(rawLink).trim(),
      pubDate: d && !isNaN(d.getTime()) ? d : null,
      source,
    });
  }
  return items;
}

async function fetchGoogleNewsRSS(query, maxItems) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml).slice(0, maxItems);
  } catch (e) {
    console.warn(`[rss] "${query}" 조회 실패: ${e.message}`);
    return [];
  }
}

// ── 신선도 기준: 직전 브리핑 "생성 시각" 이후만 (없으면 48시간 이내) ──────
// 반드시 실제 시각(Date)끼리 비교해야 한다 — 이 크론은 KST 06:30에 도는데 그 순간의 UTC
// 날짜는 아직 전날이라, "YYYY-MM-DD" 문자열만 비교하면(예: pubDate가 UTC로 dateKey-1일에
// 찍힌 경우) 방금 나온 진짜 새 뉴스까지 "너무 이르다"며 걸러지는 버그가 있었다.
const indexFile = path.join(BRIEF_DIR, 'index.json');
const priorDates = fs.existsSync(indexFile)
  ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter(d => d < dateKey).sort()
  : [];
const lastDate = priorDates[priorDates.length - 1];

let freshnessCutoff = new Date(Date.now() - 48 * 3600 * 1000); // 기본값: 최근 48시간
if (lastDate) {
  const lastFile = path.join(BRIEF_DIR, `${lastDate}.json`);
  if (fs.existsSync(lastFile)) {
    const prior = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
    // generatedAt은 "YYYY-MM-DD HH:MM" 형식의 KST 시각이다 — UTC 인스턴트로 바꿔 컷오프로 쓴다.
    const kst = prior.generatedAt ? new Date(`${prior.generatedAt.replace(' ', 'T')}:00+09:00`) : null;
    if (kst && !isNaN(kst.getTime())) freshnessCutoff = kst;
  }
}

function isFreshEnough(pubDate) {
  if (!pubDate) return true; // 발행일 파싱 실패 시 배제하지 않고 일단 보여준다
  return pubDate >= freshnessCutoff;
}

function toDisplayDate(pubDate) {
  return pubDate ? pubDate.toISOString().slice(0, 10) : '';
}

// ── 한국어 요약·선별 (haiku, 하루 1회 단 한 번의 호출) ──────────────
// 2026-08-05에 Claude를 걷어낸 이유는 "요약"이 아니라 web_search 서버 툴이었다.
// 검색은 이제 RSS가 대신하므로, 이미 손에 든 헤드라인을 번역·선별하는 것만 haiku에
// 맡기면 비용이 하루 1센트 이하다. 반드시 지킬 것:
//   - 호출은 하루 딱 1회. 뉴스 종류별로 쪼개면 프롬프트가 그만큼 중복 과금된다.
//   - 검색·리서치 툴을 다시 붙이지 말 것. 예전 $1/일의 원인이 그것이었다.
//   - 실패하면 조용히 건너뛴다. 한국어 요약은 있으면 좋은 것이지 브리핑의 필수 요소가 아니다.
const ENRICH_MODEL = 'claude-haiku-4-5';

async function enrichKorean(brief) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[claude] ANTHROPIC_API_KEY 없음 — 한국어 요약 없이 진행합니다.');
    return;
  }

  // 모든 뉴스를 한 배열로 펴서 번호를 매긴다. 응답도 이 번호로 받아 되꽂는다.
  // label 은 프롬프트에 노출해 모델이 섹션별 목표 건수를 지킬 수 있게 하기 위한 것이다.
  const flat = [];
  const push = (n, bucket, label) => flat.push({ n, bucket, label });
  brief.news.forEach(n => push(n, 'news', '주요뉴스'));
  brief.stocks.forEach(s => (s.news || []).forEach(n => push(n, `stock:${s.ticker}`, s.name)));
  brief.aiNews.forEach(n => push(n, 'ai', '앤트로픽'));
  if (!flat.length) return;

  const idxLine = brief.indices.filter(i => i.price !== '확인 실패')
    .map(i => `${i.name} ${i.changePct}`).join(', ');
  const stkLine = brief.stocks.filter(s => s.price !== '확인 실패')
    .map(s => `${s.name} ${s.changePct}`).join(', ');
  const list = flat.map((f, i) => `${i}. [${f.label}][${f.n.source || '출처미상'}] ${f.n.title}`).join('\n');

  const prompt = `미국 증시 브리핑에 쓸 자료다. 아래 지수·종목 등락과 뉴스 헤드라인을 보고 JSON으로만 답하라.

지수: ${idxLine || '없음'}
종목: ${stkLine || '없음'}

헤드라인:
${list}

요구사항:
1) summary: 오늘 시장을 한 문장(60자 이내)으로. 숫자를 나열하지 말 것 — 등락률은 화면에 이미 표시된다.
   무엇이 시장을 움직였는지를 헤드라인에서 읽어내 쓴다. 근거가 부족하면 담백하게 쓰고 지어내지 않는다.
2) items: 위 목록에서 읽을 가치가 있는 것만 골라 담는다. 고르지 않은 번호는 아예 넣지 않는다.
   섹션별 목표 건수(대괄호 안 라벨 기준): 주요뉴스 4건, 종목별 각 2건, 앤트로픽 3건.
   후보가 목표보다 많으니 그중 나은 것을 고르면 된다.
   제외 대상: "지금 사야 할까?" 같은 낚시성 제목, 광고·홍보성 기사,
   같은 사건을 다룬 중복 기사(가장 나은 것 하나만 남긴다).
   ko 는 한국어 한 줄 요약(45자 이내, 제목 번역이 아니라 내용 요약).
3) 설명·마크다운 없이 JSON만. 형식:
{"summary":"","items":[{"i":0,"ko":""}]}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ENRICH_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.warn(`[claude] 한국어 요약 실패: ${res.status} ${await res.text()}`);
      return;
    }
    const data = await res.json();
    const u = data.usage || {};
    const cost = ((u.input_tokens || 0) / 1e6) * 1 + ((u.output_tokens || 0) / 1e6) * 5;
    console.log(`[claude] ${ENRICH_MODEL} 입력 ${u.input_tokens ?? '?'} · 출력 ${u.output_tokens ?? '?'} 토큰 ≈ $${cost.toFixed(5)}`);

    let txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    txt = txt.replace(/```json|```/g, '').trim();
    const start = txt.indexOf('{'), end = txt.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('JSON 형태가 아님');
    const parsed = JSON.parse(txt.slice(start, end + 1));

    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      brief.summary = parsed.summary.trim();
    }
    // 모델은 "고른 것만" 돌려준다 — 목록에 없는 번호가 곧 탈락이다.
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if (!items.length) {
      // 응답이 비었으면 필터를 아예 걸지 않는다. 전부 탈락시키는 것보다 원문이라도 보이는 게 낫다.
      console.warn('[claude] 고른 헤드라인이 없어 필터를 건너뜁니다 (원문 그대로 노출).');
      return;
    }
    const keep = new Set();
    for (const it of items) {
      const f = flat[it.i];
      if (!f) continue;
      keep.add(it.i);
      if (typeof it.ko === 'string' && it.ko.trim()) f.n.ko = it.ko.trim();
    }

    // 섹션이 통째로 비면 그 자리만 허전해지므로, 버킷별로 최소 1건은 살려둔다.
    for (const b of new Set(flat.map(f => f.bucket))) {
      if (!flat.some((f, i) => f.bucket === b && keep.has(i))) {
        const first = flat.findIndex(f => f.bucket === b);
        if (first !== -1) keep.add(first);
      }
    }

    const kept = n => keep.has(flat.findIndex(f => f.n === n));
    brief.news = brief.news.filter(kept);
    brief.aiNews = brief.aiNews.filter(kept);
    brief.stocks.forEach(s => { if (s.news) s.news = s.news.filter(kept); });
    console.log(`[claude] 후보 ${flat.length}건 중 ${keep.size}건 선별 (낚시성·중복 제외)`);
  } catch (e) {
    console.warn(`[claude] 한국어 요약 건너뜀: ${e.message}`);
  }
}

async function main() {
  const sessionDate = computeSessionDate(dateKey);

  // 팔란티어는 더 이상 별도 뉴스 섹션(aiNews)이 아니라 관심 종목(PLTR)의 종목별 뉴스로만
  // 나간다 — WATCH에 이미 들어있으므로 아래 종목별 RSS가 그 몫을 대신한다. aiNews는 앤트로픽 전용.
  const [liveQuotes, marketNewsRaw, anthropicNewsRaw, stockNewsRaw] = await Promise.all([
    fetchLiveIndicesAndStocks(),
    fetchGoogleNewsRSS('S&P 500 OR Nasdaq OR Dow Jones stock market', 12),
    fetchGoogleNewsRSS('Anthropic AI', 8),
    Promise.all(WATCH.map(s => fetchGoogleNewsRSS(s.query, 6))),
  ]);

  const toItem = n => ({ title: n.title, link: n.link, date: toDisplayDate(n.pubDate), source: n.source });
  // 여기서 만드는 건 "후보"다. 최종 건수로 자르는 건 enrichKorean 뒤(FINAL_CAPS)에 한다 —
  // 순서가 뒤집히면(먼저 자르고 나중에 거르면) 낚시성 기사가 걸러진 자리가 빈 채로 끝나
  // 뒤에 대기 중인 멀쩡한 후보로 채워지지 않는다. 실제로 그렇게 만들었다가 주요 뉴스가
  // 4건에서 2건으로 줄어든 적이 있다.
  const news = marketNewsRaw.filter(n => isFreshEnough(n.pubDate)).slice(0, 8).map(toItem);
  const aiNews = anthropicNewsRaw.filter(n => isFreshEnough(n.pubDate)).slice(0, 5)
    .map(n => ({ company: 'Anthropic', ...toItem(n) }));

  // 종목별 뉴스 후보는 종목당 최대 3건. 직전 브리핑 이후 새로 나온 기사가 우선이지만, 한 종목의
  // 24시간 창은 자주 비기 때문에(특히 TSM 처럼 후보 자체가 적은 종목) 신선한 게 하나도 없으면
  // 최신 1건이라도 채워 카드가 통째로 비어 보이지 않게 한다 — 그래서 같은 헤드라인이 며칠 이어질 수 있다.
  function pickStockNews(raw) {
    const fresh = raw.filter(n => isFreshEnough(n.pubDate));
    return (fresh.length ? fresh.slice(0, 3) : raw.slice(0, 1)).map(toItem);
  }
  const stocks = liveQuotes.stocks.map((s, i) => {
    const items = pickStockNews(stockNewsRaw[i] || []);
    return items.length ? { ...s, news: items } : s;
  });

  const brief = {
    sessionDate,
    sessionDateLabel: sessionDateLabel(sessionDate),
    indices: liveQuotes.indices,
    news,
    stocks,
    aiNews,
  };

  // 뉴스·시세가 다 모인 뒤에 한 번만 호출한다 (실패해도 브리핑 자체는 그대로 저장된다)
  await enrichKorean(brief);

  // 최종 노출 건수. 반드시 enrichKorean 뒤에 적용한다 — 걸러지고 남은 것 중에서 고르기
  // 위해서다. 요약이 실패해 필터가 안 걸렸을 때도 후보가 그대로 다 나가지 않도록 막아준다.
  const FINAL_CAPS = { news: 4, aiNews: 3, stock: 2 };
  brief.news = brief.news.slice(0, FINAL_CAPS.news);
  brief.aiNews = brief.aiNews.slice(0, FINAL_CAPS.aiNews);
  brief.stocks.forEach(s => { if (s.news) s.news = s.news.slice(0, FINAL_CAPS.stock); });

  const failedSymbols = [...brief.indices, ...brief.stocks].filter(x => x.price === '확인 실패').map(x => x.name);
  if (failedSymbols.length) {
    console.warn(`⚠️  Worker에서 시세를 못 받아온 항목: ${failedSymbols.join(', ')}`);
  }

  brief.generatedAt = new Date(Date.now() + 9 * 3600 * 1000)
    .toISOString().slice(0, 16).replace('T', ' ');
  brief.date = dateKey;

  fs.writeFileSync(outFile, JSON.stringify(brief, null, 2), 'utf8');
  const stockNewsCount = brief.stocks.reduce((n, s) => n + (s.news ? s.news.length : 0), 0);
  console.log(`생성 완료: ${dateKey}.json (지수 ${brief.indices.length} · 종목 ${brief.stocks.length} · 뉴스 ${brief.news.length} · 종목뉴스 ${stockNewsCount} · 앤트로픽 ${brief.aiNews.length})`);

  const dates = fs.readdirSync(BRIEF_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();
  fs.writeFileSync(path.join(BRIEF_DIR, 'index.json'), JSON.stringify(dates, null, 2), 'utf8');
  console.log(`index.json 갱신: ${dates.length}일치`);
}

main().catch(e => { console.error(e); process.exit(1); });
