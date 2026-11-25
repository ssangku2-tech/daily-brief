// 아침 브리핑·일정 정시 실행용 Cloudflare Worker (무료 플랜의 Cron Trigger 사용)
// portfolio 저장소의 cloudflare/gfi-cron 과 같은 방식이다.
//
// GitHub Actions 의 예약 실행(schedule)은 이 저장소에서 매일 3~7시간씩 밀려
// (2026-11 기준 KST 06:30 예약이 실제로는 10~11시에 돌았다) 아침 알림이 점심 무렵에 왔다.
// 이 Worker 는 정해진 시각에 workflow_dispatch 로 워크플로를 깨우는 "정시 알람" 역할만 하고,
// 실제 생성·커밋·푸시 발송은 지금처럼 GitHub Actions 가 한다.
// 워크플로 쪽 schedule 은 백업으로 그대로 두며, 두 스크립트 모두 그날 파일이 이미 있으면
// 바로 건너뛰므로 중복 생성·중복 알림은 없다.
//
// 필요한 Worker 비밀값: GITHUB_TOKEN
//   (ssangku2-tech/daily-brief 저장소 하나에만 Actions: Read and write 권한을 준 fine-grained 토큰)

const REPO = 'ssangku2-tech/daily-brief';

// wrangler.toml 의 crons 와 정확히 같은 문자열이어야 한다 (event.cron 으로 구분한다).
const JOBS = {
  '0 21 * * *': 'daily-agenda.yml', // KST 06:00 일정·메일
  '30 21 * * *': 'daily.yml',       // KST 06:30 미국 시장 브리핑 + 아침 알림
  // 급변동 알림. GitHub schedule 로는 30분 간격 예약이 하루 3번 정도만 실제로 돌아
  // (2026-11-11~24 확인) 장중 감시도, 새 구독 확인 발송도 사실상 안 되고 있었다.
  '*/30 0-6 * * MON-FRI': 'alerts.yml',   // 한국장 KST 09:00~15:30
  '*/30 13-20 * * MON-FRI': 'alerts.yml', // 미국장 KST 22:30~05:00
};

async function dispatch(env, workflow) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'brief-cron-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status !== 204) throw new Error(`GitHub dispatch 실패 ${workflow} ${res.status}: ${await res.text()}`);
  console.log(`dispatch 완료: ${workflow}`);
}

export default {
  async scheduled(event, env, ctx) {
    const workflow = JOBS[event.cron];
    if (!workflow) {
      console.log(`알 수 없는 cron: ${event.cron}`);
      return;
    }
    ctx.waitUntil(dispatch(env, workflow));
  },
};
