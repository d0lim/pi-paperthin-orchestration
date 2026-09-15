# 실행과 Paperthin 운영 계약

Lead 한 명이 계획·작업 큐·검토·통합을 소유한다. `workflow_run`은 영속 상태와 승인 조건, `workflow_spawn`·`workflow_jobs`는 독립 프로세스 실행과 결과 회수를 담당한다. [전체 구조](architecture.md)

## 실행 설정

번들 기본값 → 개인 `~/.pi/agent/paperthin.json` → 신뢰한 프로젝트 `.pi/paperthin.json` 순서로 덮어쓴다. `PAPERTHIN_SETTINGS_PATH`는 개인 설정 경로를 지정한다. 기본값은 [roles.json](../config/roles.json), [orchestration.json](../config/orchestration.json)이다.

```json
{
  "routing": {
    "mode": "adaptive",
    "allowFableHeadless": false,
    "pins": {},
    "phases": {
      "plan_review": "fable",
      "implement": "codex",
      "code_review": "opus"
    }
  },
  "jobs": { "maxConcurrent": 2, "maxQueued": 8, "timeoutMs": 900000 }
}
```

| phase | task | 기본 profile | 실행 |
| --- | --- | --- | --- |
| plan_review | review | fable | Claude CLI / Fable |
| implement | implement | codex | Codex CLI / Sol |
| code_review | review | opus | Claude CLI / Opus |

사용자 task pin → 호출의 명시 profile → phase 기본값 → phase 없는 작업의 adaptive/fixed 순으로 선택한다. pin과 명시 profile이 다르면 오류다. `pins.review`는 계획·작업·통합 리뷰 모두에 적용되므로 각각 다른 모델을 원하면 `routing.phases`를 사용한다. `sol`은 Pi Worker, `codex`는 Codex Worker다. Lead는 Pi/Astra를 유지한다.

phase 없는 `analyze`는 기본 Opus, `workflow_cold_read`의 probe는 기본 Pi/Sol이며 adaptive frontier는 Fable이다. 사용자 effort는 `roles.<role>.effort`에서 고정한다. fixed 모드는 역할 effort를 유지한다. 중립 추천의 Pi/Codex 매핑은 minimal/medium/high/max, Claude는 low/high/xhigh/max다.

`modelchk` assessment의 여섯 필드는 `recommended_tier`(fast/standard/frontier), `recommended_effort`(glance/measured/thorough/exhaustive), `rationale`, `move_up_if`, `move_down_if`, `proof_surface`다. 선택 정책은 모델 성능의 실험적 증명이 아니다.

