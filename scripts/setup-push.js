// 웹 푸시용 VAPID 키쌍을 한 번만 만들어 출력한다. CI에서 돌리는 스크립트가 아니라
// 로컬에서 딱 한 번 실행하는 도구다 (setup-google-auth.js 와 같은 성격).
//
//   node scripts/setup-push.js
//
// 출력되는 비밀키는 이 터미널 밖으로 내보내지 말 것 — 채팅·커밋·로그 어디에도 붙여넣지
// 않는다. GitHub Secret 입력창에 직접 붙여넣는 것만 안전하다.
const crypto = require('crypto');

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });

// VAPID 공개키는 비압축 EC 포인트(0x04 || x || y) 65바이트를 base64url 로 인코딩한 값이다.
const publicKey = b64url(Buffer.concat([
  Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y),
]));

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VAPID 키쌍을 만들었습니다. 아래 두 가지를 각각 다른 곳에 넣으세요.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1] 공개키 — index.html 의 VAPID_PUBLIC_KEY 상수에 붙여넣기
    (공개돼도 안전한 값입니다. 저장소에 그대로 커밋합니다.)

${publicKey}

[2] 비밀키 — GitHub Secret 에만 붙여넣기
    저장소 → Settings → Secrets and variables → Actions → New secret
    이름: VAPID_PRIVATE_KEY

${jwk.d}

    ⚠️  이 값은 커밋하거나 채팅에 붙여넣지 마세요. 유출되면 누구나 회원님 폰으로
        알림을 보낼 수 있습니다. 유출됐다면 이 스크립트를 다시 돌려 키를 새로 만들고
        앱에서 알림을 다시 구독하면 됩니다.

[3] 남은 한 가지 — 앱에서 "알림 받기"를 누른 뒤 나오는 구독 정보(JSON)를
    PUSH_SUBSCRIPTION 이라는 이름의 Secret 으로 추가하세요.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
