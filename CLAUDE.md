# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"My Agent" — a single-page PWA (no build step, no framework, no package.json) that shows a Korean user one screen of daily briefing: overnight US market moves, Anthropic/Palantir news, and later their own assets, schedule, and mail. It is served as static files (GitHub Pages). Everything the app needs lives in three files: `index.html` (markup + CSS + JS in one file), `sw.js` (service worker), `manifest.json` (PWA manifest).

The app is at v0.2. The US market card and the Anthropic/Palantier news card exist; the 자산 card is a link-out placeholder.

**Generation pipeline (implemented):** `.github/workflows/daily.yml` runs on a cron (`0 21 * * *` UTC = KST 06:00, plus manual `workflow_dispatch`) and calls `scripts/generate.js`, which prompts the Anthropic Messages API (`claude-sonnet-5`, with the `web_search` server tool enabled — this is a live, verified generation, not a training-data guess) for a JSON-only briefing and writes it to `briefings/YYYY-MM-DD.json`, then regenerates `briefings/index.json` from the files actually present in the directory. It skips generation if the day's file already exists, and commits/pushes only when `briefings/` actually changed. It also skips (no API calls at all) when `dateKey` (the KST calendar day, not "now") falls on Saturday or Sunday — the US market is closed those days, so KST Sat/Sun mornings would otherwise both re-research and re-pay for the same already-published Friday session. This must be checked against `dateKey`, not against the current moment converted to US Eastern time: a KST Monday-morning run is still Sunday night in US Eastern, so checking "now" would wrongly skip Monday's run too (which is the first run that's actually due to look for a new session).

`generate.js`'s prompt follows the same three-stage discipline used elsewhere for this user's market briefings: (0) pin down T, the most recently closed US trading session, before researching anything; (1) verify every price/percent against dated sources, cross-check two sources where possible, run the T-1×(1+chg)≈T sanity check, and write "확인 실패" rather than guess when a figure can't be confirmed; (2) emit a JSON object; (3) self-audit the numbers against a checklist before finalizing. This mirrors the verification rules used in the user's daily Notion market-briefing report — the intent is that this PWA and the Notion report should never disagree on a given day's numbers.

**Two parallel requests, not one (as of 2026-08-01):** `generate.js` makes two independent Messages API calls via `Promise.all` — `marketPrompt` (indices/news/semiconductor stocks, `max_uses: 18`, `effort: medium`) and `aiNewsPrompt` (Anthropic/Palantier news, `max_uses: 6`, `effort: low`) — then merges the two JSON results into one `brief` object. This exists because a single shared `web_search` budget let the semiconductor cross-verification (which often needs repeated searches when sources disagree on weekend/stale data) consume the whole budget, silently starving the AI-news section that came last in the prompt — it came back "확인 실패" for both companies with a budget-exhaustion reason, not a genuine no-news finding. Giving each concern its own request with its own budget makes that starvation structurally impossible. Do not re-merge these into a single call without re-solving that starvation problem. (Budgets were trimmed from the original 24/15 to 18/8 to 18/6 on 2026-08-01 for cost, and aiNews's effort was dropped to `low` since it doesn't need the deep numeric reasoning market's cross-verification does. If "확인 실패" rates rise noticeably, raise `market`'s budget/effort back first — it's closer to the bare minimum needed for cross-verifying 9 items and is the section tied to the "거래일 혼동" bug history.)

**Agenda pipeline (implemented, 2026-08-02; rewritten 2026-08-03):** `.github/workflows/daily-agenda.yml` runs on its own cron (offset a few minutes from the market workflow's, independent workflow so overlap is harmless, four retry firings same as `generate.js`) and calls `scripts/generate-agenda.js`, which writes `agenda/YYYY-MM-DD.json`. Same skip-if-exists-for-the-day convention as `generate.js` — checked first, before any API calls, since the workflow retries up to four times a day and every retry would otherwise re-call both Google and Anthropic and re-commit. OAuth credentials (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`) are obtained once via `scripts/setup-google-auth.js` (a local one-time script, not run in CI) and stored as GitHub Actions secrets; the Google side is read-only by construction — the OAuth scopes granted (`calendar.readonly`, `gmail.metadata`) cannot write to the calendar or send mail no matter what the code does. `gmail.metadata` (not `gmail.readonly`) is deliberate: it covers everything the script reads (labels, From/Subject headers, snippet) while staying a "sensitive" rather than "restricted" Google scope — restricted scopes require Google's formal security-assessment process to leave OAuth consent-screen "Testing" status, and "Testing" status caps refresh tokens at a 7-day lifetime, which would silently break the daily cron.

Calendar: fetches today+tomorrow (KST, converted to UTC for the Calendar API) from the primary calendar; `allDay` = response has `date` but no `dateTime`. Getting the KST day-boundary math wrong is this script's equivalent of the market pipeline's "거래일 혼동" bug — there's no other verification step for calendar data, since it's the user's own already-settled data with nothing to cross-source-verify. Mail: unlike the calendar half, **this half does call the Claude API** (`claude-haiku-4-5`, cheap/fast — deliberately not `claude-sonnet-5`) — it sends only the subject/sender/snippet (never the full body) of up to 15 unread messages and asks Claude to pick up to 5 as "important" with a one-line Korean summary each, filtering out ads/newsletters/automated notices. `unreadCount` is a separate `resultSizeEstimate` query against Gmail (a real total, not capped by the 15-message detail slice used for the importance pass). Self-audit is lighter than the market pipeline's — no numeric cross-check needed — but the skip-if-exists check and the separate true-total unread query are the two things that keep this cheap and correct under the four-retries-a-day schedule.

## Commands

There is no build/lint/test tooling for the client. To work on it locally, serve the directory with any static file server (e.g. `npx serve .`) — use a server rather than opening `index.html` via `file://`, since service workers and `fetch` of `briefings/*.json` require an http origin.

To manually generate a day's briefing (normally done by the cron workflow):
```
ANTHROPIC_API_KEY=xxx node scripts/generate.js [YYYY-MM-DD]
```
Defaults to today in KST if no date given; skips if `briefings/YYYY-MM-DD.json` already exists.

To manually generate a day's agenda (normally done by the cron workflow):
```
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx GOOGLE_REFRESH_TOKEN=xxx node scripts/generate-agenda.js [YYYY-MM-DD]
```
Same defaulting/skip behavior as `generate.js`, against `agenda/YYYY-MM-DD.json`. To obtain the three `GOOGLE_*` values in the first place, run `node scripts/setup-google-auth.js` locally once (opens a browser OAuth consent flow, prints the values to your own terminal — never paste them into chat, commits, or logs) after creating a Google Cloud OAuth client; see the Agenda pipeline note above for the scope rationale.

## Architecture

**`index.html`** is the entire application: inline `<style>` for all CSS, inline `<script>` for all logic. There is no router or component framework. The structure is:
- A single `state` object: `{ briefing, shownDate }`.
- One renderer function per card — `renderUSBriefing(b)` (지수/뉴스/반도체 종목) and `renderAiNews(b)` (앤트로픽·팔란티어). Each computes its own body HTML (handling its own loading/empty state) and hands it to `cardShell(id, icon, title, sub, bodyHtml, defaultOpen)`, which wraps it in the accordion header (clickable, chevron) and the collapsible `.card-body`. Open/closed state per card id is remembered in `localStorage` (`mycard_open_v1`) via `isCardOpen`/`toggleCard`, overriding `defaultOpen` once the user has toggled a card at least once.
- A single `render()` that fills the header, toggles the "갱신" timestamp, then joins the section strings into `#sections`.
- `loadBriefing()` is the sole data entry point (startup + refresh button both call it) — see **Data flow** below.

**Data flow:** `loadBriefing()` is the sole data entry point (startup + refresh button). It sets state, renders, then fetches `briefings/${todayKST()}.json` with `cache:'no-store'`. A 404 is a normal outcome, not an error — it means today's briefing doesn't exist yet. In that case `loadBriefing` reads `briefings/index.json` (a sorted array of available date keys) and falls back to the most recent key `<= today`, recording it in `state.shownDate` so the card can say which day it's showing.

**Briefing file shape** (`briefings/YYYY-MM-DD.json`, produced by `scripts/generate.js`):
```json
{
  "date": "2026-08-01",
  "sessionDate": "2026-07-31",
  "sessionDateLabel": "2026년 7월 31일(금) 미국 동부시간 정규장 마감",
  "generatedAt": "2026-08-01 07:30",
  "summary": "한 줄 총평",
  "indices": [{"name":"S&P 500","price":"6,432.10","changePct":"+0.62%","up":true}],
  "news": [{"title":"...","body":"...","date":"2026-07-31"}],
  "semiconductorNote": "반도체 섹터 전반 동향 한 줄",
  "stocks": [{"name":"엔비디아","ticker":"NVDA","price":"$182.40","changePct":"+2.1%","up":true,"note":""}],
  "aiNews": [{"company":"Anthropic","title":"...","body":"...","date":"2026-07-29"}]
}
```
`date` is the KST calendar day the file is named for; `sessionDate`/`sessionDateLabel` are the actual US trading day (T) the numbers came from — these can differ (e.g. a Monday-morning KST file reporting Friday's session). `price`/`changePct` are pre-formatted display strings (the client does no number formatting); `up` is an explicit boolean rather than derived from a signed number. `summary`/`news`/`semiconductorNote`/`stocks`/`aiNews` are each optional — the renderers only emit a block for ones that are non-empty, so older or partial briefing files degrade gracefully. A price/changePct value of `"확인 실패"` means `generate.js` could not confirm that figure from a dated source and refused to guess — this is expected occasionally, not a bug.

**`state`** carries `{ briefing, shownDate }`. Renderers read this global directly rather than taking it as an argument (only `renderUSBriefing(b)`/`renderAiNews(b)` take the briefing itself), so a new card's empty state should follow the same shape.

**Time handling:** all date/time logic is KST, computed by offsetting UTC by +9h (`todayKST`, `hourKST`) rather than using `toLocaleString` with a timezone. `greetingKST()` maps the KST hour to one of five greetings. Keep new time logic on the same +9h-offset approach so the whole app agrees on what "today" is. `sessionDate`/`sessionDateLabel`, by contrast, describe the US trading day and are produced server-side by `generate.js` — the client never computes them.

**Service worker (`sw.js`)** uses a versioned cache name (`daily-brief-vN` — bump on asset changes to bust old caches; currently v14). Fetch handling: non-GET and external API/font hosts bypass the cache entirely; `/briefings/*` is network-first with a cache fallback (so an offline user still sees the last briefing they received); everything else is cache-first with a background network fill and an `index.html` fallback. The app shell (`./`, `index.html`, `manifest.json`) is precached with `addAll` at install; the icons are precached separately with `allSettled` because `addAll` fails the entire install if any one URL 404s.

## Conventions specific to this codebase

- 단일 `index.html` 구조를 유지할 것 — HTML/CSS/JS를 별도 파일이나 빌드 단계로 분리하지 않는다.
- `index.html` 또는 `sw.js`를 수정할 때는 `sw.js`의 `CACHE` 버전 문자열(`daily-brief-vN`)을 반드시 올린다 — 그렇지 않으면 기존 캐시가 새 자산을 가리지 못한다.
- 커밋 메시지는 한국어로 작성한다.
- 대화는 한국어로 진행한다.
- UI 문구와 코드 주석은 한국어로 작성한다.
- `esc()` must wrap any data-supplied string interpolated into an HTML template string — this app has no framework-level auto-escaping, and briefing content will come from network JSON.
- All colors go through the CSS custom properties in `:root`; don't hardcode hex values in rules. Note the Korean market convention baked into the tokens: `--up` is red, `--down` is blue.
- 새 카드를 추가할 때는 `renderXxx()` 함수 하나를 만들어 본문 HTML을 계산한 뒤 `cardShell(id, icon, title, sub, bodyHtml, defaultOpen)`에 넘기고, 그 결과를 `render()`의 `sections` 배열에 push 하는 패턴을 따른다 — 카드마다 자기 빈 상태는 직접 처리하되, 헤더·접기/펼치기(아코디언)는 `cardShell`에 위임한다. `id`는 다른 카드와 겹치지 않는 짧은 문자열(예: `'us'`, `'mail'`)이어야 한다.
- 날씨 위젯은 Open-Meteo(예보) + BigDataCloud의 클라이언트용 역지오코딩(`reverse-geocode-client`, API 키 불필요)을 함께 쓴다. 새 외부 API를 붙일 때는 `sw.js`의 캐시 우회 목록(`api.anthropic.com`/`open-meteo.com`/`bigdatacloud.net`/...)에도 호스트를 추가해야 한다 — 안 그러면 서비스워커가 그 응답을 캐시-우선으로 가로챈다.
- `generate.js`의 프롬프트를 건드릴 때는 0단계(거래일 확정) → 1단계(수치 검증 규칙) → 2단계(4섹션 JSON) → 3단계(자체 감사) 구조를 유지한다. 이 구조를 허물면 이 사용자가 이미 겪었던 "T-1일 수치를 T일로 착각" 사고가 재발할 수 있다.
- Mobile-first: the layout is capped at `max-width:520px` and uses `env(safe-area-inset-*)` padding. Test at phone widths, and keep tap targets full-width like `.refresh`.

## Known gaps

- `sw.js` has a `notificationclick` handler, but nothing in the app requests notification permission or schedules a notification yet.
- The US market card, the Anthropic/Palantier news card, 오늘의 학습 (localStorage check-in), and 일정·메일 (reads `agenda/YYYY-MM-DD.json`, no fallback to a prior day if today's file is missing — a missing file just renders the empty state) exist. 자산 is still a link-out placeholder to a separate portfolio app rather than an in-app card.
- `briefings/2026-07-30.json` may still contain data from the pre-4섹션 schema (no `sessionDate`/`semiconductorNote`/`aiNews`) — the renderers tolerate this by treating missing fields as empty, but don't expect old files to show the new sections.
