// 매일 미국 시장 브리핑을 Claude로 생성해 briefings/YYYY-MM-DD.json 으로 저장한다.
// GitHub Actions에서 실행됨. API 키는 ANTHROPIC_API_KEY 시크릿으로 주입.
//
// [2-B단계] 웹 검색(web_search) 도구를 붙인 버전.
//   Claude가 브리핑을 쓰기 전에 스스로 최신 시장 데이터를 검색한다 → 실제 데이터 기반.
//   이것이 "챗봇 → 에이전트"로 넘어가는 지점: 필요한 정보를 스스로 찾아 나선다.
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

// ── 관심 종목(Cowork 브리핑 구성 그대로) ──────────────────────────
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

// ── 프롬프트: 미국 시장 브리핑을 순수 JSON으로만 ─────────────────
const prompt = `너는 한국인 개인투자자를 위한 "미국 시장 아침 브리핑" 생성기다.

먼저 웹 검색으로 아래 정보를 직접 조사하라(반드시 검색할 것).
비용 절감을 위해 검색 횟수를 아껴 써야 한다 — 종목을 하나씩 따로 검색하지 말고,
"엔비디아 AMD 인텔 TSMC 마이크론 주가" 처럼 여러 종목을 한 번의 검색어에 묶어서 조사하라.
전체 조사를 5회 이내의 검색으로 마치는 것을 목표로 한다:
- 가장 최근 미국 정규장의 S&P 500 / 나스닥종합 / 다우존스 종가와 등락률
- 그날 시장을 움직인 주요 뉴스(연준·금리, 반도체 섹터, AI 밸류체인 등)
- 관심 종목들의 최근 종가와 등락률: ${watchList}
- 앤트로픽 관련 동향, 팔란티어 이슈 등 특이사항

조사를 마친 뒤, 그 실제 데이터를 바탕으로 브리핑을 JSON으로만 출력하라.
설명·코드블록·마크다운 없이 순수 JSON만. (검색 과정 설명 없이 마지막에 JSON만)

날짜: ${dateKey} (한국 시간 기준 오늘 아침에 보는 브리핑)

구성:
- summary: 한 줄 총평(오늘 시장 분위기를 압축한 한국어 한 문장).
- indices: 미국 주요 지수 3개(S&P 500, 나스닥종합, 다우존스).
  각 항목 {name, price(종가 문자열), changePct(등락률 %, 부호 포함 문자열 예 "-1.52%"), up(상승이면 true 하락이면 false)}
- news: 주요 뉴스 3~5개. 각 항목 {title(핵심을 담은 한국어 헤드라인), body(2~3문장 한국어 요약)}
  * 연준/금리, 반도체 섹터 흐름, AI 밸류체인 등 시장 전체를 움직인 이슈 위주.
- stocks: 아래 관심 종목들의 가격·등락. 반드시 이 종목들을 포함하라: ${watchList}
  각 항목 {name, ticker, price(가격 문자열), changePct(등락률 문자열), up(true/false), note(있으면 한 줄 코멘트, 없으면 "")}
- highlights: 특별히 주목할 종목/테마 코멘트 1~3개(앤트로픽 관련 동향, 팔란티어 이슈 등). 각 항목 {topic, body(한국어 2~3문장)}. 없으면 빈 배열.

형식:
{"summary":"","indices":[{"name":"","price":"","changePct":"","up":true}],"news":[{"title":"","body":""}],"stocks":[{"name":"","ticker":"","price":"","changePct":"","up":true,"note":""}],"highlights":[{"topic":"","body":""}]}`;

async function callModel(extra) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt + (extra || '') }],
      // ── [비용 최적화] 웹 검색 도구 ────────────────────────────
      // 이걸 붙이면 Claude가 브리핑을 쓰기 전에 스스로 최신 데이터를 검색한다.
      // 서버 측에서 검색이 실행되며(server_tool_use), 결과가 응답 블록으로 돌아온다.
      // max_uses: 검색 상한. 검색 결과 텍스트가 컨텍스트에 쌓여 입력 토큰 비용의
      //   대부분을 차지하므로(웹검색 자체 요금보다 훨씬 큼), 여기를 낮추는 게
      //   가장 직접적인 비용 절감이다. 5회로도 지수·뉴스·종목·특이사항을
      //   묶음 검색(프롬프트에서 지시)으로 충분히 커버 가능.
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5
      }]
    })
  });
  if (!res.ok) {
    console.error('API 오류:', res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();

  // ── 응답 블록 처리 ───────────────────────────────────────────
  // 웹 검색을 쓰면 content 배열에 여러 종류의 블록이 섞여 온다:
  //   - server_tool_use      : Claude가 실행한 검색 요청
  //   - web_search_tool_result: 검색 결과(서버가 채워줌)
  //   - text                 : Claude가 쓴 실제 글 (우리가 원하는 JSON)
  // 최종 브리핑 JSON은 text 블록들 안에 있으므로, text만 이어붙인 뒤 파싱한다.
  const textBlocks = (data.content || []).filter(c => c.type === 'text');
  let txt = textBlocks.map(c => c.text).join('');

  // 검색을 몇 번 했는지 로그로 남겨 동작을 확인 (에이전트가 실제로 검색했는지)
  const searches = (data.content || []).filter(c => c.type === 'server_tool_use').length;
  console.log(`  · 웹 검색 ${searches}회 수행, 응답 텍스트 ${txt.length}자`);

  // JSON만 뽑기: 코드블록 표시 제거 후, 첫 '{' ~ 마지막 '}' 구간만 취한다.
  // (검색 요약 같은 잡텍스트가 JSON 앞뒤에 섞여 올 수 있으므로 방어적으로 처리)
  txt = txt.replace(/```json|```/g, '').trim();
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start !== -1 && end !== -1) txt = txt.slice(start, end + 1);

  return JSON.parse(txt);
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
