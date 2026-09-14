# Pi + Herdr + Paperthin 운영 Runbook

갱신일: 2026-09-14 · macOS, zsh, Homebrew 기준

이 저장소는 여러 프로젝트에서 재사용하는 Pi orchestration 패키지다. 설치와 빠른 사용은 [README.md](README.md), 참조 워크플로우와 구현 범위는 [reference-workflow.md](docs/reference-workflow.md)를 따른다.

## 1. 운영 원칙

사용자는 작업할 프로젝트에서 `pi`를 실행하고 `/lead <요청>`으로 역할 분담을 시작한다. 패키지 설치와 대상 프로젝트의 개발을 구분한다. 패키지 저장소의 예제 앱을 먼저 구현하거나 프로젝트마다 역할 파일을 복사할 필요는 없다.

Lead는 계획과 조율, Worker는 할당 단계 구현, Reviewer는 계획·코드 검토를 맡는다. Paperthin은 요청 해석, 위임 전 작업 규모 판단, 브리프·인계의 독립 검토와 문서 정리에 적용한다. Compound Engineering은 사용하지 않는다. Herdr pane·진행·결과 수집은 이미 설치한 `pi-herdr`를 재사용한다.

순서는 Lead가 지침에 따라 진행한다. 현재 확장은 역할·모델·지침 전달 도구이며, 모든 승인과 단계 전이를 코드로 강제하는 워크플로우 엔진은 아니다. 이 차이를 실제 작업의 검증 기준에 반영한다.

## 2. 설치와 업데이트

CLI 본체는 Homebrew를 우선한다. 현재 머신에 이미 있는 Pi·Herdr·Codex와 기존 `agents.zsh`를 재사용하며 중복 설치하지 않는다.

~~~bash
type -a pi herdr codex claude node npm
pi --version
herdr --version
claude --version
~~~

새 머신에서 필요한 도구만 설치한다.

~~~bash
brew install pi-coding-agent herdr
brew install --cask codex claude-code
~~~

