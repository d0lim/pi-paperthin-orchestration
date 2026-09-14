# Pi Paperthin Orchestration

어떤 프로젝트에서도 `/lead <요청>`으로 계획·구현·검토를 진행하는 설치형 Pi 확장이다. Lead는 Astra로 대화하고, 작업별 판단에 따라 Sol·Opus·Fable 자식을 독립 프로세스로 실행한다. 자식마다 터미널 pane을 만들지 않으며 Paperthin 28개 스킬에서 필요한 절차를 선택한다. Compound Engineering은 사용하지 않는다.

## 설치

Pi와 Claude Code, 사용할 구독 로그인이 준비되어 있어야 한다. 처음 준비한다면 [Runbook의 설치](RUNBOOK.md#2-설치와-업데이트)와 [구독 인증](RUNBOOK.md#3-구독-인증)을 따른다. 기존 `agents.zsh`·thinking 설정은 재사용하며 셸 함수는 필수가 아니다.

현재 확인 환경은 Pi 0.85.1, Herdr 0.9.0, Claude Code 2.1.270이다. Pi는 `/login`, Claude Code는 `claude auth status`로 인증 상태를 확인한다. 실제 호출과 미검증 범위는 [검증 기록](docs/verification.md)에 구분했다.

~~~bash
pi install git:github.com/d0lim/pi-paperthin-orchestration
~~~

대상 프로젝트마다 역할 파일을 복사할 필요가 없다. 설치 후 새 Pi를 열거나 `/reload`한다. 패키지를 업데이트할 때는 다음 명령을 사용한다.

~~~bash
pi update git:github.com/d0lim/pi-paperthin-orchestration
~~~

## 프로젝트에서 사용

작업할 프로젝트에서 `pi`를 실행하고 요청한다.

~~~bash
cd /path/to/your-project
pi
~~~

~~~text
/lead 현재 프로젝트에 필요한 변경을 구현하고 리뷰·테스트까지 진행해줘
~~~

이 Pi가 Lead가 되며 Worker·Reviewer는 Lead가 실행하고 결과를 회수한다. **일반 Pi는 비활성 상태로 시작한다.** `/lead`가 정확한 Lead 모델·effort와 역할 정책을 활성화한다. 사용할 수 없는 모델을 다른 모델이나 API 인증으로 자동 대체하지 않는다.

~~~text
/workflow
/workflow jobs
/workflow skills
/workflow off
~~~

`/workflow`는 역할·실제 모델·기대 설정·설정 경로와 실행 환경을, `/workflow jobs`는 자식 상태를, `/workflow skills`는 호출 조건을 포함한 catalog를 보여준다. `/workflow cancel <id>`로 소유한 작업을 취소할 수 있다. `/workflow off`는 진행 중인 자식이 모두 끝나거나 취소된 뒤 사용한다. 이 명령들은 모델을 호출하지 않는다. `/lead --help`로 명령 로드를 확인할 수 있으며 `/lead`만 입력하면 여러 줄 입력창이 열린다. 활성 Lead가 작업 중이면 후속 요청으로 대기한다.

활성화 뒤 일반 입력도 같은 Lead에게 전달되며 기존 작업의 보충인지 새 목표인지 대화로 구분한다. `/workflow off`는 모델을 유지한 채 역할 지침을 해제한다. Lead는 요청 범위에서 worktree·고정 후보를 준비하고 검토된 변경을 통합한다. 커밋 금지 등 사용자의 Git 제약을 우선하고, push·PR·배포는 해당 요청이 허용한 경우에 수행한다.

계획·브리프·리뷰 근거는 대상 프로젝트의 `.agent-runs/<작업 식별자>/`, 자식의 stdout.log·stderr.log·result.json은 `.agent-runs/jobs/<session>/<job>/`에 남는다. 실행기는 jobs 안에 로컬 `.gitignore`를 만들고 Lead는 필요한 경우 프로젝트 `.gitignore`에 `.agent-runs/`를 추가한다. 기존 규칙·추적 파일·사용자 변경을 자동 제거하지 않는다. 재개 시 기록과 실제 파일을 대조하며 죽은 프로세스를 자동 재시작하지 않는다.

프로젝트의 `AGENTS.md` 등 지침과 신뢰 설정을 존중한다. 신뢰하지 않은 프로젝트 지침·설정 때문에 활성화가 차단되면 `/trust`에서 확인한 뒤 Pi를 종료하고 다시 실행한다. 세션의 모델 표시와 프로세스 정상 종료만으로 실제 모델 접근이나 결과 품질을 증명하지 않는다.

## 역할과 모델 선택

| 작업 | 기본 profile | 실행 | frontier 판단 때 |
| --- | --- | --- | --- |
| Lead 대화·조율 | 고정 Lead | Pi / Astra / high | Lead 유지 |
| 구현 `implement` | `sol` | Pi / Sol Worker | `fable` / Claude Worker |
| 리뷰 `review` | `opus` | Claude Code / Opus Reviewer | `fable` / Escalation |
| 조사 `analyze` | `opus` | Claude Code / Opus Reviewer | `fable` / Escalation |
| 독립 읽기 `probe` | `sol` | 프로젝트 문맥 없는 읽기 | 허용된 profile 선택 |

Lead가 `modelchk`의 중립 tier·effort 추천을 작성하면 executor가 허용된 profile과 실제 effort에 매핑한다. **사용자가 지정한 profile·effort가 우선**이다. 선택 결과와 이유는 작업 기록에 남으며 전역 모델 기본값을 바꾸지 않는다. `codex` 구현 profile도 명시적으로 선택할 수 있다. 이는 설정된 실행 정책이며 모델 성능을 실험으로 입증한 분류는 아니다.

Astra·Sol은 Pi의 ChatGPT 구독 경로, Opus·Fable은 Claude Code의 Claude 구독 경로를 사용한다. 실제 provider·model ID는 [roles.json](config/roles.json)에 있다.

Fable의 headless 실행은 기본 차단한다. Claude Code의 `-p`·SDK 호출은 usage credits 대상인 Fable 요청을 확인 없이 청구할 수 있으므로, 해당 비용까지 허용한 경우에만 프로젝트 정책에서 활성화한다. 구독 모델 접근 권한만 확인한 것과 이 허용은 다르다. [Claude Code 안내](https://code.claude.com/docs/en/model-config#fable-and-usage-credits)

개인 기본값은 `~/.pi/agent/paperthin.json`, 프로젝트 덮어쓰기는 `.pi/paperthin.json`에 둔다. profile pin·effort 매핑·Fable 정책의 정확한 형식은 [실행 설정](docs/orchestration.md#실행-설정)을 따른다.

## Paperthin이 들어가는 흐름

1. `readchk`로 요청을 해석하고 `understood as: ...`를 기록한다. `modelchk`로 첫 위임과 성격이 바뀐 작업을 평가한다.
2. 계획을 작성하고 필요한 `sip` 검사·`re0` 정리를 마친 뒤 해시를 고정해 독립 계획 리뷰를 받는다.
3. 첫 실질 Worker 브리프를 `shower`로 독립 읽힌 뒤 구현을 맡긴다. Worker는 담당 worktree에서 구현·테스트한다.
4. `sip`가 외부 사실의 `factchk`, 검증 설계의 `mandela`, 중복·모순 감사 등 적용할 검사를 고른다. 문서·인계의 독립 읽기와 수정을 마친 뒤 후보 SHA를 고정해 코드 리뷰를 받는다.
5. 필요한 수정·재검토 후 허용된 범위에서 통합한다. `re0-memo`로 실제 실패·QA에서 배운 점을 다음 단계에 반영하고, 재개에는 `catchup`, 다음 행동 판단에는 `nba`를 사용한다.

28개를 매 작업에 모두 주입하거나 실행하지 않는다. Lead는 `readchk`·`modelchk`·`shower`·`re0`·`sip`, Worker 계열은 `readchk`·`re0`, Reviewer 계열은 `readchk` 원문을 기본으로 받는다. 작업에 선택된 추가 스킬만 본문을 더한다. 같은 산출물 해시의 검토 결과는 재사용하고 의미 변경 때 필요한 검토를 다시 받는다.

모델이 조건에 따라 선택하는 스킬 16개와 **사용자가 명시적으로 호출하는 스킬 12개**를 구분한다. 예를 들어 `/lead 현재 계획을 macrothink로 검토해줘`는 여러 독립 읽기를 요청한다. 활성 Lead에서 `/skill:prism`처럼 원본을 직접 호출할 수도 있다. 전체 목록과 유지보수 스킬의 적용 제한은 [스킬 선택](docs/orchestration.md#스킬-선택)에 있다.

기본 자식은 동시 2개, 대기 8개, 작업당 15분으로 제한한다. Lead만 큐와 전체 반복을 소유하며 자식이 다시 위임하지 않는다. 프로세스 `completed`와 품질 승인을 구분한다. 단계 리뷰와 Paperthin 적용 순서는 Lead 지침이며, 코드가 모든 승인 전이를 강제하는 상태 머신은 아니다.

## Herdr 화면 구성

Herdr를 쓴다면 프로젝트 workspace 안에 Lead tab을 두고 그 안에서 `pi`를 실행한다. 대부분의 자식은 화면 없이 실행되고 `/workflow jobs`에서 확인한다. 터미널 입력이나 장기 직접 상호작용이 필요한 작업만 별도 task tab으로 연다.

현재 패키지는 task tab을 자동 생성하지 않는다. 기존 `workflow_prepare`·pi-herdr pane 위임은 호환 경로다. pi-herdr 0.5는 현재 pane을 분할하므로 tab을 바꿨다는 이유로 자동 task-tab 배치가 구현됐다고 가정하지 않는다. [Herdr 운영 범위](docs/orchestration.md#herdr-화면과-호환-경로)

## 개발과 확인

~~~bash
npm test
~~~

제거하려면 `pi remove git:github.com/d0lim/pi-paperthin-orchestration`을 실행한다. 선택 실습 앱은 `examples/todo-cli`에 있으며 설치·일반 운영의 필수 단계가 아니다.

[Runbook](RUNBOOK.md)은 설치·인증·운영, [orchestration.md](docs/orchestration.md)는 실행·스킬 계약, [참조 비교](docs/reference-workflow.md)는 설계 출처를 설명한다. 현재 확인된 테스트·실제 호출·UI 범위는 [verification.md](docs/verification.md)를 따른다.
