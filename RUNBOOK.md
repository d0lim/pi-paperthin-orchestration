# Pi + Herdr + Paperthin 운영 Runbook

갱신일: 2026-09-15 · macOS, zsh, Homebrew 기준

빠른 시작은 [README](README.md), profile·큐·스킬의 상세 계약은 [orchestration.md](docs/orchestration.md)를 따른다. 이 문서는 현재 프로젝트에서 설치·인증·작업·문제 해결을 수행하는 순서다.

## 1. 운영 원칙

사용자는 프로젝트에서 `pi`를 열고 `/lead <요청>`으로 시작한다. Lead 한 명이 계획·위임·리뷰·통합을 소유한다. 자식은 화면 없는 독립 프로세스로 실행하고 재위임하지 않는다. Paperthin은 전체 28개 catalog에서 필요한 절차를 선택한다. Compound Engineering은 사용하지 않는다.

scheduler는 큐·프로세스 한도·소유한 작업의 취소를 관리한다. 계획·코드 리뷰 승인과 Paperthin 순서는 Lead가 지침에 따라 판단한다. 프로세스 정상 종료를 품질 승인으로 취급하지 않는다. 패키지 예제 앱을 먼저 구현하거나 프로젝트마다 역할 파일을 복사할 필요는 없다.

## 2. 설치와 업데이트

CLI 본체는 Homebrew를 우선한다. 현재 설치와 `agents.zsh`·thinking 설정을 확인하고 필요한 도구만 설치한다.

~~~bash
type -a pi herdr codex claude node npm
pi --version
herdr --version
claude --version
~~~

새 머신의 설치 예시다. Herdr는 화면 정리, Codex CLI는 선택 구현 profile에 사용한다. 기본 headless 실행에는 Pi와 Claude Code를 준비한다.

~~~bash
brew install pi-coding-agent herdr
brew install --cask codex claude-code
pi install git:github.com/d0lim/pi-paperthin-orchestration
~~~

