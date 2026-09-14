# Pi Paperthin Orchestration

어떤 프로젝트에서도 `/lead <요청>`으로 역할 분담을 시작하는 설치형 Pi 확장이다. Pi/Astra가 계획과 조율을 맡고, Pi/Sol Worker와 Claude Code/Opus Reviewer가 구현·검토한다. 기존 `pi-herdr`를 통해 Herdr pane을 사용하며 Paperthin 네 스킬을 함께 제공한다. Compound Engineering은 사용하지 않는다.

## 설치

Pi, Herdr, Claude Code와 구독 로그인이 준비되어 있어야 한다. 이미 설치한 `pi-herdr`, `agents.zsh`, thinking 설정은 재사용한다.

~~~bash
pi install git:github.com/d0lim/pi-paperthin-orchestration
~~~

`pi-herdr`가 없는 머신에서만 추가한다.

~~~bash
pi install npm:@andrewjacop/pi-herdr
herdr integration install pi
~~~

패키지는 Pi 사용자 설정에 등록된다. 대상 프로젝트마다 확장·역할 파일을 복사하거나 이 저장소 안에서 작업할 필요가 없다. 설치 후 새 Pi를 열거나 `/reload`한다.

## 프로젝트에서 사용

작업할 프로젝트의 터미널에서 Herdr를 연다. 아래 경로는 자신의 프로젝트로 바꾼다.

~~~bash
cd /path/to/your-project
herdr
~~~

Herdr pane에서도 해당 프로젝트로 이동해 `pi`를 실행하고 입력한다.

~~~text
/lead 현재 프로젝트에 필요한 변경을 구현하고 리뷰·테스트까지 진행해줘
~~~

**일반 `pi` 세션에서는 워크플로우가 비활성 상태다.** `/lead`를 호출하거나 `--workflow-role`을 명시할 때 역할 정책을 적용한다. `/lead`는 인증된 설정에서 정확한 Lead 모델과 effort를 선택한다. 해당 모델을 사용할 수 없으면 오류를 보고하며 다른 모델이나 API 과금으로 자동 전환하지 않는다.

~~~text
/workflow
/workflow off
~~~

`/workflow`는 활성 여부, 역할, 현재 모델·effort, 역할 기준, 대상 프로젝트의 설정 경로와 Herdr 연결 상태를 모델 호출 없이 보여준다. `/workflow off`는 워크플로우 지침과 역할 검사를 해제해 일반 Pi 사용으로 돌아간다. 현재 모델은 유지된다.

`/lead`만 입력하면 여러 줄 입력창이 열린다. 도움말은 `/lead --help`다. 이미 활성화한 Lead가 작업 중이면 다음 요청으로 대기하고, 일반 Pi가 작업 중이면 끝난 뒤 Lead를 활성화한다.

작업을 맡길 때 사용자가 내부 도구, worktree 명령, 브리프 양식을 외울 필요는 없다. Lead가 현재 저장소의 지침·Git 상태·완료 조건을 확인하고 필요한 작업을 준비한다. 계획이나 읽기만 요청한 경우 구현·위임을 시작하지 않는다.

프로젝트 신뢰 확인이 나타나면 해당 프로젝트의 지침과 확장을 확인한다. 신뢰하지 않은 프로젝트의 `AGENTS.md`나 `.pi/paperthin.json` 때문에 활성화가 차단되면 `/trust`에서 확인한 뒤 Pi를 종료하고 다시 실행한다. 위임은 Herdr 안에서 수행하며 `/workflow`에서 `herdr_delegate`를 사용할 수 있는지 확인한다. 현재 세션의 모델 표시는 서버의 실제 모델 호출 성공까지 증명하는 것은 아니다.

## 역할과 반복 절차

| 역할 | 런타임·모델 | 기본 effort |
| --- | --- | --- |
| Lead | Pi / `openai-codex` / `gpt-6-astra` | high |
| Worker | Pi / `openai-codex` / `gpt-5.6-sol` | medium |
| Reviewer | Claude Code / `claude-opus-5` | high |
| Escalation, 선택 | Claude Code / `claude-fable-5-1` | high |
| Codex Worker, 선택 | Codex CLI / `gpt-5.6-sol` | medium |

Lead가 전체 계획과 단계별 브리프를 작성하고 Reviewer에게 계획을 검토시킨다. Worker는 할당된 단계와 worktree에서 구현·테스트한다. Reviewer는 고정한 후보와 검증 근거를 확인하고 결과를 텍스트로 반환한다. Lead가 필요한 수정·재검토, 허용된 로컬 커밋과 통합을 진행한다.

이 반복은 **지침을 읽은 Lead 모델이 진행한다.** 확장은 역할·실행 인자·지침을 연결하며 승인 순서를 코드로 강제하는 상태 머신은 아니다. pane idle, 완료 마커, 모델의 승인 문구만으로 완료를 판정하지 않는다. 실제 diff, 후보 SHA, 테스트 근거를 함께 확인한다.

