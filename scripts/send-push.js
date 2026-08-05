// 아침 브리핑이 새로 생성됐을 때 폰으로 웹 푸시를 한 번 쏜다. GitHub Actions 에서 실행됨.
//
// 알림 "내용"은 보내지 않는다. 페이로드를 실으려면 ECDH + HKDF + AES-GCM 암호화를 직접
// 짜야 하는데(이 레포는 package.json 을 두지 않아 web-push 패키지를 쓸 수 없다), 내용 없는
// 푸시는 VAPID JWT 서명만 하면 되고 그건 node:crypto 로 충분하다.
// 대신 sw.js 의 push 핸들러가 깨어나서 briefings/agenda JSON 을 직접 읽어 문구를 만든다 —
// 덕분에 알림 문구가 "발송 시점"이 아니라 "받는 시점"의 데이터로 만들어지는 이점도 있다.
//
// 필요한 환경변수 (모두 GitHub Secret):
//   VAPID_PRIVATE_KEY  — setup-push.js 가 출력한 비밀키 (base64url d 값)
//   VAPID_PUBLIC_KEY   — 같은 스크립트가 출력한 공개키 (index.html 에 넣은 것과 같은 값)
//   PUSH_SUBSCRIPTION  — 앱에서 구독 후 복사한 JSON
const crypto = require('crypto');

const { VAPID_PRIVATE_KEY, PUSH_SUBSCRIPTION } = process.env;

// 공개키는 index.html 에 이미 공개돼 있으므로 Secret 으로 또 받지 않고 거기서 읽는다
// (사용자가 등록해야 할 Secret 이 하나 줄고, 두 값이 어긋날 일도 없다).
function readPublicKey() {
  if (process.env.VAPID_PUBLIC_KEY) return process.env.VAPID_PUBLIC_KEY; // 있으면 그걸 우선
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/const VAPID_PUBLIC_KEY = '([^']*)'/);
  return m ? m[1] : '';
}
const VAPID_PUBLIC_KEY = readPublicKey();

// 알림은 이 앱의 필수 기능이 아니다 — 설정이 없으면 조용히 넘어가고 브리핑 생성은 그대로 성공시킨다.
if (!VAPID_PRIVATE_KEY || !VAPID_PUBLIC_KEY || !PUSH_SUBSCRIPTION) {
  const missing = [
    !VAPID_PRIVATE_KEY && 'VAPID_PRIVATE_KEY(시크릿)',
    !VAPID_PUBLIC_KEY && 'VAPID_PUBLIC_KEY(index.html)',
    !PUSH_SUBSCRIPTION && 'PUSH_SUBSCRIPTION(시크릿)',
  ].filter(Boolean).join(', ');
  console.log(`푸시 설정이 없어 알림을 건너뜁니다 — 빠진 것: ${missing}`);
  process.exit(0);
}

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// 원본 VAPID 키(공개키 65바이트 + 비밀키 d)를 JWK 로 조립해 KeyObject 를 만든다.
// PEM 을 따로 보관하지 않아도 되고, 표준 VAPID 키 형식을 그대로 쓸 수 있다.
function privateKeyFromVapid(publicB64, privateB64) {
  const pub = fromB64url(publicB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY 형식이 올바르지 않습니다 (65바이트 비압축 EC 포인트여야 함)');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: privateB64,
    },
  });
}

function makeVapidJwt(endpoint, key) {
  const aud = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(Buffer.from(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // 푸시 서비스는 24시간 넘는 exp 를 거부한다
    sub: 'https://github.com/ssangku2-tech/daily-brief',
  })));
  // JWS 는 r||s 64바이트(P1363)를 요구한다. Node 의 기본 출력은 DER 이라 그대로 쓰면 거부된다.
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key, dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${b64url(sig)}`;
}

async function main() {
  const sub = JSON.parse(PUSH_SUBSCRIPTION);
  if (!sub.endpoint) throw new Error('PUSH_SUBSCRIPTION 에 endpoint 가 없습니다.');

  const key = privateKeyFromVapid(VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const jwt = makeVapidJwt(sub.endpoint, key);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
      TTL: '3600',            // 폰이 꺼져 있으면 1시간까지 보관 후 폐기
      'Content-Length': '0',  // 페이로드 없음
    },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 404 || res.status === 410) {
    // 구독이 폐기됐다(사용자가 알림을 끔, 서비스워커 교체, 브라우저 정리 등).
    // 이건 저절로 낫지 않고 사람이 재구독해야 하는 상태라, 유일하게 워크플로를 실패시키는
    // 경우로 둔다 — 그래야 GitHub 이 실패 메일을 보내고, 그 메일이 앱의 메일 카드에도 떠서
    // 알림이 죽은 걸 바로 알 수 있다. 실제로 한 번 410 이 났는데 워크플로가 초록불이라
    // 한참 뒤에야 알아챈 적이 있다.
    // 발송은 브리핑·알림 파일을 커밋한 뒤에 하므로, 여기서 실패해도 데이터는 이미 안전하다.
    console.error(`⚠️  구독이 더 이상 유효하지 않습니다 (${res.status}).`);
    console.error('   앱에서 알림을 다시 켜고 PUSH_SUBSCRIPTION 시크릿을 갱신하세요.');
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    // 5xx·429 같은 일시적 실패는 다음 크론이 알아서 다시 시도한다. 이걸로 실패 메일을
    // 보내면(알림 워크플로는 하루 수십 번 돈다) 정작 중요한 410 이 묻힌다.
    console.warn(`⚠️  푸시 발송 실패: ${res.status} ${await res.text()}`);
    return;
  }
  console.log(`푸시 발송 완료 (${res.status})`);
}

// 그 밖의 오류(네트워크 등)는 브리핑 워크플로를 빨갛게 만들지 않고 넘어간다.
main().catch(e => { console.warn(`⚠️  푸시 건너뜀: ${e.message}`); });
