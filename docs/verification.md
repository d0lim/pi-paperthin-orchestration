# 검증 기록

확인일: 2026-09-15 · 패키지 버전: 0.4.0

## 자동 검증

`npm test`는 80개 통과, 실패·skip 없음이다. 설치된 Pi 0.85.1의 실제 로더를 사용하는 패키지 테스트와 모델 API를 모의로 대체한 확장 테스트를 구분한다.

- 임의의 프로젝트에서 확장 1개와 Paperthin 28개를 로드했다. 명시 경로 중복 제거, `--no-skills`, 원본 체크섬, model 16개·user 12개의 호출 경계를 확인했다.
- `/lead` 활성화·역할 복원·인증/모델 불일치·Worker 재위임 차단, 비동기 제출·조회·취소·세션 정리를 모의 Pi API로 확인했다.
- `modelchk` 여섯 필드, adaptive/fixed, profile pin 충돌, 개인→프로젝트 설정 상속, 역할 effort pin과 런타임별 매핑을 확인했다. Claude의 명령 인자와 자식 환경변수에 같은 effort를 전달한다.
- Fable headless 차단과 승인 설정, legacy CLI `--print` 우회 차단을 확인했다. 실제 Fable을 호출하지 않고 PATH를 비운 자식에서 차단을 검사했다.
- 실제 Node 자식 프로세스로 동시 실행·대기 한도, timeout·cancel·dispose, 소유한 프로세스 그룹 정리와 무관한 프로세스 보존을 확인했다. `HERDR_*` 제거, 셸 미사용, 로그 제한·보존, 대기 취소와 작업 취소의 구분도 검사했다.
- Pi·Claude·Codex JSON 응답에서 최종 텍스트와 오류를 해석한다. 종료 코드 0이라도 빈·누락·비문자 응답, 모델 불일치, permission denial을 품질 승인으로 바꾸지 않는다. 모델 정보가 없으면 확인 성공으로 표시하지 않는다.
- 브리프·역할 정책·선택 스킬 본문 전달과 cold-read의 artifact-only 격리를 검사했다. SHA-256은 전달한 파일 스냅샷에서 계산하며 나중에 파일을 바꾸어도 기존 내용·해시의 짝을 유지한다.

`npm pack --dry-run --json --ignore-scripts`에서 확장·런타임 3개·설정·지침·문서·28개 원문 스킬·라이선스를 확인했다. 예제 앱, 실행 기록, 인증 파일은 배포 목록에 포함하지 않는다. 문서의 로컬 링크 검사와 `git diff --check`도 통과했다.

## 실제 Pi 실행

이번 버전의 `buildManagedLaunch`와 `JobManager`로 두 개의 독립 Pi/Sol 작업을 동시에 제출했다. 실제 모델 응답은 모두 `gpt-5.6-sol`, effort는 medium이며, 정상 종료·빈 stderr와 `runtimeError: false`를 확인했다. 보고된 모델 ID는 런타임 응답의 증거이며 서버 내부 모델을 독립적으로 증명하는 것은 아니다.

Worker 읽기 전용 호출은 자신의 worker 역할·대상 프로젝트 경로, 직접 전달된 `readchk`/`re0`, catalog 28개와 model 16개·user 12개를 확인했다. 이 호출은 역할 정책 로딩과 파일 읽기 검증이다. 제품 기능 구현이나 Claude와의 코드 리뷰 전체 흐름을 수행한 결과는 아니다.

README 독립 읽기는 공통 정책·부모 의도·프로젝트 파일·도구 없이 문서 스냅샷만 전달했다. 첫 결과는 `minor gaps`였다. 기본 사용 경로를 이해했지만 활성화 뒤 입력 처리, Git 통합 범위와 로그 제외 방식 등이 모호하다고 지적했다. 해당 설명과 확인 환경·모델 ID 안내를 보완했다. 설치·인증·상세 설정은 연결한 Runbook과 실행 계약에서 다루는 README의 범위를 유지했다.

첫 검토 SHA-256은 `10cd4d875953e734d0cfc44cb98ea22d8d516b84f936e49941c03bf549a19587`이다. 수정본 SHA-256 `9bbd245ca7c191ab8dcfe04db8e0cb0a5e0fce3e0ac724bde9b00d7093fd91c4`도 새 독립 Pi/Sol 세션으로 읽혔고 정상 종료·빈 stderr·모델 일치를 확인했다.

수정본의 판정은 `needs work`였다. 검토자는 기본 사용법·입력 처리·로그·Herdr 제약은 이해했지만, 처음 설치하는 독자가 README 하나만으로 설정·실패 복구·Git 영향까지 판단할 수 없다고 지적했다. 해당 판정을 통과로 바꾸지 않았다. README는 빠른 시작으로 유지하고 설치·인증·문제 해결은 Runbook, 설정 형식·큐·리뷰 계약은 orchestration.md로 연결했다. 따라서 README의 독립적인 전체 운영 매뉴얼 적합성에는 보완 권고가 남아 있으며, 연결 문서 전체를 한 산출물로 읽히는 독립 검증은 수행하지 않았다.

실호출의 stdout·stderr·result.json 및 해석은 Git에서 제외한 `.agent-runs/v0.4-smoke/`에 보존했다. 스킬 본문 전달과 모델의 자기 보고만으로 모든 Paperthin 절차 준수를 인정하지 않는다.

## 독립 검토와 남은 범위

코드 독립 검토에서 큐·수명 관리, 인자 전달, 역할별 routing, Fable 차단, 응답 오류 처리와 문서 계약을 확인했다. 최종 검토에서 추가 배포 차단 사항은 발견되지 않았다. 이 검토는 실제 모델 운영이나 Herdr UI 검증을 대신하지 않는다.

확인 환경은 Pi 0.85.1, Herdr 0.9.0, pi-herdr 0.5.0, Claude Code 2.1.270이다. Claude CLI 도움말·설정 계약을 확인했지만 현재 검증 환경의 `claude auth status`가 `loggedIn: false`였으므로 이 버전의 Opus·Fable 실호출은 하지 않았다. Fable은 별도의 headless 과금 허용이 필요하며 기본 설정은 false다. [Claude Code 공식 안내](https://code.claude.com/docs/en/model-config#fable-and-usage-credits)

Astra Lead에서 계획 리뷰→Worker 구현→코드 리뷰→통합까지의 전체 실호출, Codex 선택 profile, Herdr 화면 안의 전체 작업은 아직 검증하지 않았다. 실제 Pi 자식 호출은 새 runtime·job manager로 수행했고 확장 도구 핸들러는 모의 API로 검증했다. 기존 버전의 호출 결과를 이 버전의 전체 검증으로 재사용하지 않는다.

Herdr의 사용 중인 pane을 밖에서 조작하지 않았다. 기본 headless 경로는 Herdr 도구를 호출하지 않으며 자동 task-tab 어댑터는 구현하지 않았다. 계획·품질 승인 순서를 강제하는 별도 상태 머신이나 죽은 작업의 자동 재개 엔진도 제공하지 않는다. 동시 실행·큐·timeout·소유한 작업 취소는 코드가 제한하고, Paperthin 선택·리뷰·통합은 Lead 지침과 실제 근거에 의존한다.

## 설치 확인

전역 패키지 등록은 `pi list`로 확인하고 업데이트 후 새 Pi 또는 `/reload`로 명령을 다시 로드한다. 진행 중인 자식은 먼저 완료·취소한다. `/lead --help`, `/workflow`, `/workflow jobs`, `/workflow skills`는 모델 호출 없이 명령과 상태를 확인한다.