참고한 4역할 워크플로우와 현재 구성의 차이는 [reference-workflow.md](docs/reference-workflow.md)에 정리했다.

## 프로젝트별 설정

패키지 기본값은 `config/roles.json`에 있다. 대상 프로젝트의 `.pi/paperthin.json`으로 필요한 역할 값만 덮어쓴다.

~~~json
{
  "roles": {
    "worker": {
      "model": "gpt-5.6-sol",
      "effort": "high"
    }
  }
}
~~~

이 파일은 패키지 저장소가 아닌 **실제로 작업할 프로젝트**에 둔다. 다른 역할과 전역 Pi 설정은 유지한다. 변경 후 `/workflow`에서 적용 경로와 기대 값을 확인한다.

활성 역할의 현재 provider·model·effort가 기준과 다르면 요청을 차단한다. `/lead`는 Lead의 정확한 설정을 선택하며 Worker는 생성된 실행 인자를 사용한다. `modelchk`의 추천만으로 역할 기준을 바꾸지 않는다. 기존 `pi-worker` 셸 함수가 모델만 지정한다면 그 함수 자체가 Worker 지침을 전달하는 것은 아니다.

## 지침·Paperthin 자동 로드

패키지 manifest의 `pi.extensions`가 `extensions/workflow.ts`를, `pi.skills`가 Paperthin 원본을 등록한다. 역할 정책은 패키지의 `instructions/`에서 읽는다. 대상 프로젝트의 `AGENTS.md` 등 기존 지침도 존중한다.

활성 세션에서는 공통·역할 정책을 주입하고, 자식 실행에는 작업 브리프와 모델·effort·스킬 경로를 함께 전달한다. 다른 프로젝트의 경로를 가정하거나 부모 대화를 자동 복사하지 않는다. Claude Reviewer는 plan 모드로 응답만 반환하고 Lead가 리뷰 결과를 기록한다.

| Paperthin 스킬 | 적용 조건 |
| --- | --- |
| `readchk` | 복합 요청이나 모호한 범위를 작업 전에 해석 |
| `modelchk` | 작업 배정·추론 수준 판단에 추천이 필요 |
| `shower` | 이전 대화 없이 결과물이 이해되는지 검토 |
| `re0` | 누적된 문서 중복·오래된 설명을 정리 |

Pi에서는 `/skill:readchk`처럼 호출하거나 실제 SKILL.md를 읽도록 요청한다. 스킬 설명이 보이는 것과 본문을 읽고 적용한 것을 구분한다. 매 작업마다 네 스킬을 모두 실행하지 않는다.

shower 검토 요청 예시:

~~~text
/lead README.md를 Paperthin shower로 검토해.
독립 세션의 해석과 원래 의도를 비교하고 수정할 부분을 알려줘.
아직 파일은 수정하지 마.
~~~

Lead는 `workflow_cold_read`에 결과물 경로만 전달한다. 최대 120초의 별도 Pi 세션은 결과물 내용만 받고 도구·자동 지침·스킬·확장·세션 저장을 제외한다. 반환된 독립 해석을 원래 세션에서 비교한다.

## 내부 도구

일반 사용은 `/lead`로 충분하다. 확장의 연결 구조를 확인할 때 참고한다.

- `workflow_prepare`: 역할, worktree 절대경로, 브리프 파일로 `herdr_delegate` 입력을 준비한다. 실행하지 않는다.
- `herdr_delegate`: 기존 `pi-herdr` 도구다. Lead가 준비된 JSON 전체를 전달해 에이전트를 실행하고 결과를 회수한다.
- `workflow_cold_read`: Lead가 독립적인 shower 읽기를 요청한다.

프로젝트 확장에서 Herdr 제어를 중복 구현하지 않는다. `workflow_prepare`가 반환한 `agentArgs`, `cwd`, `prompt`, `onBlocked`를 보존한다. 추가 지시는 브리프를 수정하고 다시 준비한다. timeout이면 기존 pane을 확인하고 중복 작업자를 만들지 않는다.

## 개발·업데이트

이 저장소의 주 산출물은 Pi 패키지다. `examples/todo-cli`는 선택적인 로컬 실습 앱이며 설치나 일반 워크플로우의 필수 단계가 아니다.

~~~bash
npm test
pi update git:github.com/d0lim/pi-paperthin-orchestration
~~~

확장을 제거하려면 다음을 실행한다.

~~~bash
pi remove git:github.com/d0lim/pi-paperthin-orchestration
~~~

설치·구독·운영 배경은 [RUNBOOK.md](RUNBOOK.md), 참조 설계는 [reference-workflow.md](docs/reference-workflow.md), 실제 확인 범위는 [verification.md](docs/verification.md)를 참고한다. 설치·로더·모의 도구 검증과 실제 Herdr pane을 이용한 E2E 검증은 구분한다.
