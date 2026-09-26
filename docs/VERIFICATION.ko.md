# 검증 방법과 판정 범위

## 세 단계는 다른 주장입니다

1. **Unit/contract:** 2026-09-26 현재 오케스트레이션 Node 테스트 **243/243**, 검증기 자기 테스트 **59/59**와 `npm run check` 통과를 확인했습니다. 코드의 분기·구조·모의 서버 계약을 검사합니다. 모델 판단 정확도가 아닙니다.
2. **Independent offline black box:** verifier는 SUT 소스를 import하지 않고 공개 installer와 stdin hook을 호출합니다. 합성 TypeSafe 응답, 임시 HOME, 원본 source hash를 사용합니다. 별도 acceptance suite는 올바른 reference를 통과시키고 깨진 stub을 거부합니다.
3. **Real native comparison:** 실제 TypeSafe·Claude 계정과 격리된 프로젝트에서 한 과제의 고정/자연 위임을 각 2쌍 비교했습니다. Codex 0.156.1에서는 새 협업 spawn 이름과 Jev 판단을 권고 모드로 관측했습니다. Claude의 개별 route→child 모델은 관측했습니다. 후속 유지보수 3쌍·웹 1쌍의 child `.jsonl` 최상위 assistant 이벤트에서는 **2/4쌍의 CLI typed effort `high→xhigh`**가 확인됐지만, 제공자 내부 연산량이나 그 변경의 인과적 품질 효과는 관측되지 않았습니다. 원래 채점 계약의 결함과 작은 표본 때문에 품질·비용 우위는 판정하지 않습니다. [실험·사후 재채점 상세](../reports/PLAN_ROUTING_COMPARISON_20260925.md).

`PASS`, `FAIL`, `BLOCKED`, `INCONCLUSIVE`, `NOT_RUN`을 구분합니다. [2026-09-26 독립 offline 공개 요약](../reports/controller-offline-20260926-final/report.ko.md)는 격리된 HOME의 공개 설치·두 runtime의 이전 라우팅 계약·고장 시 fallback·8개 손상 fixture 거부·SUT 원본 불변을 PASS로 기록합니다. `live_stages=NOT_RUN`이며 새 controller의 품질을 채점하지 않습니다. 공개 요약은 마지막 controller 수용 순서·observer 수정 **이전의 보존 스냅샷**입니다. 이후 전체 offline suite를 임시 비공개 출력에 다시 실행해 exit 0을 확인했지만 원본 JSON을 소급 교체하지 않습니다. offline exit 0은 전체 제품 성능 인증이 아닙니다. 통계 코드의 합성 테스트는 라우터가 우수하다는 근거가 아닙니다.

## 재현

```bash
bash scripts/test-all.sh
# 단계별:
(cd orchestration && npm test && npm run check)
python3 verification/verify.py --self-test --sut ./orchestration
python3 verification/verify.py --suite offline --sut ./orchestration --out /tmp/jev-independent-offline
```

첫 명령은 별도의 빈 HOME과 제한된 env에서 실행해 사용자 키·모델 override를 테스트에 상속하지 않습니다. asdf Node shim은 격리 HOME에서 동작하지 않으므로 설치된 Node의 실제 실행 파일을 찾아 PATH에 앞세우고, Python 3.11+ interpreter를 선택합니다. macOS의 `/tmp`·`/private/tmp` 별칭은 물리 경로 `TMPDIR`로 통일합니다. 단계별 명령에는 같은 PATH·TMPDIR 조건을 적용해야 합니다. interpreter와 git가 없으면 실패 또는 BLOCKED이며 통과로 바꾸지 않습니다.

검증기와 SUT는 형제 폴더여야 합니다. SUT 내부에 verifier를 넣어 자기 소스를 검사하는 구조는 허용하지 않습니다. 결과 폴더도 SUT 밖이어야 합니다. 오케스트레이션의 unit test·optimizer score·모의 PASS 문구는 black-box 판정에 사용하지 않습니다.

## 새 Claude controller 경로의 별도 검사

`orchestration/test/controller.test.mjs`는 사설 계획 schema, 민감 경계·confirmed 프로필, Main 직접 작업/Workflow 거부, 실제 설치된 CLI stdin 호출, 선행 task 수용 기록, Jev 비구속적 비평, **decoded OTLP protobuf** 필드/비밀 제외를 검사합니다. mock worker/가짜 gateway를 쓰는 오프라인 계약 검사입니다. 기존 `verification/verify.py --suite offline`은 이전 Jev 라우팅 인터페이스 검증기이며 **controller의 품질이나 OTLP 실제 수집을 독립 인증하지 않습니다**.

