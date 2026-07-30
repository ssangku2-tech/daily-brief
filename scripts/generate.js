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

// ── 프롬프트: 먼저 웹 검색으로 실데이터를 조사한 뒤, 그 데이터로 순수 JSON만 출력 ──
const prompt = `너는 한국인 개인투자자를 위한 "미국 시장 아침 브리핑" 생성기다.

먼저 웹 검색으로 가장 최근 미국 정규장(어젯밤 뉴욕장) 기준 아래 내용을 실제로 조사하라:
1. S&P 500, 나스닥종합, 다우존스의 종가와 등락률
2. 시장을 움직인 주요 뉴스 (연준·금리, 반도체 섹터, AI 밸류체인 등)
3. 다음 관심 종목들의 주가와 등락률: ${watchList}
4. 앤트로픽(Anthropic), 팔란티어(Palantir) 관련 특이 동향

조사가 끝나면, 그 실제 데이터를 바탕으로 브리핑을 순수 JSON으로만 출력하라.
설명·코드블록·마크다운 없이 JSON 객체 하나만 출력한다.

날짜: ${dateKey} (한국 시간 기준 오늘 아침에 보는 브리핑)

JSON 구성:
- summary: 한 줄 총평(오늘 시장 분위기를 압축한 한국어 한 문장)
- indices: 위 지수 3개. 각 항목 {name, price(종가 문자열), changePct(등락률 %, 부호 포함 문자열 예 "-1.52%"), up(상승이면 true 하락이면 false)}
- news: 주요 뉴스 3~5개. 각 항목 {title(핵심을 담은 한국어 헤드라인), body(2~3문장 한국어 요약)}
- stocks: 관심 종목 전부(${watchList}). 각 항목 {name, ticker, price(가격 문자열), changePct(등락률 문자열), up(true/false), note(있으면 한 줄 코멘트, 없으면 "")}
- highlights: 앤트로픽·팔란티어 등 특별히 주목할 종목/테마 코멘트 1~3개. 각 항목 {topic, body(한국어 2~3문장)}. 없으면 빈 배열.

형식:
{"summary":"","indices":[{"name":"","price":"","changePct":"","up":true}],"news":[{"title":"","body":""}],"stocks":[{"name":"","ticker":"","price":"","changePct":"","up":true,"note":""}],"highlights":[{"topic":"","body":""}]}`;

async function callModel() {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    console.error('API 오류:', res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  const content = data.content || [];

  // web_search 사용 시 응답에 server_tool_use(검색 호출)·web_search_tool_result(검색 결과)·
  // text(최종 답변) 블록이 섞여 온다. 검색 결과도 출력 토큰 예산을 소모하므로
  // 검색 횟수·종료 사유·토큰 사용량을 로그로 남겨 최종 text 가 비는 경우를 진단할 수 있게 한다.
  const searchCount = content.filter(c => c.type === 'server_tool_use' && c.name === 'web_search').length;
  console.log(`웹 검색 실행 횟수: ${searchCount}, 종료 사유: ${data.stop_reason}, 토큰 사용량: ${JSON.stringify(data.usage)}`);

  // text 블록만 모아 이어붙이고, 코드블록 표시를 제거한 뒤
  // 첫 { 부터 마지막 } 까지만 잘라 JSON으로 파싱한다.
  let txt = content.filter(c => c.type === 'text').map(c => c.text).join('');
  txt = txt.replace(/```json|```/g, '').trim();
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    console.error('응답에서 JSON을 찾지 못했습니다. content 블록 구성:',
      content.map(c => c.type).join(', ') || '(없음)');
    process.exit(1);
  }
  return JSON.parse(txt.slice(start, end + 1));
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
