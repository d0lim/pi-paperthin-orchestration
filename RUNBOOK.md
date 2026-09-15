# Pi + Herdr + Paperthin 운영 Runbook

갱신일: 2026-09-15 · macOS, zsh, Homebrew 기준

빠른 시작은 [README](README.md), 도구·routing·스킬의 상세 계약은 [orchestration.md](docs/orchestration.md)를 따른다.

## 1. 운영 원칙

대상 프로젝트에서 Pi를 열고 `/lead <요청>`으로 시작한다. Astra Lead가 계획과 유일한 작업 큐를 소유하고 Fable 계획 리뷰 → Codex/Sol 구현 → Opus 작업 리뷰 → 통합 검사·Opus 리뷰를 조율한다. 자식은 재위임하지 않는다. 패키지 예제 앱이나 역할 파일을 프로젝트에 복사할 필요는 없다.

`workflow_run`은 계획·후보 해시, 작업별 worktree, 파일 소유권, 선행 승인과 실제 검사 결과를 관리한다. `workflow_spawn`이 만든 job의 결과를 `workflow_jobs`로 회수해야 승인 원장이 갱신된다. 프로세스 정상 종료만으로 승인하지 않는다. 테스트의 충분성과 리뷰 내용은 Lead와 Reviewer가 근거를 보고 판단한다.

## 2. 설치와 업데이트

기존 설치·셸 함수·thinking 설정을 확인하고 필요한 도구만 준비한다. 기본 단계에는 Pi, Codex CLI, Claude Code가 필요하며 Herdr는 터미널 화면과 직접 대화에 사용한다.

~~~bash
type -a pi herdr codex claude node npm
pi --version
herdr --version
codex --version
claude --version
~~~

새 머신의 Homebrew 설치 예시다.

~~~bash
brew install pi-coding-agent herdr
brew install --cask codex claude-code
pi install git:github.com/d0lim/pi-paperthin-orchestration
~~~

