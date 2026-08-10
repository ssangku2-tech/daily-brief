// 매일 "오늘·내일 일정"과 "안 읽은 메일 중 중요한 것"을 조사해
// agenda/YYYY-MM-DD.json 으로 저장한다. GitHub Actions에서 실행됨.
//
// 인증: Google OAuth refresh token 사용, 스코프는 반드시 .readonly만.
//   → 이 스크립트는 구조적으로 캘린더를 고치거나 메일을 보낼 수 없다
//      (발급받은 권한 자체가 읽기 전용이라서. 코드 실수로도 불가능).
const fs = require('fs');
const path = require('path');

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  ANTHROPIC_API_KEY
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  console.error('Google OAuth 환경변수(GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN)가 없습니다.');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY 가 없습니다.');
  process.exit(1);
}

function todayKST() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}
// 한국시간 기준 "오늘로부터 offset일"의 날짜 키
function kstDateKeyOffset(offset) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offset * 86400000);
  return d.toISOString().slice(0, 10);
}

const AGENDA_DIR = path.join(__dirname, '..', 'agenda');
fs.mkdirSync(AGENDA_DIR, { recursive: true });
const dateKey = process.argv[2] || todayKST();
const outFile = path.join(AGENDA_DIR, `${dateKey}.json`);

// 워크플로가 하루 여러 번 재시도로 걸려 있다(daily-agenda.yml) — 이미 그날 파일이
// 있으면 Google/Anthropic API를 다시 부르지 않고 바로 건너뛴다.
if (fs.existsSync(outFile)) {
  console.log(`이미 존재: ${dateKey}.json — 건너뜀`);
  process.exit(0);
}

