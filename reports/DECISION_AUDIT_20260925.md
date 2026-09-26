# Jev 판단 경계 감사 · 2026-09-25

## 무엇을 검증했는가

기존 웹 A/B는 **결과물** 비교이지 task 분해·파일 선택·모델/effort 판단의 정확도 실험이 아니다. 이번 감사는 `orchestration/src/`의 실제 적용 경로와 보관된 실제 Jev HTTP 요청·응답을 대조했다. 새 유료 호출, 새 모델 실행, 새로운 산출물 A/B는 하지 않았다. 실제 기록은 아래의 **라우팅 8건, 서로 다른 원과제 5종**이다. 같은 원과제의 반복 및 한 과제 내 child 조사 작업이 섞여 있어 독립 표본 8개로 해석하면 안 된다.

- 유지보수 3종: `/private/tmp/jev-expanded-real-work-results-20260925/{effort-evidence,score-schema,private-env}/real-jev-http.json`, 각 `active/trial.json`, 양쪽 `transcripts/*.meta.json`과 해당 `.jsonl`.
- 이전 한 과제의 고정 2회·자연 2회: `/private/tmp/jev-routing-compare-20260925/{fixed-v3-r1-active,fixed-v3-r2-active,natural-r1-active,natural-r2-active}/jev-real-http.json`과 각 `trial.json`.
- 웹 1종: `reports/dashboard-benchmark-20260925/real-jev-http.json`, 각 `trial.json` 및 `transcripts/`.

보관된 Jev HTTP 성공 응답은 8개 라우팅에 걸쳐 13건(분류 8회, 추가 프로필 선택 5회), HTTP 소요 시간 합계 7.986초다. 여러 실행의 합계이므로 특정 작업의 전체 지연이나 순수 추가 비용으로 해석하지 않는다. 집계는 HTTP `request.questions`의 `role` 유무로 분류 단계와 프로필 선택 단계를 구별하고, 분류 5항목(`role`, `complexity`, `risk`, `reasoning`, `information`)의 `confidence < 0.55`를 코드의 `uncertain` 규칙과 똑같이 적용했다. 문서는 `required || doc_i.noul >= 0.55`를 적용했다. 비교한 native child의 모델·effort는 메타데이터의 `agent_id`와 연결한 `.jsonl`의 최상위 `assistant` 이벤트 `model` 및 **이벤트의 `effort`**에서 확인했다. HTTP 요청 성공이나 프로필 이름만을 정확한 판단·제공자 내부 연산량으로 취급하지 않았다.

## 결과: 실제 결정과 효과의 간극

