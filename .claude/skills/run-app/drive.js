// daily-brief PWA 를 폰 크기 헤드리스 브라우저로 열어 렌더 결과를 뽑는다.
//
//   node drive.js <url> [--date YYYY-MM-DD]
//
// --date 를 주면 그 날짜 아침(KST 08:00)으로 시계를 고정한다.
// 오늘 브리핑이 없을 때 뜨는 "지난 브리핑" 안내를 확인할 때 쓴다.
const { chromium } = require('playwright');

const url = process.argv[2];
if (!url) {
  console.error('사용법: node drive.js <url> [--date YYYY-MM-DD]');
  process.exit(1);
}
const di = process.argv.indexOf('--date');
const fakeDate = di !== -1 ? process.argv[di + 1] : null;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },   // 아이폰급 폭 (레이아웃은 max-width:520px)
    deviceScaleFactor: 2,
    locale: 'ko-KR',
    // 앱이 UTC+9 로 오늘을 계산한다. 고정하지 않으면 엉뚱한 날짜 파일을 받으러 간다.
    timezoneId: 'Asia/Seoul',
  });
  const page = await ctx.newPage();

  const failures = [];
  const notFound = [];
  // 브리핑·일정 JSON 의 404 는 "아직 그날 게 없다"는 정상 신호다 (CLAUDE.md).
  // 브리핑은 지난 날짜로 폴백하고, 일정·메일은 빈 상태를 그린다. 실패로 세면 안 된다.
  const expected404 = /(briefings|agenda)\/\d{4}-\d{2}-\d{2}\.json$/;
  page.on('response', r => {
    if (r.status() !== 404) return;
    notFound.push(r.url().split('/').pop());
    if (!expected404.test(r.url())) failures.push('예상 밖 404: ' + r.url());
  });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    // 위 404 에 딸려오는 브라우저 기본 메시지는 건너뛴다
    if (/Failed to load resource/.test(m.text())) return;
    failures.push('console: ' + m.text());
  });
  page.on('pageerror', e => failures.push('pageerror: ' + e.message));
  page.on('requestfailed', r => failures.push('requestfailed: ' + r.url()));

  if (fakeDate) {
    // KST 08:00 = 전날 23:00 UTC
    const d = new Date(`${fakeDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    await page.clock.install({ time: new Date(d.toISOString().slice(0, 10) + 'T23:00:00Z') });
  }

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 15000 });

  const out = await page.evaluate(() => {
    const t = s => (document.querySelector(s)?.textContent || '').trim();
    const block = label => [...document.querySelectorAll('.block')]
      .find(b => b.querySelector('.block-label')?.textContent.includes(label));
    return {
      greeting: t('#greeting'),
      headerDate: t('#date'),
      updated: t('#updated'),
      cardSub: t('.card .sub'),
      // 오늘 것이 아닐 때만 채워진다
      staleBanner: document.querySelector('.stale')?.textContent.trim() || null,
      weather: t('#weather-row'),
      // 지수는 카드 안이 아니라 헤더 아래 스트립에 항상 떠 있다 (2026-08-05 화면 재구성)
      indices: document.querySelectorAll('#idx-strip .idx-chip').length,
      stockRows: block('관심 종목')?.querySelectorAll('.stk').length || 0,
      stockNews: block('관심 종목')?.querySelectorAll('.stk-news a').length || 0,
      newsCount: block('주요 뉴스')?.querySelectorAll('.news-item').length || 0,
      anthropicCount: block('앤트로픽')?.querySelectorAll('.news-item').length || 0,
      refreshSub: t('#refresh-sub'),
      // state·todayKST·isStale 은 스크립트 스코프에만 있다 (window 로는 안 잡힘)
      shownDate: typeof state !== 'undefined' ? state.shownDate : null,
      todayKST: typeof todayKST === 'function' ? todayKST() : null,
      isStale: typeof isStale === 'function' ? isStale() : null,
      hasAssetsCard: !!document.querySelector('.jump'),
      emptyState: !!document.querySelector('.empty'),
      sampleNote: document.body.textContent.includes('샘플 데이터'),
    };
  });

  await page.screenshot({ path: 'app.png', fullPage: true });

  console.log(JSON.stringify({ url, fakeDate, ...out, got404: notFound, failures }, null, 2));
  console.log('\n스크린샷: app.png — 반드시 열어서 눈으로 확인할 것');

  await browser.close();
  // 콘솔 오류가 있으면 실패로 끝낸다
  if (failures.length) process.exit(1);
})();
