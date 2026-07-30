// 매일 미국 시장 브리핑을 Claude(웹 검색 포함)로 생성해 briefings/YYYY-MM-DD.json 으로 저장한다.
// GitHub Actions에서 실행됨. API 키는 ANTHROPIC_API_KEY 시크릿으로 주입.
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

if (fs.existsSync(outFile)) {
  console.log(`이미 존재: ${dateKey}.json — 건너뜀`);
  process.exit(0);
}

// ── 관심 종목 ──────────────────────────
// 프롬프트에 넣어 "이 종목들의 주가·등락을 반드시 포함"하도록 지시한다.
const WATCH = [
  { name: '엔비디아',      ticker: 'NVDA' },
  { name: 'AMD',          ticker: 'AMD'  },
  { name: '인텔',          ticker: 'INTC' },
  { name: 'TSMC',         ticker: 'TSM'  },
  { name: '마이크론',      ticker: 'MU'   },
  { name: 'SK하이닉스 ADR', ticker: 'SKHY' },
  { name: '팔란티어',      ticker: 'PLTR' },
];
const watchList = WATCH.map(s => `${s.name}(${s.ticker})`).join(', ');

// ── 신선도 기준: 직전 브리핑 날짜 이후만 (없으면 24시간 이내) ──────
// 같은 이슈(예: 몇 달 전 발언)가 매일 재활용되는 것을 막는다.
const indexFile = path.join(BRIEF_DIR, 'index.json');
const priorDates = fs.existsSync(indexFile)
  ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter(d => d < dateKey).sort()
  : [];
const lastDate = priorDates[priorDates.length - 1];
const freshnessRule = lastDate
  ? `직전 브리핑 날짜는 ${lastDate} 이다. 그 이후에 새로 나온 뉴스·발언·이벤트만 포함하라. ${lastDate} 이전에 있었던 일(과거 발언, 이전 실적 발표 등)은 직전 브리핑에서 이미 다뤘을 수 있으니, 그 이후 새로 보도된 게 아니면 제외하라.`
  : `최근 24시간 이내에 새로 나온 뉴스·발언·이벤트만 포함하라.`;

// ── 프롬프트: 먼저 웹 검색으로 실데이터를 조사한 뒤, 그 데이터로 순수 JSON만 출력 ──
const prompt = `너는 한국인 개인투자자를 위한 "미국 시장 아침 브리핑" 생성기다.

먼저 웹 검색으로 가장 최근 미국 정규장(어젯밤 뉴욕장) 기준 아래 내용을 실제로 조사하라:
1. S&P 500, 나스닥종합, 다우존스의 종가와 등락률
2. 시장을 움직인 주요 뉴스 (연준·금리, 반도체 섹터, AI 밸류체인 등)
3. 다음 관심 종목들의 주가와 등락률: ${watchList}
4. 앤트로픽(Anthropic), 팔란티어(Palantir) 관련 특이 동향

뉴스·하이라이트 신선도 기준: ${freshnessRule}
지수·주가는 최신 시세를 그대로 쓰되, news/highlights 항목은 반드시 위 기준을 만족하는 것만 넣어라.
기준을 만족하는 새 소식이 부족하면 억지로 채우지 말고 news는 개수를 줄이고 highlights는 빈 배열로 두어라.

조사가 끝나면, 그 실제 데이터를 바탕으로 브리핑을 순수 JSON으로만 출력하라.
설명·코드블록·마크다운 없이 JSON 객체 하나만 출력한다.

날짜: ${dateKey} (한국 시간 기준 오늘 아침에 보는 브리핑)

JSON 구성:
- summary: 한 줄 총평(오늘 시장 분위기를 압축한 한국어 한 문장)
- indices: 위 지수 3개. 각 항목 {name, price(종가 문자열), changePct(등락률 %, 부호 포함 문자열 예 "-1.52%"), up(상승이면 true 하락이면 false)}
- news: 주요 뉴스 최대 5개(신선도 기준을 만족하는 것만). 각 항목 {title(핵심을 담은 한국어 헤드라인), body(2~3문장 한국어 요약)}
- stocks: 관심 종목 전부(${watchList}). 각 항목 {name, ticker, price(가격 문자열), changePct(등락률 문자열), up(true/false), note(있으면 한 줄 코멘트, 없으면 "")}
- highlights: 앤트로픽·팔란티어 등 특별히 주목할 종목/테마 코멘트 최대 3개(신선도 기준을 만족하는 것만). 각 항목 {topic, body(한국어 2~3문장)}. 없으면 빈 배열.

형식:
{"summary":"","indices":[{"name":"","price":"","changePct":"","up":true}],"news":[{"title":"","body":""}],"stocks":[{"name":"","ticker":"","price":"","changePct":"","up":true,"note":""}],"highlights":[{"topic":"","body":""}]}`;

