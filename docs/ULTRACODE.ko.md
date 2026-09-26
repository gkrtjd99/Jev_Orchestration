# 훅 없는 ultracode 계획 보조

## 목적과 범위

**기본 ultracode보다 목표 완수·품질을 유지하거나 높이면서 전체 시간·토큰·비용을 줄이는 것**이 목표입니다. 향상은 아직 실측하지 않았습니다. 기존 `active`/`controller`의 이름을 바꾸는 것이 아니라, **실제 Workflow + `jev-plan`의 일회성 계획 권고**를 추가하는 별도 경로입니다.

[CLAUDE.md](../CLAUDE.md)는 짧은 진입점이고 [.claude/skills/jev-ultracode/SKILL.md](../.claude/skills/jev-ultracode/SKILL.md)는 planner가 읽는 지침입니다. 이 상세 문서를 매번 읽거나 추가 scout/critic fleet을 만들 필요는 없습니다. Astra가 원래 목표와 acceptance를 고정하고, 이미 가진 근거로 provisional task 1~8개를 만든 뒤 **작업 실행 전에** 한 번 권고를 받습니다. Jev는 typed 선택과 보류만 제공하고 Astra가 최종 계획을 작성합니다.

| 경로 | 개입 시점과 경계 |
|---|---|
| 기본 ultracode 비교군 | 기존 Workflow 계획·실행. 이 skill과 Jev 조회를 제외 |
| 이 지침의 `GUIDANCE_ONLY` | 얇은 지침만 사용; Jev는 `NOT_RUN`. 실제 Jev 보조 실행으로 세지 않음 |
| 이 경로의 `ADVICE` | 계획 초안에 Jev 권고를 제공; 적용은 Astra의 별도 판단과 Workflow 요청 |
| 기존 native `active`/`advisory` | 이미 제안된 native Agent/Task 경계에서 hook 재작성/권고. Workflow 내부 worker는 직접 제어하지 못함 |
| 기존 `controller` | 별도 계획·수용 규약을 강제하고 Workflow를 차단하는 native 위임 경로. 이 경로와 병용하지 않음 |

`ADVICE`는 권고를 얻었다는 뜻이지 채택·실제 model/effort 적용·품질 통과가 아닙니다. 정적 지침의 효과와 실제 Jev 판단의 효과도 나눠 측정해야 합니다.

## 사용 시작·기본 ultracode로 돌아가기

