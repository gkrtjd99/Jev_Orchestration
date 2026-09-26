# 미릴리스 — 훅 없는 ultracode 계획 보조, 2026-09-26

repository-local `CLAUDE.md`·약 3KiB의 `jev-ultracode` skill과 `bin/jev-plan.mjs`를 추가했습니다. 원래 Workflow 계획 초안의 목표·수용 기준·1~8개 task를 Jev에 한 번의 batch로 자문하고, Astra가 typed 권고의 채택과 실제 Workflow 옵션을 결정합니다. 기존 installer, hooks, controller 및 사용자 HOME 설정은 변경하지 않습니다.

명시적인 전송 동의·계획 공유 동의·TypeSafe 키가 없으면 기본 ultracode를 보존합니다. confirmed 후보의 품질 하한, private 파일·DAG·경로 충돌 검사, 고정 run-id cap 1, 캐시, 낮은 확신·정보 부족·실패 시 fallback을 사용합니다. native registry와 Workflow 지원을 동일시하지 않으며, 권고·실제 채택·requested/observed·산출물 품질을 분리합니다. 전체 실모델 대응 비교와 기본 ultracode 대비 품질·효율 우위는 **NOT_RUN/미입증**입니다. [사용·비교 계약](../docs/ULTRACODE.ko.md)을 보세요.

2026-09-26의 격리된 전체 검사에서 Node **395/395**, Python **72/72**, 구문 **46개 모듈**, 기존 라우팅의 독립 offline 검사·SUT 원본 불변이 통과했습니다. 새 advisor·경계 suite의 **151개** 회귀에는 잘못된 계획·decoded 비밀·파일·후보·typed 응답 거부, timeout/HTTP 실패, 동의 철회 후 캐시 차단, 실제 CLI subprocess의 응답·캐시·변경 계획/키 교체 cap이 포함됩니다. 독립 검토에서 재현한 hardlink/Unicode/firmlink 별칭, provider envelope의 캐시 팽창, 캐시 사용량·출처, 끝나지 않는 오류 body의 프로세스 잔류를 보완했습니다. 안전한 손상 상태 파일은 원본을 보존해 fallback하며, 실제 CLI 종료도 회귀로 확인했습니다. 별도로 실제 CLI help·dry-run·미동의 fallback·오류의 원문 비노출도 실행했습니다. 모두 로컬 합성 계약 검증이며 실제 Jev 판단·Workflow 적용·품질 우위의 증거가 아닙니다.

# 3.1.0 — Claude controller 실험 경로, 2026-09-26

기존 shadow/active/advisory와 별도로 명시적 `controller` 모드를 추가했습니다. goal-bound Astra 계획 schema 2, native Agent/Task의 동적 confirmed 프로필 선택, Main 직접 작업/Workflow 거부, 선행 task의 Main 수용 기록, 선택적인 비구속적 Jev 비평 및 로컬 AgentOTelStack OTLP protobuf 전송을 포함합니다. Reporivet 원칙을 참고한 근거 진입점 `AGENTS.md`도 추가했습니다.

회귀 테스트는 모의 worker·모의 OTLP 수신과 설치된 CLI stdin 경계까지 검사합니다. 2026-09-26에 Node 243/243, 검증기 자기 테스트 72/72, 기존 경로의 독립 offline 검사를 통과했습니다. 추가로 불확실한 작업의 effort 하한, 범위가 넓은 debug의 max 제외, 실제 동기 native stop→PostToolUse 순서의 선행 수용, 잘못된 시작/중지 순서 거부와 protobuf partial rejection 필드 순서를 검증했습니다. 검증기의 typed Claude child `assistant.effort` 관측도 추가했습니다. 별도 검증기에 동일 실저장소 작업의 세 조건 pilot driver와 결함/참조 canary를 추가했습니다. 후속 native/controller 실모델 두 과제의 결과는 [실측 보고서](../reports/REPOSITORY_PILOT_20260926.md)에 분리했습니다. 이들 시행에서 native 두 후보는 독립 채점 통과, controller 두 후보는 소스 무수정·채점 실패였으며, 별도 TypeSafe 전송 동의가 없어 active는 미실행입니다. 실제 AgentOTelStack 저장·조회와 세 조건 우위는 검증하지 않았습니다. 사용자 프로젝트에 hook을 설치하거나 외부 서비스에 자료를 게시하지 않았습니다.

# 3.0.0 — 통합판, 2026-09-25

0.4.0-router.1의 네이티브 위임 연결과 검증기 1.0.0을 기반으로, v2.3의 명시적 전송 동의·품질 우선 effort 정책을 통합했습니다.
외부 전송 기본 차단, shadow 기본값, 확인된 capability 필터, 별도 Codex rewrite 동의, 사용자 모델 보존, metadata-only 로그, 작업 revision 재검사, max/상위 모델 공동 비교, selector abstain 보존, 대응 표본 비교를 추가했습니다.
실제 API·native 모델 품질 검증은 이 릴리스의 로컬 검사에 포함되지 않습니다. 변경 근거와 검사는 최상위 문서를 따릅니다.
