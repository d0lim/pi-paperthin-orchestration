# Pi Paperthin Orchestration

어떤 프로젝트에서도 `/lead <요청>`으로 역할 분담을 시작하는 설치형 Pi 확장이다. Pi/Astra가 계획과 조율을 맡고, Pi/Sol Worker와 Claude Code/Opus Reviewer가 구현·검토한다. 기존 `pi-herdr`를 통해 Herdr pane을 사용하며 Paperthin을 요청 해석, 작업 규모 판단, 브리프·인계 검증과 문서 정리에 적용한다. Compound Engineering은 사용하지 않는다.

## 설치

이 안내는 Pi, Herdr, Claude Code와 구독 로그인이 준비된 개발자를 대상으로 한다. 처음 준비한다면 [Runbook의 설치](RUNBOOK.md#2-설치와-업데이트)와 [구독 인증](RUNBOOK.md#3-구독-인증)을 먼저 따른다. `agents.zsh` 셸 함수는 선택 사항이며 없어도 아래처럼 사용할 수 있다. 기존 `pi-herdr`와 thinking 설정은 재사용한다.

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

Herdr 안의 pane 하나에서 해당 프로젝트로 이동해 `pi`를 실행한다. 이 Pi에 아래 요청을 입력하면 그 세션이 Lead가 된다. 이후 Worker와 Reviewer는 Lead가 Herdr를 통해 실행하므로 사용자가 별도로 시작할 필요가 없다.

~~~text
/lead 현재 프로젝트에 필요한 변경을 구현하고 리뷰·테스트까지 진행해줘
~~~

**일반 `pi` 세션에서는 워크플로우가 비활성 상태다.** `/lead`를 호출하거나 `--workflow-role`을 명시할 때 역할 정책을 적용한다. `/lead`는 인증된 설정에서 정확한 Lead 모델과 effort를 선택한다. 해당 모델을 사용할 수 없으면 오류를 보고하며 다른 모델이나 API 과금으로 자동 전환하지 않는다.

~~~text
/workflow
/workflow off
~~~

`/workflow`는 활성 여부, 역할, 현재 모델·effort, 역할 기준, 대상 프로젝트의 설정 경로와 Herdr 연결 상태를 모델 호출 없이 보여준다. `/workflow off`는 워크플로우 지침과 역할 검사를 해제해 일반 Pi 사용으로 돌아간다. 현재 모델은 유지된다.

설치 직후에는 `pi list`에서 패키지를 확인하고, Pi의 `/lead --help`로 명령 로드를 확인한다. Herdr 안에서 `/workflow`의 `herdr.insidePane`과 `herdr.delegateAvailable`이 모두 `true`여야 위임할 준비가 된 상태다. `/lead`를 아직 호출하지 않았다면 `active: false`는 정상이다. 이 확인은 모델을 호출하지 않으며 실제 모델 접근 검증은 첫 작업에서 별도로 이뤄진다.

`/lead`만 입력하면 여러 줄 입력창이 열린다. 도움말은 `/lead --help`다. 이미 활성화한 Lead가 작업 중이면 다음 요청으로 대기하고, 일반 Pi가 작업 중이면 끝난 뒤 Lead를 활성화한다.

작업을 맡길 때 사용자가 내부 도구, worktree 명령, 브리프 양식을 외울 필요는 없다. Lead가 현재 저장소의 지침·Git 상태·완료 조건을 확인하고 필요한 작업을 준비한다. 계획이나 읽기만 요청한 경우 구현·위임을 시작하지 않는다.

구현 위임은 Git worktree를 사용한다. 기준 커밋이 없거나 worktree를 만들 수 없으면 Lead가 제약과 필요한 준비를 알린다. 기존 변경은 보존하며 사용자가 허용한 범위에서 커밋·통합한다. 계획·브리프·해시·리뷰·Paperthin 근거는 대상 프로젝트의 `.agent-runs/<작업 식별자>/`에 남기고 Git에서 제외한다. Worker·Reviewer의 시작 출력과 결과는 Lead가 회수해 이 기록에 반영한다.

프로젝트 신뢰 확인이 나타나면 해당 프로젝트의 지침과 확장을 확인한다. 신뢰하지 않은 프로젝트의 `AGENTS.md`나 `.pi/paperthin.json` 때문에 활성화가 차단되면 `/trust`에서 확인한 뒤 Pi를 종료하고 다시 실행한다. 위임은 Herdr 안에서 수행하며 `/workflow`에서 `herdr_delegate`를 사용할 수 있는지 확인한다. 현재 세션의 모델 표시는 서버의 실제 모델 호출 성공까지 증명하는 것은 아니다.

## 역할과 반복 절차

| 역할 | 런타임·모델 | 기본 effort |
| --- | --- | --- |
| Lead | Pi / `openai-codex` / `gpt-6-astra` | high |
| Worker | Pi / `openai-codex` / `gpt-5.6-sol` | medium |
| Reviewer | Claude Code / `claude-opus-5` | high |
| Escalation, 선택 | Claude Code / `claude-fable-5-1` | high |
| Codex Worker, 선택 | Codex CLI / `gpt-5.6-sol` | medium |

Lead가 `readchk`로 요청을 해석하고 `modelchk`로 첫 위임의 작업 규모를 판단한다. 전체 계획은 필요한 `re0` 정리를 마친 뒤 해시를 고정해 Reviewer에게 검토시킨다. 승인된 계획을 바탕으로 첫 실질 Worker 브리프를 작성하고, `shower` 독립 검토와 수정을 마친 뒤 Worker에게 전달한다.

Worker가 할당된 단계와 worktree에서 구현·테스트하고 필요한 문서 정리에 `re0`를 적용한다. Lead는 최종 사용자용 문서·인계 산출물의 `shower` 검토와 수정을 마친 뒤 코드 후보 SHA를 고정한다. Reviewer가 고정된 후보와 검증 근거를 검토하며, Lead가 필요한 수정·재검토 후 허용된 커밋·통합을 진행한다.

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

## Paperthin 적용과 증거

패키지 manifest가 확장과 Paperthin 원본을 등록한다. 활성 역할의 시스템 정책에는 공통·역할 지침과 아래 SKILL.md **원문 전체**를 포함한다. 나머지 스킬도 경로로 제공하며 대상 프로젝트의 `AGENTS.md` 등 기존 지침을 존중한다.

| 역할 | 자동으로 전달하는 스킬 본문 |
| --- | --- |
| Lead | `readchk`, `modelchk`, `shower`, `re0` |
| Worker·Codex Worker | `readchk`, `re0` |
| Reviewer·Escalation | `readchk` |

| Paperthin 스킬 | 워크플로우에서 적용하는 시점 |
| --- | --- |
| [readchk](vendor/paperthin/skills/readchk/SKILL.md) | 실질 작업 전에 요청을 문맥과 대조하고 기존 작업 기록·응답에 `understood as: ...` 한 줄 기록 |
| [modelchk](vendor/paperthin/skills/modelchk/SKILL.md) | Lead가 첫 위임 전, 범위·위험·실패 양상이 바뀔 때 작업에 필요한 capability tier와 effort를 중립 척도로 추천 |
| [shower](vendor/paperthin/skills/shower/SKILL.md) | Lead가 첫 실질 Worker 브리프와 최종 사용자용 문서·인계 산출물을 독립 세션에서 검토 |
| [re0](vendor/paperthin/skills/re0/SKILL.md) | 문서를 반복 수정하거나 연관 문서를 동기화할 때 작성자가 전체를 읽고 기존 섹션을 정리 |

`modelchk`는 `recommended_tier`, `recommended_effort`, `rationale`, `move_up_if`, `move_down_if`, `proof_surface` 여섯 필드로 판단을 남긴다. 추천은 실제 역할 설정과 구분하며 모델을 자동 변경하지 않는다. Reviewer는 `re0`가 필요한 문제를 지적할 수 있지만 파일을 수정하지 않는다.

`shower`는 Lead가 `workflow_cold_read`에 산출물 경로를 주면, 도구가 읽은 **내용만** 최대 120초의 독립 Pi 호출에 전달한다. 독립 호출에는 부모 의도·대화와 도구·자동 지침·스킬·확장·세션 저장을 전달하지 않는다. 도구는 실제 읽은 내용의 `artifactSha256`와 독립 해석을 반환하며, Lead가 그 해석을 자신이 따로 기록한 의도와 비교한다. 동일 내용의 검토는 해시로 재사용하고 의미가 바뀌었을 때 재검토한다. 매 브리프마다 무조건 새 모델을 호출하지 않는다.

각 역할은 기존 작업 기록·응답에 적용 내용과 근거, 조건에 해당하지 않아 생략했거나 실행에 실패한 이유를 남긴다. 본문이 시스템 정책에 들어간 사실만으로 실행 완료를 기록하지 않는다. Lead는 독립 해석·해시·문서 변경 등 실제 증거를 확인한다.

사용자가 스킬 이름을 매번 지정할 필요는 없다. 특정 산출물만 점검하려면 `/lead README.md를 Paperthin shower로 검토하고 결과만 알려줘`처럼 요청할 수 있다. 적용 순서와 기록은 에이전트 지침이며, 확장이 모든 실행 여부를 강제하거나 승인하는 상태 머신은 아니다.

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
