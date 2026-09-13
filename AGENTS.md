# Pi + Paperthin 예제 프로젝트 운영 지침

Node.js 할 일 CLI를 대상으로 모델별 역할과 파일 기반 인계를 연습한다. Compound Engineering은 사용하지 않는다.

## 실행과 검증

- CLI: `node src/cli.js --file .data/tasks.json add "첫 작업"`; `list`, `done <id>`도 지원한다.
- 테스트: `npm test`. 외부 의존성 없이 Node.js 22 이상에서 실행한다.
- Herdr 안에서 프로젝트로 이동해 `pi` 또는 기존 `pi-lead`를 시작한다. 프로젝트 확장이 자동 로드되고 기본 역할은 Lead다. `/workflow`로 현재 역할·실제 모델·effort·설정·Paperthin 경로를 확인한다.
- 확장의 `before_agent_start`가 공통·역할 지침을 주입한다. `--workflow-role`은 역할을 고르며 모델을 변경하지 않는다. 현재 provider·model·effort가 역할 기준과 다르거나 지침이 없거나 충돌하면 입력 단계에서 모델 요청을 차단한다. `/workflow`로 확인하고 설정을 맞춘다. 역할 기준 변경은 `.workflow/roles.json`과 실행 설정에 명시적으로 반영한다.
- 프로젝트 고유 요구사항과 하위 디렉터리 지침을 확인한다. 이 공통 지침은 작업 브리프를 대체하지 않는다.

## 역할과 완료 기준

- Lead는 요구사항, 제외 범위, 담당 파일, 기준 커밋, 검증 방법을 브리프로 전달한다. 모델과 effort의 기준은 `.workflow/roles.json`이다.
- 동시에 쓰는 작업자는 별도 worktree를 사용한다. 다른 작업자의 변경을 되돌리거나 해당 checkout을 수정하지 않는다.
- Worker는 지정 범위의 구현·테스트 결과를 반환한다. Lead의 브랜치에 직접 통합하거나 작업을 재위임하지 않는다.
- Reviewer는 고정한 통합 후보와 테스트 근거를 검토한다. plan 모드에서는 파일을 쓰지 않고 응답으로 결과를 반환한다. Lead가 출처와 기준 SHA를 기록한다.
- 검토 중 코드를 바꾸지 않는다. 수정 후 필요한 테스트와 재검토를 수행한다. pane의 idle/done 표시나 에이전트의 완료 선언만으로 승인하지 않는다.
- 인증 또는 요청한 모델 사용이 실패하면 해당 작업의 오류를 보고한다. 다른 모델이나 API 결제로 자동 전환하지 않는다.
- 승인된 작업 범위는 계속 수행한다. 이미 허용된 읽기·수정·테스트마다 재확인을 요청하지 않는다. push·merge·공개 배포·파괴적 작업은 해당 작업에 대한 사용자 권한이 필요하다.

## Paperthin 적용 조건

- `readchk`: 복합 요청이나 모호한 작업 범위를 실제 작업 전에 확인한다. 해석이 명확하면 확인 질문을 반복하지 않는다.
- `modelchk`: 새로운 작업 배정이나 추론 비용 판단이 필요할 때 읽는다. 추천 결과만 받고, 실제 라우팅은 Lead가 별도로 결정한다.
- `shower`: 인계 문서가 이전 대화 없이 이해되는지 검증할 때 사용한다. 스킬 지침을 읽고 `workflow_cold_read`에 `artifact` 경로만 전달한다. 별도의 도구 없는 새 Pi 세션은 결과물 내용만 받는다. 원래 요청이나 리뷰 의도를 추가하지 않는다. 진단과 의도를 원래 세션에서 비교하며 일반 코드 리뷰를 shower 실행으로 보고하지 않는다.
- `re0`: 문서가 누적 수정으로 낡거나 중복됐을 때 적용한다. 매 코드 변경 후 전체 문서를 다시 쓰지 않는다.
- 스킬 이름을 언급한 것만으로 적용했다고 보고하지 않는다. 적용 시 실제 SKILL.md를 읽고 결과와 한계를 인계에 남긴다.
- 위 스킬만으로 테스트가 대체되거나 자동 작업 분배가 구현되지는 않는다. `re0-loop`, `sip` 등 다른 전체 루프는 이 예제에 추가하지 않는다.

## 자동 위임

Lead는 `workflow_prepare`에 역할, 실제 worktree 절대경로, 브리프 파일 경로를 전달한다. 선택 가능한 위임 역할은 `worker`, `reviewer`, `escalation`, `codex-worker`다. 필요하면 pane 이름인 `name`도 지정한다.

```json
{
  "role": "worker",
  "cwd": "/Users/limdongyoung0/Develop/worktrees/pi-paperthin-delete",
  "brief": ".workflow/briefs/add-delete.md",
  "name": "todo-delete-worker"
}
```

이 도구는 실행하지 않고 `herdr_delegate` 입력을 준비한다. 반환 텍스트의 JSON 전체(`details.spec`과 동일)를 기존 `pi-herdr`의 `herdr_delegate`에 그대로 전달한다. `agentArgs`, `cwd`, `prompt`, `onBlocked`를 생략하거나 기본 pi/claude 실행으로 치환하지 않는다. 추가 지시가 필요하면 브리프를 수정한 뒤 다시 준비한다.

프로젝트 확장에서 Herdr 제어를 중복 구현하거나 다른 확장의 도구를 직접 호출하는 비공개 API를 사용하지 않는다. 실행·대기·결과 회수에는 설치된 `pi-herdr`를 사용한다.

긴 작업은 같은 위임 인자에서 `prompt`, `timeoutMs`, `onBlocked`를 제외해 `herdr_start_agent`에 전달하고, 준비된 pane에 `herdr_send_prompt`로 원래 `prompt`를 보낸 뒤 제한된 대기와 결과 읽기를 사용한다. 시간 초과 후에는 기존 pane을 확인하고 중복 작업자를 만들지 않는다. `workflow_cold_read`는 최대 120초의 독립 호출이며 확장과 도구를 로드하지 않는다.

인계 결과는 작업, worktree/branch, base/candidate SHA, 변경 파일, 실행한 명령, 검증 결과, 남은 문제를 포함한다. 토큰·인증 파일·전체 셸 환경은 읽거나 인계하지 않는다. `scripts/agent.mjs`는 호환·디버깅용 보조 CLI이며 일반 위임은 확장 도구를 사용한다.
