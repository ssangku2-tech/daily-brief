// 웹 푸시용 VAPID 키쌍을 한 번만 만든다. CI 용이 아니라 로컬에서 딱 한 번 실행하는
// 도구다 (setup-google-auth.js 와 같은 성격).
//
//   node scripts/setup-push.js
//
// 비밀키는 화면에 찍지 않고 push-keys.txt 에 쓴다. 터미널 출력은 캡처되거나 로그·대화에
// 남기 쉬운데(예: Claude Code 에서 `! node ...` 로 실행하면 출력이 그대로 대화 기록에
// 들어간다), 파일로 빼면 그런 경로로 새지 않는다. push-keys.txt 는 .gitignore 에 있다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });

// VAPID 공개키는 비압축 EC 포인트(0x04 || x || y) 65바이트를 base64url 로 인코딩한 값이다.
const publicKey = b64url(Buffer.concat([
  Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y),
]));

const outFile = path.join(__dirname, '..', 'push-keys.txt');
fs.writeFileSync(outFile, `VAPID 키쌍 (생성: ${new Date().toISOString()})

이 파일은 .gitignore 에 있어 커밋되지 않습니다.
GitHub Secret 에 옮겨 담은 뒤 삭제하세요.

VAPID_PUBLIC_KEY
${publicKey}

VAPID_PRIVATE_KEY
${jwk.d}
`, { encoding: 'utf8', mode: 0o600 });

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VAPID 키쌍을 만들어 push-keys.txt 에 저장했습니다.
비밀키는 화면에 찍지 않습니다 — 파일을 직접 열어서 복사하세요.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ${outFile}

[1] 파일의 VAPID_PUBLIC_KEY 를 index.html 의  const VAPID_PUBLIC_KEY = '';  안에
    붙여넣고 커밋합니다. 공개돼도 안전한 값이고, 발송 스크립트가 여기서 읽어갑니다
    (그래서 시크릿으로 따로 등록할 필요가 없습니다).

[2] 파일의 VAPID_PRIVATE_KEY 는 GitHub Secret 에만 넣습니다:
      저장소 → Settings → Secrets and variables → Actions → New secret
      이름: VAPID_PRIVATE_KEY

[3] 앱에서 "알림 받기"를 누른 뒤 나오는 구독 JSON 을
      GitHub Secret  PUSH_SUBSCRIPTION 으로 추가합니다.

[4] 다 옮긴 뒤 push-keys.txt 를 지웁니다.

⚠️  이 파일 내용을 채팅·커밋·로그에 붙여넣지 마세요. 유출됐다면 이 스크립트를
    다시 돌려 키를 새로 만들고 앱에서 알림을 다시 구독하면 됩니다.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
