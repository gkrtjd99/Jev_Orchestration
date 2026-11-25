# Decision kernel 평가 러너

`run-eval.mjs`는 `orchestration/src`의 **실제 제품 코드**(`createKernel`, `DecisionLog`, `loadSkillCatalog`, `selectSkills`, `skillContext`, `localSkillResolver`, `supervisorQuestions`, `supervisorAdvice`, `calibrationReport`, `defaults`)를 그대로 불러 `qa/kernel/data`의 합성 데이터로 skill 라우팅(`delegation.skills`)과 supervisor(`supervisor.outcome`)를 측정합니다. 판단 로직을 다시 구현하지 않습니다. 러너가 직접 계산하는 것은 채점과 통계뿐입니다.

## 실행

```bash
# 저장소(worktree) 루트에서. 키는 환경 변수로만 받습니다.
node qa/kernel/run-eval.mjs --run-id 20261125-full
node qa/kernel/run-eval.mjs --run-id smoke --limit 5                     # 앞에서 5건씩만
node qa/kernel/run-eval.mjs --run-id sk --suite skills --arms local,chain
```

| 옵션 | 기본 | 뜻 |
|---|---|---|
| `--run-id <id>` | 필수 | 결과 폴더 이름. 이미 있으면 `QA_RUN_ID_EXISTS`로 거부 (`--force`로 지우고 다시) |
| `--arms` | `jev,openai,local,chain` | 실행할 arm |
| `--suite` | `all` | `skills`, `supervisor`, `all` |
| `--limit n` | 없음 | 각 데이터 파일의 앞 n건만 |
| `--timeout-ms` | `20000` | 요청당(체인은 체인 전체) 예산. 아래 "제품과 다른 점" 참고 |
| `--concurrency` | `4` | 동시 요청 수 |
| `--openai-model` | 제품 기본값(`gpt-6-luna`) | OpenAI judge 모델 이름 |
| `--max-requests` | `3000` | arm·suite 하나가 보낼 수 있는 HTTP 요청 상한. 넘으면 `QA_REQUEST_BUDGET` |
| `--no-retry` | 꺼짐 | 전송 오류 1회 재시도를 끔 |
| `--data`, `--out` | `qa/kernel/data`, `qa/kernel/results` | 입력·출력 위치 |

종료 코드: `0` 성공, `2` 필요한 키 없음(`QA_MISSING_KEYS`), `64` 잘못된 옵션, `1` 그 밖의 실패. 선택한 arm이 요구하는 키만 확인합니다(`jev`·`chain` → `TYPESAFE_API_KEY`, `openai` → `OPENAI_API_KEY`, `local` → 없음). 키 값은 출력하지 않으며, 결과 파일을 쓰기 직전에 키 값이 들어 있는지 검사해 들어 있으면 `QA_SECRET_IN_OUTPUT`으로 중단합니다.

하니스 자체의 오프라인 테스트(주입된 가짜 전송, **측정이 아님**):

```bash
TMPDIR="$(cd /tmp && pwd -P)" node --test qa/kernel/test/run-eval.test.mjs
```

## Arm

| arm | 판단 지점의 judge 체인 | `escalateBelow` | suite |
|---|---|---|---|
| `jev` | `jev` | 0 | skills, supervisor |
| `openai` | `openai` | 0 | skills, supervisor |
| `local` | `local` (BM25 어휘 규칙) | 0 | skills |
| `chain` | `local` → `jev` | 0.6 | skills |

arm·suite마다 임시 `stateDir`을 새로 만들고, 그 설정에서만 `safety.allowEgress=true`, `kernel.providers.openai.approved=true`로 둡니다. 설치된 사용자 설정은 읽지도 바꾸지도 않습니다. 임시 디렉터리는 decision log를 결과 폴더로 복사한 뒤 지웁니다.

## 제품과 다른 점 (결과를 읽을 때 알아야 할 것)

