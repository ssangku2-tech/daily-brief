// 서버(=CI)가 지금 어떤 구독으로 알림을 보내고 있고, 마지막 발송이 어떻게 됐는지를
// push/state.json 에 남긴다. 앱은 GitHub Secret 안을 볼 수 없으므로, 이 파일이
// "내 폰의 구독과 시크릿이 같은 것인가"를 확인할 수 있는 유일한 통로다.
//
// 2026-08-13 이전에는 앱이 localStorage(`mypush_synced_v1`) 에 "구독 정보를 복사한 시각의
// endpoint" 를 적어두고 비교했다. 그건 근사치라 두 가지를 놓쳤다 — 복사하기 전에 구독이
// 바뀌면 기준값이 아예 없고(2026-08-12 가 이 경우였다), 앱을 재설치하면 기준값도 함께
// 지워진다. 지문을 서버가 적어 내려주면 두 경우 모두 정확히 잡힌다.
//
// endpoint 원문이 아니라 SHA-256 앞 16자만 적는다. 이 파일은 공개 저장소에 커밋되고
// GitHub Pages 로도 서빙되는데, endpoint 는 (VAPID 비밀키와 함께라면) 이 폰에 알림을
// 보낼 수 있는 주소이므로 공개하면 안 된다. 지문은 같은지 다른지만 알려준다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveSubscription } = require('./push-store.js');

const FILE = path.join(__dirname, '..', 'push', 'state.json');

const hashOf = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

// 지금 CI 가 실제로 쓰는 구독의 지문 — 워커에 등록된 값이 있으면 그것, 없으면 시크릿.
// 앱은 이 지문을 자기 구독과 대조해 "서버가 내 구독을 들고 있는가"를 판단하므로,
// 여기서 고르는 구독과 send-push.js 가 실제로 쏘는 구독이 반드시 같아야 한다.
async function endpointHashFromEnv() {
  const r = await resolveSubscription();
  return r ? hashOf(r.sub.endpoint) : '';
}

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return null; }
}

// 지문과 발송 결과가 그대로면 파일을 건드리지 않는다 — 이 스크립트는 30분마다 도는
// 알림 워크플로에서도 불리므로, 타임스탬프만 바뀐 커밋이 쌓이면 저장소가 지저분해진다.
// 그래서 `at` 은 "마지막으로 기록한 시각"이 아니라 "이 상태가 시작된 시각"이다.
function record({ endpointHash, status }) {
  if (!endpointHash) return { changed: false, prev: read() };
  const prev = read();
  const sameSub = !!prev && prev.endpointHash === endpointHash;
  const next = {
    endpointHash,
    // 시크릿이 새 구독으로 바뀌었으면 이전 410 은 더 이상 이 구독의 이야기가 아니다.
    // 0 = 이 구독으로 아직 한 번도 보낸 적 없음.
    status: status !== undefined ? status : (sameSub ? prev.status : 0),
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  if (sameSub && prev.status === next.status) return { changed: false, prev };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  return { changed: true, prev };
}

module.exports = { endpointHashFromEnv, record, read };

// 워크플로에서 `node scripts/push-state.js` 로 직접 부르면 "발송과 무관하게 지금 시크릿의
// 지문만" 기록한다. 이게 있어야 시크릿을 갱신한 뒤 앱의 경고가 다음 실행에서 풀린다 —
// 발송할 일(급변동·아침 브리핑)이 생길 때까지 기다리면 하루가 걸릴 수 있다.
if (require.main === module) {
  endpointHashFromEnv().then(h => {
    if (!h) {
      console.log('등록된 구독이 없어(워커·시크릿 모두) 상태 기록을 건너뜁니다.');
      return;
    }
    const { changed } = record({ endpointHash: h });
    console.log(changed ? `푸시 구독 지문 기록: ${h}` : `푸시 구독 지문 변화 없음: ${h}`);
  });
}
