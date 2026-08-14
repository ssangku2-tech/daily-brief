// 푸시 구독 주소 보관소 — Cloudflare Worker.
//
// 왜 필요한가: 폰의 푸시 구독(endpoint)은 브라우저가 마음대로 갈아끼우거나 통째로 버린다.
// 2026-08-08 부터 08-13 까지 엿새 사이 다섯 번 끊겼고, 그때마다 사람이 폰에서 값을 복사해
// GitHub Secret(PUSH_SUBSCRIPTION) 에 손으로 붙여넣어야 했다. 30분마다 바뀔 수 있는 값을
// 사람이 옮기는 구조가 틀렸다. 앱이 직접 여기에 써 두면 CI 가 발송 직전에 읽어가므로
// 손으로 하는 단계가 사라진다.
//
// **이 파일은 저장소에 있지만 저장소에서 배포되지 않는다.** Cloudflare 대시보드에
// 손으로 붙여넣어 배포한다(계정에 이미 있는 stock-proxy 워커와는 별개의 워커다 —
// 그쪽은 포트폴리오 앱이 쓰는 외부 계약이라 건드리지 않는다). 고치면 여기와 대시보드
// 양쪽을 함께 갱신해야 한다.
//
// 필요한 바인딩 (대시보드에서 설정):
//   KV 네임스페이스  PUSH_KV      — 구독 하나를 담아둘 저장소
//   환경 변수        WRITE_TOKEN  — 앱이 쓸 때 쓰는 토큰. index.html 에 들어가므로 공개값이다.
//   환경 변수        ADMIN_TOKEN  — CI 가 읽을 때 쓰는 토큰. GitHub Secret 에만 둔다.
//
// 토큰을 둘로 나눈 이유: 쓰기 토큰은 브라우저 코드에 들어가니 숨길 수 없다(공개 저장소에
// 커밋되는 index.html 안에 있다). 그래서 **읽기는 따로 막는다** — endpoint 는 이 폰으로
// 알림을 보낼 수 있는 주소이므로 아무나 읽게 두면 안 된다.
// 쓰기 토큰이 공개인 것의 위험은 "누군가 남의 구독으로 덮어써서 알림이 안 오게 만드는 것"
// 하나이고, 알림에는 내용이 실리지 않으므로(내용은 폰이 GitHub Pages 에서 직접 읽어 만든다)
// 새어 나갈 데이터는 없다. 그 위험보다 매일 손으로 값을 옮기는 쪽이 실제로 더 자주 앱을
// 망가뜨렸다. 그래도 스캐너가 지나가며 덮어쓰는 건 막으려고 토큰과 호스트 검사를 둔다.

// 구독 endpoint 로 인정할 호스트. 푸시 서비스가 아닌 주소가 저장되면 CI 가 매번 그리로
// POST 하게 되므로(=아무 서버나 두드리는 꼴) 반드시 걸러낸다.
const ALLOWED_HOSTS = [
  'fcm.googleapis.com',              // 크롬/안드로이드
  'android.googleapis.com',
  'updates.push.services.mozilla.com', // 파이어폭스
  'web.push.apple.com',              // 사파리
  'wns2-*.notify.windows.com',       // 엣지 (와일드카드는 아래에서 처리)
];

// 앱이 올라가 있는 오리진. 브라우저가 보내는 Origin 은 위조할 수 없으므로(스크립트로는)
// 토큰과 함께 얕은 잠금 하나를 더 두는 셈이다. curl 로는 얼마든지 흉내낼 수 있다.
const ALLOWED_ORIGIN = 'https://ssangku2-tech.github.io';

const KEY = 'current';

function hostAllowed(host) {
  return ALLOWED_HOSTS.some(p => {
    if (!p.includes('*')) return host === p;
    const [head, tail] = p.split('*');
    return host.startsWith(head) && host.endsWith(tail);
  });
}

async function sha16(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', ...cors(), ...extra },
});

// 앱과 서비스워커가 브라우저에서 직접 부르므로 CORS 가 필요하다.
// 본문을 text/plain 으로 보내면 프리플라이트 없이 통과한다(그래서 앱은 그렇게 보낸다).
const cors = () => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (url.pathname !== '/sub') return json({ error: 'not found' }, 404);

    const token = url.searchParams.get('t') || '';

    // ── 읽기: CI 전용. 여기서 막지 않으면 endpoint 가 공개된다. ───────────────────
    if (request.method === 'GET') {
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);
      const raw = await env.PUSH_KV.get(KEY);
      if (!raw) return json({ sub: null }, 404);
      return json(JSON.parse(raw));
    }

    // ── 쓰기: 앱/서비스워커가 구독을 새로 만들 때마다 부른다. ────────────────────
    if (request.method === 'POST') {
      if (!env.WRITE_TOKEN || token !== env.WRITE_TOKEN) return json({ error: 'unauthorized' }, 401);

      let sub;
      try {
        sub = JSON.parse(await request.text());
      } catch (e) {
        return json({ error: 'bad json' }, 400);
      }
      if (!sub || typeof sub.endpoint !== 'string') return json({ error: 'no endpoint' }, 400);

      let host;
      try { host = new URL(sub.endpoint).host; } catch (e) { return json({ error: 'bad endpoint' }, 400); }
      if (!hostAllowed(host)) return json({ error: 'host not allowed' }, 400);

      const endpointHash = await sha16(sub.endpoint);
      const prevRaw = await env.PUSH_KV.get(KEY);
      const prev = prevRaw ? JSON.parse(prevRaw) : null;

      // 같은 구독을 다시 보내오는 건 정상이다(앱이 켜질 때마다 확인하므로).
      // 그때는 KV 에 다시 쓰지 않는다 — 무료 한도의 쓰기 횟수를 아끼고, at 이
      // "이 구독이 등록된 시각"이라는 뜻을 유지한다.
      if (prev && prev.endpointHash === endpointHash) {
        return json({ ok: true, changed: false, endpointHash, at: prev.at });
      }

      const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      await env.PUSH_KV.put(KEY, JSON.stringify({ sub, endpointHash, at }));
      return json({ ok: true, changed: true, endpointHash, at });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