- **timeout**: 제품은 `timeoutMs`를 5000ms까지만 허용하고 기본값은 1200ms, skill 지점은 `routeDeadlineMs`(3000ms)에서 끊습니다. 러너는 지연을 자르지 않고 재려고 기본 20000ms로 돕니다(나머지 설정은 `validateConfig`를 통과). 그래서 제품에서 timeout이 됐을 호출도 여기서는 답으로 채점됩니다. 대신 `operations.shareOverBudgetMs`가 1200/2500/3000/5000ms를 넘긴 호출의 비율을 알려 줍니다. **예외: OpenAI judge**는 제품이 자체 상한 `kernel.providers.openai.timeoutMs`(기본 2500ms, 최대 5000ms)를 따로 두므로 `--timeout-ms`로 풀리지 않습니다. 러너는 이 값을 제품 최대치 5000ms로 올려 돌리며, 5000ms를 넘긴 OpenAI 호출은 `DECISIONS_TIMEOUT` 실패로 남습니다.
- **scope**: 항목·시도마다 새 scope를 쓰고 `cacheTtlMs=0`입니다. 모든 항목이 실제 호출이고, 세션 요청 상한과 circuit이 항목끼리 영향을 주지 않습니다. 따라서 circuit open에 따른 연쇄 실패는 이 측정에 나타나지 않습니다.
- **지점 모드**: `shadow`. judge 호출과 log 기록은 `active`와 같습니다. 주입 블록 크기는 `active`였다면 만들어졌을 `skillContext()` 결과로 잽니다.
- **카탈로그**: 제품은 프로젝트의 `.claude/skills`만 프로젝트 skill로 읽으므로, `data/skills`를 임시 프로젝트의 `.claude/skills`로 복사해 `loadSkillCatalog`에 넘깁니다.
- **supervisor**: hook과 같은 순서(빈 보고·키 유사 문자열이면 보내지 않음 → `redact(text, maxReportChars)` → `decide` → `supervisorAdvice`)를 따릅니다. "이 확장이 라우팅한 위임인가" 같은 세션 조건은 평가 대상이 아닙니다.
- **재시도**: 전송 오류(타입 없는 fetch 예외, HTTP 429/5xx, `LOCK_BUSY`)만 한 번 다시 보내고 `retriedTransportErrors`에 셉니다. timeout(`JEV_TIMEOUT`, `DECISIONS_TIMEOUT`, `KERNEL_DEADLINE`)과 그 밖의 typed 오류는 다시 보내지 않고 코드와 함께 실패로 남깁니다. 첫 시도의 실패 분포는 `failuresFirstPassByCode`에 따로 있습니다.

## Gold

- `author`: `*.gold.jsonl`, `blind`: `*.blind.jsonl` (작성자 gold를 보지 않고 붙인 라벨).
- `consensus`: 두 라벨이 정확히 일치하는 항목만. skill은 집합으로 비교, supervisor는 outcome이 같으면 일치. supervisor의 consensus evidence는 두 라벨의 evidence도 같을 때만 있습니다.
- **대표 수치는 `gold.consensus`** 입니다. `gold.author`(전체 항목)와 `gold.blind`도 같은 구조로 함께 나옵니다. blind 파일이 없으면 `consensus`·`blind`는 `null`이고 요약은 author gold를 쓰며 그 사실을 표시합니다.
- `dataset.*`: 항목 수, consensus 수, 라벨러 일치율(`exactSetMatchRate`, `outcomeExactRate`), Cohen's kappa(`anySkillKappa`: "skill이 하나라도 필요한가" 이진 판단, `outcomeKappa`: supervisor outcome), evidence 일치율, 카탈로그에 없는 gold 이름.

## 출력

`qa/kernel/results/<run-id>/`

| 파일 | 내용 |
|---|---|
| `metrics.json` | 아래의 모든 수치. `live: true`는 전송을 주입하지 않았다는 뜻이고(테스트용 전송을 주입하면 `live: false`, `transport: "injected"`), `remoteArms: false`면 원격 API를 부르는 arm이 없었다는 뜻입니다(`local`만 돌린 실행). 실제로 보낸 요청 수는 `liveRequests`에 있습니다 |
| `summary.txt` | 화면에 찍힌 요약 |
| `rows-skills-<arm>.jsonl` | 항목별 원자료: id, 언어, 범주, 상태·오류 코드, `need`, 후보별 BM25 순위·점수·확률·단계, load/suggest, 전체 순위, 채택 judge·모델, `trail`, 지연, usage, gold |
| `rows-supervisor-<arm>.jsonl` | 항목별: outcome, 확신, 분포, evidence 점수·단계·분포, `advisory`, 지연, usage, `trail`, gold |
| `decision-log/<suite>-<arm>/` | 제품 `DecisionLog`가 쓴 `decisions-*.jsonl`, `labels-*.jsonl` 사본 |

