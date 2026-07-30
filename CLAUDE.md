# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"My Agent" — a single-page PWA (no build step, no framework, no package.json) that shows a Korean user one screen of daily briefing: overnight US market moves, and later their own assets, news, schedule, and mail. It is served as static files (GitHub Pages). Everything the app needs lives in three files: `index.html` (markup + CSS + JS in one file), `sw.js` (service worker), `manifest.json` (PWA manifest).

The app is at an early stage (v0.1). Only the US market card exists.

**Generation pipeline (implemented):** `.github/workflows/daily.yml` runs on a cron (`0 21 * * *` UTC = KST 06:00, plus manual `workflow_dispatch`) and calls `scripts/generate.js`, which prompts the Anthropic Messages API (`claude-haiku-4-5`) for a JSON-only briefing and writes it to `briefings/YYYY-MM-DD.json`, then regenerates `briefings/index.json` from the files actually present in the directory. It skips generation if the day's file already exists, and commits/pushes only when `briefings/` actually changed. This is a "2-A단계" version per its own comment: Claude answers from training data, not live web search, so quotes are not real-time-accurate yet — a known limitation, not a bug to fix reflexively.

## Commands

There is no build/lint/test tooling for the client. To work on it locally, serve the directory with any static file server (e.g. `npx serve .`) — use a server rather than opening `index.html` via `file://`, since service workers and `fetch` of `briefings/*.json` require an http origin.

To manually generate a day's briefing (normally done by the cron workflow):
```
ANTHROPIC_API_KEY=xxx node scripts/generate.js [YYYY-MM-DD]
```
Defaults to today in KST if no date given; skips if `briefings/YYYY-MM-DD.json` already exists.

## Architecture

**`index.html`** is the entire application: inline `<style>` for all CSS, inline `<script>` for all logic. There is no router or component framework. The structure is:
- A single `state` object: `{ briefing, shownDate, loading, error }`.
- One renderer function per card — `renderUSBriefing(b)` is the only one so far. Each returns an HTML string for one `<section class="card">` and handles its own loading/error/empty state internally.
- A single `render()` that fills the header, toggles the "갱신" timestamp, then joins the section strings into `#sections`.
- `loadBriefing()` is the sole data entry point (startup + refresh button both call it) — see **Data flow** below.

**Data flow:** `loadBriefing()` is the sole data entry point (startup + refresh button). It sets `state.loading`, renders, then fetches `briefings/${todayKST()}.json` with `cache:'no-store'` via `fetchBriefing()`. A 404 is a normal outcome, not an error — it means today's briefing doesn't exist yet, so `fetchBriefing` returns `null` rather than throwing. In that case `loadBriefing` reads `briefings/index.json` (a sorted array of available date keys) and falls back to the most recent key `<= today`, recording it in `state.shownDate` so the card can say which day it's showing. Any real failure (non-404 HTTP status, network error) sets `state.error`. Every path ends in `render()`.

**Briefing file shape** (`briefings/YYYY-MM-DD.json`, produced by `scripts/generate.js`):
```json
{ "date": "2026-07-30", "generatedAt": "2026-07-30 06:30",
  "summary": "한 줄 총평",
  "indices": [{"name":"S&P 500","price":"6,432.10","changePct":"0.62%","up":true}],
  "news": [{"title":"...","body":"..."}],
  "stocks": [{"name":"엔비디아","ticker":"NVDA","price":"$182.40","changePct":"2.1%","up":true,"note":""}],
  "highlights": [{"topic":"...","body":"..."}] }
```
`price`/`changePct` are pre-formatted display strings (the client does no number formatting); `up` is an explicit boolean rather than derived from a signed number, and the renderer picks the ▲/▼ arrow and `.up`/`.down` color class from it directly. `summary`/`news`/`stocks`/`highlights` are each optional — `renderUSBriefing` only emits a `.block` for ones that are non-empty, so older or partial briefing files degrade gracefully instead of rendering `undefined`. An optional `sessionDate` (US trading session the numbers came from) shows in the card header if present; `generate.js` doesn't currently set it, so the header falls back to "어젯밤 뉴욕장". An optional `source: "sample"` makes the card render a "샘플 데이터입니다" note — `generate.js` must NOT set it, so real generated briefings render without the disclaimer; it exists for hand-written placeholder files like the one currently in the repo.

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
- `scripts/generate.js` asks Claude for figures from training data, not a live market data source — quotes are not real-time-accurate. Wiring in actual web search / a quotes API is the documented next step in the script's own comments.
- Only the US market card exists. The 자산/뉴스/일정/메일 cards are not built.
- `briefings/2026-07-30.json` in the repo is hand-written placeholder data (`source: "sample"`), kept as a fixture demonstrating the full card layout (summary + indices + news + stocks + highlights).
