# 보안·실행 한계

## 신뢰 경계

이 확장은 사용자 홈의 신뢰된 설정을 읽고 허용된 프로젝트에만 개입합니다. 프로젝트 문서·위임 텍스트·로그는 판단 데이터이지 상위 지침이 아닙니다. API 키는 별도 owner-only env에 두며 코드 저장소/로그/판단 state에 넣지 않습니다. 간단한 secret pattern 검사는 완전한 DLP가 아니므로 민감한 내용을 전송하지 않을 책임과 조직 정책은 여전히 필요합니다.

Jev는 권한을 부여하지 않습니다. Claude에서는 `allow` 없이 인자만 바꿉니다. Codex는 protocol 제약 때문에 `allow`가 필요한 경로를 별도 opt-in으로 분리했습니다. 활성화를 승인해도 기존 호스트/OS 제한을 넓힐 권한이 생기지는 않습니다. 알 수 없는 인자·custom agent·resume·명시 모델·강제 environment override·nested 위임은 보존합니다.

이름이 비슷한 MCP 도구를 native spawn으로 간주하지 않습니다. model/effort는 지원 registry에서만 가져오며 확인 안 된 값을 임의로 보정하지 않습니다. profile file hash를 검사하지만, 모델 사용 권한이나 실제 backend 적용까지 증명하지는 않습니다.

여러 router hook이 같은 도구를 수정하면 적용 순서를 보장할 수 없습니다. 알려진 이전 project Jev hook은 installer가 탐지하지만 모든 타사 router를 식별하는 것은 아닙니다. 단일 routing owner를 유지하세요. `JEV_SHARE_PLAN_CONTEXT=true`는 프로젝트 내 owner-only `.jev/routing-plan.json`의 제한된 요약을 **TypeSafe로 전송하는 별도 동의**입니다. 목표 해시·파일 권한·크기·비밀 패턴을 검사하지만 완전한 DLP가 아닙니다. 계획 파일은 원본 프로젝트에 남고, 기존 `JEV_RETAIN_PROMPT_TEXT`까지 켜면 부모 목표 일부도 외부로 나갑니다. `Workflow` 내부 `agent()`는 이 hook 경계 밖이므로 그 실행에는 Jev 결정이 적용되지 않습니다.

## 상태·네트워크

기본 로그는 원문 대신 hash·결정·관측 메타데이터입니다. 캐시는 계정/세션/프로젝트/질문/state가 다르면 재사용하지 않습니다. pending 결정은 코드·문서·목표의 변경을 확인하며, 판단 중 변화가 생겨도 적용하지 않습니다. bounded snapshot은 파일 시스템 트랜잭션이나 모든 바이너리 변경에 대한 증명이 아닙니다.

요청 cap·deadline·회로 차단은 Jev 호출의 폭주를 줄이는 장치입니다. 전체 생성모델 달러 예산을 보장하지 않으며, 토큰/비용을 모르면 unknown입니다. 훅 runtime은 worker 실행·재시도 루프를 소유하지 않습니다. watchdog timeout은 native 호스트의 오류 처리에 따르므로 hook 자체를 절대적인 보안 강제선으로 사용하지 마세요. `JEV_WORKFLOW_POLICY=block`은 신뢰된 hook이 정상 실행되고 `active`인 Claude 세션의 `Workflow` 요청을 거부하는 운영 정책입니다. 미설치·비활성·미신뢰 hook 및 입력·설정 오류나 watchdog 종료는 거부를 보장하지 않습니다. native `Agent` 위임도 부적격·명시 모델·custom agent·Jev 장애 등에는 원래 호출 그대로 실행될 수 있으므로 완전한 worker 통제나 성공 증거가 아닙니다.

## Claude controller의 추가 경계

`controller`는 기존 Jev active 재작성과 상호 배타적입니다. 로컬 프로필 선택은 Astra 계획의 **신뢰되지 않은 분류값**을 입력으로 받는 정책이지 Astra의 실제 작성·판단을 인증하지 않습니다. 계획은 목표 해시·owner-only 디렉터리·파일 identity·크기·경로·DAG 충돌을 검사하지만, 다른 프로세스가 같은 UID로 파일을 바꾸거나 작업 내용을 속이는 행위를 격리하지 않습니다. `.jev/controller-status.json`도 Main이 보고한 검사 hash와 실제로 관측한 native spawn/stop의 연결만 확인하며 독립 검증 결과를 자동 채점하지 않습니다. 원본 증거를 보관하고 사용자가 검토하세요.

Main의 직접 도구 거부는 **정상 설치·신뢰·호출된 Claude PreToolUse**와 callback의 `agent_id`에 의존합니다. 알려지지 않은 도구 이름도 matcher에 포함하지만 누락된 child ID는 Main/worker 오식별을 초래할 수 있습니다. worker의 `readPaths`/`writePaths`는 텍스트 계약일 뿐 도구 수준 권한 제한이 아닙니다. `Workflow` 내부 위임은 이 모드에서 호출 전 거부하지만 native hook을 우회하는 모든 실행을 탐지하는 sandbox는 아닙니다. CLI 진입 전 설정 오류, 타임아웃, 다른 hook의 재작성, hook 미신뢰 상황은 내부 fail-closed 분기를 우회할 수 있습니다. 따라서 이 제약을 보안 격리·비밀 보호·권한 승인의 근거로 사용하지 마세요.

Jev 비평을 명시적으로 켜면 계획 요약·task 설명·경로가 외부 TypeSafe로 전송됩니다. secret pattern 검사는 완전한 DLP가 아니며 키가 있어도 자동 사용자 동의가 생기지 않습니다. AgentOTelStack 전송은 별도 opt-in, 실제 **ingest** 토큰, numeric loopback의 4318 포트, protobuf를 요구합니다. local Gateway가 성공 응답을 돌려주어도 저장·조회까지 인증되지 않습니다. OTel span에는 고정 코드·해시/계획 버전만 허용하고 원문 목표·출력·경로·토큰을 싣지 않습니다. 로컬 trace의 hash는 익명화나 제3자 접근 제어가 아닙니다. 두 외부 서비스에 보낼 데이터를 별도로 검토하세요.

## 검증기

검증기는 별도 프로세스·임시 HOME·원본 해시·테스트 외부 보관·실제/합성 구분을 사용합니다. `INDEPENDENT_CHECKS_PASSED` 출력과 exit 0만으로 성공을 인정하던 취약 경로를 제거했습니다. 실행별 nonce, 먼저 확보한 assertion/writer, seek할 수 없는 stdin pipe, 제한된 읽기 경로를 사용합니다. 상수 marker·조기 종료·stdin 되감기·assert 덮어쓰기·grader 파일 읽기를 회귀 검사합니다.

**Node permission model은 악성 코드를 안전하게 실행하는 sandbox가 아닙니다.** 공식 문서도 이를 resource safety 장치로 설명합니다. 실제 생성 코드 또는 신뢰하지 않는 custom suite는 별도 폐기 가능한 VM/container에서 실행하세요. 네트워크·동일 UID 프로세스·OS 자원에 대한 완전 격리를 이 패키지가 제공한다고 주장하지 않습니다.

실제 native 검증에서 파일 기반 로그인을 복사하는 기능은 `--reuse-cli-login`으로 명시적으로 요청한 경우에만 임시 HOME에서 작동하고 cleanup합니다. production hook은 해당 기능을 사용하지 않습니다. 검증에 API 키를 쓰는 경우 역시 verifier 전용 env에서 지정하고 보고서에 실키가 없는지 확인하세요. 실계정 테스트는 직접 검토한 명령으로만 실행합니다.