실모델 controller의 객관적 비교를 하려면 사용자 목표·필수 파일·acceptance를 결과 확인 전에 고정하고, Main의 첫 목표 hash→Astra 계획 출처→task DAG→native child 모델과 CLI typed effort→실제 파일·검사·검토→첫 시도 및 전체 시도의 품질·시간·토큰·비용을 각각 수집해야 합니다. `controller-status.json`의 Main attestation, `SubagentStop`, Gateway `200`, Jev 점수를 객관적 성공으로 세지 마세요. native/legacy/controller를 동일 목표·격리 환경에서 짝지어 비교하고, 모델 접근·시도 수·작업 순서·기준 변경을 보고해야 합니다. 실제 동기 `Agent`의 SubagentStop→PostToolUse 순서와 typed `assistant.effort` 파싱은 2026-09-26 오프라인 회귀에서 보완했습니다. 검증기의 observer는 호스트 matcher와 SUT stdout/stderr/종료 코드를 보존하지만, Python proxy의 추가 지연과 native hook 미호출은 별도로 관측해야 합니다. **세 조건의 동일 실저장소 작업을 실행·채점하는 driver와 사전에 확정된 실계정 registry/비용 한도는 아직 없습니다.** 기존 작은 함수 과제나 수정된 회귀 테스트를 실제 품질 비교로 대체하지 마세요. 이 새 controller의 실계정 A/B와 실제 AgentOTelStack 수집·조회는 수행 여부를 별도로 표시합니다. [운영 계약](CONTROLLER.ko.md)을 보세요.

## 실제 검증을 준비할 때

확인한 모델 registry와 별도 verifier env를 준비합니다. 그 env에서만 `JEV_ALLOW_EGRESS=true`를 켜고, Codex rewrite 의미를 검토한 경우 `JEV_CODEX_REWRITE_APPROVED=true`를 선택합니다. 확인되지 않은 registry를 테스트 도구가 실계정용으로 자동 confirmed 처리하지 않습니다. synthetic offline fixture의 confirmed 값은 **합성 계정 fixture**로 보고서에 표시합니다.

```bash
python3 verification/verify.py --suite native --sut ./orchestration \
  --registry /absolute/models.local.json --env-file /absolute/verifier.env \
  --runtimes claude --plan
# 실제 비용 동의 후에만 --plan 대신 --accept-costs 추가.
```

Codex 테스트의 `--approve-test-hooks`는 임시 테스트 HOME의 생성된 hook을 해당 실행에서 신뢰하도록 하는 별도 테스트 옵션입니다. 사용자 설치기에 trust bypass를 추가하지 않습니다. 파일 로그인을 임시 복사할 때만 `--reuse-cli-login`을 명시합니다. 테스트 자동화 인터페이스는 새 제품 CLI나 두 번째 Main이 아닙니다.

## 비교 판정

native / hooks-off / shadow / active와 지원되는 경우 ultracode를 같은 작업·repeat 단위로 짝지어 비교합니다. 새로운 failure를 숨기지 않고 모든 attempt를 포함합니다. 누락된 짝은 버리지 않고 INCONCLUSIVE로 처리합니다. 동일 task의 반복을 독립적인 새 문제 수로 세지 않습니다.

실제 route가 적용되지 않았거나 child model/effort를 관측하지 못했으면 성능 우위를 판정하지 않습니다. model명을 자연어 출력에서 추출해 실제 metadata인 것처럼 쓰지 않습니다. 비용이 없으면 0이 아니라 unknown입니다. latency 개선이 관측돼도 총비용·전반적 효율 우위까지 확장하지 않습니다.

오케스트레이터의 feedback importer는 사용자가 별도 승인한 schema 자료만 받습니다. artifact hash/validatorVersion 필드는 추적 자료이지 서명된 제3자 인증이 아닙니다. 같은 task cohort·실행 환경·profile revision의 독립 관측만 선택에 반영합니다. 실제 기록 없이 자동 학습한다고 주장하지 않습니다.

## Claude Workflow 정책의 별도 계약

`JEV_WORKFLOW_POLICY=warn` 기본값과 명시적인 Claude `active`/`block`을 분리해 검사합니다. 명시 정책은 이름 있는 workflow를 포함한 **모든** `Workflow` `PreToolUse`의 `deny`, Jev 요청 0, 상태 기록 실패 시에도 `deny`를 기대합니다. `off`/`shadow`/`advisory`, 허용 프로젝트 밖, `PostToolUse`는 거부하지 않아야 합니다. 그다음 **별개로 생성한** native `Agent` 호출의 `updatedInput`을 검사하되, 거부 자체를 Main의 자동 재위임으로 세지 않습니다. 설치된 훅에 JSON stdin을 넣는 CLI 검사는 내부 함수를 import하지 않는 경계 검사입니다. 잘못된 설정은 훅 exit 1과 빈 출력으로 종료될 수 있으므로 deny로 간주해서는 안 됩니다.

2026-09-25의 이전 실제 계정 비교는 이 새 정책을 사용하지 않았습니다. 새 정책의 독립 시험과 실제 ultracode 재위임·child model/effort·결과 품질 차이는 별개 판정으로 기록해야 합니다. 테스트가 실행되지 않았다면 기존 222/54/31이라는 과거 수치를 새 정책의 통과 결과로 옮기지 않습니다.