원자료에는 작업 문장·보고 본문·키가 들어가지 않습니다. 측정하지 못한 값은 `0`이 아니라 `null`입니다.

## 지표: skill 라우팅 (`metrics.skills.<arm>`)

제품 기본 임계값을 그대로 씁니다: `need 0.5`, `autoLoad 0.9`, `suggest 0.5`, `maxCandidates 8`, `maxLoaded 3`.

**실패한 항목은 "아무것도 고르지 않음"으로 채점합니다**(제품이 실제로 그렇게 동작). judge가 답한 항목만의 수치는 각 gold 블록의 `answeredOnly`에 있습니다.

| 위치 | 뜻 |
|---|---|
| `metrics.retrieval.<gold>[k]` | arm과 무관. BM25 상위 k(4/8/12/16/40) 안에 gold skill이 들어온 비율(`goldSkillRecall`)과 gold가 전부 들어온 작업 비율, 전체·언어별. 카탈로그가 40개라 judge가 보기 전에 정답을 잃을 수 있고, **이 값이 뒤의 모든 recall의 상한**입니다. `inTopKWithPositiveScore`는 BM25 점수가 0보다 커서 들어온 것만 센 값(점수 0은 이름순 동률) |
| `gold.<g>.retrievalAtMaxCandidates` | 실제 실행에서 judge에게 간 후보(8개) 안의 gold recall |
| `gold.<g>.needGate` | "skill이 필요한가"(`need ≥ 0.5`) 대 gold(`gold`가 비어 있지 않음)의 accuracy/precision/recall과 tp/fp/tn/fn |
| `gold.<g>.loaded` | **load된 집합** 대 gold: micro precision/recall/F1(전 항목의 tp/fp/fn 합), `exactSetMatchRate`(집합이 정확히 같은 항목 비율, 둘 다 빈 경우 포함) |
| `gold.<g>.loadedOrSuggested` | load+consider를 양성으로 센 같은 지표 |
| `gold.<g>.noneTasks.falseInjectionRate` | gold가 빈 작업 중 skill이 하나라도 load된 비율. `falseInjectionOrSuggestionRate`는 consider 포함 |
| `gold.<g>.goldTasks.missRate` | gold가 있는 작업 중 gold skill이 **하나도** load되지 않은 비율. `incompleteRate`는 gold 전부가 load되지는 않은 비율. `...CountingSuggested`는 consider 포함 |
| `gold.<g>.goldSkillNotLoadedByStage` | load되지 못한 gold skill이 어디서 멈췄는가: `retrieval`, `need_gate`, `below_threshold`, `suggested`, `cap`, `judge_unavailable` |
| `gold.<g>.byLanguage`, `byCategory` | 위 지표의 언어별·범주별 분해 |
| `autoLoadSweep` | 기록된 확률을 **실제 `selectSkills`에 다시 넣어**(replay judge, 추가 호출 없음) `autoLoad`를 0.5/0.6/0.7/0.8/0.9/0.95로 바꿨을 때의 load P/R/F1, 오주입률, miss율. `replayOfShippedThresholdsMismatches`는 기본 임계값으로 replay했을 때 실제 결과와 다른 항목 수(0이어야 함) |
| `calibration.product` | 답이 나온 결정마다 제품의 `log.label()`로 `need`와 `skill_i` 라벨을 쓰고 제품의 `calibrationReport()`를 돌린 결과(라벨은 consensus gold). 제품 보고서는 `need`와 `skill_i`를 한 `noul` 묶음으로 합칩니다 |
| `calibration.direct` | 같은 라벨로 러너가 직접 계산한 Brier/ECE/기저율/신뢰도 표. `need`와 `perSkill`을 **따로** 보여 주고(`labelGold`), author gold 전체 기준(`author`)도 제공 |
| `calibration.crossCheck` | 제품 보고서의 `noul` 묶음과 직접 계산의 Brier·ECE 차이. `agrees: true`면 라벨 수가 같고 차이가 1e-9 미만 |
| `operations.latencyMs` | judge 호출 한 번(체인은 체인 전체)의 p50/p90/p95/max. 실패·재시도 포함. `latencySuccessfulMs`는 성공만, `latencyByJudgeMs`는 `trail` 기준 judge별 |
| `operations.failuresByCode`, `timeouts` | 최종 실패의 코드별 수, timeout 수 |
| `operations.http` | 실제 HTTP 요청 수(호스트·상태 코드별). `wireUsage`는 **API 응답 본문의 `usage`를 그대로 합한 값**과 본 필드 이름. 응답에 없으면 `null` |
| `operations.tokens` | 제품 어댑터가 채택된 답에 대해 노출한 usage. OpenAI 어댑터는 없는 필드를 0으로 바꾸고 local judge는 0을 보고하므로, 토큰 수는 `http.wireUsage`를 보세요 |
| `operations.chain` | judge가 둘 이상인 arm만. `escalationRate`: judge를 둘 이상 거친 결정 비율, `lowConfidenceEscalations`: 첫 judge가 확신 미달로 넘긴 수, `savedCallRate`: 원격 judge를 한 번도 부르지 않고 끝난 비율, `heldAnswerFallbacks`: 뒤 judge가 실패해 보류한 답을 쓴 수, `acceptedBy`: 채택된 judge |
| `operations.context` | `skillContext()` 블록의 글자 수(주입된 항목 평균·최대, 전 항목 평균) 대 카탈로그 전체를 `- 이름: 설명`으로 나열한 글자 수. 글자 수이지 토큰 수가 아닙니다 |

