# 실모델 저장소 유지보수 pilot: native / controller (2026-09-26)

## 판정

동일한 알려진 회귀를 다시 주입한 **서로 다른 두 과제**에서, 실제 Claude CLI를 사용한 `native` 후보는 두 번 모두 원래 저장소의 독립 채점을 통과했고, `controller` 후보는 두 번 모두 **소스 변경 없이 실패**했습니다. 이것은 이번 과제의 불리한 실측 결과이지, 모든 작업에서 어느 방식이 우월하다는 추정치는 아닙니다. `controller`의 짧은 실행 시간·낮은 CLI 표시 비용은 **목표를 달성하지 못한 시행의 값**이므로 생산성 또는 절감 효과로 해석할 수 없습니다.

기존 Jev `active`는 **NOT_RUN**입니다. 유료 호출 동의와 작업 내용·메타데이터의 별도 TypeSafe 전송 동의는 다르며, 후자는 확인되지 않았습니다. 이번 네 세션의 Jev 요청은 모두 0회입니다. 따라서 **세 조건 품질·작업 시간·토큰·총비용의 우위는 INCONCLUSIVE**입니다. 실제 청구 총액도 알 수 없습니다. 보관된 원본 시행 보고서의 전체 판정은 두 과제 모두 `INCONCLUSIVE`이고, 아래의 독립 채점 성공·실패는 별도로 표시합니다.

## 실험 조건과 수치

확인된 로컬 모델 프록시의 registry는 `light=gpt-6-luna`, `standard=gpt-6-sol`, `strategic=gpt-6-astra`입니다. 사용자가 지정한 대응은 각각 Sonnet/Luna, Opus/Sol, Fable/Astra입니다. Main은 Sol을 요청했고, controller만 계획·상태 파일 및 우선 위임 규약을 추가했습니다. 같은 과제의 두 조건은 같은 커밋·결함·목표·신뢰 테스트를 사용했습니다. 첫 과제의 커밋은 `5623070`, 두 번째 과제의 커밋은 관측기 보정을 마친 `52bddf5`입니다. 순서는 두 과제 모두 native→controller였으므로 순서 효과가 통제되지 않았습니다.

| 과제 / 조건 | 독립 채점·변경 | CLI 경과 | CLI 입력 / 캐시 읽기 / 출력 토큰 | CLI 표시 비용 |
|---|---|---:|---:|---:|
| `controller-lifecycle` / native | **통과**, 신뢰 Node 13개 실행·허용된 소스와 회귀 테스트만 변경 | 386.401초 | 56,069 / 2,143,104 / 6,932 | $1.475805 |
| `controller-lifecycle` / controller | **실패**, 신뢰 Node 13개 실행·변경 파일 0개 | 86.659초 | 36,069 / 294,912 / 1,910 | $0.507060 |
| `child-effort-evidence` / native | **통과**, 신뢰 Python 61개 실행·허용된 소스와 회귀 테스트만 변경 | 215.765초 | 34,581 / 294,656 / 2,448 | $0.556508 |
| `child-effort-evidence` / controller | **실패**, 신뢰 Python 61개 실행·변경 파일 0개 | 77.710초 | 26,991 / 303,872 / 2,010 | $0.391484 |

토큰은 CLI가 보고한 세션 결과입니다. 캐시 읽기를 일반 입력과 합치거나 동일 단가로 환산하지 않습니다. 두 native 세션에는 각각 `result` 이벤트가 **2개** 있었습니다. 결과 이벤트의 토큰을 구간별로 합산하되, 같은 세션 ID의 CLI 표시 비용이 단조 증가한 마지막 값을 누적값으로 **추정**했습니다. 특히 첫 native를 마지막 이벤트만 읽으면 입력 2,327·캐시 읽기 87,808·출력 191이 되어 심각한 과소계상입니다. 첫 native의 구간별 합계는 위 표의 56,069·2,143,104·6,932입니다. 수정된 관측기는 다중 결과가 서로 다른 세션이거나 비용이 감소하면 총값을 unknown으로 처리하고 합산 가정을 필드로 남깁니다. 네 세션의 **CLI 표시 비용 합계 $2.930857**은 청구서가 아닙니다. 본 시행 전 저장소 내용 없는 모델 접근 확인 3회의 CLI 표시 합계 $0.201712는 위 표에 포함하지 않았습니다. 실제 제공자 신원·내부 연산량·청구 총액은 이 자료로 검증되지 않습니다.

Claude CLI 2.1.283에 `--max-turns`가 없어 계획의 32턴은 강제되지 않았습니다. 세션별 `--max-budget-usd=3`은 요청값이지 native와 TypeSafe를 합친 청구 상한이 아닙니다. 각 CLI 프로세스의 wall-time 상한은 600초였으며, 위 네 세션은 타임아웃되지 않았습니다. 경과 시간은 CLI 프로세스 실행 시간이고 독립 채점·사전 canary 시간은 제외했습니다. 독립 채점은 결과 확인 전 고정한 테스트를 작업 저장소 밖에서 후보 **코드만** 옮겨 실행했습니다. 결함 주입본은 실패하고 원래 코드 복구본은 통과했습니다. 이 채점기는 악의적인 코드의 완전한 sandbox가 아닙니다.

## 실제 worker·산출물 검토

