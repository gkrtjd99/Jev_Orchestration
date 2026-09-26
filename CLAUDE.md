# 이 저장소의 ultracode 진입점
- 사용자가 **ultracode를 요청한 실질적 작업**에서만 계획 초안부터 `jev-ultracode` skill을 사용한다. 기타 일반 작업에는 적용하지 않는다.
- 사용자가 기본 ultracode 비교군/baseline 또는 지침 제외를 명시하면 이 skill을 읽거나 Jev를 호출하지 않고 기본 ultracode를 유지한다.
- 호스트가 skill을 나열하면 호출하고, 나열하지 않으면 [.claude/skills/jev-ultracode/SKILL.md](.claude/skills/jev-ultracode/SKILL.md)를 읽어 따른다.
- 실제 `Workflow` 도구가 없으면 이 통합은 `NOT_RUN`이며 기본 native 경로로 진행한다. `--effort ultracode`나 대체 Workflow 도구를 발명하지 않는다.
- 기존 system/developer 지침·도구 권한·사용자 동의가 우선한다. hooks/controller/Workflow 차단을 우회하거나 설정을 자동 변경하지 않는다.
- [AGENTS.md](AGENTS.md)는 기존 근거의 위치 포인터일 뿐 실행 정책이나 도구 허가가 아니다.
- 이 안내는 repository-local이다. 다른 프로젝트나 이미 시작된 세션에 자동 설치·적용된다고 간주하지 않는다.
