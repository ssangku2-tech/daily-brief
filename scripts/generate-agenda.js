// 매일 Google 캘린더 일정과 안읽은 중요 메일을 읽어 agenda/YYYY-MM-DD.json 으로 저장한다.
// GitHub Actions에서 실행됨. Google OAuth 자격증명은 GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/
// GOOGLE_REFRESH_TOKEN 시크릿으로 주입한다 (발급 방법: scripts/setup-google-auth.js).
//
// generate.js(시장 브리핑)와 달리 Claude API를 호출하지 않는다 — 캘린더·메일은 사용자
// 본인의 이미 확정된 데이터라 시장 수치처럼 "여러 소스 중 뭐가 맞는지" 검증할 대상이
// 없다. 대신 같은 공학적 규율을 이렇게 옮겨 적용한다:
//   0단계(기준 확정) — KST 기준 "오늘 00:00 ~ 모레 00:00"(오늘+내일 전체)을 정확히 UTC로
//     환산해 Calendar API에 넘긴다. 여기서 시간대를 잘못 계산해 하루 밀리는 게 시장
//     브리핑의 "거래일 혼동"에 대응하는 이 스크립트의 유일한 실수 유형이다.
//   1단계(수집 규칙) — allDay는 응답에 date만 있고 dateTime이 없을 때로 판정한다.
//     "중요 메일"은 Gmail 자체의 IMPORTANT 라벨(+안읽음)로만 판정한다 — Claude에게
//     중요도를 새로 판단시키지 않는다. Gmail 자체 ML 신호를 그대로 쓰는 게 더 정확하고,
//     매일 API 호출이 하나 더 늘어나는 비용도 없앤다.
//   2단계 — JSON 조립.
//   3단계(자체 감사) — 필터링 전후 개수를 대조해 조용한 누락을 로그로 잡는다.
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN 이 없습니다.');
  process.exit(1);
}

// 한국 시간(KST) 기준 오늘 날짜
function todayKST() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

const AGENDA_DIR = path.join(__dirname, '..', 'agenda');
fs.mkdirSync(AGENDA_DIR, { recursive: true });

const dateKey = process.argv[2] || todayKST();
const outFile = path.join(AGENDA_DIR, `${dateKey}.json`);

// 워크플로가 커밋 메시지에 쓸 수 있게 KST 기준 날짜를 넘겨준다.
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `date=${dateKey}\n`);
}

if (fs.existsSync(outFile)) {
  console.log(`이미 존재: ${dateKey}.json — 건너뜀`);
  process.exit(0);
}

// ── 0단계: 기준 확정 — KST "오늘 00:00" ~ "모레 00:00"(오늘+내일 전체)을 UTC로 환산 ──
const startKST = new Date(`${dateKey}T00:00:00+09:00`);
const endKST = new Date(startKST.getTime() + 2 * 86400000);
const timeMin = startKST.toISOString();
const timeMax = endKST.toISOString();

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google 토큰 갱신 실패: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── 1단계: 캘린더 수집 — allDay는 date만 있고 dateTime이 없을 때로 판정 ──────
async function fetchEvents(token) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({
    timeMin, timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  })}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`캘린더 조회 실패: ${JSON.stringify(data)}`);

  const items = (data.items || []).filter(ev => ev.status !== 'cancelled');
  const events = items.map(ev => {
    const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
    return {
      title: ev.summary || '(제목 없음)',
      allDay,
      start: allDay ? undefined : ev.start.dateTime,
      location: ev.location || undefined,
    };
  });
  return { events, rawCount: items.length };
}

function parseFromName(raw) {
  const s = String(raw || '').trim();
  const m = /^"?([^"<]*)"?\s*<.*>$/.exec(s);
  if (m && m[1].trim()) return m[1].trim();
  return s.replace(/<.*>/, '').trim() || s;
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── 1단계: 메일 수집 — "중요"는 Gmail 자체 IMPORTANT 라벨 + 안읽음으로만 판정 ──
async function fetchMail(token) {
  const auth = { authorization: `Bearer ${token}` };

  // 전체 안읽음 개수 — Gmail이 돌려주는 추정치(resultSizeEstimate)라 근사값이다.
  const unreadRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'is:unread', maxResults: '1' })}`,
    { headers: auth }
  );
  const unreadData = await unreadRes.json();
  if (!unreadRes.ok) throw new Error(`Gmail 안읽음 조회 실패: ${JSON.stringify(unreadData)}`);
  const unreadCount = unreadData.resultSizeEstimate || 0;

  // 안읽음 + 중요 표시된 메일만 상세 조회 (최대 10통)
  const impRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'is:unread is:important', maxResults: '10' })}`,
    { headers: auth }
  );
  const impData = await impRes.json();
  if (!impRes.ok) throw new Error(`Gmail 중요 메일 조회 실패: ${JSON.stringify(impData)}`);
  const ids = (impData.messages || []).map(m => m.id);

  const importantMails = [];
  for (const id of ids) {
    const params = new URLSearchParams();
    params.append('format', 'metadata');
    params.append('metadataHeaders', 'From');
    params.append('metadataHeaders', 'Subject');
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${params}`,
      { headers: auth }
    );
    const msgData = await msgRes.json();
    if (!msgRes.ok) {
      console.warn(`⚠️  메일 ${id} 상세 조회 실패 — 건너뜀: ${JSON.stringify(msgData)}`);
      continue;
    }
    const headers = (msgData.payload && msgData.payload.headers) || [];
    const from = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '(제목 없음)';
    importantMails.push({
      from: parseFromName(from),
      subject,
      summary: truncate(decodeEntities(msgData.snippet || ''), 100),
    });
  }

  return { importantMails, unreadCount, rawImportantCount: ids.length };
}

async function main() {
  const token = await getAccessToken();
  const [{ events, rawCount }, { importantMails, unreadCount, rawImportantCount }] = await Promise.all([
    fetchEvents(token),
    fetchMail(token),
  ]);

  // ── 3단계: 출력 전 자체 감사 — 필터링 전후 개수를 대조해 조용한 누락을 잡는다 ──
  if (events.length !== rawCount) {
    console.warn(`⚠️  일정 개수 불일치: 정리 후 ${events.length}건, API 원본(취소 제외) ${rawCount}건`);
  }
  if (importantMails.length !== rawImportantCount) {
    console.warn(`⚠️  중요 메일 상세조회 개수 불일치: ${importantMails.length}건 (목록에서는 ${rawImportantCount}건)`);
  }
  if (importantMails.length > unreadCount) {
    console.warn(`⚠️  중요 메일(${importantMails.length})이 전체 안읽음 추정치(${unreadCount})보다 많습니다 — unreadCount는 Gmail의 근사치라 오차가 있을 수 있습니다`);
  }

  const agenda = {
    date: dateKey,
    generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    events,
    unreadCount,
    importantMails,
  };

  fs.writeFileSync(outFile, JSON.stringify(agenda, null, 2), 'utf8');
  console.log(`생성 완료: ${dateKey}.json (일정 ${events.length}건 · 안읽음 ${unreadCount}통 · 중요메일 ${importantMails.length}건)`);
}

main().catch(e => { console.error(e); process.exit(1); });
