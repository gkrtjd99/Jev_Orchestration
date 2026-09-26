# 실제 계획 문맥·위임 경로 비교 (2026-09-25)

이 보고서는 기존 오프라인 계약 검사를 **실제 Jev 판단과 실제 Claude CLI 위임을 동반한 한 과제의 소규모 반복 비교**로 보완합니다. 비교 산출물은 `/private/tmp/jev-routing-compare-20260925/`의 시행별 `trial.json`, native hook·transcript, TypeSafe HTTP 기록 및 평가 대상 코드 복사본입니다. 원본 프로젝트의 평가 대상 검증기 코드는 변경하지 않았습니다.

## 구현한 경계

- `Agent`/`Task` 위임 전, 별도 `JEV_SHARE_PLAN_CONTEXT=true` 동의와 현재 부모 목표의 해시가 일치하는 owner-only `.jev/routing-plan.json`이 있으면, 제한된 계획 요약·수용 조건·위임 목록을 Jev의 **분류와 프로필 선택**에 전송합니다. 부모 프롬프트 일부 전송에는 `JEV_RETAIN_PROMPT_TEXT=true`도 필요합니다. 기본값은 모두 비동의입니다. 계획 문맥은 신뢰하지 않는 데이터이며 프로필 선택은 native 권한을 대신하지 않습니다.
- `Workflow` 경계는 관측하고 내부 `agent()`가 Jev 라우팅 대상이 아님을 고지합니다. 내부 worker에 개별 `PreToolUse`가 없으므로 이 hook만으로는 내부 모델·effort를 선택할 수 없습니다. 계획 전송에 동의해도, 출처를 증명할 수 없는 같은 세션의 후속 프롬프트가 생기면 기존 부모 목표·계획을 Jev에 다시 보내지 않습니다.
- Codex 0.156.1의 실제 `collaborationspawn_agent` 이름을 인식합니다. 재작성에는 기존 Codex 승인 외에 별도의 `JEV_CODEX_COLLABORATION_REWRITE_APPROVED=true`가 필요합니다. 이번 native 시험에서는 두 승인을 켜지 않아 권고만 검증했습니다.

## 비교 설계와 결과

동일 과제: `verification/verifier/evidence.py`에서 **같은 실행 프로필의 child 두 명**을 PreToolUse `tool_use_id` → PostToolUse `agent_id` → SubagentStart로 안전하게 연결하는 코드·회귀 테스트. 과제·프로젝트 복사본·간략 계획 파일·프로필 메뉴와 Main의 `--effort ultracode` 요청은 양군에서 동일했습니다. `native`는 Jev mode `off`, `active`는 계획 공유와 Jev 라우팅을 켰습니다. 각 세션은 CLI 표시 예산 상한 $1.75, 시간 제한 330초를 사용했습니다. 과제 하나를 두 번 반복한 결과로 일반적인 품질·속도·비용의 인과효과를 판단할 수 없습니다.

| 조건·반복 | CLI 완료 | 당시 독립 계약 / 전체 테스트 | native 위임과 Jev route | 소요 시간 | CLI 표시 비용 |
|---|---|---|---|---:|---:|
| 고정 active 1 | 완료 | PASS / PASS | worker 1 / route 1 | 309초 | $1.082474 |
| 고정 native 1 | 완료 | FAIL / FAIL | worker 1 / route 0 | 282초 | $0.999811 |
| 고정 active 2 | 완료 | PASS / PASS | worker 1 / route 1 | 276초 | $0.918962 |
| 고정 native 2 | `error_max_turns`, 미완료 | PASS / PASS | worker 1 / route 0 | 218초 | $1.120082 |
| 자연 active 1 | 완료 | PASS / PASS | worker 3 / route 1 | 271초 | $1.446519 |
| 자연 native 1 | 완료 | PASS / FAIL | worker 2 / route 0 | 228초 | $1.380191 |
| 자연 active 2 | 완료 | PASS / PASS | worker 2 / route 1 | 207초 | $1.180709 |
| 자연 native 2 | 완료 | PASS / PASS | worker 2 / route 0 | 266초 | $1.093695 |

'고정'은 Main에 먼저 **동일 문장으로 native `Agent` 한 명**에게 위임하도록 요구했습니다. '자연'은 Main이 도구와 인원을 결정했습니다. 자연군의 `Workflow` 내부 worker는 어느 군에서도 Jev route로 세지 않았습니다. 네 active route 모두 Jev 프로필 선택 → hook `updatedInput` → native child의 `gpt-6-sol` 모델 관측이 연결됐습니다. **child의 실제 effort 값은 네 번 모두 관측되지 않았습니다.** 고정 native 두 시행의 기본 child도 `gpt-6-sol`이었고, 자연 native 1의 두 child도 같은 모델이었습니다. 자연 native 2는 child transcript 모델 정보를 확보하지 못했습니다. 따라서 **선택된 프로필은 확인했으나 실제 모델 변경이나 effort 배분 개선은 확인하지 못했습니다.** 네 route에서 Jev HTTP 요청은 총 5회였고, 그중 3회에 계획과 부모 목표가 실렸습니다. 자연 active 1의 2회는 후속 프롬프트 출처가 불명확해 두 문맥을 보류했습니다. 양군에 제공된 계획은 시험 드라이버가 작성한 **동일 요약 파일**로, 각 Main이 자유롭게 세운 내부 계획 전체를 Jev가 읽었다는 증거는 아닙니다.

