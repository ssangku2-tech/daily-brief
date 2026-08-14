// CI 가 "지금 폰이 쓰는 푸시 구독"을 어디서 얻는지 한 곳에 모아둔 모듈.
//
// 원래는 GitHub Secret(PUSH_SUBSCRIPTION) 하나뿐이었는데, 그 값은 브라우저가 마음대로
// 갈아끼우는 값이라 사람이 계속 옮겨 적어야 했다(2026-08-08~13 에 다섯 번). 이제는 앱이
// Cloudflare Worker(worker/push-store.js) 에 직접 써 두고, 여기서 그걸 읽는다.
//
// 시크릿은 그대로 **대비책**으로 남는다 — 워커가 아직 없거나, 죽었거나, 환경변수가 안
// 들어왔을 때 예전처럼 동작해야 하기 때문이다. 워커 설정 전까지는 아무것도 달라지지 않는다.
//
// 환경변수:
//   PUSH_STORE_URL          — 예: https://push-store.ssangku2.workers.dev/sub
//   PUSH_STORE_ADMIN_TOKEN  — 워커의 ADMIN_TOKEN (읽기 전용 토큰, GitHub Secret)
//   PUSH_SUBSCRIPTION       — 예전 방식의 구독 JSON (대비책)

async function fromStore() {
  const { PUSH_STORE_URL, PUSH_STORE_ADMIN_TOKEN } = process.env;
  if (!PUSH_STORE_URL || !PUSH_STORE_ADMIN_TOKEN) return null;
  try {
    const url = `${PUSH_STORE_URL}${PUSH_STORE_URL.includes('?') ? '&' : '?'}t=${encodeURIComponent(PUSH_STORE_ADMIN_TOKEN)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.status === 404) {
      console.log('[push-store] 워커에 아직 등록된 구독이 없습니다 — 시크릿으로 대체합니다.');
      return null;
    }
    if (!res.ok) {
      console.warn(`[push-store] 워커 조회 실패 (${res.status}) — 시크릿으로 대체합니다.`);
      return null;
    }
    const data = await res.json();
    if (!data || !data.sub || !data.sub.endpoint) return null;
    return { sub: data.sub, at: data.at || '', source: 'worker' };
  } catch (e) {
    // 워커가 잠깐 죽어도 알림 발송 자체는 시크릿으로 계속돼야 한다.
    console.warn(`[push-store] 워커 조회 오류 (${e.message}) — 시크릿으로 대체합니다.`);
    return null;
  }
}

function fromSecret() {
  const raw = process.env.PUSH_SUBSCRIPTION;
  if (!raw) return null;
  try {
    const sub = JSON.parse(raw);
    return sub && sub.endpoint ? { sub, at: '', source: 'secret' } : null;
  } catch (e) {
    return null;
  }
}

// 워커 우선, 없으면 시크릿. 둘 다 없으면 null (호출한 쪽이 조용히 건너뛴다).
async function resolveSubscription() {
  return (await fromStore()) || fromSecret();
}

module.exports = { resolveSubscription };
