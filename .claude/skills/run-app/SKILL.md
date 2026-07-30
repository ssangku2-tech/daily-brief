---
name: run-app
description: daily-brief PWA를 실제 브라우저로 띄워 화면을 확인한다. 앱 실행·구동·스크린샷 요청, "브리핑이 제대로 뜨는지 확인", index.html/sw.js 변경이 실제 화면에 반영됐는지 검증할 때 사용한다. Use when asked to run, open, or screenshot this app, or to verify a rendering change works.
---

# daily-brief 앱 실행·확인

빌드 단계가 없는 정적 PWA다. "실행"은 **정적 서버로 띄우고 헤드리스 Chromium 으로 열어
스크린샷을 찍는 것**을 뜻한다. 콘솔에 오류가 없는지까지 봐야 실행을 확인한 것이다.

## 어디를 열 것인가

| 목적 | 대상 |
|---|---|
| 로컬 수정분 확인 (커밋 전) | `npx serve .` → `http://localhost:3000` |
| 실제 사용자 화면 확인 | `https://ssangku2-tech.github.io/daily-brief/` |

`file://` 로 열면 안 된다. 서비스워커와 `briefings/*.json` fetch 는 http 오리진을 요구한다
(CLAUDE.md 에 명시돼 있다). 로컬 서버는 다 쓰고 반드시 내린다:

```powershell
# npx.cmd 로 불러야 한다. Start-Process 는 npx(.cmd 심)를 직접 못 띄운다
#   → "%1 is not a valid Win32 application"
Start-Process npx.cmd -ArgumentList '--yes','serve','.','-l','3000' -WindowStyle Hidden

# 포트가 실제로 응답할 때까지 기다린다 (sleep 로 때우지 말 것). 첫 실행은 serve 를
# 내려받느라 20초 넘게 걸릴 수 있으니 넉넉히 준다.
$ok=$false; 1..40 | ForEach-Object { if(-not $ok){ try { Invoke-WebRequest http://localhost:3000 -TimeoutSec 1 -UseBasicParsing | Out-Null; $ok=$true } catch { Start-Sleep 1 } } }
if(-not $ok){ throw '서버가 안 떴다' }

# 정리 — 다 쓰면 반드시 내린다
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

배포본을 볼 때는 Pages 배포가 끝났는지 먼저 확인한다 — push 직후엔 아직 옛 파일이 나온다:

```powershell
gh run list --workflow "pages-build-deployment" --limit 1
```

## 준비 (최초 1회)

Windows 에 `chromium-cli` 가 없어 Playwright 를 쓴다. **의존성은 이 스킬 디렉터리 안에 넣는다** —
저장소 루트에 `package.json` 을 만들지 않는 게 이 프로젝트 규칙이고, `drive.js` 가 여기 있으니
node 가 위로 올라가며 찾을 때 `.claude/skills/run-app/node_modules` 에서 먼저 잡힌다.
`.gitignore` 에 이미 제외돼 있다.

```powershell
npx --yes playwright@latest install chromium          # 브라우저 (사용자 홈에 캐시됨)
cd .claude/skills/run-app; npm install playwright --no-audit --no-fund; cd ../../..
```

이미 깔렸는지 따로 확인할 필요는 없다. 그냥 아래 실행을 해보면 되고,
없으면 `Cannot find module 'playwright'` 로 바로 알려준다.

## 실행

`drive.js` 가 이 디렉터리에 있다. 대상 URL 을 인자로 준다:

```powershell
node .claude/skills/run-app/drive.js https://ssangku2-tech.github.io/daily-brief/
node .claude/skills/run-app/drive.js http://localhost:3000
```

렌더 결과가 JSON 으로 나오고 `app.png` 가 남는다. **스크린샷을 반드시 눈으로 볼 것** —
빈 화면이면 실행 실패다.

지난 브리핑 fallback(오늘 것이 없을 때 뜨는 안내)을 확인하려면 날짜를 하루 앞으로 돌린다:

```powershell
node .claude/skills/run-app/drive.js https://ssangku2-tech.github.io/daily-brief/ --date 2026-08-01
```

이때 `staleBanner` 가 채워지고 카드 부제가 `7월 31일자` 처럼 바뀌면 정상이다.

## 이 앱에서 실제로 걸린 것들

- **타임존을 반드시 `Asia/Seoul` 로 고정한다.** 앱은 `todayKST()` 로 오늘을 계산하는데,
  브라우저 로케일이 다르면 엉뚱한 날짜 파일을 받으러 가서 멀쩡한 브리핑이 "없음"으로 보인다.
  `drive.js` 가 이미 고정해 두었다.
- **`state` / `todayKST` / `isStale` 은 `window` 에 없다.** `index.html` 안에서 `let`·함수 선언으로
  잡혀 스크립트 스코프에만 있다. `page.evaluate` 안에서 `window.state` 는 항상 `undefined` 니
  맨 이름 그대로(`state.shownDate`) 써야 한다. 이걸로 한 번 헛다리를 짚었다.
- **서비스워커 캐시.** 매번 새 컨텍스트로 열어 캐시를 피한다. 반대로 실기기에서 옛 화면이
  남는다면 `sw.js` 의 `CACHE` 버전을 올렸는지 확인한다 (CLAUDE.md 규칙).
- **브리핑 JSON 의 404 는 오류가 아니다.** "그날 브리핑이 아직 없다"는 정상 신호이고,
  앱은 이걸 받아 지난 브리핑으로 넘어간다 (CLAUDE.md). `drive.js` 는 `briefings/*.json` 404 만
  정상으로 치고 `got404` 에 따로 적는다. 그 밖의 404 는 실패로 잡는다.
- **PowerShell 로 JSON 을 읽지 말 것.** PS 5.1 이 UTF-8 을 ANSI 로 읽어 한글이 깨지고
  `ConvertFrom-Json` 이 실패한다. `node -e "require('./briefings/....json')"` 로 확인한다.

## 확인해야 할 것

`drive.js` 출력에서:

- `failures` 가 빈 배열 — 콘솔 오류·실패 요청 없음
- `indices`/`stockRows`/`newsCount` 가 0 이 아님 — 데이터가 실제로 붙었음
- `sampleNote` 가 `false` — 손으로 넣은 샘플이 아니라 생성된 브리핑
- 오늘 것을 기대한다면 `staleBanner` 가 `null`, `shownDate` == `todayKST`
