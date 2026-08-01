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

// ── 관심 종목 ──────────────────────────
const WATCH = [
  { name: '엔비디아',      ticker: 'NVDA' },
  { name: 'AMD',          ticker: 'AMD'  },
  { name: '인텔',          ticker: 'INTC' },
  { name: 'TSMC',         ticker: 'TSM'  },
  { name: '마이크론',      ticker: 'MU'   },
  { name: 'SK하이닉스 ADR', ticker: 'SKHY' },
];
const watchList = WATCH.map(s => `${s.name}(${s.ticker})`).join(', ');

// ── 신선도 기준: 직전 브리핑 날짜 이후만 (없으면 24시간 이내) ──────
const indexFile = path.join(BRIEF_DIR, 'index.json');
const priorDates = fs.existsSync(indexFile)
  ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter(d => d < dateKey).sort()
  : [];
const lastDate = priorDates[priorDates.length - 1];
const freshnessRule = lastDate
  ? `직전 브리핑 날짜는 ${lastDate} 이다. 그 이후에 새로 나온 뉴스·발언·이벤트만 포함하라. ${lastDate} 이전에 있었던 일은 직전 브리핑에서 이미 다뤘을 수 있으니, 그 이후 새로 보도된 게 아니면 제외하라.`
  : `최근 24시간 이내에 새로 나온 뉴스·발언·이벤트만 포함하라.`;

