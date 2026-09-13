# 검증 기록

확인일: 2026-09-14. 이 기록은 환경 구성과 지침 전달 검증이며 삭제 기능 구현 완료 기록이 아니다.

## Pi 확장 도입 후 검증

| 항목 | 결과 | 근거와 범위 |
| --- | --- | --- |
| 전체 자동 테스트 | 29개 통과, 실패·skip 없음 | `npm test`; CLI·실행기 13개와 확장 테스트 16개 |
| 프로젝트 확장 로드 | 통과 | 실제 설치된 Pi 0.85.1의 로더로 `.pi/extensions/workflow.ts`를 로드해 명령·도구·이벤트 등록 확인 |
| 지침·네이티브 스킬 연결 | 통과 | `before_agent_start`의 공통·역할 주입과 `resources_discover`의 Paperthin 경로, 역할 중복·충돌 검사 |
| 모델 요청 전 검사 | 통과 | 현재 provider/model/effort와 역할 기준 불일치, 잘못된 역할·역할 충돌 시 입력을 처리해 모델 요청 차단. 자동 모델 변경 없음 |
| `/workflow` | 통과 | 모델 호출 없이 역할·현재 모델·effort·설정·소스·Herdr 상태를 반환하는 명령 핸들러 검사 |
| `/lead` 작업 요청 | 통과 | 원문 보존, 현재 세션으로 전달, 응답 중 followUp, 여러 줄 편집·취소·빈 입력, 도움말, 잘못된 역할·모델 및 편집 중 모델 변경 검사 |
| `/lead --help` 실제 CLI | 정상 종료 | 설치된 Pi를 JSON 모드·`--no-session`으로 실행. workflow-help 메시지 출력, 모델 요청 없음. TUI 편집기와 실제 Astra 작업 호출은 모의 핸들러 검증과 구분 |
| 위임 준비 도구 | 통과 | 모의 도구 호출로 `workflow_prepare`의 정확한 `herdr_delegate` JSON 확인. 실제 pane 생성은 수행하지 않음 |
| 독립 검토 도구 | 통과 | 모의 실행으로 `workflow_cold_read`의 격리 인자·120초 제한·오류 처리 검사. 실제 독립 모델 호출은 수행하지 않음 |
| 확장을 적용한 실제 Worker 호출 | 정상 종료 | Sol/medium Worker의 load-check 응답. 역할·지침을 확인하고 실제 readchk 본문을 읽음. 코드 변경·테스트·재위임 없음 |

실제 Worker 호출 기록은 `.agent-runs/verification/pi-worker-extension.txt`에 있으며 Git에서 제외한다. 모델 요청 전 현재 설정이 역할 기준과 일치함을 검사하고 호출이 정상 종료됨을 확인했다. 모델의 자기 보고만으로 독립적인 서버 모델 정체까지 증명한 것은 아니다.

확장 검증은 Herdr E2E를 대체하지 않는다. Herdr 안에서 `pi` → `/lead <작업>` → `workflow_prepare` → 실제 `herdr_delegate`의 pane 생성·대기·결과 회수는 아래 남은 검증에 포함한다.

## 확장 도입 전 구성 검증

| 항목 | 결과 | 근거와 범위 |
| --- | --- | --- |
| Pi | 0.85.1 | 로컬 `pi --version` |
| Herdr | 0.9.0, 서버 running | 로컬 버전 및 상태 확인 |
| Claude Code | 2.1.270 | 로컬 `claude --version` |
| pi-herdr | 이미 설치됨 | `pi list`; 기존 설치 재사용 |
| 역할 함수·thinking 설정 | 이미 존재 | 기존 `~/.config/agents.zsh`와 모델별 thinking 설정을 읽기 전용 확인 |
| CLI 테스트 | 6개 통과 | 추가·목록·완료, 상태 유지, 잘못된 입력, 손상된 파일 보존 |
| 실행기 테스트 | 7개 통과 | 외부 cwd 지침 전달, 정확한 모델/effort, Herdr 인자 보존, cold-read 문맥 제외, 잘못된 입력 거부, shell 미사용, 소스 체크섬·symlink |
| Pi 스킬 탐색 | 네 스킬 발견, diagnostics 없음 | 설치된 Pi의 실제 `loadSkills`·`loadSkillsFromDir`로 확인 |
| Worker 실제 호출 | 정상 종료 | `node scripts/agent.mjs worker --brief .workflow/briefs/load-check.md --print` |
| Reviewer 실제 호출 | 정상 종료 | `node scripts/agent.mjs reviewer --brief .workflow/briefs/load-check.md --print` |
| SKILL.md 실제 읽기 | 두 모델 호출에서 readchk 읽음 | 카탈로그만 본 스킬과 본문을 읽은 스킬을 구분해 응답 |
| Paperthin 원본 | 커밋·체크섬 고정 | `vendor/paperthin/source.json`; 원문·LICENSE·NOTICE 보존 |

실제 모델 호출 출력은 `.agent-runs/verification/pi-worker.txt`와 `claude-reviewer.txt`에 있으며 Git에서 제외한다. 이는 역할 인식과 읽기 동작을 확인한 결과다. 모델 이름에 대한 자기 보고만으로 서버 모델 정체를 증명하지는 않는다. 실행기는 요청한 모델과 effort를 명시하며 별도의 모델 fallback을 구현하지 않는다.

## 남은 검증

- Astra Lead, Fable escalation, Codex Worker의 실제 모델 호출은 수행하지 않았다. 선택 역할의 CLI 인자는 생성 가능하지만 계정 접근까지 확인한 것은 아니다.
- Herdr pane 생성부터 prompt 전송·대기·결과 회수까지의 통합 시험은 수행하지 않았다. 검증 당시 실행 환경의 `HERDR_ENV`가 1이 아니었다. 설치된 `herdr --skill`은 “Do not inspect or control the focused Herdr session from outside Herdr.”라고 안내하므로 사용 중인 pane을 외부에서 조작하지 않았다. README의 Herdr 내부 실행 절차로 검증한다.
- 다른 cwd의 지침 전달은 자동 테스트로 확인했으며, 실제 Git worktree와 모델을 결합한 시험은 첫 커밋 후 수행한다.
- `cold-read`의 context/tool 제외는 실행 인자와 설치된 Pi 리소스 로더를 확인했다. 실제 별도 cold-read 모델 호출은 수행하지 않았다.
- 삭제 기능의 구현·리뷰·통합은 다음 실습이다. 현재 CLI에는 `delete`가 없다.

## 변경 범위

이 예제 디렉터리에 코드, 지침, 브리프, 스킬 원본, 실행기, 문서와 Git 저장소를 만들었다. 전역 셸 설정·인증·기존 플러그인·기존 Herdr 세션은 변경하지 않았다. 초기 구성은 `235a1fb`로 커밋해 지정한 GitHub 저장소의 `main`에 푸시했으며, 이후 `/lead` 진입점을 추가했다.
