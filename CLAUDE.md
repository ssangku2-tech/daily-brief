# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"My Agent" — a single-page PWA (no build step, no framework, no package.json) that shows a Korean user one screen of daily briefing: overnight US market moves, Anthropic/Palantir news, and later their own assets, schedule, and mail. It is served as static files (GitHub Pages). Everything the app needs lives in three files: `index.html` (markup + CSS + JS in one file), `sw.js` (service worker), `manifest.json` (PWA manifest).

The app is at v0.2. The US market card and the Anthropic/Palantier news card exist; the 자산 card is a link-out placeholder.

**Generation pipeline (implemented):** `.github/workflows/daily.yml` runs on a cron (`30 21 * * *` UTC = KST 06:30, plus manual `workflow_dispatch`, plus three retry firings) and calls `scripts/generate.js`, which writes `briefings/YYYY-MM-DD.json`, then regenerates `briefings/index.json` from the files actually present in the directory. It skips generation if the day's file already exists, and commits/pushes only when `briefings/` actually changed. It also skips when `dateKey` (the KST calendar day, not "now") falls on Saturday or Sunday — the US market is closed those days, so a Sat/Sun run would just regenerate the same already-published Friday session under a new filename. This must be checked against `dateKey`, not against the current moment converted to US Eastern time: a KST Monday-morning run is still Sunday night in US Eastern, so checking "now" would wrongly skip Monday's run too (which is the first run that's actually due to look for a new session). The weekday check (`weekdayOf()` in `generate.js`) computes this from `dateKey` using UTC-only `Date` methods (`` `${dateStr}T00:00:00Z` `` + `.getUTCDay()`) rather than `.getDay()` — `.getDay()` follows the *process's* local timezone, and on a GitHub Actions runner (UTC) the older `` `${dateKey}T00:00:00+09:00` `` + `.getDay()` form actually computed the wrong weekday (it only ever looked correct when tested on a KST-timezone dev machine). This was a live, unnoticed bug fixed 2026-08-05 — the code hadn't yet run through a real weekend since the Sat/Sun-skip feature was added.

**No Claude in the market pipeline (as of 2026-08-05):** `generate.js` calls no LLM at all and needs no `ANTHROPIC_API_KEY`. Earlier versions used the Anthropic Messages API (`claude-sonnet-5` with the `web_search` server tool) first to verify index/stock prices, then (once the Worker took over prices, see below) to research and write Korean-language market news summaries. Both were removed on 2026-08-05: the trigger was cost — the companion "내 주식 현황" portfolio app (`ssangku2-tech/portfolio`) does all of its market data client-side against the same Worker and never calls an LLM, so its bill is near zero, while this app's daily Claude calls were running close to $1/day. Rather than just trim the `web_search` budget further, the user chose to drop AI-written Korean summaries/verification entirely and show raw source headlines instead. Concretely:
- **Prices** (`indices`/`stocks`): fetched directly from a Cloudflare Worker (`stock-proxy.ssangku2.workers.dev`, `?symbol=<ticker>` → `{price, prev, currency}`) — the same personal Worker the portfolio app uses to proxy Yahoo Finance/Naver quotes. Its source is not in this repo; treat its `?symbol=` contract as an external API. This part dates to 2026-08-04 (before the rest of the pipeline dropped Claude too) and works because the cron fires at 06:30 KST, hours after the US regular session closes, so Yahoo's `regularMarketPrice` is already frozen to that day's close. Per-symbol failure still yields `"확인 실패"`, with the existing four-times-a-day retry cron as the safety net — there is no separate fallback path.
- **News** (`news`/`aiNews`): fetched from Google News RSS (`https://news.google.com/rss/search?q=...` — unauthenticated, no key) and parsed with a small hand-rolled regex parser in `generate.js` (`parseRssItems`) instead of an XML library, since this repo intentionally has no `package.json`/dependencies. Items are the *original* title/link/source/date — no Korean translation, no summarization, no "why did it move" commentary. `isFreshEnough()` keeps only items published after the previous briefing's `generatedAt` (its KST timestamp converted to a real instant) so the same story doesn't reappear day after day; comparing by calendar-day string alone was tried first and undercounted fresh items, because the cron's KST 06:30 run instant is still the previous calendar day in UTC (the same class of bug as the weekday check above, fixed together).
- **`sessionDate`/`sessionDateLabel`** (T, the most recently closed US session): computed by `computeSessionDate()` from `dateKey` alone (yesterday, or last Friday if `dateKey` is Monday) — no longer researched. This has **no US-holiday awareness** (a holiday Monday would mislabel T) — acceptable because the Worker's price is always the true latest close regardless of the label; only the display label could read one day off around a US market holiday.
- **`summary`**: now a mechanical one-liner built from the index changePct values (`buildSummary()`), e.g. `"S&P 500 +1.79%, 나스닥종합 +2.59%, 다우존스 +1.71%로 마감"` — a formatting pass, not a qualitative take on *why*.
- **`semiconductorNote`/`stockNotes`** (the old per-stock "왜 그렇게 움직였는가" commentary): removed entirely — producing that requires exactly the kind of research/reasoning this change stopped paying for. `stocks` items now only carry a `note` field in the Worker-failure case (`"Worker 조회 실패"`).

If `news`/`aiNews` quality or volume feels off, the first things to check are the RSS query strings in `generate.js` (the `fetchGoogleNewsRSS(...)` call sites in `main()`) and `isFreshEnough`'s cutoff — there is no `web_search`/`effort` budget to tune anymore. (Historical note: between 2026-08-01 and 2026-08-04, `generate.js` made two parallel Claude requests — `marketPrompt` and `aiNewsPrompt` — specifically to stop a shared `web_search` budget from letting semiconductor-price cross-verification starve the AI-news section. That whole mechanism, and the budget-tuning history that went with it, no longer applies now that neither request exists.)

**Agenda pipeline (implemented, 2026-08-02; rewritten 2026-08-03):** `.github/workflows/daily-agenda.yml` runs on its own cron (offset a few minutes from the market workflow's, independent workflow so overlap is harmless, four retry firings same as `generate.js`) and calls `scripts/generate-agenda.js`, which writes `agenda/YYYY-MM-DD.json`. Same skip-if-exists-for-the-day convention as `generate.js` — checked first, before any API calls, since the workflow retries up to four times a day and every retry would otherwise re-call both Google and Anthropic and re-commit. OAuth credentials (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`) are obtained once via `scripts/setup-google-auth.js` (a local one-time script, not run in CI) and stored as GitHub Actions secrets; the Google side is read-only by construction — the OAuth scopes granted (`calendar.readonly`, `gmail.metadata`) cannot write to the calendar or send mail no matter what the code does. `gmail.metadata` (not `gmail.readonly`) is deliberate: it covers everything the script reads (labels, From/Subject headers, snippet) while staying a "sensitive" rather than "restricted" Google scope — restricted scopes require Google's formal security-assessment process to leave OAuth consent-screen "Testing" status, and "Testing" status caps refresh tokens at a 7-day lifetime, which would silently break the daily cron.

Calendar: fetches today+tomorrow (KST, converted to UTC for the Calendar API) from the primary calendar; `allDay` = response has `date` but no `dateTime`. Getting the KST day-boundary math wrong is this script's equivalent of the market pipeline's "거래일 혼동" bug — there's no other verification step for calendar data, since it's the user's own already-settled data with nothing to cross-source-verify. Mail: unlike the calendar half, **this half does call the Claude API** (`claude-haiku-4-5`, cheap/fast — deliberately not `claude-sonnet-5`) — it sends only the subject/sender/snippet (never the full body) of up to 15 unread messages and asks Claude to pick up to 5 as "important" with a one-line Korean summary each, filtering out ads/newsletters/automated notices. `unreadCount` is a separate `resultSizeEstimate` query against Gmail (a real total, not capped by the 15-message detail slice used for the importance pass). Self-audit is lighter than the market pipeline's — no numeric cross-check needed — but the skip-if-exists check and the separate true-total unread query are the two things that keep this cheap and correct under the four-retries-a-day schedule.

## Commands

There is no build/lint/test tooling for the client. To work on it locally, serve the directory with any static file server (e.g. `npx serve .`) — use a server rather than opening `index.html` via `file://`, since service workers and `fetch` of `briefings/*.json` require an http origin.

To manually generate a day's briefing (normally done by the cron workflow):
```
node scripts/generate.js [YYYY-MM-DD]
```
No API key needed — as of 2026-08-05 this script only talks to the Worker and Google News RSS (see the Generation pipeline note above). Defaults to today in KST if no date given; skips if `briefings/YYYY-MM-DD.json` already exists.

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

**Briefing file shape** (`briefings/YYYY-MM-DD.json`, produced by `scripts/generate.js`), current (2026-08-05+) form:
```json
{
  "date": "2026-08-05",
  "sessionDate": "2026-08-04",
  "sessionDateLabel": "2026년 8월 4일(화) 미국 동부시간 정규장 마감",
  "generatedAt": "2026-08-05 06:30",
  "summary": "S&P 500 +1.79%, 나스닥종합 +2.59%, 다우존스 +1.71%로 마감",
  "indices": [{"name":"S&P 500","price":"7,736.52","changePct":"+1.79%","up":true}],
  "news": [{"title":"Dow surges 900 points, S&P 500 closes above 7,700...","link":"https://news.google.com/rss/articles/...","date":"2026-08-04","source":"CNBC"}],
  "stocks": [{"name":"엔비디아","ticker":"NVDA","price":"$211.94","changePct":"+2.56%","up":true}],
  "aiNews": [{"company":"Anthropic","title":"Anthropic Inks $10 Billion Computing Deal...","link":"https://news.google.com/rss/articles/...","date":"2026-08-04","source":"Bloomberg.com"}]
}
```
`date` is the KST calendar day the file is named for; `sessionDate`/`sessionDateLabel` are the actual US trading day (T) the numbers came from — these can differ (e.g. a Monday-morning KST file reporting Friday's session), and as of 2026-08-05 this is computed by date arithmetic, not researched (see the Generation pipeline note above — no US-holiday awareness). `price`/`changePct` are pre-formatted display strings (the client does no number formatting); `up` is an explicit boolean rather than derived from a signed number. `summary`/`news`/`stocks`/`aiNews` are each optional — the renderers only emit a block for ones that are non-empty, so older or partial briefing files degrade gracefully.

Each `news`/`aiNews` item is `{title, link, date, source}` as of 2026-08-05 — the original (usually English) headline from Google News RSS and a link to it, not a Korean summary. Files from before 2026-08-05 instead have `{title, body, date}` (no `link`/`source`) — a Claude-written Korean summary with no source link. `index.html`'s renderers branch on `n.link` being present to support both shapes in the files already committed under `briefings/`; don't remove the `body` branch without migrating or deleting those older files. `stocks` items only carry a `note` field in the Worker-failure case now (`"Worker 조회 실패"`) — the old per-stock "왜 움직였는가" commentary and the `semiconductorNote` field no longer exist. A price/changePct value of `"확인 실패"` means the Cloudflare Worker query for that symbol was unreachable or 404'd — see the Generation pipeline note above. This is expected occasionally, not a bug.

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
- `generate.js`는 (2026-08-05부터) Claude API를 전혀 호출하지 않는다 — `marketPrompt`/`aiNewsPrompt` 같은 프롬프트 구조는 더 이상 없다. 지수·종목의 price/changePct는 `fetchLiveIndicesAndStocks()`가 Cloudflare Worker에서, 뉴스(`news`/`aiNews`)는 `fetchGoogleNewsRSS()`가 Google News RSS에서 받아온다. 이 두 데이터 소스에 다시 Claude 검증·요약을 끼워 넣지 말 것 — 비용 때문에 일부러 뺀 것이다(위 "No Claude in the market pipeline" 참고). Worker 호출을 건드릴 때는 `WORKER_URL`이 이 레포 소유가 아닌 외부 계약(포트폴리오 앱의 개인 Cloudflare Worker)이라는 점을, RSS 호출을 건드릴 때는 이 레포에 `package.json`이 없어 XML 파서를 정규식(`parseRssItems`)으로 직접 짰다는 점을 유의한다.
- Mobile-first: the layout is capped at `max-width:520px` and uses `env(safe-area-inset-*)` padding. Test at phone widths, and keep tap targets full-width like `.refresh`.

## Known gaps

- `sw.js` has a `notificationclick` handler, but nothing in the app requests notification permission or schedules a notification yet.
- The US market card, the Anthropic/Palantier news card, 오늘의 학습 (localStorage check-in), and 일정·메일 (reads `agenda/YYYY-MM-DD.json`, no fallback to a prior day if today's file is missing — a missing file just renders the empty state) exist. 자산 is still a link-out placeholder to a separate portfolio app rather than an in-app card.
- `briefings/2026-07-30.json` may still contain data from the pre-4섹션 schema (no `sessionDate`/`semiconductorNote`/`aiNews`) — the renderers tolerate this by treating missing fields as empty, but don't expect old files to show the new sections.
