# 실행과 Paperthin 운영 계약

사용자는 `/lead`로 목표를 맡긴다. Lead 한 명이 계획·작업 큐·리뷰·통합을 소유하고 자식은 독립 프로세스에서 정해진 작업을 수행한다. 여기서는 패키지의 실행 정책을 설명하며 기본 설치는 [README](../README.md)를 따른다.

## 실행 설정

번들 기본값 → 개인 `~/.pi/agent/paperthin.json` → 신뢰한 프로젝트 `.pi/paperthin.json` 순서로 필요한 필드를 덮어쓴다. `PAPERTHIN_SETTINGS_PATH` 환경변수로 개인 설정 파일 경로를 지정할 수도 있다. 기본 파일은 [roles.json](../config/roles.json)과 [orchestration.json](../config/orchestration.json)이다. `roles`는 runtime·provider·model·effort, `routing`은 작업별 profile 선택, `jobs`는 프로세스 한도를 정한다.

~~~json
{
  "routing": {
    "mode": "adaptive",
    "allowFableHeadless": false,
    "pins": {}
  },
  "jobs": {
    "maxConcurrent": 2,
    "maxQueued": 8,
    "timeoutMs": 900000
  }
}
~~~

`adaptive`는 작업 종류와 `modelchk` assessment를 매핑한다. `fixed`는 기본 profile과 설정된 역할 effort를 유지한다. `pins`와 이번 요청의 명시적 `profile`은 자동 선택보다 우선하며, 서로 충돌하면 오류를 반환한다. 예를 들어 `"pins": { "implement": "sol", "review": "opus" }`는 구현·리뷰 profile을 고정한다. 실제 effort는 개인·프로젝트의 `roles.<role>.effort`로 고정할 수 있고 중립 추천보다 우선한다.

| task | 기본 profile | frontier profile | 허용 profile |
| --- | --- | --- | --- |
| implement | sol | fable | sol, fable, codex |
| review | opus | fable | opus, fable |
| analyze | opus | fable | opus, fable |
| probe | sol | fable | sol, opus, fable |

profile은 작업에 따라 역할에 연결된다. sol은 Pi Worker, codex는 Codex Worker다. opus는 Reviewer이며 fable은 구현 시 Claude Worker, 검토·분석 시 Escalation 역할이다. Lead의 현재 모델을 자식의 profile로 바꾸지 않는다. 정확한 모델 ID는 [roles.json](../config/roles.json)이 기준이다.

`modelchk`는 다음 여섯 필드의 중립 추천을 반환한다. 모델 제품명이나 실제 provider 설정은 이 평가에 섞지 않는다.

~~~text
recommended_tier: fast|standard|frontier
recommended_effort: glance|measured|thorough|exhaustive
rationale: 두 추천의 공통 이유
move_up_if: capability와 effort를 높일 조건
move_down_if: capability와 effort를 낮출 조건
proof_surface: 선택과 무관하게 필요한 검증
~~~

executor의 기본 effort 매핑은 Pi에서 minimal/medium/high/max, Claude에서 low/high/xhigh/max 순서다. 실행 가능한 실제 단계와 profile 설정을 확인하며 사용자 pin이 있으면 우선한다. fast와 standard는 등록된 기본 profile을 공유할 수 있다. 이 매핑은 허용된 실행 후보 안에서의 정책이며 벤치마크 결과가 아니다. 선택한 profile·모델·effort와 추천/고정의 이유를 job 근거에 보존한다.

