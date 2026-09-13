# Pi Agent + Herdr + Paperthin 학습·운영 Runbook

갱신일: 2026-09-14 · 대상: macOS, zsh, Homebrew

이 문서는 설치·구독·역할 설계와 운영 규칙을 정리한다. 바로 시작할 때는 [README.md](README.md), 실제 확인 결과는 [.workflow/verification.md](.workflow/verification.md)를 따른다.

## 1. 목표와 구성

작은 기능 하나의 `계획 → 구현 → 리뷰 → 필요한 수정 → 통합 테스트 → 로컬 커밋`을 경험한다. 모델별 역할과 인계가 실제로 작동하는지가 완료 기준이다. 설치나 문서 작성만으로 전체 실습이 완료되지는 않는다.

| 구성 요소 | 담당 |
| --- | --- |
| Pi Agent | 모델 대화, 파일 읽기·수정, 명령 실행 |
| Herdr | 여러 CLI 에이전트의 pane과 상태 관리 |
| Herdr integration | Pi·Claude·Codex의 세션 상태 보고 |
| 기존 `@andrewjacop/pi-herdr` | 에이전트 시작, 프롬프트 전송, 대기·결과 수집 |
| 프로젝트 `workflow.ts` 확장 | 역할·지침·모델 설정 연결, 위임 인자 준비, 독립 검토 |
| Paperthin | 요구사항 해석, 추론 수준 추천, 결과물 검토·문서 정리 |
| 프로젝트 운영 지침 | worktree 소유권, 테스트·리뷰·통합 완료 조건 |

Compound Engineering은 사용하지 않는다. 기존 다른 프로젝트의 설치를 삭제하는 작업은 포함하지 않는다. 앞서 검토한 `pi-herdr-workflow-kit`이나 Paperthin의 전체 반복 루프는 이 예제에 추가하지 않았다.

~~~text
Herdr 안의 Pi / Astra / high
  ├─ workflow_prepare → herdr_delegate → Pi / Sol / medium Worker
  └─ workflow_prepare → herdr_delegate → Claude Code / Opus 5 / high Reviewer

브리프 → 구현·테스트 → 후보 SHA 고정 → 리뷰 → 수정·재검토 → 통합
~~~

프로젝트에는 추가·목록·완료를 제공하는 JSON 할 일 CLI가 있다. 삭제 기능이 첫 위임 과제다. 동시에 코드를 쓰는 작업자는 각각 별도 worktree를 사용한다.

## 2. 현재 환경과 변경 범위

사용자가 이미 설치한 `pi-herdr`, `agents.zsh`, thinking 설정을 재사용한다.

| 항목 | 대화에서 확인한 환경 |
| --- | --- |
| 프로젝트 | `~/Develop/pi-paperthin-orchestration` |
| Pi | 0.85.1, Homebrew 설치 |
| Herdr | 0.9.0, Homebrew 설치 |
| Codex CLI | 0.153.4, Homebrew cask 설치 |
| Claude Code | 2.1.270, 실행 경로 `~/.local/bin/claude` |
| Node.js | 현재 PATH는 mise의 Node 22; Homebrew 설치도 존재 |
| Herdr integrations | Pi·Codex·Claude 연결 설치 |
| Paperthin | 프로젝트에 네 스킬 원본·라이선스·소스 커밋 고정 |
| 역할 설정 | `.workflow/roles.json`; 프로젝트 Pi 기본값 Astra/high |

현재 버전은 실행 시 다시 확인한다. 프로젝트 파일과 로컬 검증 기록만 작성했으며 전역 셸 설정·인증·기존 플러그인·기존 Herdr pane은 변경하지 않았다. 초기 커밋, 실제 Git worktree 기반 삭제 기능 위임, 원격 저장소 생성은 별도 실습이다.

## 3. 설치와 버전 관리

설치는 Homebrew를 우선한다. 현재 머신에서 이미 있는 도구를 재설치하지 않는다.

~~~bash
type -a pi herdr codex claude node npm
brew list --versions pi-coding-agent herdr
brew list --cask --versions codex claude-code
pi --version
herdr --version
claude --version
~~~

새 머신에서 필요한 도구만 설치한다.