`local` arm의 확률은 BM25 점수를 `s/(s+4)`로 누른 순서용 숫자입니다. 그 calibration 수치는 "calibration되지 않았다"는 것을 보여 주는 용도입니다.

## 지표: supervisor (`metrics.supervisor.<arm>`)

| 위치 | 뜻 |
|---|---|
| `gold.<g>.outcome` | `accuracy`(답이 없으면 오답), `accuracyAnsweredOnly`, 클래스별 precision/recall/F1/support, `macroF1`, `confusion`(행 gold, 열 예측, `none` = 답 없음) |
| `gold.<g>.evidence` | evidence 단계: `mae`(judge의 기대 점수와 gold의 절대 오차 평균), `exactLevelRate`(가장 확률 높은 단계가 gold와 같은 비율), `withinOneRate` |
| `gold.<g>.calibrationDirect` | outcome 선택의 다중 클래스 Brier, 최상위 확률 기준 ECE, 평균 확신, 신뢰도 표 |
| `gold.<g>.shippedThreshold` | 제품 임계값 `cfg.kernel.supervisor.confidence`(0.65)의 효과. `coverage`: 조언이 Main에게 표시될 항목 비율(전체 대비), `accuracyAmongSurfaced`: 표시된 것 중 정답 비율, `accuracyAmongHidden`, `wrongAdviceSurfaced` |
| `gold.<g>.thresholdSweep` | 임계값을 0~0.95로 바꿨을 때의 같은 수치(오프라인) |
| `gold.<g>.byLanguage` | 언어별 정확도·evidence·임계값 효과 |
| `calibration.product`, `crossCheck` | `log.label()`로 `outcome`·`evidence` 라벨을 쓰고 `calibrationReport()`를 돌린 결과와, 직접 계산(Brier, accuracy, ECE, MAE, 단계 일치율)의 비교 |
| `operations` | skill과 같음. `skipped`는 보내지 않은 항목(`EMPTY_REPORT`, `SECRET_GUARD`), `truncatedReports`는 1600자로 잘린 보고 수 |

## 한계

- 합성 데이터에 대한 judge 정확도·calibration·지연·토큰만 잽니다. 실제 작업의 품질·시간·비용 개선(end-to-end 효과)은 이 러너로 알 수 없습니다.
- hook을 실제 Claude Code/Codex 세션에 설치해 도는 경로는 다루지 않습니다.
- 한 번 실행한 결과입니다. 반복 실행에 따른 분산은 재지 않습니다.
- 비용은 계산하지 않습니다. API가 돌려준 토큰 수만 기록합니다.
