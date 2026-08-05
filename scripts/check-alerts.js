// 관심·보유 종목이 전일 종가 대비 크게 움직였는지 확인하고, 그런 종목이 있으면
// alerts/ 에 기록한다. 실제 푸시 발송은 워크플로가 이 파일들을 커밋·배포한 뒤에 한다
// (서비스워커가 alerts/latest.json 을 읽어 알림 문구를 만들기 때문에 배포가 먼저다).
//
// 감시 대상 = WATCH(이 레포에 하드코딩된 관심 종목) ∪ ALERT_SYMBOLS(앱에서 내보낸 보유 종목)
// 보유 종목은 심볼과 표시용 이름만 받는다 — 수량·평단은 필요 없고, 있으면 자산 규모가
// 드러나므로 일부러 받지 않는다.
//
// 환경변수:
//   ALERT_SYMBOLS    "NVDA=엔비디아,005930.KS=삼성전자" 형태. 없으면 WATCH 만 감시한다.
//   ALERT_THRESHOLD  퍼센트 임계값. 기본 5.
const fs = require('fs');
const path = require('path');

const WORKER_URL = 'https://stock-proxy.ssangku2.workers.dev';
// generate.js 의 WATCH 와 같은 목록. 한쪽만 고치면 알림과 화면이 어긋나므로 같이 고칠 것.
const WATCH = [
  { symbol: 'NVDA', name: '엔비디아' },
  { symbol: 'AMD',  name: 'AMD' },
  { symbol: 'INTC', name: '인텔' },
  { symbol: 'TSM',  name: 'TSMC' },
  { symbol: 'MU',   name: '마이크론' },
  { symbol: 'SKHY', name: 'SK하이닉스 ADR' },
  { symbol: 'PLTR', name: '팔란티어' },
];

const THRESHOLD = Number(process.env.ALERT_THRESHOLD) > 0 ? Number(process.env.ALERT_THRESHOLD) : 5;
const ALERT_DIR = path.join(__dirname, '..', 'alerts');

function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// "NVDA=엔비디아,005930.KS=삼성전자" → [{symbol,name}]. 이름이 없으면 심볼을 이름으로 쓴다.
function parseExtra(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const i = pair.indexOf('=');
    return i === -1
      ? { symbol: pair, name: pair }
      : { symbol: pair.slice(0, i).trim(), name: pair.slice(i + 1).trim() || pair.slice(0, i).trim() };
  }).filter(x => x.symbol);
}

async function fetchQuote(symbol) {
  try {
    const res = await fetch(`${WORKER_URL}/?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (d.price == null || !(d.prev > 0)) return null;
    return d;
  } catch (e) {
    return null;
  }
}

async function main() {
  // 합집합. 같은 심볼이 양쪽에 있으면 보유 쪽 이름을 우선한다(사용자가 붙인 이름이므로).
  const bySymbol = new Map();
  for (const w of WATCH) bySymbol.set(w.symbol, w);
  for (const e of parseExtra(process.env.ALERT_SYMBOLS)) bySymbol.set(e.symbol, e);
  const targets = [...bySymbol.values()];
  console.log(`감시 대상 ${targets.length}종목 (임계값 ±${THRESHOLD}%)`);

  const quotes = await Promise.all(targets.map(t => fetchQuote(t.symbol)));
  const moved = [];
  targets.forEach((t, i) => {
    const q = quotes[i];
    if (!q) return;
    const pct = ((q.price - q.prev) / q.prev) * 100;
    if (Math.abs(pct) >= THRESHOLD) {
      moved.push({ symbol: t.symbol, name: t.name, pct: Number(pct.toFixed(2)) });
    }
  });

  if (!moved.length) {
    console.log('임계값을 넘은 종목이 없습니다.');
    return;
  }

  // 같은 종목이 하루 종일 임계값을 넘어 있으면 크론마다 알림이 가므로, 하루 한 번으로 막는다.
  fs.mkdirSync(ALERT_DIR, { recursive: true });
  const dayFile = path.join(ALERT_DIR, `${todayKST()}.json`);
  const already = fs.existsSync(dayFile) ? JSON.parse(fs.readFileSync(dayFile, 'utf8')) : {};
  const fresh = moved.filter(m => !already[m.symbol]);

  console.log(`임계값 초과 ${moved.length}종목 · 이미 알린 것 제외 ${fresh.length}종목`);
  if (!fresh.length) return;

  for (const m of fresh) already[m.symbol] = { pct: m.pct, at: new Date().toISOString() };
  fs.writeFileSync(dayFile, JSON.stringify(already, null, 2), 'utf8');

  // 서비스워커가 읽어 알림 문구를 만드는 파일. 최신 한 건만 유지한다.
  fs.writeFileSync(path.join(ALERT_DIR, 'latest.json'), JSON.stringify({
    at: new Date().toISOString(),
    threshold: THRESHOLD,
    items: fresh,
  }, null, 2), 'utf8');

  console.log(fresh.map(m => `${m.name} ${m.pct > 0 ? '+' : ''}${m.pct}%`).join(' · '));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'alerted=true\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
