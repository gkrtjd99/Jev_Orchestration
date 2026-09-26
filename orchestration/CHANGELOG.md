# 3.1.0 — Claude controller 실험 경로, 2026-09-26

기존 shadow/active/advisory와 별도로 명시적 `controller` 모드를 추가했습니다. goal-bound Astra 계획 schema 2, native Agent/Task의 동적 confirmed 프로필 선택, Main 직접 작업/Workflow 거부, 선행 task의 Main 수용 기록, 선택적인 비구속적 Jev 비평 및 로컬 AgentOTelStack OTLP protobuf 전송을 포함합니다. Reporivet 원칙을 참고한 근거 진입점 `AGENTS.md`도 추가했습니다.

회귀 테스트는 모의 worker·모의 OTLP 수신과 설치된 CLI stdin 경계까지 검사합니다. 2026-09-26에 Node 243/243, 검증기 자기 테스트 65/65, 기존 경로의 독립 offline 검사를 통과했습니다. 추가로 불확실한 작업의 effort 하한, 범위가 넓은 debug의 max 제외, 실제 동기 native stop→PostToolUse 순서의 선행 수용, 잘못된 시작/중지 순서 거부와 protobuf partial rejection 필드 순서를 검증했습니다. 검증기의 typed Claude child `assistant.effort` 관측도 추가했습니다. 별도 검증기에 동일 실저장소 작업의 세 조건 pilot driver와 결함/참조 canary를 추가했지만, 실제 Astra/Sol/Luna 작업 품질 비교와 실제 AgentOTelStack 저장·조회는 수행했다고 주장하지 않습니다. 사용자 프로젝트에 hook을 설치하거나 외부 서비스에 자료를 게시하지 않았습니다.

# 3.0.0 — 통합판, 2026-09-25

0.4.0-router.1의 네이티브 위임 연결과 검증기 1.0.0을 기반으로, v2.3의 명시적 전송 동의·품질 우선 effort 정책을 통합했습니다.
외부 전송 기본 차단, shadow 기본값, 확인된 capability 필터, 별도 Codex rewrite 동의, 사용자 모델 보존, metadata-only 로그, 작업 revision 재검사, max/상위 모델 공동 비교, selector abstain 보존, 대응 표본 비교를 추가했습니다.
실제 API·native 모델 품질 검증은 이 릴리스의 로컬 검사에 포함되지 않습니다. 변경 근거와 검사는 최상위 문서를 따릅니다.
