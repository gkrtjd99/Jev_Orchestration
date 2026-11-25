# 3.2.0 — decision kernel, skill routing, advisory supervisor, 2026-11-25

기존 native hook의 모든 Jev 판단(위임 분류·프로필 선택·실패 분류·읽기 조언)을 provider-agnostic **decision kernel**(`src/kernel/`)의 지점(`delegation.classify`, `delegation.profile`, `failure.classify`, `read.advice`)으로 옮겼습니다. 기본 설정(`judges:['jev']`, `active`)에서는 hook 출력이 이전과 byte 단위로 같고 judge 호출 횟수도 같습니다. 지점별 `off|shadow|active` 모드와 `jev|openai|local` judge 체인, 낮은 확신 시 다음 judge로의 escalation, 원문 없는(해시·숫자·선택지 이름만) decision log(`stateDir/decisions-log`, 0600/0700)와 calibration 보고(`scripts/decisions.mjs`)를 추가했습니다.

새 지점 두 개는 기본 **off**입니다. `delegation.skills`는 위임 경계에서 프로젝트 `.claude/skills`와 `JEV_SKILL_DIRS`의 skill 카탈로그를 BM25로 좁힌 뒤 judge 확률로 load/consider를 정하고, `active`일 때만 routing packet 뒤에 이름·경로·확률만 담은 `<jev-skills>` 블록을 붙입니다(설명·본문은 주입하지 않음, `maxContextChars`를 넘으면 블록만 생략, 동일 tool id 재호출은 저장된 텍스트로 동일하게 재현). custom agent·명시적 native 설정·중첩 위임·resume 등 기존 보존 guard가 skill 작업보다 먼저 적용되며, skill judge 실패·지연은 라우팅을 실패시키거나 route deadline 이상 지연시키지 않습니다. `supervisor.outcome`은 이 확장이 라우팅한 동기 위임의 보고 텍스트만(비밀 유사 문자열이면 전송 생략) 판정해 `complete|retry|replan|escalate`와 근거 수준을 **조언으로만** 표시하며, 확신이 `kernel.supervisor.confidence` 미만이면 기존 일반 문구를 유지합니다. 자동 재시도·respawn·차단·권한 변경은 없습니다.

설정: `config.kernel`(없거나 일부만 있는 기존 설치 config는 기본값으로 병합), env `JEV_SKILLS_MODE`, `JEV_SUPERVISOR_MODE`, `JEV_SKILLS_JUDGES`, `JEV_SUPERVISOR_JUDGES`, `JEV_DECISION_JUDGES`, `JEV_SKILL_DIRS`, `JEV_OPENAI_DECISIONS_APPROVED`, `JEV_OPENAI_DECISIONS_MODEL`, `JEV_DECISION_LOG`(잘못된 값은 `INVALID_<NAME>`). `OPENAI_API_KEY`는 private `.env`에서 runtime env로만 전달되고 config에는 저장하지 않습니다. `policyFingerprint`에 kernel 설정이 포함되어 설정 변경 시 대기 중인 호출이 무효화됩니다. 설치기는 `src/kernel/`을 포함해 복사하고, `npm run check`는 하위 디렉터리까지 구문 검사하며, `scripts/skills.mjs --judge config --config <path>`는 설정된 judge 체인과 decision log를 사용합니다.

검증 범위: 2026-11-25 격리 실행(`scripts/test-all.sh`)에서 Node **498/498**, 구문 **61개 모듈**, 독립 검증기 self-test와 offline suite가 통과했습니다. 모두 mock judge·loopback 서버·주입된 fetch를 사용한 로컬 계약 검증입니다. OpenAI Decisions wire 계약과 기본 모델 이름은 실제 API로 확인하지 않았고, 실제 Jev/OpenAI 판단 품질, skill 선택의 정확도, supervisor 조언의 유용성과 calibration은 **NOT_RUN/미입증**입니다. `local` judge는 calibration되지 않은 어휘 휴리스틱입니다.

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
