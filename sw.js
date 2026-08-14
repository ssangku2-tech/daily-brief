const CACHE='daily-brief-v41';
// 구독 교체 자국을 남겨두는 별도 캐시. 배포 때마다 지워지면 안 되므로 activate 의
// 삭제 대상에서 제외한다 (index.html 이 걷어간 뒤 스스로 비운다).
const DIAG='push-diag-v1';
// 앱 셸 — 이 파일들이 없으면 앱이 뜨지 않으므로 설치 단계에서 반드시 캐시한다.
const CORE=['./','./index.html','./manifest.json'];
// 아이콘은 아직 저장소에 없을 수 있다. addAll 은 하나만 404 나도 전체가 실패해
// 설치가 깨지므로 실패를 허용하는 별도 목록으로 분리한다.
const OPTIONAL=['./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>
      c.addAll(CORE).then(()=>
        Promise.allSettled(OPTIONAL.map(u=>c.add(u)))
      )
    )
  );
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE&&k!==DIAG).map(k=>caches.delete(k)))));
  self.clients.claim();
});
// 푸시 수신 → 알림 표시.
// send-push.js 는 내용 없는 푸시만 보낸다(암호화 없이 보내려고). 그래서 문구는 여기서
// 만든다 — 오늘자 브리핑·일정 JSON 을 직접 읽어 조립하므로 "보낸 시점"이 아니라
// "받는 시점"의 데이터가 들어간다.
// userVisibleOnly:true 로 구독했기 때문에 푸시를 받고 알림을 안 띄우면 브라우저가
// 경고를 띄우거나 구독을 해지한다 — 무슨 일이 있어도 showNotification 은 호출해야 한다.
self.addEventListener('push',e=>{
  e.waitUntil((async()=>{
    const get=async u=>{ try{ const r=await fetch(u,{cache:'no-store'}); return r.ok?await r.json():null; }catch(_){ return null; } };

    // 푸시는 내용이 없으므로 "무슨 알림인지"도 여기서 판단한다. 급변동 알림은 발송 직전에
    // alerts/latest.json 을 갱신·배포하므로, 그 파일이 방금 쓰인 것이면 급변동 알림이다.
    // 20분은 크론 간격(30분)보다 짧아 지난 알림을 다시 띄우지 않으면서, 배포·전달 지연은
    // 충분히 감당하는 값이다.
    const alert=await get('alerts/latest.json');
    if(alert&&alert.at&&(Date.now()-new Date(alert.at).getTime())<20*60*1000&&(alert.items||[]).length){
      const txt=alert.items.map(i=>`${i.name} ${i.pct>0?'+':''}${i.pct}%`).join('\n');
      await self.registration.showNotification('📈 관심 종목 급변동',{
        body:txt,
        icon:'./icon-192.png',
        badge:'./icon-192.png',
        tag:'stock-alert',
      });
      return;
    }

    let body='앱을 열어 확인하세요';
    try{
      const key=new Date(Date.now()+9*3600*1000).toISOString().slice(0,10); // KST 오늘
      const [b,a]=await Promise.all([get(`briefings/${key}.json`),get(`agenda/${key}.json`)]);
      const lines=[];
      if(b&&b.summary) lines.push(b.summary);
      else if(b&&b.indices&&b.indices.length){
        lines.push(b.indices.filter(i=>i.price!=='확인 실패').map(i=>`${i.name} ${i.changePct}`).join(' · '));
      }
      if(a){
        const bits=[];
        const today=(a.events||[]).filter(ev=>String(ev.start||'').slice(0,10)===key).length;
        if(today) bits.push(`일정 ${today}건`);
        if(a.importantMails&&a.importantMails.length) bits.push(`중요 메일 ${a.importantMails.length}건`);
        if(bits.length) lines.push(bits.join(' · '));
      }
      if(lines.length) body=lines.join('\n');
    }catch(_){ /* 문구 조립에 실패해도 알림 자체는 반드시 띄운다 */ }
    await self.registration.showNotification('☀️ 오늘의 브리핑',{
      body,
      icon:'./icon-192.png',
      badge:'./icon-192.png',
      tag:'daily-brief',   // 같은 tag 는 덮어쓴다 — 재시도 크론이 여러 번 쏴도 알림이 쌓이지 않는다
      renotify:false,
    });
  })());
});
// 브라우저가 스스로 구독을 갈아끼울 때 발생한다(키 회전 등). 여기서 다시 구독해두지
// 않으면 구독이 사라진 채로 남아, 서버는 다음 발송에서 410 을 받는다.
// 새 endpoint 를 서버에 알릴 방법은 없다(이 앱에는 서버가 없고 값은 GitHub Secret 에 있다).
// 대신 index.html 이 앱을 열 때 endpoint 를 마지막으로 복사한 값과 비교해
// "시크릿과 어긋남" 을 띄우므로, 여기서는 구독만 되살려 두면 된다.
// 서비스워커는 localStorage 를 쓸 수 없으므로 Cache 에 자국을 남긴다. index.html 이
// 앱을 열 때 이걸 걷어가 구독 변경 기록에 합친다 — "브라우저가 스스로 갈아끼웠다"와
// "앱 데이터가 통째로 지워졌다"를 구분하는 유일한 단서다.
async function mark(endpoint){
  let h='';
  if(endpoint){
    const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(endpoint));
    h=[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16);
  }
  const c=await caches.open(DIAG);
  const prev=await c.match('./marks.json');
  const list=prev?await prev.json():[];
  list.push({t:new Date().toISOString(),h});
  await c.put('./marks.json',new Response(JSON.stringify(list.slice(-12)),{headers:{'Content-Type':'application/json'}}));
}
self.addEventListener('pushsubscriptionchange',e=>{
  e.waitUntil((async()=>{
    try{
      // 공개키는 index.html 한 곳에만 둔다(send-push.js 도 거기서 읽는다) — 여기 복사해두면
      // 키를 바꿨을 때 조용히 어긋난다. 이전 구독이 키를 들고 있으면 그걸 먼저 쓴다.
      let key=e.oldSubscription&&e.oldSubscription.options&&e.oldSubscription.options.applicationServerKey;
      if(!key){
        const r=await fetch('./index.html',{cache:'no-store'});
        const m=(await r.text()).match(/VAPID_PUBLIC_KEY\s*=\s*'([^']+)'/);
        if(!m) return;
        const s=m[1], pad='='.repeat((4-s.length%4)%4);
        const raw=atob((s+pad).replace(/-/g,'+').replace(/_/g,'/'));
        key=Uint8Array.from(raw,c=>c.charCodeAt(0));
      }
      const sub=await self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
      await mark(sub&&sub.endpoint);
    }catch(_){
      // 되살리기 실패해도 앱의 "알림 받기" 버튼으로 복구할 수 있다.
      // 다만 "브라우저가 구독을 갈아끼웠다"는 사실 자체는 남겨야 원인 추적이 된다.
      try{ await mark(''); }catch(__){}
    }
  })());
});
// 알림 클릭 → 앱 열기/포커스
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
      for(const c of list){ if('focus'in c) return c.focus(); }
      if(self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'){return}
  const url=e.request.url;
  // 외부 API/폰트는 항상 네트워크 (캐시하지 않는다)
  // workers.dev = 시세·뉴스 프록시(stock-proxy). 접속 시점에 받는 값을 캐시하면 낡은 값이
  // 그대로 나오므로 반드시 캐시 우회 대상이어야 한다.
  // accounts.google.com = 구글 로그인 스크립트/토큰, googleapis.com = Gmail·Calendar API
  // (실시간 메일·일정)와 translate.googleapis.com (뉴스 제목 번역) 양쪽을 함께 덮는다.
  if(url.includes('workers.dev')||url.includes('open-meteo.com')||url.includes('bigdatacloud.net')||url.includes('accounts.google.com')||url.includes('googleapis.com')||url.includes('fonts.g')||url.includes('gstatic.com')){return}
  // 매일 갱신되는 브리핑/일정·메일·급변동 알림은 네트워크 우선(실패 시 캐시) —
  // 오프라인에서 어제 것이라도 보이게. (alerts/ 는 지금은 서비스워커가 직접 읽어서
  // 이 핸들러를 타지 않지만, 나중에 페이지가 읽게 되면 캐시된 낡은 알림을 보게 된다)
  // push/state.json 은 "지금 서버가 어떤 구독으로 보내고 있는가"를 알려주는 파일이라
  // 캐시된 값을 보면 이미 고쳐진 경고가 계속 뜨거나, 새 고장을 놓친다.
  if(url.includes('/briefings/')||url.includes('/agenda/')||url.includes('/alerts/')||url.includes('/push/')){
    e.respondWith(
      fetch(e.request).then(resp=>{
        if(resp.ok){const cl=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,cl))}
        return resp;
      }).catch(()=>caches.match(e.request).then(r=>
        // 캐시에도 없으면 undefined 가 되어 respondWith 가 깨진다 → 앱이 에러 상태를 그리도록 504 를 준다.
        r||new Response('{}',{status:504,headers:{'Content-Type':'application/json'}})
      ))
    );
    return;
  }
  // 앱 셸(index.html)도 네트워크 우선 — 캐시 우선으로 두면 새 버전을 배포해도 항상 한
  // 박자 늦게(다음 실행 때) 반영돼, 고친 화면이 안 보인다는 착각을 부른다.
  // 오프라인 대비는 catch 쪽 캐시 폴백이 그대로 맡는다.
  // 응답은 요청 URL이 아니라 './index.html' 키로 저장한다 — '/' 로 들어오든
  // '/index.html' 로 들어오든 오프라인 폴백이 같은 항목을 찾게 하기 위함.
  if(e.request.mode==='navigate'||url.endsWith('/')||url.endsWith('/index.html')){
    e.respondWith(
      // cache:'no-store' 가 핵심이다. GitHub Pages 가 index.html 에 Cache-Control: max-age=600
      // 을 붙이기 때문에, 그냥 fetch(e.request) 하면 서비스워커를 거치고도 브라우저 HTTP
      // 캐시가 최대 10분 묵은 HTML 을 그대로 준다. URL 문자열로 부르는 이유는 mode 가
      // 'navigate' 인 Request 로는 new Request(...) 를 만들 수 없기 때문.
      fetch(url,{cache:'no-store'}).then(resp=>{
        if(resp.ok){const cl=resp.clone();caches.open(CACHE).then(c=>c.put('./index.html',cl))}
        return resp;
      }).catch(()=>caches.match('./index.html').then(r=>r||caches.match('./')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
      if(resp.ok){
        const cl=resp.clone();
        caches.open(CACHE).then(c=>c.put(e.request,cl));
      }
      return resp;
    }).catch(()=>caches.match('./index.html')))
  );
});