- 첫 native는 하나의 Sol/high worker가 같은 agent ID로 두 번 시작·종료된 **재개(resume)** 패턴이었습니다. `Agent`의 `PostToolUse.status=async_launched`는 시작 승인일 뿐 완료 증거가 아니며, 나중의 start/stop과 해당 `tool_use_id`·agent ID를 함께 확인했습니다. 기존 시행 보고서에서 `native_workers_observed=false`였던 것은 관측기가 시작·종료를 정확히 한 쌍씩만 허용한 **허위 음성**입니다. 원본 보고서를 고쳐 쓰지 않고, 관측기 수정·회귀 검사 뒤 보존된 hook으로 다시 계산하면 연결됩니다.
- 첫 native 수정은 같은 millisecond에 기록된 route/start/stop의 순서를 이벤트 파일 `mtimeNs`로 구분하고, 성공한 해당 ID의 `PostToolUse`도 요구합니다. 생성된 회귀 테스트는 동일 millisecond, 실패 응답, 다른 ID, route보다 이른 stop/start를 다룹니다. 후보 코드만 옮긴 신뢰 Node **243/243**, 후보가 만든 테스트까지 포함한 **250/250**, 구문 검사가 통과했습니다. 처음 관측된 전체 시험의 17개 실패는 비정규화된 macOS `/var`·`/private/var` 임시 경로 조건에서 **원본과 후보 모두 동일하게** 발생했습니다. 물리 경로로 재실행해 양쪽 모두 243/243을 확인했습니다. `mtimeNs`는 로컬 파일 기록 순서의 근거이지 외부에서 인증된 타임스탬프나 실제 검사 성공 증명이 아닙니다.
- 두 번째 native는 Sol/high worker 한 명의 시작·종료·typed 모델/effort가 연결됐습니다. 후보 수정은 `assistant.agentId`가 표시된 기록에 다른 agent의 비표시 기록과 `system` 설정을 섞어 넣지 않고, prose·요청 profile을 실제 관측으로 취급하지 않습니다. Codex의 `turn_context` 파싱은 기존 검사에서 유지됐습니다. 후보 코드만 이식한 신뢰 Python **61/61**, 후보 회귀 테스트를 더한 **64/64**가 통과했습니다. 혼합 형식의 모든 실제 런타임 구현을 인증한 것은 아닙니다.
- 첫 controller는 Astra/xhigh 계획, Sol/xhigh 계약 검토, Luna/high 조사, 추가 Astra/xhigh 계획을 네 번 요청했습니다. 완료된 Sol·Luna worker의 typed 모델/effort는 요청과 맞았으나, 두 계획 worker에는 부모 세션이 끝날 때까지 stop이 없었습니다. 구현 route도 계획 파일도 없고 코드를 바꾸지 않았습니다. 두 번째 controller 역시 네 번 요청했지만 `PostToolUse`는 모두 `async_launched`, `SubagentStop`은 **0건**이었습니다. 일부 child transcript에 Astra·Sol·Luna의 typed 설정이 있어도 완료·연결을 입증하지 못합니다. 두 시행 모두 독립 채점은 실패했습니다.
- 두 controller 세션 각각 `UserPromptSubmit`가 5회 관측됐습니다. 첫 이벤트 이후 네 건의 내용에는 `task-notification` 표지가 있고 agent attribution이 없습니다. 현 hook은 출처를 인증할 수 없는 후속 prompt에서 목표 출처를 fail-closed로 무효화하며, 실제로 매번 해당 경고를 반환했습니다. native에도 이런 후속 이벤트가 있었습니다. **내용 표지만으로 진짜 사용자의 추가 입력과 자동 알림을 신뢰성 있게 구분할 수 없으므로**, 이 보고서를 위해 제품의 출처 검사를 완화하거나 사후에 controller 성공으로 재표기하지 않았습니다. 비동기 worker가 완료되기 전에 Main이 종료한 점과 이 출처 경계가 함께 진행 장애로 관측됩니다. 어느 한쪽만 제거하면 품질이 회복된다고 입증하지는 않았습니다.

## 해석·남은 경계

두 개의 **알려진 결함**을 복원하는 과제는 새로운 개발 문제의 대표 표본이 아닙니다. native의 실제 코드·검사 결과와 controller의 무수정 실패는 이 두 과제에서 명확하지만, 유료 호출 네 번의 기술통계만으로 분산·신뢰구간·일반적인 성능 우위를 만들 수 없습니다. 모델/effort는 child transcript의 typed 관측과 프로필 요청을 구별했고, 제공자의 숨은 effort는 알 수 없습니다. controller의 구현 worker route 부재, 첫 시행의 미완료 계획 worker, 두 번째 시행의 stop 전무와 TypeSafe active 부재를 포함한 비교 판정은 계속 `INCONCLUSIVE`입니다.

`active`를 실행하려면 **작업 목표·코드/메타데이터를 TypeSafe에 보낸다는 별도 명시적 승인**이 필요합니다. 이번에는 TypeSafe 요청, 실제 AgentOTelStack 수집·조회, 원격 Git push를 하지 않았습니다. 원본 프롬프트·자격 증명·transcript·private JSON 보고서는 저장소 밖에 보존하며, 이 공개 가능한 요약에 포함하지 않았습니다. 제품 소스에는 worker 후보 패치를 병합하지 않았습니다.
