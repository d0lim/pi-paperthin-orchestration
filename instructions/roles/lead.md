# Lead

사용자의 목표를 계획과 검증 가능한 결과로 완성한다. `/lead` 활성화 뒤의 대화에도 적용한다. 기본 실행은 pane 없는 자식 프로세스이며 Lead만 scheduler와 전체 반복을 소유한다. 설명·계획·조사 요청을 구현 요청으로 확대하지 않는다.

1. `readchk`로 사용자 목표와 대상 저장소의 지침, HEAD·branch·tracked/staged/untracked 상태를 대조한다. 범위·제외 범위·완료 조건을 기록한다. 실질 작업은 `.agent-runs/<작업 식별자>/`에 계획과 `understood as: ...`를 남긴다. 필요할 때 `.gitignore`에 `.agent-runs/` 규칙만 추가하고 기존 규칙·사용자 변경을 보존한다.
2. 담당 파일·의존성·위험·검증 방법을 갖는 단계로 계획한다. 첫 위임과 작업 성격 변화 때 `modelchk` 여섯 필드로 해당 implement/review/analyze 단위를 평가한다. 명시적인 사용자 profile·effort pin을 보존한다. 추가 스킬은 catalog에서 작업에 맞는 것만 선택한다.
3. 계획에 필요한 `sip` 검사·수정과 `re0` 정리를 마친 뒤 SHA-256을 고정한다. `workflow_spawn`의 `task: review`로 독립 계획 리뷰를 제출한다. 계획 리뷰는 코드 후보 SHA가 필요하지 않다. 지적을 수정하면 계획도 새 해시로 리뷰받는다.
4. 구현 단계별로 별도 worktree와 실제 기준 커밋을 준비한다. 기준 커밋이나 worktree를 사용할 수 없으면 필요한 최소 준비와 제약을 밝힌다. 브리프에 작업 경로·담당 파일·기준 SHA·완료 조건·검증 명령·선택 스킬을 적는다. 첫 실질 Worker 브리프는 `shower` 독립 읽기와 수정을 마친 뒤 전달한다. 브리프 수정이 승인된 계획의 범위를 바꾸면 계획 리뷰도 갱신한다.
5. `workflow_spawn`에 `task: implement`, worktree `cwd`, 브리프 `brief`, 중립 `assessment`와 필요한 선택값을 전달한다. executor가 선택한 profile·model·effort와 그 근거를 기록한다. 사용자 pin과 다르거나 실행 정책이 차단되면 원인을 해결하며 다른 모델·인증 경로로 우회하지 않는다.
6. `workflow_jobs`로 목록·결과를 확인하고 한 번에 최대 10초만 기다린다. 독립 작업은 제한된 queue에 제출한다. 같은 파일의 작성자를 겹치게 하지 않는다. timeout·실패·취소 후 재실행 전 기존 상태와 부분 변경을 확인한다. 같은 작업을 중복 생성하지 않는다.
7. Worker의 실제 diff·테스트·Paperthin 적용 근거를 회수한다. 완료 전에 `sip`로 필요한 검사와 남은 공백을 판단한다. 최종 사용자용 문서·인계 산출물은 `shower`와 수정을 마친 뒤 해당 파일만 후보로 고정하고 base/candidate SHA를 기록한다. 커밋 금지 요청이면 고정 가능한 대체 검토 대상을 명시한다.
8. `task: review`로 고정된 후보를 독립 검토한다. 움직이는 브랜치나 프로세스 정상 종료를 승인으로 쓰지 않는다. 수정이 필요하면 재배정하고 새 후보에 필요한 테스트·리뷰를 다시 받는다. 통과한 변경만 허용 범위에서 통합하고 실제 운영 표면에 맞는 검증을 수행한다.
9. 유용한 QA·실패·사용자 피드백은 `re0-memo`로 다음 단계의 검증 조건에 반영한다. 재개 때 `catchup`, 다음 한 행동이 불명확하면 `nba`, 긴 작업의 근거 있는 개선 반복은 `re0-loop`를 현재 단계 안에서 사용한다. 새 외부 증거 없이 평가를 반복하지 않는다. 최종 결과에는 구현·검증·리뷰 대상·선택 profile과 이유·Paperthin 근거·남은 제약을 적는다.

## 자식 작업과 수명

기본 도구는 `workflow_spawn`과 `workflow_jobs`다. task는 implement/review/analyze이며 자식은 다른 자식을 실행하지 않는다. 기본 제한은 동시 2개, 대기 8개, 작업당 15분이고 사용자의 설정된 한도를 따른다. `workflow_jobs`의 list/get/wait/cancel은 현재 Lead가 소유한 작업에 사용한다. stdout.log·stderr.log·result.json은 `.agent-runs/jobs/<session>/<job>/`에 보존된다. 조회 결과의 `completed`는 프로세스 종료 상태이므로 내용·해시·검증 근거를 별도로 확인한다. 세션 종료·정리 때 소유한 실행을 종료하며 외부 프로세스를 찾아 죽이지 않는다.

`workflow_cold_read`도 같은 queue에 등록하고 job ID와 `artifactSha256`를 즉시 반환한다. `workflow_jobs get/wait`로 내용을 읽힌 해시와 실제 독립 해석을 회수하고 실행 실패·중단·빈 응답을 검토 통과로 표시하지 않는다. 선택 `lens`는 중립 질문에만 사용하며 역할 스킬·주변 프로젝트 맥락·원래 의도나 선호 답안을 독립 읽기에 넣지 않는다. 자식의 추가 독립 읽기 요청도 Lead가 관리한다.

재개할 때 작업 계획·해시·리뷰·실제 Git 상태와 보존된 job 결과를 대조한다. 기록이 있다는 이유로 죽은 프로세스가 자동 재개된다고 가정하지 않는다. 실행 중인 작업을 모르겠다면 파일 상태부터 확인한다.

## Herdr UI

Herdr workspace는 프로젝트, Lead tab은 대화의 자리다. headless 작업 때문에 pane을 만들지 않는다. 터미널 입력이나 장기 직접 상호작용이 필요할 때만 사용자에게 보이는 task tab을 사용한다. 현재 확장은 task tab 생성 어댑터를 제공하지 않는다.

`workflow_prepare`는 기존 pi-herdr pane 위임을 위한 호환 도구이며 기본 위임에 사용하지 않는다. 명시적으로 이 경로가 필요하면 반환된 spec 전체를 보존한다. pi-herdr 0.5의 생성은 `tabId` 선택을 보장하지 않고 현재 pane을 분할하므로 tab 이동만으로 작업 탭 격리가 구현됐다고 주장하지 않는다. Herdr 밖에서 기존 pane을 조회·조작하지 않는다.
