# Pi + Paperthin orchestration 예제

프로젝트에서 `pi`를 열면 Lead 지침과 Paperthin을 사용할 준비가 된다. Lead는 Pi/Sol Worker에 구현을 맡기고 Claude Code/Opus Reviewer의 결과를 받아 통합한다. Herdr가 pane을 관리하고 기존 `pi-herdr`가 실행·대기·결과 수집을 맡는다. Compound Engineering은 사용하지 않는다.

기존 전역 `agents.zsh`, 인증, thinking 설정을 재사용한다. 이 프로젝트를 사용하기 위해 전역 설정을 바꿀 필요는 없다.

## 시작

~~~bash
cd ~/Develop/pi-paperthin-orchestration
npm test
herdr
~~~

Herdr pane에서 프로젝트로 이동한 뒤 평소처럼 실행한다.

~~~bash
cd ~/Develop/pi-paperthin-orchestration
pi
# 기존 함수로 명시적 Astra/high 설정을 쓰려면 pi-lead
~~~

Pi 입력창에서 연결 상태를 확인한다.

~~~text
/workflow
~~~

확인 후 같은 Pi에서 Lead에게 작업을 요청한다.

~~~text
/lead .workflow/briefs/add-delete.md를 구현하고 리뷰·테스트까지 진행해줘
~~~

`/workflow`는 상태 확인이고 `/lead <요청>`은 현재 Lead에게 보내는 작업 요청이다. `/lead`만 입력하면 여러 줄 요청을 작성하는 편집기가 열린다. 취소하면 요청을 보내지 않는다. 사용법은 모델 호출 없이 `/lead --help`로 확인한다. Lead가 응답 중이면 요청은 후속 메시지로 대기한다. Worker 등 다른 역할에서는 `/lead`를 사용할 수 없다.

프로젝트의 `.pi/extensions/workflow.ts`가 자동 로드된다. 프로젝트 신뢰·확장 실행 확인이 나타나면 저장소의 코드를 검토하고 허용한다. 이미 열어 둔 Pi에서는 `/reload` 후 `/workflow`를 실행한다. 확장 오류가 없어야 `workflow_prepare`, `workflow_cold_read` 도구를 사용할 수 있다. 위임할 때는 Herdr 안에서 시작한 Pi를 사용한다.

`/workflow`는 현재 역할·경로, `actualModel`의 provider/model/effort, 역할 설정인 `expected`, 지침·스킬 경로인 `sources`, Herdr pane 여부와 `herdr_delegate` 가용 상태를 보여준다. 기본 역할은 `lead`다. 실제 모델 표시는 현재 세션 설정이며 서버의 모델 호출 성공을 증명하지는 않는다.

프로젝트 기본값은 Astra/high다. CLI 인자나 복원한 세션의 선택이 다를 수 있으며 **확장은 현재 모델을 자동 변경하지 않는다. 현재 provider·model·effort가 역할 기준과 다르면 모델 요청을 차단한다.** `/workflow`에서 차이를 확인하고 `/model`, `/thinking` 또는 기존 `pi-lead` 실행 설정을 기준에 맞춘다. 역할 기준을 의도적으로 바꾸려면 `.workflow/roles.json`과 Pi 설정·실행 인자를 함께 변경한다. 지침 누락·역할 충돌도 오류로 보고한다.

작업 전에 지침 로딩만 점검하려면 다음처럼 요청한다.

~~~text
/lead .workflow/briefs/load-check.md를 읽고 지침 로딩을 점검해.
현재 역할과 실제로 읽은 Paperthin 지침을 구분해서 알려줘.
코드 수정이나 작업 위임은 하지 마.
~~~

## 예제 앱

~~~bash
node src/cli.js add "지침 자동 로드 확인"
node src/cli.js list
node src/cli.js done 1
~~~

Node.js 22 이상을 사용하며 외부 npm 의존성이 없어 `npm install`은 필요 없다. 데이터는 Git에서 제외한 `.data/tasks.json`에 저장하고 `--file JSON_PATH`로 다른 파일을 지정한다. 여러 작업자가 같은 데이터 파일을 동시에 수정하는 기능은 없으므로 작업자별 파일이나 worktree를 사용한다.

추가·목록·완료 처리는 구현되어 있다. `delete <id>`는 Worker에게 맡길 실습 과제로 남겨 두었다.

## 지침과 모델이 연결되는 방식