~~~bash
brew install pi-coding-agent herdr
brew install --cask codex claude-code
~~~

Claude Code가 다른 방식으로 설치된 현재 머신에서는 실행 경로를 확인한 뒤 brew 전환을 별도 작업으로 진행한다. Homebrew는 업데이트 경로를 통일하지만 임의의 과거 버전 전환이나 모든 의존성 고정을 보장하지는 않는다. [Pi formula](https://formulae.brew.sh/formula/pi-coding-agent), [Herdr 설치](https://herdr.dev/docs/install/), [Claude cask](https://formulae.brew.sh/cask/claude-code)

진행 중 작업을 정리한 뒤 업데이트한다.

~~~bash
brew update
brew upgrade pi-coding-agent herdr
brew upgrade --cask codex
# Claude Code를 brew로 설치한 머신에서만 실행
brew upgrade --cask claude-code
~~~

Pi 본체는 brew, Pi 확장 패키지는 `pi install`로 관리한다. 다음은 미설치 머신의 연결 예시이며 현재 머신에서는 이미 설치되어 있다.

~~~bash
herdr integration install pi
pi install npm:@andrewjacop/pi-herdr
~~~

`npm:`은 패키지 출처이며 Pi 본체를 npm으로 중복 설치한다는 뜻이 아니다. 이 프로젝트 확장은 저장소의 `.pi/extensions/workflow.ts`이므로 별도의 전역 패키지 설치가 필요 없다. [Pi 패키지](https://pi.dev/docs/latest/packages)

## 4. 구독 인증과 과금 경로

사용자가 밝힌 “GPT 20x, Claude 5x”는 대화에서 ChatGPT Pro 20x와 Claude Max 5x로 해석했다. 실제 상품명·접근 권한·한도는 계정에서 확인하며 두 회사의 배수를 같은 단위로 비교하지 않는다.

| 사용 방식 | 이 예제의 선택 |
| --- | --- |
| Pi → ChatGPT Plus/Pro (Codex) 로그인 | Lead와 Pi Worker의 기본 |
| Claude Code → Claude 구독 로그인 | Reviewer의 기본 |
| Pi → Claude 직접 연결 | 사용하지 않음; Pi 문서의 extra usage 과금 확인 필요 |
| API key 인증 | 사용하지 않음; 구독 포함량과 별도의 결제 경로 |

Pi에서는 `/login`에서 `ChatGPT Plus/Pro (Codex)`를 선택하고 기존 로그인은 재사용한다. Codex CLI 로그인 성공은 Pi 인증 성공의 증거가 아니다. Claude Code는 구독 계정의 로그인 상태와 사용량을 확인한다. 키·인증 파일 내용을 출력하지 않는다. [Pi Providers](https://pi.dev/docs/latest/providers), [Claude Code 구독](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)

앞선 조사에서 확인한 Anthropic 공지에 따르면 과금 변경 계획이 중단되어 구독으로 인증한 Agent SDK와 `claude -p`도 구독 한도를 사용한다. 이 내용과 Pi의 Claude 직접 연결을 혼동하지 않는다. 실제 실행 시 공지와 계정 인증·청구 경로를 확인한다. [Agent SDK 구독 안내](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

모델 목록에 보인다는 사실은 호출 성공이나 계정 권한 보장이 아니다. 런타임 실행 인자, 현재 모델·effort, 실제 응답·종료 상태를 함께 확인한다. 인증이나 모델 접근이 실패하면 오류를 보고하고 다른 모델이나 API 과금으로 자동 전환하지 않는다.

## 5. 프로젝트에서 Pi 시작하기

일반 터미널에서 프로젝트로 이동해 Herdr를 시작한다.

~~~bash
cd ~/Develop/pi-paperthin-orchestration
herdr
~~~

Herdr pane에서 같은 프로젝트로 이동하고 `pi` 또는 기존 `pi-lead`를 실행한다. 프로젝트 신뢰·확장 실행 확인이 나타나면 소스를 검토하고 허용한다. 기존 Pi 세션에서는 `/reload`로 변경된 확장을 로드한다.

Pi 입력창에서 `/workflow`를 실행한다. 모델 호출 없이 다음 상태를 확인한다.

- `role`, `cwd`: 현재 역할과 작업 경로.
- `actualModel`: 현재 Pi 세션의 provider·model·effort.
- `expected`: 역할 설정이 요구하는 값.
- `sources`: 공통·역할 지침과 Paperthin 경로.
- `herdr`: Herdr pane 안인지와 `herdr_delegate` 활성 여부.

기본 역할은 Lead다. `before_agent_start`가 공통·역할 지침을 추가하고 `resources_discover`가 Paperthin 네이티브 스킬 경로를 제공한다. 이미 주입된 역할 지침은 중복 추가하지 않는다.

확장은 현재 모델을 자동 변경하지 않는다. **현재 provider·model·effort가 역할 기준과 다르면 모델 요청을 차단한다.** 지침 누락·역할 충돌도 오류로 보고한다. Pi가 사용할 수 없는 기본 모델 대신 다른 모델을 선택하더라도 그 상태로 작업을 계속하지 않는다. `/workflow`에서 차이를 확인하고 `/model`, thinking 설정을 기준에 맞춘다. 역할 기준을 의도적으로 바꾸려면 `.workflow/roles.json`과 Pi 설정·실행 인자를 함께 변경한다.

`/workflow`의 모델 표시는 세션 상태이며 서버의 실제 호출 성공까지 증명하지는 않는다. `load-check.md`를 읽도록 요청해 역할과 실제 SKILL.md 읽기도 별도로 확인한다.

## 6. 역할별 모델과 지침

| 역할 | 런타임·provider | 모델 | effort |
| --- | --- | --- | --- |
| Lead | Pi / `openai-codex` | `gpt-6-astra` | high |
| Worker | Pi / `openai-codex` | `gpt-5.6-sol` | medium |
| Reviewer | Claude Code | `claude-opus-5` | high |
| Escalation, 선택 | Claude Code | `claude-fable-5-1` | high |
| Codex Worker, 선택 | Codex CLI | `gpt-5.6-sol` | medium |

모델 배치는 학습 시작값이며 측정으로 입증한 최적값은 아니다. Fable 접근 권한은 선택적으로 검증한다. Claude 모델·effort 지원과 버전 요구는 [공식 설정 안내](https://code.claude.com/docs/en/model-config)를 따른다.

프로젝트의 `.pi/settings.json`은 Astra/high를 기본값으로 지정한다. 전역의 `packages`, 인증, 다른 모델 설정은 유지한다. 기본값 예시는 다음과 같다.

~~~json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-6-astra",
  "defaultThinkingLevel": "high",
  "modelThinkingLevels": {
    "openai-codex/gpt-6-astra": "high",
    "openai-codex/gpt-5.6-sol": "medium"
  }
}
~~~

부모의 대화나 모델 설정이 자식 pane에 자동 전달된다고 가정하지 않는다. 기존 `agents.zsh` 함수는 모델·effort를 지정하는 데 계속 쓸 수 있지만, 함수만으로 역할 지침·브리프까지 전달되지는 않는다.

`workflow_prepare`는 역할 설정을 읽어 provider·model·effort를 명시한 실행 인자를 만든다. Pi Worker에는 `--workflow-role worker`를 전달하고 일반 확장 탐색을 끈 뒤 프로젝트 확장 하나만 명시적으로 로드한다. Claude Reviewer에는 공통·역할 지침과 스킬 경로를 전달하고 plan 모드를 사용한다. Reviewer는 파일을 쓰지 않으며 Lead가 응답과 리뷰 기준 SHA를 기록한다.

역할 플래그는 역할 지침을 선택한다. 플래그만 바꿔서 모델이 변경되지는 않는다. 생성된 전체 인자를 보존해야 의도한 조합으로 실행된다. [Pi 모델·추론 설정](https://pi.dev/docs/latest/settings)

## 7. 자동 위임과 결과 수집

평소에는 mjs 명령을 직접 실행하지 않고 Pi에 작업을 요청한다. Lead는 다음 순서를 따른다.

1. 실제 worktree 절대경로, 기준 커밋, 파일 소유권, 테스트·완료 조건을 브리프에 정한다.
2. `workflow_prepare`에 `role`, `cwd`, `brief`, 선택적 `name`을 전달한다.
3. 반환 텍스트의 JSON 전체를 기존 `herdr_delegate` 도구에 그대로 전달한다. 구조화 결과의 `details.spec`에도 같은 인자가 있다.
4. Worker 결과, 변경 diff, 실제 테스트 근거를 확인하고 리뷰 후보를 고정한다.
5. 실제 base/candidate SHA와 테스트 근거를 담은 리뷰 브리프를 만든 뒤 같은 방식으로 Reviewer에 위임한다.
6. 수정·재검토 후 통합한 상태에서 테스트하고 승인된 범위의 커밋과 인계 기록을 남긴다.

`workflow_prepare`는 공통 실행 설정 함수를 직접 호출하며 CLI 하위 프로세스나 Herdr pane을 만들지 않는다. 프로젝트 확장이 역할·브리프 연결을 맡고 기존 `pi-herdr`가 실행·대기·결과 회수를 맡는다. 다른 확장의 도구를 직접 호출하는 비공개 API나 중복 Herdr 제어를 추가하지 않는다.

`agentArgs`, `cwd`, `prompt`, `onBlocked`를 생략하거나 재작성하지 않는다. 추가 지시가 필요하면 브리프를 수정하고 `workflow_prepare`를 다시 실행한다. 긴 작업은 `AGENTS.md`의 start/send/wait/read 절차를 따른다. timeout이면 기존 pane을 확인하고 중복 Worker를 생성하지 않는다.

pane의 idle 표시, 프로세스 정상 종료, 모델의 완료 선언은 품질 승인 근거가 아니다. 테스트 결과와 검토 범위가 있어야 한다. 리뷰는 고정한 SHA와 tracked·staged·untracked 상태를 함께 확인한다. 리뷰 도중 후보를 바꾸지 않으며 수정 후에는 다시 검증한다.

첫 실습의 기준 커밋·worktree 명령과 복사 가능한 작업 요청은 [README.md](README.md)에 있다. Worker 브리프는 기본적으로 커밋을 허용하지 않는다. README의 실습 요청은 Lead에게 해당 기능의 로컬 커밋과 cherry-pick을 허용하며 원격 push·PR 생성은 포함하지 않는다.

## 8. Paperthin 적용

| 스킬 | 적용 시점 | 역할 |
| --- | --- | --- |
| `readchk` | 복합·모호한 브리프를 받았을 때 | 해석 누락과 실제 모호함 확인 |
| `modelchk` | 작업 배정·추론 비용 판단이 필요할 때 | 모델 등급·추론 강도 추천 |
| `shower` | 이전 대화 없이 인계물을 검토할 때 | 독립 해석과 원래 의도 비교 |
| `re0` | 문서 중복·오래된 설명이 쌓였을 때 | 문서를 현재 상태로 정리 |

원본은 `vendor/paperthin/skills/`, 소스 커밋·체크섬은 `vendor/paperthin/source.json`에 있다. Pi·Claude·Codex용 스킬 경로는 같은 원본을 가리킨다. 업데이트할 때 원문·라이선스·manifest를 함께 검토한다.

Pi에서는 `/skill:readchk`처럼 네이티브 스킬을 호출하거나 모델에게 실제 SKILL.md를 읽도록 요청한다. 설명이 보이는 것과 본문을 읽고 적용한 것을 구분한다. 네 스킬을 매번 의무 실행하지 않는다.

`modelchk`는 추천하며 모델을 자동 라우팅하지 않는다. 필요하면 Lead가 역할 기준 변경을 검토한다. `hate`, `re0-memo`는 후속 후보이며 현재 설치한 네 스킬에는 없다. `sip`, `re0-loop`, `re0-work`도 첫 사이클 검증 전에는 추가하지 않는다. [Paperthin](https://github.com/LilMGenius/paperthin), [modelchk](https://github.com/LilMGenius/paperthin/blob/main/skills/depth/modelchk/SKILL.md)

shower는 원래 요청을 아는 Reviewer의 코드 리뷰와 구분한다. Lead가 shower 지침을 읽고 `workflow_cold_read`에 결과물 파일 경로만 전달한다.

~~~json
{"artifact": "README.md"}
~~~

최대 120초의 새로운 Pi 호출에 결과물 내용만 전달한다. 자동 context·skills·extensions·prompt templates·도구·세션 저장을 제외하며 `--no-extensions`로 프로젝트 확장도 실행하지 않는다. 실패나 timeout을 다른 모델로 자동 재시도하지 않는다. 독립 해석이 돌아오면 원래 세션이 의도와 비교하고 필요한 수정을 판단한다.

## 9. 시작·종료와 문제 해결

시작할 때 프로젝트 경로, Git 상태, `/workflow`의 actual/expected 값, Herdr 연결을 확인한다. 종료할 때 인계에 다음을 남긴다.

~~~text
Task:
Worktree / branch / base SHA / candidate SHA:
Changed files:
Behavior changed:
Commands and verification results:
Review result and known gaps:
Commit(s), if created:
Next action:
~~~

검증 기록은 Git에서 제외한 `.agent-runs`에 둘 수 있다. 토큰·인증 파일·전체 환경변수·세션 전체를 복사하지 않는다. Herdr에서 분리하는 것과 작업 프로세스를 종료하는 것을 구분하며 다른 pane을 포함한 서버 종료는 범위를 확인한다.

| 증상 | 확인·조치 |
| --- | --- |
| `/workflow`가 없음 | 프로젝트 cwd, 확장 파일, 신뢰 허용, 확장 로드 오류 확인 후 `/reload` |
| `workflow-error`로 요청 중단 | actual/expected model·provider·effort와 역할 지침을 맞추고 재요청 |
| `herdr_delegate`가 없음 | 기존 pi-herdr 설치·활성 상태 확인 후 Lead Pi 재시작 또는 `/reload` |
| Herdr pane 밖 | Herdr를 터미널에서 시작하고 그 안의 pane에서 Lead Pi 실행 |
| Worker pane이 바로 종료 | pane PATH, Node·Pi 실행 경로, 모델·인증 오류 확인 |
| Worker에 Lead 지침이 보임 | 생성한 `agentArgs`와 역할 플래그를 생략했는지 확인 |
| 스킬 설명만 알고 있음 | 전달된 실제 SKILL.md를 읽도록 요청; load-check로 구분 |
| 리뷰 대상이 불명확 | 실제 기준·후보 SHA, staged·untracked 상태를 브리프에 기록 |
| 위임 timeout | 기존 pane 결과를 읽고 중복 작업자를 만들지 않음 |
| 예상 밖 과금 경로 | 키 값을 출력하지 말고 인증 방식과 계정 사용량 화면 확인 |

## 10. 검증과 보조 CLI

현재 검증 결과와 미검증 범위는 [.workflow/verification.md](.workflow/verification.md)를 따른다. Herdr 밖에서 사용 중인 pane을 조작하지 않았으므로 pane 생성부터 실제 기능 통합까지의 E2E는 아직 수행하지 않았다.

기존 CLI는 자동화 호환성과 디버깅용으로 유지한다. 확장은 이 CLI 프로세스를 호출해 위임을 준비하는 것이 아니라 같은 내부 함수를 직접 재사용한다.

~~~bash
node scripts/agent.mjs lead --dry-run
node scripts/agent.mjs worker --brief .workflow/briefs/load-check.md --herdr-spec
node scripts/agent.mjs cold-read --artifact README.md --dry-run
~~~

학습 완료는 역할별 지침·모델·effort 확인, 실제 스킬 읽기, 별도 worktree 구현, 고정 후보 리뷰, 통합 테스트, 승인된 로컬 커밋을 한 번 마친 상태다.

## 참고

설치·인증·모델 지원은 바뀔 수 있으므로 실제 설치 버전과 계정 상태를 함께 확인한다.

- [Pi 소개](https://pi.dev/)
- [Pi 확장 API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Herdr integrations](https://herdr.dev/docs/integrations/)
- [Herdr 시작](https://herdr.dev/docs/quick-start/)
- [pi-herdr](https://github.com/AndrewJacop/pi-herdr)
- [Claude 모델·effort](https://code.claude.com/docs/en/model-config)
