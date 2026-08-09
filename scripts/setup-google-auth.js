// 로컬 실행 스크립트: Google Calendar/Gmail 읽기 권한에 동의하고 refresh_token을 발급받는다.
// generate-agenda.js가 매일 크론에서 쓸 자격증명을 준비하는 단계다.
//
// 실행 전에 OAuth 동의 화면이 "프로덕션"으로 게시돼 있는지 먼저 확인할 것.
// "테스트" 상태에서 발급한 refresh_token은 7일 뒤 만료되고, 그날부터 크론이
// invalid_grant("Token has been expired or revoked")로 조용히 죽는다.
// 2026-08-08에 실제로 이렇게 끊겼다 — 게시를 먼저 하지 않고 재발급만 하면 일주일 뒤 똑같아진다.
//
// 사용법:
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/setup-google-auth.js
//
// 브라우저가 자동으로 안 뜨면 터미널에 출력되는 URL을 직접 열어서 동의하면 된다.
// 발급된 값은 화면에만 출력된다 — GitHub 저장소 Settings → Secrets and variables →
// Actions 에 그대로 등록할 것. (채팅·커밋·로그 등 어디에도 붙여넣지 말 것 — 이 값은
// 본인 Gmail/캘린더에 접근 가능한 자격증명이다.)
const http = require('http');
const { URL } = require('url');
const { exec } = require('child_process');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET 환경변수가 필요합니다.');
  process.exit(1);
}

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;
// 캘린더/메일 둘 다 읽기 전용. Gmail은 gmail.readonly(본문 전체 접근) 대신
// gmail.metadata 로 최소화했다 — generate-agenda.js가 실제로 쓰는 건 라벨·발신자·제목·
// snippet뿐이라 metadata 로 충분하고, 자격증명이 새더라도 본문까지는 안 넘어간다.
// (2026-08-10 정정: 예전 주석은 metadata 가 "민감" 스코프라 심사 없이 게시할 수 있다고
//  적어놨는데 틀렸다. Google 분류상 metadata 도 readonly 와 같은 "제한된" 스코프다.
//  심사를 면하게 해주는 건 스코프 선택이 아니라 "개인 사용" 예외 — 본인만 쓰는 앱 —
//  이고, 그건 두 스코프 어느 쪽이든 똑같이 적용된다.)
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.metadata',
].join(' ');

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES,
  access_type: 'offline',
  prompt: 'consent', // 예전에 동의한 적 있어도 refresh_token을 다시 받기 위해 동의 화면을 강제로 띄운다
})}`;

console.log('\n브라우저에서 아래 주소를 열어 Google 계정으로 동의해주세요:\n');
console.log(authUrl + '\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>동의가 취소됐습니다.</h1>이 창은 닫아도 됩니다.');
    console.error(`동의 실패: ${error}`);
    server.close();
    process.exit(1);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1>완료됐습니다.</h1>이 창은 닫고 터미널로 돌아가세요.');
  server.close();

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      console.error('토큰 발급 실패:', tokens);
      console.error('\n(refresh_token이 안 왔다면 예전에 이미 한 번 동의했을 가능성이 있습니다.');
      console.error(' https://myaccount.google.com/permissions 에서 이 앱의 접근 권한을 제거한 뒤 다시 실행하세요.)');
      process.exit(1);
    }

    console.log('\n=== 아래 세 값을 GitHub 저장소 Settings → Secrets and variables → Actions 에 등록하세요 ===\n');
    console.log(`GOOGLE_CLIENT_ID     = ${CLIENT_ID}`);
    console.log(`GOOGLE_CLIENT_SECRET = ${CLIENT_SECRET}`);
    console.log(`GOOGLE_REFRESH_TOKEN = ${tokens.refresh_token}`);
    console.log('\n등록 후에는 이 터미널 화면을 지우거나 창을 닫아 화면에 남기지 않는 걸 권장합니다.\n');
    process.exit(0);
  } catch (e) {
    console.error('토큰 교환 중 오류:', e);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  // 가능하면 기본 브라우저를 자동으로 연다. 실패해도 위에 출력된 URL을 손으로 열면 된다.
  const opener = process.platform === 'win32' ? 'start ""'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  exec(`${opener} "${authUrl}"`, () => {});
});