| 결정/경계 | 코드상 실제 제어 | 기존 실기록에서 확인한 것 | 아직 판정할 수 없는 것 |
|---|---|---|---|
| task 여부·분해·worker 수 | `UserPromptSubmit`은 native 위임을 권할 뿐이고, `PreToolUse`는 **Main이 이미 만든** `Agent`/`Task` 호출에만 적용. `Workflow` 내부 worker는 개별 라우팅 불가 (`hooks.mjs:38-49,69-76,76-123`) | 이번 유지보수 3건·웹 1건은 과제 프롬프트에서 **정확히 1회 위임을 강제**했다. 이전 자연 시행에서는 active 3 worker/route 1, 2 worker/route 1. | Jev의 위임/분해 판단의 정확도: 이 구현에는 독립적인 자동 결정·강제가 없음. 자연 시행의 모든 worker를 Jev로 간주할 수 없음. |
| 어떤 파일을 읽을지 | `inventory`는 루트 필수 문서와 제한된 문서 확장자/디렉터리의 **경로·크기·mtime**만 제시. 선택 문서는 worker 프롬프트의 시작 힌트이지 접근 허용 목록이 아님 (`documents.mjs:4-35`, `questions.mjs:18-21`, `router.mjs:9-16`, `policy.mjs:12-16`). `readAdvice` 기본값은 false이고 true여도 Read에 대한 메타데이터 힌트만 제공하며 요청 파일을 교체/차단하지 않음 (`config.mjs:11`, `hooks.mjs:149-155`). | 분류 8건에 문서 메타데이터 총 64개가 제시됐으나 선택은 **1개**; **7/8 route가 선택 문서 0개**. 유지보수 3건과 웹 1건은 모두 0개. 웹의 핵심 `dashboard/data.json`은 `dashboard/` 디렉터리가 inventory 탐색 대상이 아니어서 후보에도 없었다. | 관련 소스 파일의 precision/recall: 소스 코드는 후보군 자체에 없고, 별도 정답 파일 목록과 실제 읽기 로그의 연결 평가를 하지 않았다. 빈 목록만으로 Jev의 의미 분류 정확도를 채점할 수는 없다. |
| 모델 선택 | 분류가 만든 제약으로 후보를 만들고, 관측 성능 데이터가 없으면 정책 거리(`policyDistance`)로 우선순위를 정함. 기본 평가 컨텍스트는 `native-default-unvalidated`라 경험 자료를 최적화에 사용하지 않음 (`optimizer.mjs:6-58,65-110`, `router.mjs:30-34`, `config.mjs:15-18`). | **8/8 분류에서 적어도 한 항목의 confidence < 0.55**, 따라서 `uncertain=true`여서 light 후보 제외. 최종 8/8 child 요청/관측 모델은 `gpt-6-sol`. 2단계 Jev selector가 호출된 **5/8** 건은 **5/5 기존 정책 baseline과 동일**. | Luna/Sol/Astra 중 어느 모델이 어떤 종류의 실제 작업에서 더 좋은지. 8번의 판단이 독립적인 모델 비교를 뜻하지 않음. |
| effort 선택 | 승인된 native profile의 frontmatter에 선언하며, child 이벤트로 effective 요청 값을 따로 확인해야 함 (`adapters.mjs:37-46`, `profiles.mjs:5-17`). | 비교 가능한 유지보수 3쌍+웹 1쌍에서 native child 모두 `gpt-6-sol/high`. active child는 각 `high`, `xhigh`, `xhigh`, `high`: **2/4쌍에서 CLI typed effort가 실제로 바뀌었음**. 원래 verifier의 `effort_status=INCONCLUSIVE`는 이 로그 형식의 최상위 `assistant.effort`를 놓친 파싱 한계다. | effort 변경이 품질·시간·비용 차이의 **원인**인지, 제공자 내부에서 얼마나 연산했는지. 각 과제의 Main 코딩과 child 조사 효과가 혼재됨. |
| 정보 부족·오류 시 보류 | `information=missing && !uncertain`일 때에만 보류. 이때도 **원래 native 호출은 unchanged**, 실행 중단 명령은 아님. 기본 `failureMode=native`이면 hook 실패도 원래 호출로 돌아감 (`router.mjs:20-29`, `hooks.mjs:123-128,177-184`, `config.mjs:11`). | 실제 분류 **2/8에서 `information=missing`**이지만 다른 항목이 불확실해 두 경우 모두 route가 계속됐다. 웹 조사 지시는 존재하는 `dashboard/data.json`의 직접 열람을 명시했는데 `missing`으로 분류했다. 따라서 이 사례의 정보 부족 판단은 주어진 작업에 비춰 설득력이 없다. | 대부분의 위험한 상황을 올바르게 보류하는지: 거절·실패 사례를 고정한 실작업 검사는 아직 없음. |

**가장 중요한 설계 구분:** Jev가 문서를 ‘선택’하는 기능은 현재 **메타데이터 문서 힌트**, task ‘판단’은 **이미 만들어진 위임의 분류**다. 사용자가 기대한 ‘필요한 소스 파일을 골라 읽히고, 작업을 나눌지 판단하는 오케스트레이터’와 다른 인터페이스다. 단순히 Jev 정확도가 떨어지는지와 별개로, 이 두 목표를 달성하는 통제 경로가 구현되어 있지 않다.

## 불리한 경계 실험(로컬 mock, 실제 Jev 정확도 아님)