Claude Code가 다른 경로에 있다면 실제 실행 경로를 확인한다. Homebrew는 설치·업데이트 경로를 통일하지만 임의의 과거 버전 전환이나 전체 의존성 고정을 보장하지 않는다. [Pi formula](https://formulae.brew.sh/formula/pi-coding-agent), [Herdr 설치](https://herdr.dev/docs/install/), [Claude cask](https://formulae.brew.sh/cask/claude-code)

기존 pane 위임 호환 경로를 쓸 때만 pi-herdr가 필요하다. 이미 설치돼 있으면 재사용한다.

~~~bash
pi install npm:@andrewjacop/pi-herdr
herdr integration install pi
~~~

기본 headless 자식은 pi-herdr를 호출하지 않는다. 패키지 manifest가 확장과 pinned Paperthin 스킬을 등록한다. 기존 인증·셸 함수·전역 모델 설정을 덮어쓰지 않는다. [Pi 패키지](https://pi.dev/docs/latest/packages)

진행 중인 자식 작업을 먼저 마치거나 취소한 뒤 업데이트한다. 새 Pi를 열거나 `/reload`하며 재시작이 실행 중 작업을 자동 이어받는다고 가정하지 않는다.

~~~bash
brew update
brew upgrade pi-coding-agent herdr
pi update git:github.com/d0lim/pi-paperthin-orchestration
~~~

## 3. 구독 인증

사용자가 밝힌 “GPT 20x, Claude 5x”는 이 구성에서 ChatGPT Pro 20x와 Claude Max 5x로 해석했다. 계정의 정확한 상품명·모델 권한·한도를 확인하며 두 회사의 배수를 같은 단위로 비교하지 않는다.

| 경로 | 용도 |
| --- | --- |
| Pi → ChatGPT Plus/Pro (Codex) 구독 로그인 | Lead·Sol Worker·기본 독립 읽기 |
| Claude Code → Claude 구독 로그인 | Opus Reviewer·선택 Fable |
| Codex CLI → ChatGPT 로그인 | 선택 codex 구현 profile |
| API key | 실패 시 자동 대체하지 않음 |

Pi의 `/login`에서 `ChatGPT Plus/Pro (Codex)`를 선택하고 기존 로그인이 있으면 재사용한다. Codex CLI 로그인과 Pi 로그인은 각각 확인한다. Claude Code도 구독 계정으로 로그인한다. 인증 파일·키·토큰을 출력하거나 인계하지 않는다. [Pi Providers](https://pi.dev/docs/latest/providers), [Claude Code 구독](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)

**Fable headless 실행은 기본 차단한다.** Claude Code 공식 문서에 따르면 계정 조건에 따라 Fable은 포함 한도 대신 usage credits를 사용하며, `-p`·Agent SDK에서는 해당 청구의 확인 질문 없이 실행한다. `routing.allowFableHeadless: true`는 그 비용까지 허용하는 설정이다. 포함 구독 사용을 보장하는 값이 아니다. 사용자의 허용 없이 이를 켜거나 Fable로 시험 호출하지 않는다. [Fable와 usage credits](https://code.claude.com/docs/en/model-config#fable-and-usage-credits)

모델 목록 표시는 접근 권한·호출 성공·청구 경로의 증거가 아니다. 요청 모델과 실제 런타임 응답을 함께 확인한다. 인증·접근 실패를 다른 모델이나 API 결제로 우회하지 않는다. CLI 내부의 모델 대체가 관찰되면 지정 모델의 성공으로 기록하지 않는다.

## 4. 프로젝트와 화면 준비

기본 실행은 대상 프로젝트에서 `pi`를 열면 된다. Herdr를 사용한다면 프로젝트 workspace의 Lead tab에서 같은 경로로 이동해 실행한다.

~~~text
/lead 현재 요청의 계획을 세우고 구현·리뷰·테스트까지 진행해줘
/workflow
/workflow jobs
/workflow skills
~~~

`/workflow`는 활성 역할·현재 모델·기대 설정·개인/프로젝트 설정과 실행 환경을, `/workflow jobs`는 자식 상태를, `/workflow skills`는 catalog를 보여준다. 활성화 전 `active: false`는 정상이다. `/workflow off`는 자식이 모두 끝나거나 `/workflow cancel <id>`로 취소된 뒤 일반 Pi 사용으로 돌아간다.

`pi list`와 `/lead --help`로 설치·명령 로드를 확인한다. 기본 자식 위임은 Herdr pane 존재나 `herdr_delegate`에 의존하지 않는다. 프로젝트 신뢰 확인과 기존 `AGENTS.md`를 존중하며 `/trust` 후에는 Pi를 재시작한다.

대부분의 자식에는 tab·pane을 만들지 않는다. 터미널 입력이나 장기 직접 상호작용이 필요할 때만 별도 task tab을 사용한다. 이 패키지는 task tab 자동 생성·기존 job 이전 어댑터를 제공하지 않는다. 수동 UI와 native CLI의 범위는 [Herdr 화면](docs/orchestration.md#herdr-화면과-호환-경로)을 따른다.

## 5. 역할·routing·thinking

Lead는 Pi/Astra high를 유지한다. 일반 구현은 `sol`, 일반 검토·조사는 `opus`, frontier 판단은 `fable` profile로 매핑한다. `codex`는 선택 구현 profile이다. Fable은 실행 허용 정책이 먼저 충족되어야 한다.

`modelchk`의 중립 여섯 필드와 실행 profile·모델·effort를 따로 기록한다. `routing.mode`의 adaptive/fixed, 작업별 pins와 명시 profile·effort가 실제 실행 선택을 정한다. 사용자 pin이 자동 추천보다 우선한다. 정확한 JSON과 effort 매핑은 [실행 설정](docs/orchestration.md#실행-설정), 모델 ID는 [roles.json](config/roles.json)을 따른다.

개인 기본값은 `~/.pi/agent/paperthin.json`, 프로젝트 덮어쓰기는 `.pi/paperthin.json`에서 필요한 필드만 지정한다. Pi·Claude 자체의 전역 모델 기본값이나 설치 디렉터리를 바꾸지 않는다. 기존 셸 함수가 모델만 선택한다고 역할·브리프까지 자동 전달되는 것은 아니다. 기본 자식은 `workflow_spawn`의 실행 정책으로 시작한다.

## 6. 단계별 운영

1. `readchk`로 목표·문맥·실제 Git 상태를 대조하고 해석, 범위, 제외 범위, 완료 조건을 기록한다.
2. 첫 위임 전 `modelchk`를 작성한다. 계획의 필요한 `sip` 검사·정리를 마치고 계획 해시를 고정해 독립 리뷰를 받는다.
3. 담당 파일·worktree·기준 SHA·검증 명령을 담은 첫 실질 Worker 브리프를 `shower`로 독립 읽힌 뒤 수정해 전달한다.
4. `workflow_spawn`으로 implement/review/analyze 작업을 제출한다. 반환한 job ID로 `workflow_jobs`의 get/wait를 사용해 결과를 회수한다. 한 번의 wait는 최대 10초다.
5. 실제 diff·테스트·Paperthin 근거를 확인한다. 문서·인계의 필요한 독립 읽기와 수정을 마친 뒤 코드 후보 SHA를 고정하고 독립 코드 리뷰를 받는다.
6. 필요한 수정·검증·재리뷰 후 허용된 변경만 통합한다. 실사용 표면의 증거를 확인하고 `re0-memo`로 다음 단계가 피해야 할 실패 유형을 기록한다.
7. 남은 단계를 이어간다. 새 외부 증거 없이 내부 검토만 반복하지 않는다. 재개에는 `catchup`, 다음 한 행동이 불명확하면 `nba`를 사용한다.

계획/후보를 고정하거나 승인받은 뒤 수정하면 새 해시로 영향받는 리뷰를 다시 받는다. 일반 analyze는 코드 후보가 없어도 확인한 live state와 시점을 밝히며 수행할 수 있다. Reviewer는 읽기 전용이며 구현이 필요하면 Lead가 구현 profile로 별도 배정한다.

동시 작성자는 별도 worktree를 쓴다. 자식은 재위임하거나 다른 작업을 통합하지 않는다. 작업당 기본 15분, 실행 2개·대기 8개 한도를 넘겨 무한 fan-out하지 않는다. 실패·취소·timeout 뒤에는 원래 작업의 로그와 부분 변경을 확인하고 재시도한다.

## 7. Paperthin와 증거 보존

전체 catalog와 역할별 로딩·user-only 12개는 [스킬 선택](docs/orchestration.md#스킬-선택)을 따른다. Lead는 기본 5개 본문을 받고 작업에 맞는 추가 스킬만 선택한다. `sip`는 완료 시 검사 선택자이며 모든 28개를 무조건 실행하는 루프가 아니다.

`shower`의 `workflow_cold_read`도 같은 큐에 job을 제출한다. 반환된 job ID·`artifactSha256`를 보존하고 `workflow_jobs get/wait`로 독립 해석을 회수한다. 중립 lens를 줄 수 있지만 원래 의도·선호 답안을 넘기지 않는다. 같은 내용의 검토는 재사용하고 의미 변경 때 재검토한다.

계획·브리프·리뷰는 `.agent-runs/<작업 식별자>/`, 실행 결과는 `.agent-runs/jobs/<session>/<job>/`에 남는다. 스킬·대상·해시·적용 내용·실제 근거와 미적용·실패 이유를 기록한다. 원문 주입, 프로세스 종료, 스킬 완료 문구를 실제 적용의 증거로 대신하지 않는다.

`re0-memo`는 실패와 재사용 가능한 사실을 로컬 기록에 남기며 제품 문서에 작업 일지를 붙이지 않는다. `re0-loop`·`re0-work`도 현재 Lead의 하나인 반복 안에서만 사용한다. `re0-plan`·`re0-upgrade`·`re0-release`·`re0-merge`는 upstream 유지보수 관례이므로 일반 프로젝트에 그대로 적용하지 않는다.

## 8. 문제 해결과 검증

| 증상 | 확인·조치 |
| --- | --- |
| /lead 또는 /workflow 없음 | `pi list`·확장 로드 오류 확인 후 새 Pi 또는 `/reload` |
| Lead 활성화 실패 | 정확한 모델의 인증·접근 가능 여부·프로젝트 신뢰·역할 설정 확인 |
| Fable 작업 차단 | 사용자의 비용 허용과 `routing.allowFableHeadless` 확인, 임의 우회 금지 |
| 자식 queued | 동시 실행 한도와 기존 job 확인, 같은 작업 중복 제출 금지 |
| 자식 failed/timed out/cancelled | 반환한 job 경로의 stderr·stdout·부분 파일 상태 확인 |
| completed지만 결과가 불충분 | 대상 해시·diff·실제 검증 근거를 확인하고 필요한 수정·재검토 |
| 추가 터미널 입력 필요 | headless로 답을 추측하지 말고 필요한 상호작용을 보고, 별도 task tab 수동 운영 |
| pane 호환 실행이 잘못 배치됨 | pi-herdr 0.5의 현재 pane 분할 제약 확인, tabId 격리로 가정하지 않음 |
| 스킬 적용을 알 수 없음 | catalog·선택 본문과 실제 해석·외부 출처·독립 응답·해시를 구분 |

현재 검증 범위는 [verification.md](docs/verification.md)에 기록한다. 모의 테스트, 실제 headless 모델 호출, Herdr 화면 조작, 전체 프로젝트 실행을 구분한다. 이전 예제나 정상 종료를 새 흐름의 전체 검증 결과로 재사용하지 않는다.