Fable의 비대화형 호출은 usage credits를 확인창 없이 차감할 수 있어 기본 차단한다. 그 비용까지 허용한 운영 정책이 있을 때만 `allowFableHeadless: true`로 설정한다. 인증·과금 차단은 다른 모델·API key로 자동 우회하지 않는다. [Claude 공식 안내](https://code.claude.com/docs/en/model-config#fable-and-usage-credits)

## 도구

아래는 **Pi가 호출하는 도구**이며 같은 이름의 셸 명령이나 slash command가 아니다.

| 도구 | 입력·동작 |
| --- | --- |
| `workflow_run` | start/list/get/plan/task/freeze/check/recover/integrate/complete |
| `workflow_spawn` | task, phase, runId, taskId, brief, assessment, 선택 profile·skills·cwd·label |
| `workflow_jobs` | 현재 세션의 list/get/wait/cancel, wait 최대 10초 |
| `workflow_cold_read` | artifact 내용만 읽는 독립 job 제출 |
| `workflow_skills` | catalog 또는 개별 호출 조건 조회 |
| `workflow_tab` | Herdr 내부에서 workspaceId, cwd, label, role, brief로 새 대화형 보조 탭 |
| `workflow_prepare` | 기존 pi-herdr 대화형 pane 실행 spec을 만드는 호환 경로 |

일반 `analyze`만 `runId`·phase 없이 실행한다. 구현·승인 리뷰를 요청한다면 반드시 관리되는 run을 사용한다. `workflow_prepare`·`workflow_tab`은 직접 상호작용을 위한 별도 세션이며 그 출력을 관리 run의 승인으로 등록하지 않는다.

## 계획부터 완료까지

1. Lead는 깨끗한 Git checkout에서 계획·브리프를 준비한다. 산출물을 `.agent-runs/`에 저장한다면 기존 규칙을 보존하며 필요한 ignore만 설정한다. 사용자 변경을 자동 stash/reset하지 않는다.
2. `workflow_run {action:"start", plan:"<계획 경로>", runId:"<선택 ID>"}`가 현재 HEAD와 계획 SHA-256·스냅샷을 고정한다. 반환된 runId를 보존한다.
3. `workflow_spawn {task:"review", phase:"plan_review", runId, brief, assessment}`로 Fable 계획 리뷰를 제출하고 `workflow_jobs get/wait`로 회수한다. 이 결과가 검증돼야 구현할 수 있다.
4. `workflow_run {action:"task", runId, taskId, files:["src/feature.js"], dependsOn:[], brief:"<선택 경로>"}`가 해당 저장소에 독립 detached worktree를 만든다. 파일·디렉터리 경로만 허용하며 glob·상위 경로·저장소 전체는 소유 범위가 될 수 없다.
5. 첫 실질 브리프를 `workflow_cold_read`로 읽혀 수정한다. `workflow_spawn {task:"implement", phase:"implement", runId, taskId, brief, assessment}`는 승인된 계획·의존 작업을 검사한 뒤 Codex/Sol을 실행한다. cwd를 지정했다면 등록된 worktree와 같아야 한다.
6. 구현 결과를 회수한다. Lead가 실제 diff를 확인하고 허용된 담당 경로만 커밋한다. `workflow_run {action:"freeze", runId, taskId}`는 깨끗한 HEAD·기준 커밋 ancestry·파일 소유권을 확인해 후보 SHA를 고정한다.
7. `workflow_run {action:"check", runId, taskId, argv:["npm","test"], timeoutMs:60000}`가 그 후보에서 명령을 직접 실행한다. 문자열 셸 명령이 아닌 argv 배열이다. exit code·출력·후보·계획 해시를 기록하며, 검사가 tracked/untracked 상태나 HEAD를 바꾸면 통과로 기록하지 않는다.
8. `workflow_spawn {task:"review", phase:"code_review", runId, taskId, brief, assessment}`로 Opus 리뷰를 받고 실제 job 결과를 회수한다. 코드 수정은 같은 task의 새 implement → commit → freeze → check → review로 진행한다.
9. 모든 작업이 승인되면 `workflow_run {action:"integrate", runId}`가 별도 통합 worktree에 승인된 후보를 합친다. 원래 사용자 브랜치를 이동하지 않는다.
10. **taskId 없이** `check`로 통합 후보를 검증하고, **taskId 없이** `task:"review", phase:"code_review"`를 제출해 Opus의 최종 통합 리뷰를 받는다. `complete`는 이 검사와 최종 승인을 요구한다.
11. 완료한 통합 candidate를 반환한다. Lead가 사용자 권한 범위에서 해당 후보를 반영·push·PR 처리하고 실사용 근거와 `re0-memo`를 남긴다.

위 JSON 조각은 도구별 핵심 필드다. spawn에는 실제 assessment 여섯 필드가 모두 필요하다. runId/taskId는 선행 도구가 반환한 값을 사용한다. start 시점의 사용자 checkout HEAD가 바뀌면 새로운 기준에서 run을 시작해야 한다. 커밋을 금지한 작업에서는 현재 commit-SHA 기반 관리 실행을 강행하지 않고 분석과 대체 검토 범위를 명시한다.

## 리뷰와 증거

관리 리뷰의 마지막 응답은 다음 형태의 **단일 JSON 객체**다. Claude에는 `--json-schema`도 전달한다. 해시는 실행기가 고정한 실제 값이어야 한다.

```json
{
  "phase": "plan_review",
  "planSha256": "<64자리 SHA-256>",
  "baseSha": null,
  "candidateSha": null,
  "verdict": "approve",
  "findings": []
}
```

코드·통합 리뷰는 phase `code_review`, 같은 계획 SHA-256, 실제 base/candidate Git SHA를 모두 갖는다. findings 항목은 `{ "severity": "blocking" | "non_blocking", "message": "근거·위치·영향·수정 제안" }`이다. blocking 결함이 있으면 approve할 수 없다. Markdown 울타리, 일부 JSON만 추출 가능한 응답, 누락·추가 필드, 다른 해시의 응답을 승인으로 쓰지 않는다.

실제 job ID·요청 runtime/model·보고된 모델·오류·permission denial을 함께 검사한다. 보고된 모델이 없으면 모델 검증 성공으로 표시하지 않으며 관리 리뷰를 승인하지 않는다. 라이브러리의 저수준 `interpretJob`은 process status를 보존하고 `runtimeError`, `modelVerified`, `reviewResultError`를 별도로 반환한다. 영속 승인 전이는 controller가 이 결과를 회수할 때 일어난다.

계획 수정은 `action:"plan"`으로 새 스냅샷과 리뷰를 받는다. 기존 계획·후보 승인은 새 해시에 적용되지 않는다. 동일 후보의 검사 명령별 최신 기록에 실패가 남으면 통과시킬 수 없다. 같은 후보에서 실패한 명령을 고쳐 다시 실행하면 새 결과로 대체된다.

코드는 검사 명령의 실행·상태 일치를 강제한다. 검사가 요구사항을 충분히 검증하는지는 계획·리뷰와 `mandela`·실사용 QA에서 판단한다. 도구를 통한 통제는 에이전트의 모든 OS 접근을 차단하는 sandbox를 뜻하지 않는다.

## 작업 소유권·복구·기록

하나의 controller가 Git common directory의 `paperthin/workflows/state.json`과 lease를 소유한다. 이 위치의 run별 plans/worktrees에 스냅샷·작업/통합 worktree를 보존한다. 저장소와 상태의 실제 경로를 대조하며, 살아 있는 다른 controller의 상태를 가져오지 않는다.

worktree를 만들기 전에 원장에 경로와 기준 SHA를 기록한다. 생성 중 중단되면 명시적 recover가 등록된 저장소·경로·기준 SHA와 깨끗한 상태를 확인해 생성을 마무리한다. 내용이나 기준이 달라졌으면 보존한 채 차단한다. controller 인계 기록도 소유자 정보와 함께 저장하며, 죽은 소유자의 기록만 따라가 인계를 재시도한다.

의존 관계 없는 작업은 파일 소유 범위가 겹치지 않아야 한다. 겹치는 변경은 기존 작업을 명시적으로 dependsOn에 넣어 순서화한다. 의존 작업의 승인된 후보를 새 작업 시작 전에 합치며, 이후 의존 후보가 바뀌면 계속 진행하지 않는다. 후보 freeze·review·통합에서도 실제 변경 경로와 ancestry를 검사한다.

프로세스는 기본 동시 2개·대기 8개·15분이다. 설정 한도는 동시 1~4, 대기 0~32, timeout 1초~1시간이다. 정상 종료·취소 때도 소유한 프로세스 그룹을 정리하며, stderr/stdout/result.json은 보존한다. 개발 서버를 job 자식으로 띄워 지속 실행을 기대하지 않는다.

후보 검사는 별도 한도로 동시 2개, 각 최대 60초다. 비동기로 실행해 다른 job의 시간 제한·취소를 유지하며 검사 중인 후보와 계획 변경을 차단한다. stdout·stderr 합계는 검사당 8 MiB까지 저장하고 응답에는 각 출력의 마지막 12,000바이트를 담는다. 세션 종료는 진행 중 검사를 취소하고 프로세스 정리·결과 저장이 끝난 뒤 원장 소유권을 반납한다.

실행 실패·timeout·세션 중단은 해당 작업을 blocked로 남긴다. 로그·실제 프로세스·부분 변경을 확인한 다음 `workflow_run {action:"recover",runId,taskId,reason:"확인한 상태와 다음 시도 이유"}`로 복구를 기록한다. 계획 리뷰·통합 실패는 taskId를 생략한다. 복구는 프로세스를 재시작하거나 파일을 되돌리지 않는다. 작업·단계·계획 revision별 최대 시도는 기본 3회이며 자동 retry는 없다.

일반 리뷰의 `changes_requested`는 수정 작업으로 돌아가는 판정이며 실행 실패와 구분한다. merge conflict는 실제 작업 트리에서 명시적으로 해결하고 커밋한 뒤 복구한다. 통합 결과는 검사와 최종 리뷰를 다시 거친다. worktree를 자동 삭제하지 않는다.

`/workflow metrics`는 현재 세션의 보고된 실행시간과 `inputTokens`, `outputTokens`, `cachedInputTokens`, `totalTokens`, `costUsd`를 단계/profile별로 합산한다. 미보고 수치는 null과 unknownJobs로 남긴다. 가격표에서 추정한 금액을 실청구로 표시하지 않는다.

## 스킬 선택

[source.json](../vendor/paperthin/source.json)의 커밋 `6f706e30b5ec55e87598bf3b59164c9d9d96222f`에서 28개 원문·라이선스를 보존한다. 실행 선택의 기준은 [skills.json](../config/skills.json)의 invocation·when·roles·note다. 역할 핵심 본문과 선택한 추가 본문만 주입한다.

| 역할 | 기본 본문 |
| --- | --- |
| Lead | readchk, modelchk, shower, re0, sip |
| Worker·Codex Worker·Claude Worker | readchk, re0 |
| Reviewer·Escalation | readchk |

| 호출 기준 | 스킬 |
| --- | --- |
| 조건에 따라 모델이 선택, 16개 | re0, readchk, aim, modelchk, autobahn, detool, shower, factchk, mandela, sip, ssotize, re0-loop, re0-memo, re0-work, catchup, nba |
| 사용자 명시 호출, 12개 | hate, macrothink, feynman, reorder, dedash, debloat, re0-git, re0-release, re0-merge, re0-upgrade, re0-plan, prism |

사용자 전용 스킬은 명시적 이름 요청 또는 `/skill:<name>`으로 호출한다. 다른 스킬이 해당 이름을 언급하거나 `nba`가 추천한 사실은 실행 허가가 아니다. 스킬 설치는 권한을 추가하지 않으며 대상 프로젝트의 기존 지침과 사용자 권한이 우선한다.

`sip`는 완료 전 검사 선택자다. `shower`로 이해 가능성, 외부 사실이 있으면 `factchk`, 검증 설계가 있으면 `mandela`, 복제·모순은 `ssotize` 읽기 전용 감사, 이식성을 주장할 때만 `detool`, 문서 정리는 `re0`를 적용한다. 모든 체크를 매 수정마다 새로 실행하지 않고 기존 해시·근거를 재사용한다. `ssotize`의 통합은 읽기 전용 감사와 분리해 허용된 구체 범위에서 수행한다.

`macrothink`는 방향의 프레이밍을 벗긴 2~5개 독립 읽기이며 기본 3개다. `prism`은 산출물의 서로 다른 실패 양상마다 2~5개 관점을 고른다. 둘 다 Lead가 같은 큐를 사용하므로 논리적 읽기 수가 5개여도 동시 실행은 기본 2개다. 일치 횟수로 진실을 결정하지 않고 차이와 그것을 가를 검증을 반환한다. 자식이 다시 여러 자식을 만드는 방식은 사용하지 않는다.

`re0-loop`는 긴 작업의 실사용 검증·학습·다음 구현을 현재 Lead의 단계 안에서 반복한다. `re0-memo`는 실제 실패·QA에서 다음 검증 조건을 남긴다. `re0-work`는 근거가 있는 재설계가 필요할 때 보존/폐기 대상을 명시한다. 어느 것도 새로운 scheduler나 기존 작업을 파괴할 권한을 만들지 않는다. 외부 증거 없이 내부 평가만 반복되면 새 검증·입력을 먼저 얻는다. `catchup`은 현재 상태에서 사용자 맥락을 복원하고 `nba`는 다음 행동 하나를 추천한다.

유지보수용 스킬은 적용 대상을 먼저 확인한다. `re0-plan`은 upstream의 paperthin-only iteration 관례이며 일반 계획 작성의 필수 단계가 아니다. `re0-upgrade`는 별도 npx skills 설치를 다루며 이 Pi 패키지는 `pi update`로 갱신한다. `re0-release`·`re0-merge`는 upstream의 카탈로그·태그·CI·기여 처리 관례를 가정하므로 대상의 실제 정책과 권한이 맞을 때만 적용한다. 이 패키지가 npx 목록에 없다는 이유로 중복 설치하거나 hook·GitHub star를 추가하지 않는다.

## Herdr 화면과 호환 경로

프로젝트 workspace에 Pi/Astra Lead tab을 두고 기본 job은 headless로 실행한다. Herdr의 working/idle은 운영 신호이며 개별 run의 완료·승인 근거가 아니다.

`workflow_tab`은 `HERDR_ENV=1`과 현재 workspace/tab/pane 식별자가 있는 Herdr 내부에서만 동작한다. 명시한 workspace와 절대 cwd에 `tab create --no-focus`로 새 탭을 만들고, 응답에서 확인한 새 pane ID에만 CLI를 시작·프롬프트를 전달한다. 셸 문자열을 조합하지 않고 argv를 전달한다. 실패하면 생성된 탭을 보존하고 관찰된 식별자를 반환한다. 전송 결과가 불확실하면 자동 재전송하지 않는다.

이 도구는 직접 디버깅·질문을 위한 새 대화형 보조 세션이다. 기존 headless job 이전·자동 승인·별도 scheduler는 제공하지 않는다. 역할의 기본 interactive launch 인자를 사용하며, Fable의 실제 상호작용·비용 확인은 CLI가 처리한다.

`workflow_prepare`는 기존 pi-herdr의 현재 pane 분할 경로를 위한 spec 준비다. 새 task-tab 어댑터와 구분하며, pi-herdr의 `split --current`를 특정 tab 배치로 간주하지 않는다. Herdr 밖에서 현재 사용자의 pane을 조회·제어하지 않는다.