// ── 프롬프트 1: 시장 데이터(지수/뉴스/반도체 종목) ──────────────────
// 0단계(거래일 확정) → 1단계(수치 검증 규칙) → 2단계(3섹션 작성) → 3단계(자체 감사).
// 지금까지 반복된 유일한 오류 유형은 "어느 거래일 수치인지 혼동"이었으므로,
// 그 방지 규칙을 최우선으로 명시한다.
const marketPrompt = `너는 한국인 개인투자자를 위한 "데일리 마켓 브리핑" 생성기다. 오늘은 한국 시간(KST) 기준 ${dateKey} 아침이다.

## 0단계. 대상 거래일(T) 확정 — 가장 먼저, 생략 금지
지금까지 발생한 오류는 전부 "어느 거래일 수치인지 혼동한 것" 하나였다. 조사를 시작하기 전에 반드시 T를 확정하라.
- T = 직전에 정규장이 마감된 미국 거래일이다. KST 새벽 실행이면 보통 T는 미국 기준 전일, 토·일·월요일이면 직전 금요일, 미국 공휴일이면 그 전 영업일이다.
- 결과 JSON의 sessionDate(T의 ISO 날짜, 예 "2026-07-31")와 sessionDateLabel("YYYY년 M월 D일(요일) 미국 동부시간 정규장 마감" 형식의 한국어 문장)에 반드시 명시하라.
- 이후 모든 가격·등락률은 오직 이 T일 것만 써라. T-1일 수치를 T일로 옮겨 적는 것이 유일한 반복 오류 유형이므로 계속 경계하라.

## 1단계. 수치 검증 규칙 — 모든 가격·등락률에 예외 없이 적용
- 실시간 시세 스냅샷을 그대로 쓰지 마라. "현재가/전일종가" 형태의 위젯성 데이터는 프리마켓·애프터마켓·주말 잔여 호가일 수 있다. 반드시 날짜가 명시된 기사·히스토리 데이터로 확인하라.
- "today"/"Friday"/"this week"/"오늘"/"이번 주" 같은 상대적 시간 표현은 무효로 간주하고, 기사의 절대 날짜(YYYY-MM-DD)로 환산하라. 환산이 안 되면 그 소스는 폐기하라.
- 종가·등락률은 T일이 명시된 서로 다른 소스 2곳이 일치할 때 확정하라. 1곳뿐이면 note에 "(단일 출처)"를 병기하라.
- T-1 종가 × (1 + T일 등락률) ≈ T일 종가 가 성립하는지 검산하라(오차 0.5%p 초과면 불일치 — 재조사).
- 값이 일간 등락률이 아니라 52주 범위·연초 대비·주간 등락 등일 수 있다. 무엇에 대한 %인지 확정되지 않으면 쓰지 마라.
- 확인 불가 시 추정·근사 금지: 끝까지 확정 못 하면 price/changePct 필드에 "확인 실패"라고 쓰고 note에 사유를 남겨라. 근사치나 빈칸으로 얼버무리지 마라.
- 서로 다른 지수·종목의 changePct 를 재사용하지 마라(각 항목은 그 항목 자신을 검색한 결과에서만).
- 뉴스에도 같은 규칙: 기사의 요일·"최근"은 절대 날짜로 환산해 news[].date 에 채워라. 1~2주 전 사건을 T일 사건으로 옮겨 적지 마라.
- 검색 예산은 넉넉하지만 무한하지 않다. 한 종목에서 소스가 계속 상충하면 무한정 파고들지 말고 2~3회 재검색 후에도 안 맞으면 "확인 실패"로 정리하고 다음 항목으로 넘어가라 — 뒤 항목을 아예 조사 못 하는 것보다 낫다.

## 조사 대상
1. S&P 500, 나스닥종합, 다우존스의 T일 종가·등락률 (지수마다 개별 검색)
2. T일 미국·글로벌 증시에 영향을 준 핵심 뉴스 2~4개 (유가·금리·지정학 등 원인 포함)
3. 다음 반도체 관련 종목의 T일 종가·등락률: ${watchList} (종목마다 개별 검색). SK하이닉스는 반드시 미국 ADR 티커 SKHY 기준(코스피 000660 아님). 섹터 전반 동향도 한 줄(semiconductorNote) 파악하라 — 종목별 방향이 크게 엇갈리면(일부 급등·일부 급락) 날짜 혼동 신호일 수 있으니 그 종목들을 재확인하라.

뉴스 신선도 기준: ${freshnessRule}

## 2단계. 순수 JSON 출력
조사가 끝나면 그 실제 데이터로만 아래 형식의 JSON 객체 하나만 출력하라. 설명·코드블록·마크다운 없이 JSON만.

{
  "sessionDate": "T의 ISO 날짜",
  "sessionDateLabel": "YYYY년 M월 D일(요일) 미국 동부시간 정규장 마감",
  "summary": "한 줄 총평 — 지수 동향과 주요 변동 원인을 압축한 한국어 한 문장",
  "indices": [{"name":"S&P 500","price":"","changePct":"","up":true}],
  "news": [{"title":"","body":"2~3문장 한국어 요약","date":"YYYY-MM-DD"}],
  "semiconductorNote": "반도체 섹터 전반 동향 한 줄",
  "stocks": [{"name":"","ticker":"","price":"","changePct":"","up":true,"note":""}]
}

## 3단계. 출력 전 자체 감사 — 생략 금지
JSON을 확정하기 전, 표의 모든 숫자를 한 줄씩 다시 훑으며 스스로 확인하라(하나라도 "아니오"면 그 항목을 재조사하거나 "확인 실패"로 수정할 것):
- 이 숫자의 출처에 T일 날짜가 명시적으로 적혀 있는가?
- T-1일 급등/급락 기사를 T일 수치로 착각한 것은 아닌가?
- T-1 종가 × (1+등락률) ≈ T일 종가 검산이 맞는가?
- changePct 부호와 up 필드가 서로 일치하는가?
- news 의 date 가 실제 사건 발생일인가(T일 근처 상대 표현을 그대로 옮기지 않았는가)?
- 확인 불가인데 근사치나 빈칸으로 넘어간 필드는 없는가?
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
async function streamOnce(prompt, maxUses, label) {
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
        output_config: { effort: 'medium' },
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

async function callModel(prompt, maxUses, label) {
  const MAX_TRIES = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await streamOnce(prompt, maxUses, label);
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
  // 시장 데이터와 aiNews를 예산이 서로 침범할 수 없는 별도 요청으로 병렬 실행한다.
  const [market, aiNewsResult] = await Promise.all([
    callModel(marketPrompt, 24, 'market'),
    callModel(aiNewsPrompt, 15, 'aiNews'),
  ]);

  const brief = market;
  brief.aiNews = aiNewsResult.aiNews;

  // 최소 형식 검증
  if (!Array.isArray(brief.indices) || !Array.isArray(brief.stocks)) {
    throw new Error('형식이 올바르지 않습니다 (indices/stocks 배열 없음).');
  }
  if (!Array.isArray(brief.news)) brief.news = [];
  if (!Array.isArray(brief.aiNews)) brief.aiNews = [];

  // 정합성 경고: 서로 다른 종목이 등락률을 그대로 복사한 흔적이 있으면 로그로 남긴다(막지는 않음).
  const changePcts = brief.stocks.map(s => s.changePct);
  const dupePcts = [...new Set(changePcts.filter((v, i) => changePcts.indexOf(v) !== i))];
  if (dupePcts.length) {
    console.warn(`⚠️  종목 등락률 중복 발견 — 다른 종목 값을 복사했을 가능성이 있다: ${dupePcts.join(', ')}`);
  }
  if (!brief.sessionDate || !brief.sessionDateLabel) {
    console.warn('⚠️  sessionDate/sessionDateLabel 이 비어 있습니다 — 거래일 확정 단계가 누락됐을 수 있습니다.');
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