실제 실행 경로와 모델 접근 권한을 확인한다. Homebrew는 임의의 과거 버전 전환이나 전체 의존성 고정을 보장하지 않는다. [Pi formula](https://formulae.brew.sh/formula/pi-coding-agent), [Herdr 설치](https://herdr.dev/docs/install/), [Claude cask](https://formulae.brew.sh/cask/claude-code)

manifest가 확장과 pinned Paperthin 스킬을 등록한다. 기존 인증·셸 함수·전역 모델 설정을 덮어쓰지 않는다. 기본 headless 실행과 새 `workflow_tab`은 pi-herdr에 의존하지 않는다. 기존 pane 위임 호환 경로가 필요할 때만 다음 설치를 사용한다. [Pi 패키지](https://pi.dev/docs/latest/packages)

~~~bash
pi install npm:@andrewjacop/pi-herdr
herdr integration install pi
~~~

진행 중인 작업을 마치거나 취소한 뒤 업데이트하고 새 Pi 또는 `/reload`로 적용한다. 이전 프로세스가 자동 재개되지는 않는다.

~~~bash
brew update
brew upgrade pi-coding-agent herdr
pi update git:github.com/d0lim/pi-paperthin-orchestration
~~~

## 3. 인증과 Fable 정책

| 경로 | 용도 |
| --- | --- |
| Pi → ChatGPT Plus/Pro (Codex) 로그인 | Astra Lead·선택 Pi/Sol 구현·기본 독립 읽기 |
| Codex CLI → ChatGPT 로그인 | 기본 Codex/Sol 구현 |
| Claude Code → Claude 계정 로그인 | Fable 계획 리뷰·Opus 작업/통합 리뷰 |
| API key | 인증·모델 실패 시 자동 대체하지 않음 |

Pi `/login`의 `ChatGPT Plus/Pro (Codex)`와 Codex CLI의 로그인은 각각 확인한다. 기존 인증을 재사용하고 인증 파일·키·토큰을 출력하거나 인계하지 않는다. 계정의 상품명, 모델 권한과 한도는 실제 계정에서 확인한다. [Pi Providers](https://pi.dev/docs/latest/providers), [Claude Code 구독](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)

**Fable headless 실행은 기본 차단**이다. 공식 문서에 따르면 계정 조건에 따라 Fable은 usage credits를 사용하며 `-p`·Agent SDK는 해당 청구의 확인 질문 없이 실행한다. 사용자의 운영 정책에서 그 비용까지 허용한 경우에만 개인 또는 신뢰한 프로젝트 설정에 `routing.allowFableHeadless: true`를 지정한다. 모델 순서를 선택했다는 사실만으로 비용 허용을 추론하지 않는다. [Fable와 usage credits](https://code.claude.com/docs/en/model-config#fable-and-usage-credits)

모델 목록은 접근·호출·청구 경로의 증거가 아니다. 실행기가 요청 모델과 보고된 모델을 대조한다. 다른 모델이 보고되거나 관리 리뷰에서 모델을 확인할 수 없으면 승인하지 않는다. 접근·과금 차단을 다른 모델이나 API로 자동 우회하지 않는다.

## 4. 프로젝트와 화면 준비

Herdr를 쓴다면 대상 프로젝트 workspace의 Lead tab에서 Pi를 실행한다. 일반 Pi 세션은 비활성으로 시작한다.

~~~text
/lead 현재 요청의 계획을 세우고 구현·리뷰·테스트까지 진행해줘
/workflow
/workflow jobs
/workflow runs
/workflow metrics
/workflow skills
~~~

`/workflow`는 활성 역할·모델·설정·실행 환경을, `jobs`는 현재 세션의 자식 상태를, `runs`는 영속 실행 기록을 보여준다. `metrics`는 현재 세션에 보고된 시간·토큰·비용을 집계하고 미보고 값을 모름으로 남긴다. `/workflow off`는 소유 작업이 끝나거나 취소된 뒤 일반 Pi 사용으로 돌아간다.

`pi list`와 `/lead --help`로 확장 로드를 확인한다. 프로젝트 신뢰와 기존 `AGENTS.md`를 존중하고 `/trust` 후에는 Pi를 재시작한다. 관리 실행을 시작할 checkout은 깨끗해야 한다. 사용자 변경을 자동 stash/reset하지 않는다. 계획·브리프를 `.agent-runs/`에 두면 기존 규칙을 보존하며 필요한 ignore만 준비하거나 저장소 밖의 산출물 경로를 사용한다.

기본 자식은 화면 없는 프로세스다. 직접 대화가 필요하면 Herdr 내부에서 `workflow_tab`에 명시적인 `workspaceId`, 절대 `cwd`, `label`, `role`, `brief`를 전달한다. 이 도구는 지정 workspace에 새 탭·새 세션을 만들며 기존 job을 이전하지 않는다. 탭 결과는 관리 run의 승인으로 자동 등록되지 않는다. 시작·프롬프트 전달 실패 때 만들어진 탭을 보존하므로 상태를 확인한 뒤 후속 조치를 정한다. [Herdr 계약](docs/orchestration.md#herdr-화면과-호환-경로)

## 5. 단계별 routing

| 역할·단계 | 기본 실행 |
| --- | --- |
| Lead | Pi / Astra |
| `plan_review` | Claude / Fable |
| `implement` | Codex / Sol |
| 작업·통합 `code_review` | Claude / Opus |
| `workflow_cold_read` | Pi / Sol |

`sol` profile은 Pi/Sol이며 `codex`는 Codex CLI/Sol이다. 단계별 기본값은 `routing.phases`, task별 사용자 고정은 `routing.pins`로 지정한다. task pin → 명시 profile → phase 기본값 순으로 적용하며 pin과 명시 profile이 충돌하면 오류다. `pins.review`는 계획·작업·통합 리뷰 모두에 적용한다. 서로 다른 리뷰 모델을 유지하려면 phase 설정을 사용한다.

중립 `modelchk` 여섯 필드와 실제 profile·model·effort를 따로 기록한다. 사용자 effort pin을 유지한다. 설정은 번들 → 개인 `~/.pi/agent/paperthin.json` → 신뢰한 프로젝트 `.pi/paperthin.json` 순이며 필요한 필드만 덮어쓴다. 상세 JSON은 [실행 설정](docs/orchestration.md#실행-설정), 정확한 모델 ID는 [roles.json](config/roles.json)을 따른다.

## 6. 계획부터 완료까지

아래 이름은 Lead가 사용하는 Pi 도구이며 셸 명령이 아니다.

1. `readchk`로 목표·실제 Git 상태·범위를 확인하고 계획의 담당 파일·의존성·검증·완료 조건을 작성한다. 필요한 `sip` 검사와 `re0` 정리를 마친다.
2. `workflow_run`의 `start`에 계획 경로를 전달해 현재 HEAD·계획 스냅샷을 등록한다. 반환된 `runId`로 `workflow_spawn`의 `task: review`, `phase: plan_review`를 실행하고 `workflow_jobs get/wait`로 결과를 회수한다.
3. `workflow_run`의 `task`로 명시적인 담당 파일·디렉터리와 `dependsOn`을 등록한다. 반환된 `taskId`·worktree를 사용한다. 겹치는 경로는 명시적인 선행 의존성이 필요하며 같은 파일을 동시에 작성하지 않는다.
4. 첫 실질 Worker 브리프는 `shower` 독립 읽기와 수정을 마친다. `workflow_spawn`에 `task: implement`, `phase: implement`, `runId`, `taskId`, `brief`, 여섯 필드의 `assessment`를 전달한다. 지정한 cwd는 등록 worktree와 같아야 한다.
5. 결과를 회수하고 Lead가 실제 diff·테스트·선택 스킬 근거를 확인한다. 허용된 담당 경로만 커밋한 뒤 `workflow_run freeze`로 깨끗한 후보 SHA를 고정한다.
6. `workflow_run check`에 `taskId`, 실제 명령의 `argv` 배열, 최대 60초 `timeoutMs`를 전달한다. 이 도구가 명령을 직접 실행한다. 작업 트리나 HEAD를 바꾼 검사는 통과로 기록되지 않는다.
7. 같은 task의 `code_review`를 제출해 Opus 결과를 회수한다. 수정은 implement → 담당 경로 커밋 → freeze → check → review로 반복한다. 검사·승인은 현재 계획과 후보에만 유효하다.
8. 모든 작업이 승인되면 `workflow_run integrate`로 별도 통합 worktree를 만든다. **taskId 없이** `check`, 이어서 **taskId 없이** `code_review`를 실행한다. `complete`는 통합 후보의 검사와 최종 리뷰 승인을 모두 요구한다.
9. 완료한 통합 후보를 사용자 허용 범위에서 반영·push·PR 처리한다. 원래 사용자 브랜치는 도구가 자동 이동하지 않는다. 실제 QA·실패·피드백은 `re0-memo`로 보존한다.

계획 수정은 `workflow_run plan`으로 새 스냅샷과 계획 리뷰를 받는다. 기존 계획·후보 승인은 새 revision에서 다시 받아야 한다. 통합 시작 뒤 수정이 필요하면 새 계획 revision 또는 새 run으로 돌아가 영향 작업을 구현·검사·리뷰하고 재통합한다. 커밋을 금지한 요청에서는 이 commit-SHA 기반 실행을 강행하지 않고 분석과 가능한 대체 검토 범위를 명시한다.

일반 `analyze`는 run 없이 실제 파일·Git 상태를 읽을 수 있으며 승인 결과로 확대하지 않는다. Reviewer는 읽기 전용이다. 관리 리뷰의 마지막 응답은 정확한 phase·계획·base/candidate·verdict·findings를 담은 단일 JSON 객체다. 역할의 일반 서술 형식보다 [리뷰 JSON 계약](docs/orchestration.md#리뷰와-증거)이 우선한다.

## 7. 기록·재개·복구

- 계획·브리프·학습: 프로젝트 `.agent-runs/<작업 식별자>/` 권장.
- 프로세스 stdout·stderr·result: `.agent-runs/jobs/<session>/<job>/`.
- 승인 원장·고정 계획·작업/통합 worktree: Git common directory의 `paperthin/workflows/`.
- 후보 검사 로그: 같은 위치의 `<runId>/checks/<jobId>/`.

한 controller가 저장소의 원장을 소유한다. 기본 실행은 동시 2개·대기 8개·job당 15분이다. `workflow_jobs`는 현재 세션이 소유한 job만 관리하며 한 번의 wait는 최대 10초다. 새 세션은 기록을 읽을 수 있지만 죽은 프로세스를 재접속하거나 자동 재시작하지 않는다.

후보 검사는 별도로 동시 2개·각 최대 60초다. 검사 중에도 다른 작업의 시간 제한과 취소가 작동한다. 검사 도구 취소와 세션 종료는 소유한 검사 프로세스도 정리한다. 비정상 종료로 남은 검사 기록은 로그·프로세스·작업 공간 확인 후 복구해야 한다.

실패·timeout·취소·이전 세션의 미정산 시도는 로그와 부분 worktree를 확인한다. blocked 대상은 `workflow_run recover`에 `runId`, 해당하면 `taskId`, 확인한 상태와 다음 조치를 담은 `reason`을 전달한다. 복구는 관찰 기록을 남기며 파일을 reset하거나 재실행하지 않는다. 미완료 merge는 명시적으로 해결한 뒤 복구한다. 같은 phase·task·계획 revision의 시도는 기본 3회로 제한된다.

시작 checkout의 HEAD가 바뀌었으면 새 기준에서 run을 시작한다. 통합 충돌은 보존된 통합 worktree에서 해결·커밋하고 recover → integrate → 통합 check·review로 진행한다. worktree·과거 로그를 자동 삭제하지 않는다.

worktree 생성 도중 중단됐다면 같은 recover 도구를 사용한다. 저장된 경로·저장소·기준 SHA와 깨끗한 상태가 일치할 때 기존 worktree를 이어받거나 누락된 생성을 마친다. 일치하지 않는 경로나 부분 변경을 자동 삭제하지 않는다.

## 8. Paperthin 적용과 문제 해결

28개 catalog, 역할 핵심 본문과 user-only 12개의 조건은 [스킬 선택](docs/orchestration.md#스킬-선택)을 따른다. `sip`는 필요한 검사 선택자이며 모든 스킬을 반복 실행하지 않는다. `shower`는 같은 큐에서 산출물 내용만 독립 읽고 해시·응답을 반환한다. `re0-loop`·`re0-work`는 Lead의 기존 반복에 통합한다. `re0-plan`·`re0-upgrade` 등의 upstream 유지보수 절차를 일반 프로젝트에 자동 적용하지 않는다.

| 증상 | 확인·조치 |
| --- | --- |
| /lead 또는 /workflow 없음 | 설치 목록·확장 로드 오류 확인 후 새 Pi 또는 `/reload` |
| 모델 활성화 실패 | 정확한 모델 권한·인증·프로젝트 신뢰·역할 설정 확인 |
| Fable 차단 | 사용자의 비용 허용과 `allowFableHeadless` 확인, 우회 금지 |
| 구현·리뷰 제출 거절 | runId·phase·현재 승인·후보·검사·소유 worktree 확인 |
| queued | 실행 한도와 기존 job 확인, 중복 제출 금지 |
| failed/timed out/cancelled | 실제 로그·부분 변경 확인 후 필요한 명시적 recover |
| completed지만 승인 없음 | 모델·구조화 verdict·대상 해시·실제 검사 결과 확인 |
| tab 시작·prompt 전달 실패 | 보존된 탭 상태 확인, 같은 요청의 무조건 재전달 금지 |
| 다른 controller가 원장 소유 | 기존 세션과 소유 작업 상태 확인, 프로세스 강제 탈취 금지 |
| 스킬 적용 근거 부족 | 본문 주입과 실제 해석·외부 출처·독립 응답·검증을 구분 |

[검증 기록](docs/verification.md)은 모의 응답, 실제 모델 호출, Herdr UI, 전체 프로젝트 실행을 구분한다. 프로세스 종료나 이전 예제를 새 기능 전체의 운영 검증으로 보고하지 않는다.
