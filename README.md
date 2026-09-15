# Pi Paperthin Orchestration

어떤 Git 프로젝트에서도 `/lead <요청>`으로 계획·구현·검토를 진행하는 Pi 확장이다. **Astra가 계획과 조율, Fable이 계획 리뷰, Codex/Sol이 구현, Opus가 코드·통합 리뷰**를 맡는다. Paperthin 28개 스킬 중 필요한 절차를 골라 적용한다.

## 설치와 시작

Node 22 이상, Pi, Codex CLI, Claude Code와 사용할 계정 로그인을 준비한다. 설치·인증은 [Runbook](RUNBOOK.md)을 따른다.

```bash
pi install git:github.com/d0lim/pi-paperthin-orchestration
cd /path/to/your-project
pi
```

```text
/lead 현재 요청을 계획하고 구현·검토·검증까지 진행해줘
/workflow
/workflow jobs
/workflow runs
/workflow metrics
/workflow skills
```

일반 Pi 세션은 비활성으로 시작한다. `/lead`가 설정된 Pi/Astra 모델·effort와 역할 지침을 활성화한다. 모델·인증 실패를 다른 모델이나 API 결제로 자동 우회하지 않는다. 업데이트는 `pi update git:github.com/d0lim/pi-paperthin-orchestration` 뒤 새 Pi 또는 `/reload`로 적용한다.

**Fable headless 실행은 기본 차단**이다. 사용자의 정책에서 Fable의 usage credits 자동 차감까지 허용한 경우 `routing.allowFableHeadless`를 설정한다. 아래 모델 순서를 선택했다는 사실만으로 비용 허용이 추가되지는 않는다. [공식 안내](https://code.claude.com/docs/en/model-config#fable-and-usage-credits)

## 전체 흐름

```mermaid
flowchart LR
    A[Astra 계획] --> F[Fable 계획 리뷰]
    F --> G{승인}
    G -->|수정| A
    G -->|통과| S[Codex · Sol 구현]
    S --> T[고정 후보 · 실제 검사]
    T --> O[Opus 코드 리뷰]
    O -->|수정| S
    O --> I[별도 worktree 통합]
    I --> V[통합 검사 · Opus 리뷰]
    V --> D[완료 · re0-memo]
```

Lead는 `workflow_run`으로 계획 스냅샷과 실행을 등록하고 작업별 worktree·파일 소유권·의존성을 지정한다. `workflow_spawn`의 구현·리뷰에는 `runId`와 `phase`가 필요하다. 실행기가 승인된 계획, 현재 후보 SHA, 실제 검사 결과를 대조한다. 자연어 “완료”나 프로세스 정상 종료만으로 승인하지 않는다.

변경은 **독립 worktree에서 구현하고 별도 통합 worktree에서 검증**한다. 완료 결과의 후보를 원래 브랜치로 반영하거나 push·PR·배포하는 작업은 사용자가 허용한 범위에서 Lead가 수행한다. 기존 사용자 checkout을 자동 덮어쓰거나 worktree를 자동 삭제하지 않는다.

## 모델과 실행 환경

| 단계 | 기본 profile | 실행 |
| --- | --- | --- |
| Lead 계획·조율 | Lead | Pi / Astra |
| `plan_review` | `fable` | Claude CLI / Fable |
| `implement` | `codex` | Codex CLI / Sol |
| `code_review` — 작업·통합 | `opus` | Claude CLI / Opus |
| 독립 내용 읽기 | `sol` | Pi / Sol |

`sol` profile은 Pi/Sol이며 `codex` profile은 Codex CLI/Sol이다. 단계별 기본값은 `routing.phases`에서 바꾸고 사용자 profile·effort pin은 유지한다. 전역 `pins.review`는 두 종류 리뷰 모두에 적용되므로 서로 다른 리뷰 모델을 원하면 단계별 설정을 사용한다. [설정·도구 계약](docs/orchestration.md), [정확한 모델 ID](config/roles.json)

## Paperthin 적용

- 요청·브리프는 `readchk`, 배정의 규모·effort 판단은 `modelchk`.
- 계획·문서 정리는 `re0`, 중요한 브리프·인계의 독립 읽기는 `shower`.
- 완료 전 `sip`로 관련 검사를 선택하고, 사실에는 `factchk`, 검증 설계에는 `mandela`.
- 실제 QA·실패에서 `re0-memo`, 장기 개선 반복에서 `re0-loop`, 재개 시 `catchup`.

기본 역할 본문과 선택한 추가 본문만 전달한다. 모델 선택 16개와 사용자 명시 호출 12개를 구분한다. `re0-plan` 같은 upstream 유지보수 절차를 일반 프로젝트 계획에 자동 적용하지 않는다. 스킬 주입은 절차 준수의 증명이 아니며 실제 해석·검토·테스트 근거를 함께 확인한다.

## Herdr와 기록

Herdr의 프로젝트 workspace에서 Lead tab을 운영한다. 기본 자식은 pane 없는 프로세스이며 동시 2개·대기 8개·작업당 15분이다. `/workflow cancel <job-id>`는 이 세션이 소유한 작업만 취소한다. 자식은 다른 자식을 배정하지 않는다.

직접 대화가 필요한 보조 작업은 Herdr 내부의 `workflow_tab`으로 지정 workspace에 새 탭을 연다. 기존 headless job을 이전하거나 그 결과를 자동 승인하는 기능은 아니다. 지속 실행할 개발 서버도 별도 탭에서 관리한다.

- 계획·브리프·학습: 프로젝트의 `.agent-runs/<작업 식별자>/` 권장.
- 프로세스 로그: `.agent-runs/jobs/<session>/<job>/`.
- 승인 원장·계획 스냅샷·작업/통합 worktree: Git common directory의 `paperthin/workflows/`.

중단 후 기록과 부분 변경을 확인하고 명시적으로 복구한다. 죽은 프로세스를 재시작하거나 다른 세션의 작업을 자동 종료하지 않는다. `/workflow metrics`는 현재 세션에서 보고된 시간·토큰·비용을 집계하고 미보고 값은 모름으로 유지한다.

[구조도](docs/architecture.md) · [실행 계약](docs/orchestration.md) · [운영·복구](RUNBOOK.md) · [검증 기록과 한계](docs/verification.md)

## 개발

```bash
npm test
```

설치된 Pi SDK가 없으면 두 로더 테스트 그룹을 생략한다. 격리된 SDK를 `PI_PACKAGE_DIR`로 지정해 실제 로더 검사까지 실행할 수 있다. 모의 모델 응답을 이용한 전체 경로 검사와 실제 모델·Herdr UI 실행은 구분한다.