1. 사용자가 **이 저장소의 실질적 작업을 ultracode로 요청한 경우에만** 진입합니다. 일반 작업에는 영향을 주지 않습니다. 사용자가 기본 ultracode 비교군/baseline 또는 지침 제외를 명시하면 **skill을 읽거나 Jev를 호출하지 않습니다**. 예: “이번 작업은 기본 ultracode baseline으로, Jev 지침과 조회 없이 실행”.
2. 호스트의 실제 도구 목록에 `Workflow`가 있어야 합니다. skill이 나열되면 호출하고, 나열되지 않으면 위 `SKILL.md`를 직접 읽을 수 있습니다. 이 repository-local 파일은 다른 프로젝트에 자동 설치되지 않으며 이미 시작된 세션의 재로딩·자동 적용도 보장하지 않습니다. 새 세션에서 지침/skill 로드 여부를 확인하세요.
3. **실제 Workflow 도구 가용성과 CLI effort 옵션은 별개**입니다. 현재 확인한 headless CLI **2.1.283은 `--effort ultracode`를 지원하지 않습니다**. 이 플래그나 이름이 비슷한 가짜 도구를 만들지 마세요. Workflow 없는 환경은 이 통합을 `NOT_RUN`으로 표시하고 기본 native 작업으로 진행할 수 있지만 이를 ultracode 비교 실행이라고 부르지 않습니다.
4. 준비된 registry/별도 env나 전송 동의가 없으면 키를 찾거나 설정을 켜지 않습니다. `GUIDANCE_ONLY`, Jev=`NOT_RUN`으로 남기고 기존 ultracode를 계속합니다. 실제 모델 실행의 비용 동의와 TypeSafe 전송 동의는 별개입니다.
5. 이 파일들을 읽는 것으로 기존 hooks가 설치·해제되지 않습니다. 기존 `controller` 또는 `active`의 `JEV_WORKFLOW_POLICY=block`과 함께 실행하지 마세요. **사용자 승인을 받은 설정 담당자**가 기존 설치 env의 `JEV_MODE=off`로 전환한 뒤 새 세션에서 확인하거나, 사용자가 승인한 별도 clean session에서 해당 hooks가 적용되지 않음을 확인하는 경로가 필요합니다. 설치 경계는 [SETUP](SETUP.ko.md#7-이전중단해제)을 참고하세요. 이 지침은 현재 사용자 설정을 수정하거나 기존 system/developer 정책·권한·차단을 우회할 권한을 주지 않습니다.
6. 중단하려면 다음 작업에서 지침 제외를 명시하고 `jev-plan`을 호출하지 않으면 됩니다. 완전히 비교하려면 이미 읽은 지침의 잔류 문맥이 없는 새 baseline 세션을 쓰세요. 전송 동의를 사용자가 철회한 경우에도 추가 요청 없이 기본 plan을 유지합니다. 이 경로가 별도의 hook 제거 명령을 자동 실행하지는 않습니다.

## 입력과 명시적 동의

### 준비 경계

- 저장소 밖의 **사용자가 지정한** private registry/env만 사용합니다. HOME·인증 저장소를 뒤지거나 native 로그인 토큰을 복사하지 않습니다. CLI는 명시 env의 TypeSafe 키와 동의만 읽습니다. 셸 환경이나 기존 hook의 활성 상태를 새 경로의 승인으로 대신하지 않습니다.
- registry의 형식은 [기존 예제](../orchestration/config/registry.example.json)를 참고하되 확인된 항목만 `availability=confirmed`로 표시합니다. **native registry의 confirmed는 Workflow API 지원 증명이 아닙니다.** 현재 Workflow `agent` opts가 실제로 지원하는 model/effort와의 교집합을 호출 측에서 확인해야 합니다. 지원 불명인 요청은 적용하지 않습니다. 후보가 없다고 모델·effort 이름을 발명하거나 더 싼 값으로 강제 보정하지 않습니다.
- input/env/registry는 사용자 소유의 일반 파일(0600), private 디렉터리(0700)에 둡니다. canonical absolute path를 사용하고 symlink 경로를 전달하지 않습니다. macOS의 `/tmp` 같은 별칭도 실제 경로로 해석해 전달하세요. input도 가능하면 저장소 밖에 두어 커밋·공유를 피합니다.
- plan에는 필요한 짧은 목표·검증 조건·task 설명·프로젝트 상대 경로만 씁니다. 소스 본문, 키, 전체 대화, 고객정보를 넣지 않습니다. 민감한 목표나 경로 자체도 정보입니다. 패턴 검사·owner-only 파일·hash는 **완전한 DLP나 OS sandbox가 아닙니다**.

실제 TypeSafe 전송에는 지정한 env 파일에 다음 세 항목이 모두 필요합니다.

```dotenv
TYPESAFE_API_KEY=<사용자가 비공개로 준비한 실제 키>
JEV_ALLOW_EGRESS=true
JEV_SHARE_PLAN_CONTEXT=true
```

이는 **별도 전송 동의를 받은 뒤에만 작성하는 형식 예시**이지 지금 켜라는 명령이 아닙니다. 설치, 키 존재, 일반 native 모델 로그인 또는 “성능을 높여 달라”는 요청만으로 승인된 것으로 간주하지 않습니다. 이 경로는 제한된 계획 요약과 후보 판단 문맥을 TypeSafe에 전송하고 API 비용이 발생할 수 있습니다. 동의가 없으면 값은 꺼 둔 채 Jev를 `NOT_RUN`으로 처리합니다.

### private-plan.json 예시

아래 목표·경로는 형식 예시입니다. 실제 과제의 원래 goal/acceptance를 보존하고 필요한 범위만 기입하세요. role은 `research|plan|implement|review|integration`, risk는 `normal|sensitive|unknown`입니다. `dependsOn`은 task ID 배열, 경로들은 프로젝트 상대 경로 배열입니다. task 수는 1~8개입니다.

```json
{
  "schema": 1,
  "goal": "파서의 빈 입력 처리를 수정하고 기존 동작을 보존한다",
  "acceptance": [
    "빈 입력의 기대 결과를 고정한 회귀 검사가 통과한다",
    "기존 파서 검사와 전체 필수 검사가 통과한다"
  ],
  "tasks": [
    {
      "id": "fix",
      "summary": "이미 확인한 파서 경계에서 빈 입력 처리를 수정하고 회귀 검사를 추가한다",
      "role": "implement",
      "risk": "normal",
      "dependsOn": [],
      "readPaths": ["src/parser.mjs", "test/parser.test.mjs"],
      "writePaths": ["src/parser.mjs", "test/parser.test.mjs"]
    },
    {
      "id": "verify",
      "summary": "변경 후 원래 acceptance와 기존 검사 결과를 확인한다",
      "role": "review",
      "risk": "normal",
      "dependsOn": ["fix"],
      "readPaths": ["src/parser.mjs", "test/parser.test.mjs"],
      "writePaths": []
    }
  ]
}
```

이 파일은 계획 **초안**이지 Jev가 작성한 최종 계획이나 task 완료 증거가 아닙니다. 경로 계약은 worker의 OS 접근 권한을 제한하지 않습니다.

### CLI 호출

이 저장소 루트에서 실행하는 계약입니다. 아래 `<...>`는 사용자 승인 경로/ID로 교체할 placeholder이며 그대로 실행하는 명령이 아닙니다.

```sh
node orchestration/bin/jev-plan.mjs \
  --project <absolute-project> \
  --input <private-plan.json-absolute-path> \
  --registry <confirmed-registry-outside-project> \
  --env-file <private-env-outside-project> \
  --run-id <fixed-task-id> \
  --dry-run
```

`--dry-run`은 외부 전송·쓰기 없는 사전 확인이며 `request_bytes/request_hash`와 입력·동의·후보 기준의 적격성을 반환합니다. 캐시·이미 소비한 요청 cap은 검사하지 않으므로 `eligible=true`가 실제 요청 가능 보장은 아닙니다. 준비·동의·비용 경계가 충족된 실제 실행에서만 이를 뺍니다. CLI 호출도 기존 도구 권한을 따라야 합니다. 문서를 읽는 것만으로 호출 승인이 추가되지 않습니다.

**같은 작업은 고정 run-id 하나와 실제 요청 cap 1**을 사용합니다. 물리 프로젝트의 device/inode와 run-id·purpose에 묶인 private 예약을 HTTP 시도 전에 남기므로, 키·초안·firmlink 경로를 바꿔도 한도를 공유하고 실패도 소비합니다. timeout·실패 뒤 ID를 회전시키거나 상태를 지워 재요청하지 않습니다. 같은 입력의 유효한 캐시 응답을 새 Jev 판단이나 독립 표본으로 세지 않습니다. 다른 입력에 이전 결과를 그대로 적용하지도 않습니다. 실제 요청 경로는 `project/.jev/ultracode-advice`에 owner-only 캐시/요청 cap 상태를 남길 수 있습니다.

안전한 일반 상태 파일의 깨진 JSON/UTF-8·형식 오류·과대 크기는 원본을 삭제하거나 고치지 않고 `FALLBACK/state_unavailable`로 처리합니다. 반면 잘못된 입력·권한·symlink/hardlink는 generic `ERROR/INVALID_INPUT`과 exit 2로 거부합니다. planner는 이런 거부도 기본 계획으로 돌아가는 이유로 취급하고 파일 안전성 검사를 우회하지 않습니다.

정상 권고/보류 출력은 `advisory_only`, `applied=false`, `observed=null`이며 작업 소스·Workflow opts를 자동 수정하거나 worker를 실행하지 않습니다. 후보 model/effort는 `requested`일 뿐 실제 적용이 아닙니다. `workflow_compatibility=CALLER_MUST_CONFIRM`은 Workflow 호환성을 호출 측에서 확인해야 한다는 뜻입니다. JSON 본문은 4KiB 이내입니다. `status/source/input_hash`, Workflow의 typed `strategy/reading/information`, task 후보, `usage/usage_scope/latency_ms/cached`를 기록하고 자유 형식 실행 지시로 해석하지 마세요. 권고 수신과 실제 채택은 별도 사건입니다.

`usage_scope`는 `jev_response|cache_reuse|unknown`입니다. 캐시 재사용은 `cached=true`, `usage_scope=cache_reuse`이며 `usage.input_tokens/output_tokens`가 모두 `null`입니다. 원요청 토큰을 이번 호출에 재집계하지 마세요. 응답의 사용량도 실제 청구액의 증명은 아닙니다. `latency_ms`는 요청 단계의 캐시·잠금 대기를 포함하지만 입력 검증 등을 포함한 CLI 전체시간은 아닙니다. 고정 1200ms HTTP timeout은 전체 실행 시간 상한이 아니며, 비교에는 별도로 측정한 whole-session 시간을 사용합니다.

## 계획에 반영하는 기준

- **품질을 먼저 고정합니다.** 비용을 줄이려고 acceptance, 필수 테스트, 민감 경계 검토를 줄이지 않습니다. 낮은 확신·민감/unknown 위험은 cheap 강등 근거가 아닙니다. 정보가 부족하면 필요한 근거부터 확보합니다.
- 의존 작업은 pipeline으로, 독립 read-only 조사만 병렬로 배치합니다. 작은 작업은 합쳐 agent 생성·문맥 전달 overhead를 줄입니다. 같은 파일에 concurrent writers를 만들지 않습니다. 실제 작업에 필요한 검토는 유지하되 Jev를 부르기 위해 scout/critic fleet을 추가하지 않습니다.
- Astra가 채택/기각을 결정하고, 지원이 확인된 model/effort만 기존 Workflow의 **명시적 agent opts**에 반영합니다. native hook이나 별도 controller로 새 실행 경로를 만들지 않습니다. 지원 확인이 없으면 원래 opts를 유지합니다.
- timeout·낮은 확신·미동의·후보 부재·입력 거부는 원래 plan으로 돌아가는 이유입니다. Jev 실패를 새 작업 실패로 만들거나 전체 fleet을 재생성하지 않습니다. 일반적인 실행 오류/테스트 실패의 기존 복구·검증 의무까지 없애지는 않습니다.
- 실행 후 권고별 채택/기각과 이유, requested/observed, 실제 acceptance 검사와 산출물 근거를 남깁니다. `SubagentStop`, CLI exit 0, typed 응답 또는 adoption 자체는 품질 PASS가 아닙니다.

## 최소 비교 프로토콜

현재 실제 비교는 **`NOT_RUN`**입니다. 기존 native/controller 시험의 통과 수나 토큰 수를 이 경로의 결과로 가져오지 않습니다. `verification/repo_compare.py`는 Workflow를 금지하는 native 비교이므로 **이 경로 평가에 재사용하면 안 됩니다**. headless의 `--effort ultracode` 대체 실행도 비교가 아닙니다.

1. **실제 동일 Workflow 환경의 baseline vs assisted**를 비교합니다. baseline은 이 지침과 Jev 조회를 제외한 기본 ultracode, assisted는 계획 단계의 이 지침+Jev 권고입니다. 지침만 읽은 `GUIDANCE_ONLY`는 별도 조건으로 구분합니다. 실제 모델 비용·TypeSafe 전송에 대한 별도 동의 없이 유료 비교를 시작하지 않습니다.
2. 같은 과제·원본 스냅샷·goal·acceptance·모델 접근·호스트 버전·권한·환경·예산·재시도 한도를 고정합니다. 원래 품질 검사와 가능하면 worker가 바꿀 수 없는 독립 acceptance를 미리 정합니다. assisted에만 acceptance를 줄이거나 baseline에 불리한 추가 작업을 주지 않습니다.
3. 각 조건은 잔류 계획/답안 없는 별도 세션에서 실행합니다. 과제별 대응 쌍을 만들고 실행 순서를 AB/BA로 교차합니다. cache·계정 부하·실행 순서를 함께 남깁니다. 같은 과제의 반복을 독립적인 새 문제 수로 세지 않으며 짝 누락·실패도 숨기지 않습니다.
4. 지침 읽기 전부터 계획·모든 worker·통합·최종 acceptance 검사까지 **whole-session** 시간·토큰·비용을 셉니다. 계획별 지침 로드·JSON 작성·Jev 대기·추가 모델 호출 overhead, 캐시, 재시도/복구도 포함합니다. Jev API의 호출·토큰·표시 비용과 실제 청구 비용도 별도로 기록해 합산 누락/중복을 피합니다. 관측되지 않은 비용은 0이 아니라 `null`입니다.
5. 계획의 requested model/effort와 실제 실행 metadata의 observed를 분리합니다. agent 자연어 자기소개로 실제 적용을 증명하지 않습니다. 권고별 채택/기각·이유와 실제 acceptance의 명령/검사 ID·결과·근거를 기록합니다. Jev의 확신이나 채택률로 품질 PASS를 만들지 않습니다.
6. 품질 유지 여부와 시간·토큰·비용 변화는 각각 보고합니다. 실제 대응 결과가 없으면 `NOT_RUN`, 짝/관측 누락으로 판단할 수 없으면 `INCONCLUSIVE`입니다. 시간만 줄었다고 총비용·전반적 성능 우위까지 확대하지 않습니다.

### 실행 보고 템플릿

다음은 **평가 기록용 템플릿**이며 CLI의 출력 schema가 아닙니다. 미실행 값은 모두 `null`로 남겼습니다. `advice.decisions`는 실행 후 권고별 채택/기각/이유, `acceptanceTests`는 검사별 실제 명령·결과·근거로 채웁니다. 원문 로그·키·개인 경로를 공개 보고서에 붙이지 마세요.

```json
{
  "schema": 1,
  "status": "NOT_RUN",
  "pairId": null,
  "arm": null,
  "runId": null,
  "taskRevision": null,
  "goal": null,
  "acceptance": null,
  "environment": null,
  "budget": null,
  "order": null,
  "advice": {"status": null, "decisions": null},
  "agents": {"requested": null, "observed": null},
  "acceptanceTests": null,
  "quality": null,
  "wholeSession": {
    "elapsedMs": null,
    "tokens": null,
    "reportedCostUsd": null,
    "billedCostUsd": null,
    "retries": null
  },
  "planOverhead": null,
  "jev": {
    "calls": null,
    "usage": null,
    "usageScope": null,
    "latencyMs": null,
    "cached": null,
    "reportedCostUsd": null,
    "billedCostUsd": null
  },
  "pairedDifference": null
}
```

## 확인한 경계와 남은 검증

이 파일들은 repository-local 진입점·skill·사용 문서입니다. 사용자 설정, hook 등록, 기존 installer, 다른 프로젝트를 자동 변경하지 않습니다. 실제 Workflow opts 호환·권고 채택·child model/effort·동일 acceptance의 품질·whole-session 효율 및 실제 청구액은 실행 근거로 따로 확인해야 합니다. 현재 문서/로컬 계약만으로 **기본 ultracode 대비 성능·효율 향상을 주장하지 않습니다**. 이 작성 작업에서는 외부 문서 조회나 TypeSafe 호출도 하지 않았습니다.