`TMPDIR=/private/tmp`에서 기존 `fixture`와 실제 `handleHook`을 호출하고 외부 Jev 응답만 고정했다. 구현 요청 `Implement the notification toggle`을 Jev가 `research`로 오분류하면 hook은 요청을 `jev4_research_...`로 변경하며 설치 프로필은 `tools: Read, Grep, Glob, WebSearch, WebFetch`여서 원래 작업에 필요한 편집 능력을 잃는다. 오분류가 실제로 발생했다고 주장하는 것은 아니고 **오분류의 영향 범위**를 확인한 것이다. `information=missing`(다른 항목이 확신)일 때 반환 출력에는 `updatedInput`도 `permissionDecision`도 없어 원래 위임이 계속될 수 있다. 기본 설정의 `Read` 이벤트는 반환 `{}`이며 파일을 고르는 판단은 없다. 이 세 조건은 로컬 hook 경계에서 재현됐고 외부 API 비용은 0이다.

기존 `router.test.mjs`도 `TMPDIR=/private/tmp`에서 **74/74 통과**했다. 처음 기본 `/tmp`로 실행했을 때는 macOS의 `/tmp`↔`/private/tmp` 별칭 때문에 **71/74**였으며, 이를 Jev 판단 실패로 세지 않는다. 이 테스트는 제약/재작성/보류 코드의 동작 테스트이지 Jev 분류·파일 선택의 실작업 정확도 테스트는 아니다.

## 판정과 다음 실험의 기준

1. **작동함:** 일부 native 위임에서 Jev 응답→프로필 재작성→child 모델/CLI effort 관측은 연결된다. 특히 4개의 새로운 짝 가운데 2개는 `high → xhigh`가 확인됐다. ‘아무 판단도 적용되지 않았다’는 결론은 틀리다.
2. **설계 범위가 부족함:** 작업 분해·실제 소스 파일 선별·의미 있는 보류의 강제는 현재 존재하지 않거나 힌트에 그친다. `Workflow` 내부 worker는 라우팅되지 않는다. 오분류가 read-only 능력 변경으로 이어질 수 있으므로 역할 변경을 안전하다고 가정할 수 없다.
3. **효용 미입증:** 보관된 표본은 모두 Sol을 택했고 두 번째 selector는 관측된 5건에서 정책 baseline을 바꾸지 않았다. 이것만으로 selector가 항상 쓸모없거나 다른 작업에서 Luna가 더 낫다고 추정할 수는 없지만, 지금까지의 모델 라우팅 이득은 보여 주지 않는다. `missing` 판단 2건이 보류로 연결되지 않은 것도 ‘확신이 낮을 때의 안전한 대안’이라는 주장과 다르다.
4. **후속 평가 설계:** 실제 원과제를 다양한 난이도·민감도·코드 탐색 형태로 사전 고정하고, 프롬프트에서 위임 수를 강제하지 않는다. 독립 레이블(위임 필요 여부, 최소 필수 파일, 민감 경계, 검증 조건)을 결과를 보지 않고 작성한다. `native`, `route-only`, `effort-only`, `file-hint-only`, `full`을 **구현된 경계에 한해서만** 동일 입력/격리 환경에서 비교하고, 작업 순서를 교차한다. 각 판단에서 분류 혼동행렬, 필수 파일 recall@k 및 불필요한 읽기, 위임/라우팅 커버리지, 실제 child 모델/CLI effort, 첫 시도 외부 수용률·회귀, 모든 시도 포함 토큰/시간/표시 비용을 기록한다. 역할 오분류의 권한 축소와 명백한 정보 부족을 방치한 사례는 합격 수를 늘려 상쇄하지 말고 별도 실패로 보고한다. **현재의 `file-hint-only`와 task 분해 효과는 구현 능력이 부족하므로 검증 가능한 기능처럼 이름만 붙여 비교하면 안 된다.**

기존 웹 결과의 native 우세는 그 웹 산출물 한 쌍의 사실이며, Jev의 모든 세부 판단이 틀렸다는 근거가 아니다. 반대로 회귀 테스트 74/74와 라우팅 PASS는 이 설계의 유용성을 입증하지 않는다.