Claude Code가 다른 경로에 설치되어 있다면 실제 실행 경로를 확인하고 brew 전환은 별도 작업으로 진행한다. Homebrew는 설치·업데이트 경로를 통일하며 임의의 과거 버전 전환이나 전체 의존성 고정을 보장하지 않는다. [Pi formula](https://formulae.brew.sh/formula/pi-coding-agent), [Herdr 설치](https://herdr.dev/docs/install/), [Claude cask](https://formulae.brew.sh/cask/claude-code)

Pi 확장은 Pi 패키지 관리로 설치한다.

~~~bash
pi install git:github.com/d0lim/pi-paperthin-orchestration
~~~

`pi-herdr`와 integration이 없는 머신에서만 설치한다.

~~~bash
pi install npm:@andrewjacop/pi-herdr
herdr integration install pi
~~~

패키지 manifest가 확장과 Paperthin 스킬을 등록한다. `npm:`이나 `git:`은 패키지 출처이며 Pi 본체를 중복 설치한다는 뜻이 아니다. 전역 패키지 등록 외에 기존 인증·셸 함수·모델별 thinking 설정을 덮어쓰지 않는다. [Pi 패키지](https://pi.dev/docs/latest/packages)

진행 중 작업을 정리한 뒤 업데이트하고 새 Pi를 열거나 `/reload`한다.

~~~bash
brew update
brew upgrade pi-coding-agent herdr
pi update git:github.com/d0lim/pi-paperthin-orchestration
~~~

## 3. 구독 인증

사용자가 밝힌 “GPT 20x, Claude 5x”는 대화에서 ChatGPT Pro 20x와 Claude Max 5x로 해석했다. 정확한 상품명·모델 권한·한도는 계정에서 확인하며 두 회사의 배수를 같은 단위로 비교하지 않는다.

| 경로 | 기본 구성 |
| --- | --- |
| Pi → ChatGPT Plus/Pro (Codex) 구독 로그인 | Lead·Pi Worker |
| Claude Code → Claude 구독 로그인 | Reviewer |
| Pi → Claude 직접 연결 | 사용하지 않음 |
| API key 인증 | 자동 대체 경로로 사용하지 않음 |

Pi의 `/login`에서 `ChatGPT Plus/Pro (Codex)`를 선택한다. 기존 로그인이 있으면 재사용한다. Codex CLI 로그인 성공과 Pi 로그인 성공은 각각 확인한다. Claude Code는 구독 계정으로 로그인하고 실제 사용량 화면을 확인한다. 인증 파일·키·토큰 내용을 출력하거나 동기화하지 않는다. [Pi Providers](https://pi.dev/docs/latest/providers), [Claude Code 구독](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)

앞선 조사에서 확인한 Anthropic 공지에 따르면 구독으로 인증한 Agent SDK와 `claude -p`는 구독 한도를 사용한다. Pi의 Claude 직접 연결에 대한 extra usage 설명과 혼동하지 않는다. 실행 시 최신 공지와 실제 계정의 인증·청구 경로를 확인한다. [Agent SDK 구독 안내](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

모델 목록 표시는 접근 권한이나 호출 성공 보장이 아니다. 요청한 설정과 런타임 표시, 실제 응답·종료 상태를 함께 확인한다. 오류가 나면 다른 모델이나 API 과금으로 자동 전환하지 않는다.

## 4. 대상 프로젝트에서 활성화

작업할 저장소의 터미널에서 `herdr`를 열고 그 안의 pane에서 같은 저장소로 이동해 `pi`를 실행한다. 기존 `pi-lead` 함수도 사용할 수 있지만 패키지가 전역 설치되어 있으므로 특정 시작 함수는 필수가 아니다.

~~~text
/workflow
/lead 현재 요청의 계획을 세우고 구현·리뷰·테스트까지 진행해줘
~~~

일반 Pi에서는 정책이 비활성 상태다. `/lead` 또는 명시적 `--workflow-role`이 역할 정책을 활성화한다. `/lead`는 인증된 모델 설정에서 정확한 Lead 모델과 effort를 선택하며 실패 시 요청을 중단한다.

`/workflow`는 활성 여부, 역할, 실제 모델·effort, 기대 설정, 프로젝트 설정 경로와 Herdr 연결 상태를 보여준다. 이 상태 조회는 모델 호출을 하지 않는다. `/workflow off`는 정책과 역할 검사를 비활성화한다.

프로젝트의 신뢰 확인과 로컬 `AGENTS.md` 등 지침을 존중한다. 작업 디렉터리는 대상 프로젝트이며 패키지 설치 디렉터리와 다르다. 부모 대화가 Worker에게 자동 복사된다고 가정하지 않는다.

## 5. 역할 설정과 thinking

| 역할 | 런타임·provider·모델 | effort |
| --- | --- | --- |
| Lead | Pi / openai-codex / gpt-6-astra | high |
| Worker | Pi / openai-codex / gpt-5.6-sol | medium |
| Reviewer | Claude Code / claude-opus-5 | high |
| Escalation, 선택 | Claude Code / claude-fable-5-1 | high |
| Codex Worker, 선택 | Codex CLI / gpt-5.6-sol | medium |

배치는 학습 시작값이며 성능 측정으로 확정한 최적값은 아니다. 지원 모델과 effort, 선택 역할의 계정 권한은 해당 런타임에서 확인한다. [Pi 설정](https://pi.dev/docs/latest/settings), [Claude 모델 설정](https://code.claude.com/docs/en/model-config)

패키지 기본값은 `config/roles.json`, 프로젝트별 덮어쓰기는 대상 저장소의 `.pi/paperthin.json`에 둔다. 필요한 필드만 지정한다.

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

활성 역할의 현재 provider·model·effort가 역할 기준과 다르면 입력 단계에서 요청을 차단한다. 기준을 바꿀 때는 프로젝트 설정에 명시한다. `modelchk`는 추천만 하며 실행 설정을 바꾸지 않는다.

기존 셸 함수와 전역 thinking 설정은 보존한다. 함수가 모델·effort만 지정해도 역할·브리프가 자동 전달되는 것은 아니다. Worker는 `workflow_prepare`가 만든 실행 인자로 해당 역할·모델·effort를 함께 받는다.

## 6. 단계별 운영

1. Lead가 `readchk`로 요청을 해석해 `understood as: ...`를 기록하고, 대상 저장소의 지침·Git 상태를 읽어 요구사항·제외 범위·완료 조건을 정의한다.
2. Lead가 첫 위임 전 `modelchk` 추천을 기록한다. 전체 계획은 필요한 `re0` 정리를 마친 뒤 파일 해시를 고정해 Reviewer의 검토를 받는다.
3. Lead가 한 단계의 브리프에 실제 worktree·기준 커밋·담당 파일·테스트를 명시한다. 첫 실질 Worker 브리프는 `shower` 독립 해석과 의도를 비교해 보완한 뒤 전달한다.
4. Worker가 `readchk`로 브리프를 해석하고 해당 범위를 구현해 실제 테스트 결과와 변경 파일을 반환한다. 문서를 반복 수정하거나 연관 문서를 맞출 때는 `re0`를 적용한다.
5. Lead가 최종 사용자용 문서·인계 산출물의 `shower` 검토와 수정을 마친 뒤 후보를 고정한다. Reviewer는 실제 base/candidate SHA와 tracked·staged·untracked 상태를 확인해 검토한다.
6. 필요한 수정·테스트·재검토 후 Lead가 허용된 범위의 로컬 커밋·통합을 진행한다.
7. 남은 단계를 반복하고 완료 내용·검증·제약과 Paperthin 적용 근거를 기록한다.

산출물은 필요한 `re0` 정리 → 해당하는 `shower` 검토·수정 → 계획 또는 후보 해시 고정 → Reviewer 검토 순서로 준비한다. 해시를 고정하거나 승인받은 뒤 내용을 수정하면 새 해시로 영향받는 리뷰를 다시 받는다. 브리프 정정이 승인된 계획의 범위를 바꾸는 경우에는 계획 리뷰도 갱신한다.

동시에 코드를 쓰는 작업자는 별도 worktree를 사용한다. Worker는 다른 작업자의 변경을 되돌리거나 Lead 브랜치에 직접 통합하지 않는다. Reviewer는 plan 모드에서 텍스트로 결과를 반환하며 Lead가 기록한다.

기존 사용자 변경을 작업 커밋에 섞지 않는다. 리뷰 중 후보를 바꾸지 않으며 수정 후 필요한 테스트와 재검토를 수행한다. pane idle, 완료 마커, 정상 종료만으로 품질을 승인하지 않는다. 커밋 금지 등 사용자의 제한을 우선하며 원격 push·PR 생성은 해당 권한이 필요하다.

Lead는 `workflow_prepare`가 반환한 JSON을 기존 `herdr_delegate`로 전달한다. `agentArgs`, `cwd`, `prompt`, `onBlocked`를 보존한다. 이 연결에 확장 간 비공개 도구 호출이나 중복 Herdr 제어를 추가하지 않는다. timeout이면 기존 pane을 확인하고 Worker를 중복 생성하지 않는다.

## 7. Paperthin 적용 기준

활성 역할의 시스템 정책에는 필요한 SKILL.md 원문 전체가 포함된다. Lead는 네 스킬 모두, Worker·Codex Worker는 `readchk`와 `re0`, Reviewer·Escalation은 `readchk`를 받는다. 나머지 스킬은 전달된 경로로 읽을 수 있다. 원본과 라이선스는 [vendor/paperthin/](vendor/paperthin/), 소스 커밋·체크섬은 [source.json](vendor/paperthin/source.json)에 있다.

| 스킬 | 적용·기록 기준 |
| --- | --- |
| [readchk](vendor/paperthin/skills/readchk/SKILL.md) | 각 역할이 실질 작업 전에 문맥과 대조해 해석한다. 기존 작업 기록·응답에 `understood as: ...` 한 줄을 남기고, 문맥으로 해결된 해석은 재확인 질문 없이 진행한다. |
| [modelchk](vendor/paperthin/skills/modelchk/SKILL.md) | Lead가 첫 위임 전, 범위·위험·실패 양상이 달라질 때 평가한다. 중립 tier·effort 추천과 실제 모델·effort 설정을 구분한다. 자동 전환하지 않는다. |
| [shower](vendor/paperthin/skills/shower/SKILL.md) | Lead가 첫 실질 Worker 브리프와 최종 사용자용 문서·인계 산출물을 독립 검토한다. 동일 내용의 검토는 해시로 재사용하고 의미 변경 때 재검토한다. 매 브리프를 무조건 호출하지 않는다. |
| [re0](vendor/paperthin/skills/re0/SKILL.md) | 문서 작성자가 반복 수정·연관 문서 동기화 때 대상과 관련 문서를 끝까지 읽고 기존 섹션을 정리한다. Reviewer는 문제를 보고하며 파일을 수정하지 않는다. |

`modelchk` 기록은 원본의 여섯 필드를 유지한다. `recommended_tier`는 `fast|standard|frontier`, `recommended_effort`는 `glance|measured|thorough|exhaustive` 중 하나다. `rationale`에 두 추천의 이유, `move_up_if`·`move_down_if`에 각 축을 조정할 조건, `proof_surface`에 설정과 무관하게 필요한 검증을 적는다. 기존 역할 설정과 차이가 있으면 기록하고 사용자가 지정한 모델·effort를 유지한다.

`shower`에서 Lead는 산출물의 목적과 독자를 한 줄로 따로 기록하고, `workflow_cold_read`에 파일 경로를 전달한다. 도구는 실제 파일 내용만 독립 Pi 호출에 보내며 부모 의도·대화와 도구·확장·자동 지침·스킬·세션 저장을 제외한다. 최대 120초의 호출이 반환한 `artifactSha256`와 독립 해석을 기록하고, Lead가 원래 의도와 비교해 불일치와 수정안을 정리한다. 실패·중단·불완전 응답을 독립 검토 통과로 기록하지 않는다.

Paperthin 기록은 기존 작업 기록·응답에 적용 내용, 근거, 미적용·실패 이유를 함께 남긴다. `re0`는 읽고 수정한 문서와 제거한 중복·오래된 설명을, `shower`는 실제 독립 응답과 읽은 내용의 해시를 근거로 삼는다. 별도 로그 시스템을 만들거나 본문 전달만으로 적용 완료를 선언하지 않는다. 네 스킬의 적용 순서는 역할 지침이며 코드가 강제하는 단계 전이는 아니다. 추가 스킬이나 Paperthin의 다른 전체 루프는 기본 구성에 포함하지 않는다. [Paperthin](https://github.com/LilMGenius/paperthin)

## 8. 문제 해결과 검증

| 증상 | 확인·조치 |
| --- | --- |
| /lead 또는 /workflow가 없음 | `pi list`로 설치 확인, 확장 로드 오류 확인 후 `/reload` |
| 일반 Pi에 역할 정책이 적용됨 | 명시적 역할 플래그 사용 여부 확인, `/workflow off` |
| Lead 활성화 실패 | 정확한 모델의 인증·접근 가능 여부와 역할 설정 확인 |
| 역할 기준과 모델·effort 불일치 | 프로젝트 `.pi/paperthin.json`과 현재 런타임 설정 확인 |
| herdr_delegate 없음 | 기존 pi-herdr 설치·활성 상태와 Lead가 Herdr pane 안인지 확인 |
| 새 pane이 곧 종료됨 | pane의 PATH, 런타임, 인증·모델 오류 확인 |
| Reviewer가 파일을 수정하려 함 | plan 모드와 역할 지침이 생성 인자에 포함됐는지 확인 |
| 위임 timeout | 기존 pane의 상태·출력을 확인하고 중복 생성하지 않음 |
| 스킬 사용 여부를 알 수 없음 | 역할별 본문 전달과 실제 적용을 구분하고, 작업 기록의 해석·추천·독립 응답/해시·문서 변경 근거 확인 |

설치·패키지 로드·모의 도구 테스트와 실제 Herdr pane 생성·결과 회수·프로젝트 구현 검증은 구분한다. 현재 패키지의 변경에 맞는 검증 결과를 기록하며 이전 예제의 테스트 통과를 새 패키지 E2E 통과로 재사용하지 않는다.

선택적인 앱 실습은 `examples/todo-cli`에 있다. 기본 운영은 사용자가 지정한 실제 프로젝트에서 수행한다. 종료 시 작업 경로·기준/후보 SHA·변경 파일·실행 명령·테스트·리뷰 결과·남은 제약을 인계한다.