// ── 1) refresh_token → access_token 발급 ─────────────────────────
async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) {
    console.error('Google 토큰 발급 실패:', res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  return data.access_token;
}

// ── 2) 오늘·내일 캘린더 일정 조회 (읽기 전용) ─────────────────────
async function fetchEvents(accessToken) {
  const startKST = new Date(`${dateKey}T00:00:00+09:00`);
  const endKST = new Date(`${kstDateKeyOffset(1)}T23:59:59+09:00`);
  const params = new URLSearchParams({
    timeMin: startKST.toISOString(),
    timeMax: endKST.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime'
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    console.error('캘린더 조회 실패:', res.status, await res.text());
    return [];
  }
  const data = await res.json();
  return (data.items || []).map(e => ({
    title: e.summary || '(제목 없음)',
    start: e.start?.dateTime || e.start?.date,
    allDay: !e.start?.dateTime,
    location: e.location || ''
  }));
}

// 받은편지함 안읽음 개수 — 라벨 정보에 들어 있는 정확한 값이다(추정치가 아니다).
// maxResults=15로 가져오는 상세 목록(mails.length)과는 별개로, 실제 총량을 따로 물어본다.
// q=is:unread + resultSizeEstimate 를 쓰지 않는 이유는 fetchUnreadMails 쪽 주석 참고.
async function fetchUnreadCount(accessToken) {
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    console.error('안읽음 개수 조회 실패:', res.status, await res.text());
    return 0;
  }
  const data = await res.json();
  return data.messagesUnread || 0;
}

// ── 3) 안 읽은 메일 목록 조회 (제목·발신자·미리보기만, 본문 전체 X) ──
// 검색어(q=is:unread)가 아니라 labelIds 로 거르는 것이 핵심이다 — gmail.metadata 스코프는
// q 파라미터를 아예 받지 않고 403 "Metadata scope does not support 'q' parameter" 로 죽는다.
// 2026-08-10에 실제로 이걸로 메일 절반이 통째로 비었다. 08-01~08-07 동안 돌아갔던 건
// 그때 쓰던 refresh token 이 OAuth Playground 에서 gmail.readonly 로 발급된 것이었기 때문이고,
// 문서상의 gmail.metadata 로 재발급한 순간 드러났다. q= 를 다시 넣지 말 것.
async function fetchUnreadMails(accessToken) {
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=UNREAD&labelIds=INBOX&maxResults=15',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) {
    console.error('메일 목록 조회 실패:', listRes.status, await listRes.text());
    return [];
  }
  const list = await listRes.json();
  const ids = (list.messages || []).map(m => m.id);
  const mails = [];
  for (const id of ids) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
      `?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) continue;
    const m = await r.json();
    const headers = m.payload?.headers || [];
    const from = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '(제목 없음)';
    mails.push({ from, subject, snippet: m.snippet || '' });
  }
  return mails;
}

// ── 4) Claude(haiku)로 "중요한 메일"만 골라 한 줄 요약 ────────────
// 본문 전체가 아니라 제목·발신자·미리보기(snippet)만 넘긴다 — 최소 정보만 사용.
// 이 프로젝트에 남은 유일한 LLM 호출이다(시장 브리핑 파이프라인은 2026-08-05부터 Claude 미사용).
// 싸고 빠른 haiku를 일부러 고른 것 — sonnet/opus로 올리지 말 것.
const MAIL_MODEL = 'claude-haiku-4-5';
async function summarizeMails(mails) {
  if (mails.length === 0) return [];
  const listText = mails
    .map((m, i) => `${i + 1}. 보낸사람: ${m.from} / 제목: ${m.subject} / 미리보기: ${m.snippet}`)
    .join('\n');
  const prompt = `아래는 안 읽은 이메일 목록(제목·발신자·미리보기만)이다.
이 중 개인적으로 중요할 만한 메일을 최대 5개 골라 JSON 배열로만 답하라.
광고·뉴스레터·자동알림성 메일은 제외한다. 설명·마크다운 없이 JSON만.
각 항목: {"from":"", "subject":"", "summary":"(한국어 한 줄 요약)"}

목록:
${listText}

형식: [{"from":"","subject":"","summary":""}]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MAIL_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    console.error('메일 요약 API 오류:', res.status, await res.text());
    return [];
  }
  const data = await res.json();
  // 이 프로젝트에 남은 유일한 LLM 호출이라, 매일 실제 토큰 사용량을 로그에 남겨둔다
  // (Actions 로그에서 추정치가 아닌 실측 비용을 확인할 수 있게. haiku-4.5 = 입력 $1 / 출력 $5 per 1M)
  const u = data.usage || {};
  const cost = ((u.input_tokens || 0) / 1e6) * 1 + ((u.output_tokens || 0) / 1e6) * 5;
  console.log(`[claude] ${MAIL_MODEL} 입력 ${u.input_tokens ?? '?'} · 출력 ${u.output_tokens ?? '?'} 토큰 ≈ $${cost.toFixed(5)}`);

  let txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  txt = txt.replace(/```json|```/g, '').trim();
  const start = txt.indexOf('[');
  const end = txt.lastIndexOf(']');
  if (start !== -1 && end !== -1) txt = txt.slice(start, end + 1);
  try { return JSON.parse(txt); } catch { return []; }
}

async function main() {
  const accessToken = await getAccessToken();

  const events = await fetchEvents(accessToken);
  const unreadCount = await fetchUnreadCount(accessToken);
  const mails = await fetchUnreadMails(accessToken);
  const importantMails = await summarizeMails(mails);

  const agenda = {
    date: dateKey,
    generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    events,               // 오늘·내일 일정 전체
    unreadCount,          // 전체 안읽음 개수(Gmail 추정치) — 상세 조회 목록(최대 15통)과는 별개
    importantMails        // 그중 AI가 골라 요약한 중요 메일 (최대 5개)
  };

  fs.writeFileSync(outFile, JSON.stringify(agenda, null, 2), 'utf8');
  console.log(
    `agenda 생성 완료: 일정 ${events.length}건 · 안읽음 ${unreadCount}통 · 중요메일 ${importantMails.length}통`
  );

  // briefings/index.json 과 같은 역할 — 클라이언트가 "오늘 것이 없을 때 언제 것으로
  // 되돌아갈지" 알려면 어떤 날짜가 있는지 알아야 한다. 디렉터리를 매번 다시 훑어
  // 만들기 때문에 파일을 손으로 지워도 목록이 어긋나지 않는다.
  const dates = fs.readdirSync(AGENDA_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();
  fs.writeFileSync(path.join(AGENDA_DIR, 'index.json'), JSON.stringify(dates, null, 2), 'utf8');
  console.log(`index.json 갱신: ${dates.length}일치`);
}

main().catch(e => { console.error(e); process.exit(1); });