`routing.allowFableHeadless: true`는 Fable이 usage credits를 사용하는 경우까지 자동 실행하도록 허용하는 값이다. 포함 구독 사용을 확인했다는 의미가 아니다. 기본값 false에서는 Fable headless 실행을 시작하지 않으며 다른 profile로 조용히 우회하지 않는다. Claude Code의 비대화형 `-p`·SDK 경로는 Fable의 해당 청구를 확인 없이 진행할 수 있다. [공식 모델 안내](https://code.claude.com/docs/en/model-config#fable-and-usage-credits)

인증·접근 오류에는 같은 실행의 실패를 기록한다. 다른 모델이나 API key로 바꾸지 않는다. CLI의 요청 모델과 실제 보고된 모델도 구분한다. 외부 런타임이 선택을 바꾸거나 요청 모델을 확인할 수 없다면 지정 모델의 검증 성공으로 기록하지 않는다.

## 작업 도구와 수명

| 도구 | 역할 |
| --- | --- |
| `workflow_spawn` | task, cwd, brief, assessment와 선택 profile·skills·label로 자식 작업 제출 |
| `workflow_jobs` | 현재 Lead의 작업 list/get/wait/cancel, wait는 한 번에 최대 10초 |
| `workflow_cold_read` | 내용만 전달하는 독립 읽기를 같은 큐에 제출, job ID와 artifactSha256 반환 |
| `workflow_skills` | 전체 catalog 또는 이름으로 스킬의 호출·역할·적용 조건 조회 |
| `workflow_prepare` | 기존 pi-herdr 대화형 pane 실행 spec 준비, 기본 위임에는 사용하지 않음 |

`workflow_spawn`의 일반 task는 implement/review/analyze다. probe는 `workflow_cold_read`의 독립 읽기용 routing 단위다. 일반 자식은 브리프, 역할 정책, 선택 스킬과 대상 프로젝트의 지침을 받으며 부모 대화가 자동 복제되지는 않는다. cold read는 실제 산출물 내용만 받고 프로젝트 지침·도구·스킬·확장·이웃 파일 접근을 제외한다. 선택적 lens는 읽을 중립 질문을 지정할 뿐 부모의 선호 결론이나 의도를 넘기는 통로가 아니다.

두 실행 경로 모두 비동기로 job ID를 반환한다. Lead가 `workflow_jobs get/wait`로 stdout·stderr·최종 상태를 회수한다. `workflow_cold_read`에서는 실제 읽힌 `artifactSha256`와 독립 해석을 함께 비교한다. 원본 파일을 나중에 바꿨다면 이전 해시의 검토를 새 내용에 적용하지 않는다.

기본값은 동시 2개, 대기 8개, 작업 실행 15분이다. 설정 범위는 동시 1~4개, 대기 0~32개, 실행 시간 1초~1시간이며 작업자가 한도를 임의로 늘리지 않는다. 한도가 차면 새 제출을 거부한다. wait의 10초 경과는 작업 취소가 아니다. cancel·세션 정리는 이 scheduler가 소유한 프로세스만 종료하고 로그를 보존한다. 결과는 `.agent-runs/jobs/<session>/<job>/`의 result.json·stdout.log·stderr.log에서 확인한다. 정확한 경로는 도구 반환값을 따른다. 완료·실패·시간 초과·취소 후 부분 변경도 남을 수 있으므로 재시도 전에 실제 worktree를 확인한다.

프로세스 `completed`는 품질 승인 상태가 아니다. Lead가 결과와 고정 후보·테스트·리뷰 근거를 대조한다. 승인 순서나 자동 재개까지 구현된 상태 머신으로 해석하지 않는다. 새 세션은 기존 기록을 읽고 실제 Git 상태를 확인한 뒤 필요한 다음 작업을 제출한다.

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

## 리뷰와 증거

계획·브리프와 코드·문서 산출물은 필요한 정리 → 독립 읽기·수정 → 해시 고정 → 해당 리뷰 순서로 준비한다. 계획 리뷰는 계획 SHA-256을, 코드 리뷰는 실제 base/candidate SHA를 확인한다. 일반 analyze 작업은 고정 후보가 없어도 현재 상태와 확인한 파일·시점을 밝히며 분석할 수 있다. 고정·승인 뒤 내용을 수정하면 새 해시로 영향받는 리뷰를 다시 받는다.

각 역할은 적용 스킬·대상·해시·실제 근거와 미적용·실패 이유를 기존 작업 기록·응답에 남긴다. 본문 전달이나 모델의 “실행했다”는 말만으로 완료를 인정하지 않는다. mock 검증, 실제 프로세스 호출, 실제 모델 응답, 대상 프로젝트의 전체 운영 결과를 나눠 기록한다. 모든 Worker는 담당 범위 안에서만 쓰고 Reviewer·Escalation은 분석 결과를 반환하며 파일을 수정하지 않는다.

## Herdr 화면과 호환 경로

권장 화면은 프로젝트 workspace 안에 Lead tab 하나를 두는 구성이다. tab은 터미널을 묶는 UI 단위이고 pane은 그 안의 분할이다. 기본 headless 자식은 둘 다 만들지 않는다. 터미널 입력, 사용자의 직접 디버깅, 장기 대화가 필요한 작업만 별도 task tab에서 운영한다. [Herdr 개념](https://herdr.dev/docs/concepts/)

현재 확장은 task tab 자동 생성·배치 어댑터를 제공하지 않는다. 필요할 때 Herdr UI로 대상 workspace의 새 tab을 열고 그 tab의 터미널에서 프로젝트 경로와 명시한 런타임을 시작한다. 기존 job을 새 tab으로 자동 이전하거나 동일 프로세스를 이어받는 기능으로 설명하지 않는다. 설치된 Herdr 0.9의 `herdr tab create --help`는 `--workspace`, `--cwd`, `--label`, `--focus`·`--no-focus`를 제공한다. CLI로 수동 생성할 때도 목적 workspace ID와 경로를 명시하고 현재 설치의 도움말을 확인한다.

pi-herdr 0.5의 생성은 `tabId`를 통한 목적 tab 배치를 보장하지 않으며 `split --current`를 사용한다. 탭 이동만으로 이 제약이 해결됐다고 광고하지 않는다. `workflow_prepare`는 기존 대화형 pane 위임의 spec만 준비한다. 해당 경로를 사용할 때만 기존 pi-herdr 도구를 사용하고, Herdr 밖에서 현재 사용자의 pane을 조회·제어하지 않는다.