// ── 스트리밍으로 호출한다 ────────────────────────────────────────
// 비스트리밍으로 부르면 응답 헤더가 생성이 끝난 뒤에야 오는데, Node 의 fetch(undici)
// 는 헤더를 5분 이상 기다리면 UND_ERR_HEADERS_TIMEOUT 으로 끊는다. 웹 검색 8회 +
// thinking 이 붙으면 5분을 넘기므로 새벽 자동 실행이 통째로 실패했다.
// 스트리밍은 헤더가 즉시 오고 이후 이벤트가 계속 흐르므로 이 타임아웃에 걸리지 않는다.
async function streamOnce() {
  // 무한 대기 방지용 상한 (스트림이 아예 멈추는 경우 대비)
  const abort = new AbortController();
  const guard = setTimeout(() => abort.abort(), 15 * 60 * 1000);

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
        // Sonnet 5 는 thinking 파라미터를 생략하면 adaptive thinking 이 켜진다.
        // max_tokens 는 thinking + 응답 텍스트 합계의 상한이므로, effort 로
        // thinking 깊이를 제한하고 max_tokens 에 여유를 둬야 JSON 이 잘리지 않는다.
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        // _20260209 버전은 dynamic filtering 내장 — 검색 결과를 컨텍스트에 넣기 전에
        // 걸러내므로 입력 토큰이 크게 줄어든다 (Sonnet 5 이상에서만 사용 가능).
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`API 오류 ${res.status}: ${body}`);
      // 4xx 는 재시도해도 그대로 실패하므로 구분해둔다 (429 제외)
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }

    // SSE 를 줄 단위로 파싱하면서 text 델타만 이어붙인다.
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

      // 완결된 줄만 처리하고 나머지는 버퍼에 남겨둔다.
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
          const err = new Error(`스트림 오류: ${JSON.stringify(ev.error)}`);
          err.retryable = true;
          throw err;
        }
      }
    }

    // 검색 결과도 출력 토큰 예산을 소모하므로, 최종 text 가 비는 경우를 진단할 수 있게
    // 검색 횟수·종료 사유·토큰 사용량을 로그로 남긴다.
    console.log(`웹 검색 실행 횟수: ${searchCount}, 종료 사유: ${stopReason}, 토큰 사용량: ${JSON.stringify(usage)}`);

    // 코드블록 표시를 제거한 뒤 첫 { 부터 마지막 } 까지만 잘라 JSON으로 파싱한다.
    txt = txt.replace(/```json|```/g, '').trim();
    const start = txt.indexOf('{');
    const end = txt.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      const err = new Error(`응답에서 JSON을 찾지 못했습니다 (종료 사유: ${stopReason}, 받은 텍스트 ${txt.length}자)`);
      err.retryable = true;
      throw err;
    }
    return JSON.parse(txt.slice(start, end + 1));
  } finally {
    clearTimeout(guard);
  }
}

// 네트워크·과부하 등 일시적 실패는 몇 번 다시 시도한다.
// 하루 한 번뿐인 실행이라, 한 번 실패로 그날 브리핑이 통째로 비는 걸 막는다.
async function callModel() {
  const MAX_TRIES = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await streamOnce();
    } catch (e) {
      const retryable = e.retryable !== false;   // 네트워크 오류 등은 기본 재시도
      if (!retryable || attempt >= MAX_TRIES) throw e;
      const waitSec = 30 * attempt;
      console.error(`시도 ${attempt}/${MAX_TRIES} 실패: ${e.message}`);
      console.error(`${waitSec}초 후 재시도합니다.`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }
}

async function main() {
  const brief = await callModel();

  // 최소 형식 검증
  if (!Array.isArray(brief.indices) || !Array.isArray(brief.stocks)) {
    throw new Error('형식이 올바르지 않습니다 (indices/stocks 배열 없음).');
  }

  // 생성 시각(한국 시간) 기록 — 앱 헤더의 "○○ 갱신" 표시에 사용
  brief.generatedAt = new Date(Date.now() + 9 * 3600 * 1000)
    .toISOString().slice(0, 16).replace('T', ' ');
  brief.date = dateKey;

  fs.writeFileSync(outFile, JSON.stringify(brief, null, 2), 'utf8');
  console.log(`생성 완료: ${dateKey}.json (지수 ${brief.indices.length} · 종목 ${brief.stocks.length} · 뉴스 ${(brief.news||[]).length})`);

  // 날짜 목록(인덱스) 갱신 — 앱이 사용 가능한 브리핑 날짜를 알 수 있게
  const dates = fs.readdirSync(BRIEF_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();
  fs.writeFileSync(path.join(BRIEF_DIR, 'index.json'), JSON.stringify(dates, null, 2), 'utf8');
  console.log(`index.json 갱신: ${dates.length}일치`);
}

main().catch(e => { console.error(e); process.exit(1); });
