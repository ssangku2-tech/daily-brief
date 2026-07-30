// 매일 미국 시장 브리핑을 Claude로 생성해 briefings/YYYY-MM-DD.json 으로 저장한다.
// GitHub Actions에서 실행됨. API 키는 ANTHROPIC_API_KEY 시크릿으로 주입.
//
// [2-A단계] 아직 웹 검색을 붙이지 않은 버전.
//   목적: 크론 → 생성 → 저장 → 커밋 → 앱 표시 까지의 "배관"이 새지 않는지 검증.
//   한계: Claude가 학습 데이터 범위로만 답하므로 최신 실데이터가 아님 (다음 단계에서 web_search 추가).
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
어젯밤 뉴욕장(가장 최근 미국 정규장) 기준으로 브리핑을 JSON으로만 출력하라.
설명·코드블록·마크다운 없이 순수 JSON만.

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
      model: 'claude-haiku-4-5',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt + (extra || '') }]
    })
  });
  if (!res.ok) {
    console.error('API 오류:', res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  // 텍스트 블록만 모아 JSON 파싱 (혹시 붙은 코드블록 표시는 제거)
  let txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  txt = txt.replace(/```json|```/g, '').trim();
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
