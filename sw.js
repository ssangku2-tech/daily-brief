const CACHE='daily-brief-v21';
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
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
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
  // workers.dev = 시세 프록시(stock-proxy). 접속 시점 시세를 캐시하면 낡은 값이 그대로
  // 나오므로 반드시 캐시 우회 대상이어야 한다.
  if(url.includes('workers.dev')||url.includes('open-meteo.com')||url.includes('bigdatacloud.net')||url.includes('fonts.g')||url.includes('gstatic.com')){return}
  // 매일 갱신되는 브리핑/일정·메일은 네트워크 우선(실패 시 캐시) — 오프라인에서 어제 것이라도 보이게
  if(url.includes('/briefings/')||url.includes('/agenda/')){
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
