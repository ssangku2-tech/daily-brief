# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"데일리 브리프" — a single-page PWA (no build step, no framework, no package.json) that shows a Korean user one screen of daily briefing: overnight US market moves, and later their own assets, news, schedule, and mail. It is served as static files (GitHub Pages). Everything the app needs lives in three files: `index.html` (markup + CSS + JS in one file), `sw.js` (service worker), `manifest.json` (PWA manifest).

The app is at an early stage (v0.1). The client reads briefings from `briefings/*.json`, but **nothing generates those files yet** — the only one in the repo is hand-written sample data. Wiring up generation (a data source for US index quotes + a scheduled job that commits a new `briefings/YYYY-MM-DD.json` and updates `briefings/index.json`) is the next step.

## Commands

There is no build/lint/test tooling. To work on it locally, serve the directory with any static file server (e.g. `npx serve .`) — use a server rather than opening `index.html` via `file://`, since service workers and `fetch` of `briefings/*.json` require an http origin.

## Architecture

**`index.html`** is the entire application: inline `<style>` for all CSS, inline `<script>` for all logic. There is no router or component framework. The structure is:
- A single `state` object (currently just `{ briefing }`).
- One renderer function per card — `renderUSBriefing(b)` is the only one so far. Each returns an HTML string for one `<section class="card">` and handles its own empty state internally.
- A single `render()` that fills the header, toggles the "갱신" timestamp, then joins the section strings into `#sections`.
- `loadBriefing()` is the sole data entry point, currently a stub that just calls `render()`. The refresh button and startup both go through it.

**Data flow:** `loadBriefing()` is the sole data entry point (startup + refresh button). It sets `state.loading`, renders, then fetches `briefings/${todayKST()}.json` with `cache:'no-store'` via `fetchBriefing()`. A 404 is a normal outcome, not an error — it means today's briefing doesn't exist yet, so `fetchBriefing` returns `null` rather than throwing. In that case `loadBriefing` reads `briefings/index.json` (a sorted array of available date keys) and falls back to the most recent key `<= today`, recording it in `state.shownDate` so the card can say which day it's showing. Any real failure (non-404 HTTP status, network error) sets `state.error`. Every path ends in `render()`.

**Briefing file shape** (`briefings/YYYY-MM-DD.json`):
```json
{ "date": "2026-07-30", "sessionDate": "2026-07-29", "generatedAt": "2026-07-30 06:30 KST",
  "source": "sample", "indices": [{"name":"S&P 500","price":"6,432.10","change":0.62,"changePct":"0.62%"}],
  "news": [], "stocks": [] }
```
`price` and `changePct` are pre-formatted display strings (the client does no number formatting); `changePct` is unsigned because the renderer supplies the ▲/▼ arrow from the sign of `change`. `sessionDate` is the US trading session the numbers came from, shown in the card header. `source: "sample"` makes the card render a "샘플 데이터입니다" note — the generator must NOT set it, so real briefings render without the disclaimer. `news` and `stocks` are reserved for later cards and currently unused.

**`state`** carries `{ briefing, shownDate, loading, error }`. Renderers read this global directly rather than taking it as an argument (only `renderUSBriefing(b)` takes the briefing itself), so a new card's empty/loading/error branches should follow the same four-way `if` shape.

**Time handling:** all date/time logic is KST, computed by offsetting UTC by +9h (`todayKST`, `hourKST`) rather than using `toLocaleString` with a timezone. `greetingKST()` maps the KST hour to one of five greetings. Keep new time logic on the same +9h-offset approach so the whole app agrees on what "today" is.

**Service worker (`sw.js`)** uses a versioned cache name (`daily-brief-vN` — bump on asset changes to bust old caches). Fetch handling: non-GET and external API/font hosts bypass the cache entirely; `/briefings/*` is network-first with a cache fallback (so an offline user still sees the last briefing they received); everything else is cache-first with a background network fill and an `index.html` fallback. The app shell (`./`, `index.html`, `manifest.json`) is precached with `addAll` at install; the icons are precached separately with `allSettled` because `addAll` fails the entire install if any one URL 404s.

## Conventions specific to this codebase

- 단일 `index.html` 구조를 유지할 것 — HTML/CSS/JS를 별도 파일이나 빌드 단계로 분리하지 않는다.
- `index.html` 또는 `sw.js`를 수정할 때는 `sw.js`의 `CACHE` 버전 문자열(`daily-brief-vN`)을 반드시 올린다 — 그렇지 않으면 기존 캐시가 새 자산을 가리지 못한다.
- 커밋 메시지는 한국어로 작성한다.
- 대화는 한국어로 진행한다.
- UI 문구와 코드 주석은 한국어로 작성한다.
- `esc()` must wrap any data-supplied string interpolated into an HTML template string — this app has no framework-level auto-escaping, and briefing content will come from network JSON.
- All colors go through the CSS custom properties in `:root`; don't hardcode hex values in rules. Note the Korean market convention baked into the tokens: `--up` is red, `--down` is blue.
- 새 카드를 추가할 때는 `renderXxx()` 함수 하나를 만들어 `render()`의 `sections` 배열에 push 하는 패턴을 따른다 — 카드마다 자기 빈 상태를 직접 처리한다.
- Mobile-first: the layout is capped at `max-width:520px` and uses `env(safe-area-inset-*)` padding. Test at phone widths, and keep tap targets full-width like `.refresh`.

## Known gaps

- `sw.js` has a `notificationclick` handler, but nothing in the app requests notification permission or schedules a notification yet.
- No generation pipeline. `briefings/2026-07-30.json` is hand-written placeholder data carrying `source: "sample"`; the numbers are not real quotes. `briefings/index.json` is maintained by hand and must be updated whenever a briefing file is added.
- Only the US market card exists. `news` / `stocks` in the briefing JSON, and the 자산/뉴스/일정/메일 cards, are not built.