당시 좁은 채점과 CLI 완료를 함께 요구하면 active 4/4, native 1/4입니다. **이 숫자를 품질 우위로 해석하면 안 됩니다.** 사후에 발견한 평가 계약의 결함 때문에 당시 가상 이벤트는 실제 hook에 있는 `session_id`와 `tool_name`을 빠뜨렸습니다. 이 필드를 엄격히 대조한 고정 native 1 구현은 현실적인 두 연결 사례에서는 통과했는데 원래 독립 계약에서는 실패했습니다. 그 시행의 생성 회귀 테스트도 실제 모델 alias가 미해결일 때 `INCONCLUSIVE_ALIAS_UNRESOLVED`인 결과를 무리하게 `FAIL`로 기대하여 실패했습니다. 다른 실패에도 생성된 테스트의 이벤트 형태가 영향을 미칠 수 있습니다.

**사후 탐색적 재검사**에서 저장된 여덟 구현 모두 실제 형태(`session_id`, `tool_name` 포함)의 명시적 두 연결과 무연결 보류를 통과했습니다. 잘못된 세션·도구 이름, 실패 응답, 중복 Post, 없는 child, 중복 child ID를 추가한 여덟 사례에서는 active 구현이 시행별 6/8·6/8·4/8·8/8, native 구현이 7/8·4/8·5/8·5/8이었습니다. 이는 시행 후 만든 제한된 강건성 검사지표이지 사전 등록된 독립 품질 점수나 통계적 우위가 아닙니다. 생성된 구현들은 원본 검증기에 병합하지 않았습니다. 따라서 **실제로 확인된 것은 문맥 전달과 일부 native 위임 라우팅의 작동이며, 더 나은 worker 배분·산출물 품질이라는 핵심 효과는 아직 입증되지 않았습니다.**

## 실제 Codex 경로

격리 HOME 및 project에서 Codex **0.156.1**이 `collaborationspawn_agent`를 실제 `PreToolUse`/`PostToolUse`로 전달했고, Jev는 유효한 실제 HTTP 응답 2회로 판단했습니다. 기본 권한 승인 플래그를 유지하여 `updatedInput` 재작성은 **0회**였습니다. native 세션은 종료 코드 0, child 1명 관측, 원본 소스 및 격리 프로젝트 변경 없음이었습니다. 이 시험은 Codex의 강제 route, `permissionDecision:'allow'`의 권한 의미, 별도 승인 상태의 native 적용을 입증하지 않습니다. 임시 Codex 패키지 및 인증 복사본은 시험 후 제거했습니다.

## 비용 범위

- 최종 Claude CLI 8회 **표시값 합계 $9.222443**. 고정 active/native 각각 $2.001436/$2.119893, 자연 active/native 각각 $2.627228/$2.473886입니다. 자연군은 active의 표시 비용이 더 들었으며, 고정군의 native 미완료까지 섞어 저비용 우위를 판단할 수 없습니다. 시간도 고정 active/native 합계 약 585/500초, 자연 active/native 합계 약 478/494초로 일관된 개선이 아닙니다. 양군 모두의 CLI 표시값은 청구서가 아닙니다. 두 제외 파일럿 표시값 $2.279777을 더하면 이 단계에서 확인한 Claude CLI 표시값은 **$11.502220**입니다. 이전 단계의 다른 실험 비용과 합산하지 않았습니다.
- 최종 active군 Jev: 성공 응답 5회, **입력 11,554 / 출력 1,682 token**. TypeSafe 공개 단가인 입력 **$0.042/백만 token**, 출력 **무료**를 적용한 API 추정액은 **$0.000485268**입니다. 제외 파일럿의 성공 응답 1회(입력 2,497 / 출력 389)는 추가 **$0.000104874** 추정액입니다.
- Codex 권고 관측은 Jev 2회(입력 3,439 / 출력 372), 같은 공개 단가 기준 **$0.000144438** 추정액입니다. Codex CLI의 총 청구 비용은 이 관측에서 알 수 없고 CLI가 보고한 토큰은 전체 작업의 금액이 아닙니다.
- 공개 단가 출처: [TypeSafe, *Introducing System One Models and Jev*](https://typesafe.ai/blog/introducing-system-one-models-and-jev). 실제 청구 금액과 캐시 할인·플랫폼 요금은 확인하지 않았습니다. Jev 추정액은 CLI 표시 비용의 청구 증빙도, 전체 실험의 총비용도 아닙니다.

## 재현과 한계

최종 소스는 JS 구문 검사 **35 모듈**, orchestration **222/222**, 검증기 자체 **54/54**, 독립 offline **31 PASS / 1 NOT_RUN(유료 단계), exit 0**, 원본 SUT 무변경을 확인했습니다. 검증기 자체 검사에는 Node 22 바이너리를 `PATH`에 제공해야 하고, 환경 변수를 검사하는 테스트의 계약을 깨지 않도록 `VERIFY_NODE_BIN`을 자체 검사 호출에만 주입하지 않았습니다. 앞선 잘못된 환경에서 실패한 두 차례의 자체 검사는 실패 그대로 두고, 적절한 분리 환경에서 전체 재실행해 통과했습니다.

실험 과제는 하나이며 반복 2회씩은 독립 task 2종이 아닙니다. native Main의 계획·worker 수는 자연 시행마다 달랐습니다. provider의 숨은 계산 수준, Jev의 업무 이해도·일반적 최적화 및 실제 청구 비용은 증명하지 못합니다. 계획 전송 패턴 검사도 완전한 비밀정보 보호 기능이 아닙니다. 결과 파일에는 작업 프롬프트·코드가 있으므로 외부 게시 전 별도 내용을 검토해야 합니다.
