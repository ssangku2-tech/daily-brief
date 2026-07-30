const CACHE='daily-brief-v4';
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
  if(url.includes('api.anthropic.com')||url.includes('fonts.g')||url.includes('gstatic.com')){return}
  // 매일 갱신되는 브리핑은 네트워크 우선(실패 시 캐시) — 오프라인에서 어제 것이라도 보이게
  if(url.includes('/briefings/')){
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
