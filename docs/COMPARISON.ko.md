# 비교 검토와 통합 결정 — 2026-09-25

## 검사 대상

사용자가 제공한 `Jev_Orchestration-optimized-router-0.4.0-router.1(1).zip`, `Jev_Verifier-independent-1.0.0(1).zip`, 이전 대화에서 만든 `jev-native-orchestration-v2.3.zip`을 추출해 코드와 테스트를 검사했습니다. 원본 SHA-256은 `source-inputs.json`에 있습니다. 설명만 읽어 기능이 구현됐다고 판단하지 않았습니다.

원본을 수정하기 전에 재실행한 결과는 optimized router **174/174**, native v2.3 **165/165**, verifier **44/44** 통과입니다. 실계정은 사용하지 않았습니다. 이 수치는 서로 다른 검사군이며 더 큰 숫자가 더 좋은 오케스트레이션을 의미하지 않습니다.

## 기능 비교와 선택

| 차원 | optimized router | native v2.3 | 최종 결정 |
|---|---|---|---|
| native 실행 연결 | PreToolUse에서 Agent/spawn 인자 변경 | UserPromptSubmit 권고 중심 | optimized 연결 채택. off/shadow/advisory/active로 분리 |
| 생성모델 실행 엔진 | 기존 native worker | 기존 native worker | 새 CLI/Main/실행 루프 없음 |
| 판단 경로 | 분류 후 실제 프로필 선택 | Python 정책/권고 | JS 단일 판단 코어에 통합; 같은 일을 하는 두 router 동시 설치 금지 |
| effort 정책 | light 저/중 effort, 단계적 승급 | substantive light xhigh/max 중심 | 고-effort 초기 후보·구체 rubric·max/상위 모델 공동 비교 |
| 외부 전송 | 키와 mode 중심 | 별도 명시적 egress 동의 | egress false 기본, endpoint 제한·secret guard |
| 가용성 | declared 후보 허용 기본 | 확인한 capability만 후보 | requireConfirmedAvailability=true 기본 |
| 사용자 설정 | generic call 모델 재작성 가능 | 권고로 Main 설정 보존 | 명시 모델·custom agent·resume·forced env·nested 호출 보존 |
| Codex 승인 | updatedInput+allow | 재작성하지 않음 | 별도 opt-in 전까지 권고; 모르는 permission 입력 보존 |
| 문서 | metadata inventory/필수 reference/관련성 | context pack 설계 | 선택 목록은 접근 권한이 아님. 필수 문서 누락 표시 |
| 상태 | cache·task lock·projection·recovery | SQLite·기계 계약 참조 | JS 상태 채택, 목표·source revision과 in-flight 재검사 추가 |
| 검증·학습 | 명시적 외부 자료 import | 평가 계획 | 외부 verifier 분리, 같은 cohort만 empirical 비교, 없는 측정치 생성 금지 |

## 실제 확인한 결함과 수정

### A. 검증기의 성공 marker 위조

원본 `verification/verifier/tasks.py`는 같은 Node process에서 solution과 검사를 실행하고 고정 marker+exit 0을 성공 조건으로 사용했습니다. 깨진 구현 앞에 `console.log('INDEPENDENT_CHECKS_PASSED'); process.exit(0);`를 넣자 **실제로 passed=true**가 나왔습니다. 원본 fixture가 통과한 것과 별개인 문제입니다.

이번 수정에서는 nonce 완료 증명, 먼저 준비한 assertion/writer, permission-limited grader, seek 불가능한 stdin을 사용했습니다. 수정 과정에서 seek 가능한 임시 stdin descriptor로 nonce를 읽어내는 반례도 재현해 pipe로 변경했습니다. 관련 공격형 fixture를 회귀 검사에 추가했습니다. 이것은 재현된 오판 경로의 수정이며 악성 코드 격리의 완전성 증명이 아닙니다.

### B. 비교 표본 누락

원본 `verifier/statistics.py`는 baseline-active 짝이 있는 행만 골라 나머지를 빠뜨릴 수 있었습니다. 실패·중단 측이 빠진 자료로 좋은 쪽만 비교하지 않도록, 짝이 누락되면 `INCOMPLETE_PAIRED_COHORT`로 보류합니다. boolean/NaN/음수 시간·비용과 비boolean pass값도 거부합니다.

### C. 모델 판단과 강제 권한의 혼합

첨부 router의 Codex `allow`는 현행 인자 변경 계약에 필요하지만, 라우터 판단만으로 암묵 승인하면 안 됩니다. 별도 `JEV_CODEX_REWRITE_APPROVED`와 known-input 검사로 분리했습니다. Claude에는 allow를 넣지 않습니다. 현재 자동 적용을 실호스트에서 검증했다는 주장은 하지 않습니다.

### D. 오래된 결정 재사용

HEAD와 문서 메타데이터만으로 dirty source 변경을 충분히 식별하지 못했습니다. 로컬 bounded content fingerprint·parent goal·task stamp를 함께 확인하고 API 응답 후 다시 비교합니다. 같은 tool ID라도 그 사이 변경되면 재작성하지 않습니다.

### E. 불확실한 선택의 임의 대체

selector가 defer를 반환해도 incumbent으로 바꿀 수 있던 경로를 보류로 고쳤습니다. selector HTTP 오류에는 이미 유효한 initial-policy 후보를 유지할 수 있지만, **선택 보류를 성공한 새 선택으로 포장하지 않습니다.** 로그에 근거를 구분합니다.

### F. 저-effort 기준에 의존한 작은 모델 평가

Sonnet/Luna substantive 작업에서 xhigh/max가 후보에 들어가며, 정형 기계 작업만 high 예외를 둡니다. max는 첫 시도부터 선택할 수 있고, retry에서도 같은 모델의 더 높은 effort와 큰 모델을 함께 비교합니다. 원본의 model role·effort intent·실제 backend 구분은 유지했습니다.

### G. 문맥·키·중복 설치

기본 원문 prompt 저장을 제거하고 owner-only env·duplicate/expansion 검사·동의별 네트워크 차단을 적용했습니다. 이전 project-local Jev hooks가 남아 있으면 설치를 멈춥니다. 실제 권한 격리·동시 writer 작업 스케줄러를 추가한 것은 아닙니다.

## 의도적으로 넣지 않은 것

새 native worker 런처, 항상 최상위 planner 호출, 매 Read마다 Jev 호출, 매 Stop마다 끝없는 리뷰, 실패한 검증을 재시도해서 성공처럼 기록하는 기능, 미측정 가격/성공률을 활용하는 optimizer, max→상위 모델의 의무적인 실패 사다리, 전체 대화·KV cache 재작성은 넣지 않았습니다.

독립 verifier를 runtime Stop hook에 직접 넣지 않았습니다. 릴리스 검증·비교 평가 도구로 유지해 token/비용 증가와 완료 루프를 피합니다. 실제 개발 task의 완료 근거 확인은 Main 책임이며 원한다는 가정만으로 모든 작업을 검증기 benchmark로 바꾸지 않습니다.

## 결론의 범위

최종판은 기능·권한·판정 책임을 일관되게 연결하고 재현된 결함을 수정한 통합 구현입니다. '기존 모델보다 빠르고 싸며 정확하다' 또는 '모든 환경에서 가장 좋다'는 결론은 이 검사로 얻지 못했습니다. native model/effort 적용·작업 품질·실제 비용은 다음의 실계정 검증 단계에서만 판단해야 합니다.