| 파일·구성 | 담당 |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md` | 공통 지침. Claude는 `@AGENTS.md`로 참조 |
| `.workflow/roles/*.md` | 역할별 책임과 행동 범위 |
| `.workflow/roles.json` | 런타임·provider·모델·effort |
| `.workflow/briefs/*.md` | 개별 작업과 완료 조건 |
| `.pi/extensions/workflow.ts` | Pi 역할 연결, `/workflow` 상태, `/lead` 요청, 위임 준비·독립 검토 도구 |
| `vendor/paperthin/skills/` | 커밋을 고정한 Paperthin 네 스킬 원본 |
| `.pi/skills`, `.claude/skills`, `.agents/skills` | 같은 스킬 원본을 가리키는 상대 symlink |
| `scripts/agent.mjs` | 확장과 보조 CLI가 공유하는 실행 설정 생성기 |

확장은 Pi의 `before_agent_start`에서 공통·역할 지침을 시스템 프롬프트에 추가한다. Paperthin은 Pi 네이티브 스킬로 제공하므로 `/skill:readchk`처럼 호출하거나 에이전트가 실제 `SKILL.md`를 읽어 적용할 수 있다.

위임 시에는 공통·역할 지침, 스킬 경로, 브리프, 모델·effort가 함께 전달된다. Pi Worker는 `--no-extensions`로 일반 확장 탐색을 끄고 이 프로젝트 확장만 명시적으로 로드하며 `--workflow-role worker`를 받는다. 기존 `pi-herdr`나 worktree 사본 확장을 중복 로드하지 않는다. Claude Reviewer는 공통·역할 지침과 스킬 절대경로를 받고 plan 모드로 실행한다.

기존 `pi-worker` 함수가 모델·effort만 지정한다면 함수만으로 Worker 역할이 선택되지는 않는다. 역할 플래그는 역할 지침을 고르는 값이며 모델을 바꾸지 않는다. 일반 작업에서는 Lead의 `workflow_prepare`를 사용하면 둘을 함께 지정한다. 다른 worktree의 지침을 지우거나 부모 대화를 자동 복사하지 않는다.

| 역할 | 기본 런타임 / 모델 | effort |
| --- | --- | --- |
| `lead` | Pi / `openai-codex` / `gpt-6-astra` | high |
| `worker` | Pi / `openai-codex` / `gpt-5.6-sol` | medium |
| `reviewer` | Claude Code / `claude-opus-5` | high |
| `escalation` | Claude Code / `claude-fable-5-1` | high |
| `codex-worker` | Codex CLI / `gpt-5.6-sol` | medium |

역할 배치는 학습 시작값이다. `modelchk`는 추천하며 실제 설정은 바꾸지 않는다. 인증·모델 오류를 다른 모델이나 API 과금으로 자동 우회하지 않는다. 지침은 파일 권한이나 샌드박스를 대체하지 않는다.

## 삭제 기능 위임 실습

### Lead에게 작업 요청

Herdr 안의 Lead Pi에서 `/workflow`로 상태를 확인한 뒤 다음을 입력한다.

~~~text
/lead .workflow/briefs/add-delete.md를 구현하고 리뷰·테스트까지 진행해줘
~~~

새 작업도 `/lead 할 일 CLI에 검색 기능을 추가하고 테스트해줘`처럼 자연어로 요청할 수 있다. 사용자가 내부 도구 이름을 외우거나 브리프·worktree를 미리 만들 필요는 없다. Lead가 공통·역할 지침에 따라 실제 Git 상태와 기준 SHA를 확인하고, 작업 브리프·담당 파일·별도 Worker worktree를 준비한다. 이미 초기화한 저장소에서 초기 커밋을 다시 만들지 않는다. HEAD가 없는 저장소라면 Lead가 상태를 설명하고 허용된 범위에서만 기준 커밋을 준비한다.

구현 요청에는 Lead의 로컬 worktree 준비, 담당 변경 파일만의 후보 커밋, 리뷰와 사용자 변경을 보존하는 원래 checkout으로의 로컬 통합이 포함되며, 커밋 금지 등 명시한 제한은 우선한다. Lead는 후보 SHA와 검증 근거를 담은 리뷰 브리프로 Reviewer에 위임하고, 필요한 수정·재검토와 최종 검증 후 결과를 보고한다. 계획·읽기 요청은 구현이나 Worker 위임을 뜻하지 않으며, `/lead` 자체가 원격 push·PR 권한을 부여하지는 않는다. `/lead`는 현재 세션을 사용하며 새 Lead pane을 만들거나 모델을 바꾸지 않는다.

### 선택: 도구 연결 이해하기

`workflow_prepare`에 전달하는 예시:

~~~json
{
  "role": "worker",
  "cwd": "/Users/limdongyoung0/Develop/worktrees/pi-paperthin-delete",
  "brief": ".workflow/briefs/add-delete.md",
  "name": "todo-delete-worker"
}
~~~

이 도구는 공유 실행 설정 모듈을 직접 호출해 인자를 준비한다. CLI 하위 프로세스를 실행하거나 pane을 만들지 않는다. 반환된 텍스트는 그대로 `herdr_delegate`에 전달할 JSON이며, 구조화 결과의 `details.spec`에도 같은 인자가 있다. Lead가 기존 `pi-herdr` 도구로 실행하므로 사용자에게 Node 명령을 실행시키는 중간 단계는 필요 없다.

Pi 확장 사이에서 다른 확장의 도구를 직접 호출하는 공개 API에 의존하지 않도록 두 단계를 나눴다. 프로젝트 확장은 역할·브리프 연결을 맡고 기존 `pi-herdr`가 Herdr 제어를 계속 담당한다. 지시를 추가할 때는 브리프 파일을 수정하고 `workflow_prepare`를 다시 호출한다.

`agentArgs`, `cwd`, `prompt`, `onBlocked`를 보존한다. 시간 초과나 사용자 입력 대기 시 기존 pane 상태를 확인하고 Worker를 중복 생성하지 않는다. pane idle과 정상 종료는 품질 승인 근거가 아니다. 긴 작업의 start/send/wait/read 규칙은 `AGENTS.md`에 있다.

## Paperthin 사용

| 스킬 | 적용 조건 |
| --- | --- |
| `readchk` | 길거나 모호한 브리프를 작업 전에 해석 |
| `modelchk` | 작업 배정과 추론 비용 판단에 추천이 필요 |
| `shower` | 결과물이 이전 대화 없이 이해되는지 독립 검토 |
| `re0` | 누적된 문서 중복·오래된 설명을 정리 |

스킬 설명이 보이는 것과 본문을 읽고 적용한 것은 다르다. 적용한 스킬과 실제 결과를 인계에 남긴다. 모든 작업마다 네 스킬을 모두 실행할 필요는 없다.

Lead에게 다음처럼 요청하면 별도의 독립 검토가 실행된다.

~~~text
Paperthin shower 지침을 읽고 README.md를 workflow_cold_read로 검토해.
독립 세션이 어떻게 이해했는지 원래 의도와 비교해서 설명해.
아직 파일은 수정하지 마.
~~~

`workflow_cold_read` 입력은 `{"artifact":"README.md"}`다. Worker 모델의 새 Pi를 최대 120초 실행하며 결과물 내용만 전달한다. 공통·역할 지침, 원래 요청, 자동 context/skills/extensions/prompt templates, 도구를 제외한다. `--no-extensions`로 이 프로젝트 확장도 로드하지 않는다. 독립 세션은 진단을 반환하며 원래 세션이 이를 의도와 비교해야 shower 검토가 완성된다.

## 보조 CLI와 검증 범위

기존 실행기는 디버깅·자동화 호환용으로 유지한다. 평소 시작과 위임에는 위의 Pi 확장을 사용한다.

~~~bash
node scripts/agent.mjs lead --dry-run
node scripts/agent.mjs worker --brief .workflow/briefs/load-check.md --dry-run
node scripts/agent.mjs cold-read --artifact README.md --dry-run
~~~

실제 검증 결과는 [.workflow/verification.md](.workflow/verification.md)에 기록한다. Herdr pane 생성부터 삭제 기능 구현·리뷰·통합까지의 실습은 아직 수행하지 않았다. 설정 준비와 실제 위임 완료를 구분한다.

Paperthin 커밋·체크섬은 `vendor/paperthin/source.json`으로 고정한다. `.agent-runs`의 로컬 검증 기록은 Git에서 제외한다. 전역 설정·인증·기존 플러그인·기존 pane은 변경하지 않는다.

설치·구독·운영 배경은 [RUNBOOK.md](RUNBOOK.md)를 참고한다.
