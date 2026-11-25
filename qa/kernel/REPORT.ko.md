# Decision kernel 평가 보고서 (2026-11-25)

## 먼저 읽을 것: 실제 API 평가는 실행되지 않았습니다 (BLOCKED)

- 계획한 전체 실행 `node qa/kernel/run-eval.mjs --run-id 20261125-full`(Jev, OpenAI, local, chain 4개 arm, skill·supervisor 2개 suite)은 **실행 권한 단계에서 거부되어 한 번도 시작되지 않았습니다.** 실제 API 호출은 사용자의 직접 승인이 필요한 동작이고, 이 작업에는 그 승인이 없었습니다. 우회하지 않았습니다.
- 따라서 `qa/kernel/results/20261125-full/`은 **존재하지 않습니다.** Jev arm, OpenAI arm, chain arm, supervisor suite 전체의 정확도·calibration·지연·토큰 수치는 **모두 null(미측정)** 입니다.
- 이 보고서의 수치는 전부 **API를 부르지 않는 부분**에서 나왔습니다: 데이터셋 검증, 두 라벨 파일의 일치도, BM25 후보 검색의 상한, `local` arm(BM25 어휘 규칙) 160건. 결과 폴더는 `qa/kernel/results/20261125-local-only/`이고, 이 실행의 HTTP 요청 수는 0입니다(`metrics.json`의 `liveRequests.total = 0`, `remoteArms = false`). API 키는 환경에서 지운 채로 돌렸습니다.
- `qa/kernel/results/sanity-live-5/`는 러너를 만든 단계에서 5건씩만 실제 API로 돌려 본 배선 확인입니다(요청 25건: api.typesafe.ai 15, api.openai.com 10). 5건의 정확도는 결과가 아니므로 이 보고서에서 인용하지 않습니다.

전체 실행을 하려면 저장소 소유자가 직접 아래 명령을 실행하거나 실행을 승인해야 합니다. 예상 요청 수는 api.typesafe.ai 440건(skill 160 + chain 최대 160 + supervisor 120), api.openai.com 280건입니다(전송 오류 재시도 제외).

```bash
node qa/kernel/run-eval.mjs --run-id 20261125-full
```

## 무엇을 어떻게 시험했나

| 항목 | 내용 | 근거 파일 |
|---|---|---|
| 제품 코드 | 3.2.0, commit `bbb74525`, `orchestration/` 수정 없음(`dirty: false`) | `metrics.json` → `product` |
| skill 데이터 | 가짜 skill 40개, 위임 작업 160건(영어 96, 한국어 64 / none 56, single 56, confusable 32, multi 16) | `metrics.json` → `dataset.skills` |
| supervisor 데이터 | 작업자 보고 120건, outcome 4종 각 30건 | `dataset-agreement.json` → `supervisor` |
| 실행한 arm | `local`만 (skill suite). judge 호출 160건, 실패 0건 | `metrics.json` → `skills.local.operations` |
| 임계값 | 제품 기본값: need 0.5, autoLoad 0.9, suggest 0.5, 후보 8개, load 최대 3개 | `metrics.json` → `skills.local.thresholds` |

데이터는 **전부 모델이 쓴 합성 데이터**입니다. skill, 작업 문장, 보고 본문, 라벨 모두 LLM이 만들었고 사람이 검토하지 않았습니다. 실제 세션에서 나온 항목은 하나도 없습니다.

### 라벨 일치도 — 수치는 완벽하지만 그대로 믿으면 안 됩니다

라벨은 두 벌입니다: 작성자 gold(`*.gold.jsonl`)와, 작성자 gold를 보지 않고 붙였다는 blind 라벨(`*.blind.jsonl`). 둘이 정확히 일치한 항목이 consensus 부분집합입니다.

| suite | 항목 | consensus | 일치율 | Cohen's kappa | 근거 |
|---|---|---|---|---|---|
| skill (집합 완전 일치) | 160 | 160 | 1 | 1 ("skill이 필요한가" 이진, 우연 일치 0.545) | `dataset-agreement.json` → `skills` |
| supervisor outcome | 120 | 120 | 1 | 1 (우연 일치 0.25) | `dataset-agreement.json` → `supervisor` |
| supervisor evidence 단계 | 120 | 110 | 0.9166666666666666 | 계산 안 함(null) | `supervisor.evidenceExactRate` |

**불일치가 0건이라는 점 자체가 경고 신호입니다.** 데이터 README가 "검토자가 다르게 볼 수 있다"고 직접 꼽은 라벨(GitLab→GitHub 이전을 `github-actions-ci`만으로 표시 등)과 supervisor의 작성자 재량 규칙 7개까지 한 건도 어긋나지 않았습니다. 가능한 설명은 다음과 같고, 어느 것인지 이 작업에서는 확인하지 못했습니다.

1. 두 라벨러가 모두 같은 계열의 모델이고 같은 라벨링 규칙 문서를 읽었다. 독립된 사람 두 명의 일치와는 다릅니다.
2. 작업 파일에 `category` 필드가 들어 있어 gold 개수(0/1/2)가 드러난다. blind 라벨러가 이 필드를 봤다면 "몇 개를 고를지"는 이미 주어진 셈입니다.
3. 데이터가 깔끔해서 실제로 쉽다.

결론: consensus 부분집합은 전체와 같아서(160/160, 120/120) **모호한 항목을 걸러 내는 역할을 하지 못했습니다.** 라벨 잡음은 여전히 미측정으로 봐야 하며, 사람의 표본 검토가 필요합니다.

구조 검증(직접 실행, 오류 0건): 각 파일 줄 수와 id 일대일 대응, 중복 id·중복 문장 없음, gold 이름이 모두 카탈로그에 있음, 한글 포함 여부와 `lang` 일치, `secretLike`에 걸리는 항목 0건. 하니스 자체 오프라인 테스트 5건 통과.

## 결과: skill 라우팅

### Jev / OpenAI / chain arm

| arm | 상태 | 모든 지표 |
|---|---|---|
| `jev` | BLOCKED, 미실행 | null |
| `openai` | BLOCKED, 미실행 | null |
| `chain` (local → jev) | BLOCKED, 미실행 | null |

### 검색 상한 (arm과 무관, API 불필요)

judge는 BM25 상위 8개 후보만 봅니다. gold skill이 그 안에 없으면 어떤 judge도 고를 수 없으므로, 아래 값이 **모든 arm의 recall 상한**입니다. 출처: `metrics.json` → `retrieval.consensus`.

| 상위 k | 전체 (gold skill 120개) | 영어 (71개) | 한국어 (49개) |
|---|---|---|---|
| 4 | 82 → 0.6833333333333333 | 64 → 0.9014084507042254 | 18 → 0.3673469387755102 |
| **8 (제품 기본)** | **85 → 0.7083333333333334** | **65 → 0.9154929577464789** | **20 → 0.40816326530612246** |
| 12 | 90 → 0.75 | 67 → 0.9436619718309859 | 23 → 0.46938775510204084 |
| 16 | 95 → 0.7916666666666666 | 69 → 0.971830985915493 | 26 → 0.5306122448979592 |
| 40 (전체) | 120 → 1 | 71 → 1 | 49 → 1 |

- 한국어 작업에서 상위 8개에 든 gold 20개 중 BM25 점수가 0보다 커서 들어온 것은 15개입니다(`inTopKWithPositiveScore`). 나머지 5개는 점수 0 동률에서 이름순으로 우연히 들어왔습니다. 한국어는 k를 16으로 늘려도 점수로 들어온 것은 15개 그대로입니다.
- gold가 있는 작업 104건 중 gold 전부가 상위 8개에 든 작업은 72건(0.6923076923076923), 한국어는 42건 중 16건(0.38095238095238093)입니다.
- 원인은 단순합니다. skill 설명은 영어뿐이고 작업의 40%가 한국어라 어휘가 겹치지 않습니다. 이것은 데이터를 그렇게 만든 결과이기도 하지만, 영어 설명만 있는 실제 skill 폴더에 한국어로 위임하는 경우에도 같은 구조입니다.

**이것이 이번에 확인한 가장 중요한 사실입니다:** Jev나 OpenAI judge가 완벽하더라도, 이 데이터에서 gold skill recall은 0.7083333333333334을, 한국어에서는 0.40816326530612246을 넘을 수 없습니다.

### `local` arm (BM25 어휘 규칙, 오프라인)

출처: `metrics.json` → `skills.local.gold.consensus`. consensus가 전체와 같으므로 n = 160입니다.

| 지표 | 전체 | 영어 (96) | 한국어 (64) |
|---|---|---|---|
| need 판단 accuracy | 0.625 | 0.8020833333333334 | 0.359375 |
| need tp / fp / tn / fn | 45 / 1 / 55 / 59 | 44 / 1 / 33 / 18 | 1 / 0 / 22 / 41 |
| load precision | null (load 0건) | null | null |
| load recall | 0 (0/120) | 0 | 0 |
| load 집합 완전 일치 | 0.35 (56건, 전부 none 작업) | 0.3541666666666667 | 0.34375 |
| load+consider precision | 0.640625 (tp 41, fp 23) | 0.6507936507936508 | 0 (tp 0, fp 1) |
| load+consider recall | 0.3416666666666667 | 0.5774647887323944 | 0 |
| load+consider F1 | 0.44565217391304346 | 0.6119402985074627 | null |
| none 작업 오주입률 (load) | 0 (0/56) | 0 | 0 |
| none 작업 오주입·오제안률 | 0.017857142857142856 (1/56) | 0.029411764705882353 | 0 |
| gold 작업 miss율 (load 기준) | 1 (104/104) | 1 | 1 |
| gold 작업 miss율 (consider 포함) | 0.6346153846153846 (66/104) | 0.3870967741935484 | 1 (42/42) |

- `local`은 기본 임계값에서 **아무것도 자동 load하지 못합니다.** 확률이 BM25 점수를 `s/(s+4)`로 누른 값이라 전체 최댓값이 0.8127077158702543(rows 파일에서 계산)이고 `autoLoad` 0.9에 닿지 않습니다. 할 수 있는 것은 "consider" 제안뿐입니다.
- load되지 못한 gold skill 120개가 멈춘 단계(`goldSkillNotLoadedByStage`): consider까지만 41, need 관문 37, 후보 검색 탈락 35, 임계값 미달 7.

범주별(`byCategory`):

| 범주 | n | need accuracy | load+consider precision | load+consider recall | 후보 8개 안 gold recall |
|---|---|---|---|---|---|
| none | 56 | 0.9821428571428571 | 0 (fp 1) | null | null |
| single | 56 | 0.48214285714285715 | 0.8125 | 0.4642857142857143 | 0.7857142857142857 |
| confusable | 32 | 0.40625 | 0.3333333333333333 | 0.21875 | 0.625 |
| multi | 16 | 0.3125 | 0.8 | 0.25 | 0.65625 |

### 임계값 sweep (`local`, 기록된 확률 재생, 추가 호출 없음)

출처: `skills.local.autoLoadSweep.points[*].consensus`. 기본 임계값 재생 불일치 0건.

| autoLoad | load precision | load recall | load F1 | 오주입률 | miss율 |
|---|---|---|---|---|---|
| 0.5 | 0.640625 | 0.3416666666666667 | 0.44565217391304346 | 0.017857142857142856 | 0.6346153846153846 |
| 0.6 | 0.875 | 0.23333333333333334 | 0.3684210526315789 | 0 | 0.7307692307692307 |
| 0.7 | 0.9090909090909091 | 0.08333333333333333 | 0.15267175572519082 | 0 | 0.9038461538461539 |
| 0.8 | 1 | 0.008333333333333333 | 0.01652892561983471 | 0 | 0.9903846153846154 |
| 0.9 (기본) | null | 0 | null | 0 | 1 |
| 0.95 | null | 0 | null | 0 | 1 |

Jev·OpenAI의 sweep과 supervisor의 confidence sweep은 미측정(null)입니다.

### Calibration (`local`)

출처: `skills.local.calibration.direct.labelGold`. 제품의 `calibrationReport()`와 러너의 직접 계산은 일치합니다(`crossCheck.agrees = true`, 차이 0).

| 질문 | n | Brier | ECE | 실제 양성 비율 | 평균 예측 |
|---|---|---|---|---|---|
| need | 160 | 0.2968023072247311 | 0.2874131544419385 | 0.65 | 0.36258684555806125 |
| skill별 | 1280 | 0.06665466466653219 | 0.12270427336917493 | 0.06640625 | 0.17262299434982833 |

`local`의 숫자는 확률이 아니라 순위용 점수입니다. need를 0으로 본 37건 중 실제로 skill이 필요한 비율이 0.5675675675675675였고(거의 전부 한국어), 0.6~0.7 구간은 20건 모두 필요했습니다. 즉 낮은 쪽은 과소, 높은 쪽도 과소 확신입니다. Jev·OpenAI의 calibration은 미측정(null)입니다.

### 지연·토큰·주입 크기

| arm | 지연 p50 / p95 / max (ms) | API 토큰 in / out | HTTP 요청 |
|---|---|---|---|
| `local` | 0.06683300000000258 / 0.1189160000000129 / 1.7769580000000076 | null / null (API 미사용) | 0 |
| `jev`, `openai`, `chain` | null | null | 0 (미실행) |

`local`이 제안을 낸 46건에서 주입 블록은 평균 413.60869565217394자, 최대 573자였고, 카탈로그 40개를 전부 나열하면 9589자입니다(`operations.context`). 글자 수이지 토큰 수가 아니며, 주입이 작업 결과에 도움이 되는지는 측정하지 않았습니다.

## 결과: supervisor

| arm | 상태 | accuracy, macro F1, evidence, calibration, 임계값 효과, 지연, 토큰 |
|---|---|---|
| `jev` | BLOCKED, 미실행 | null |
| `openai` | BLOCKED, 미실행 | null |

supervisor에는 로컬 규칙 arm이 없어 오프라인으로 잴 수 있는 것이 없습니다. 혼동 분석도 없습니다.

## 오류 패턴 (`local` arm, `rows-skills-local.jsonl`을 직접 읽음)

Jev·OpenAI·chain의 오주입, 누락, supervisor 혼동은 원자료가 없어 분석하지 못했습니다. 아래는 모두 `local` arm과 검색 단계에 대한 것입니다.

**1. 한국어 작업은 검색 단계에서 이미 잃습니다.** 한국어 64건 중 36건은 후보 8개의 BM25 점수가 전부 0이어서 후보가 이름순(`a11y-audit`, `ab-test-analysis`, …)으로 채워집니다(영어는 96건 중 1건). gold가 후보에 못 든 작업 32건 중 26건이 한국어입니다.
- `st-008` "utils/date.ts의 영업일 계산 함수에 테스트가 하나도 없습니다…" → gold `unit-test-vitest`는 40개 중 37위.
- `st-015` "내년도 부서별 예산안 엑셀을 만들어 주세요…" → gold `xlsx-modeling`은 40위(꼴찌). "엑셀"과 "xlsx"는 겹치는 글자가 없습니다.
- `st-030` "결제 워커를 쿠버네티스에 올려야 합니다…" → gold `k8s-manifests`는 18위.

**2. 한국어에서 맞힌 제안은 0건이고, 유일하게 need를 넘긴 1건은 틀렸습니다.**
- `st-131` "…저장소는 사내 GitLab입니다. 예전에 GitHub Actions에서 하던 것처럼…" → 영문 고유명사만 걸려 `github-actions-ci`를 0.61로 제안, gold `gitlab-ci-pipelines`는 0.44로 탈락.

**3. 혼동군에서는 문장에 등장한 "형제" skill의 단어를 따라갑니다(키워드 함정).** confusable 32건의 load+consider precision은 0.3333333333333333입니다.
- `st-110` "The migration that added the index … still does a sequential scan" → `sql-migration` 제안, gold `sql-query-tuning`은 16위로 후보에도 없음.
- `st-127` "covered end to end … in isolation with stubbed tax rates. No browser" → `e2e-playwright` 제안, gold `unit-test-vitest`는 38위. 부정문("No browser")을 어휘 일치는 읽지 못합니다.
- `st-072` "…This is about the logic, not a…" → `secrets-scanning` 0.56 제안, gold `security-code-review`는 0.49로 한 끗 차 탈락.

**4. 단어를 쓰지 않고 풀어 쓴 작업은 영어에서도 놓칩니다.**
- `st-046` "Check that the checkout flow still works when 500 users go through it at the same time." → gold `load-testing-k6`는 23위, 1위는 `a11y-audit`.
- `st-154` "…a parent form cannot drive its value and refs do not reach the element" → gold `react-component-patterns`는 9위로 한 칸 차이로 후보 탈락, 1위는 `css-design-tokens`.

**5. multi 작업은 둘 중 하나만 찾습니다.** multi 16건 중 gold 둘 다 후보에 든 것은 8건입니다.
- `st-142` (churn 데이터 탐색 + 그림) → `data-profiling` 1위, `dataviz-charts` 14위.
- `st-006` (GitLab 파이프라인 + 야간 부하 테스트, 한국어) → `gitlab-ci-pipelines` 1위, `load-testing-k6` 20위.

**6. skill이 필요 없는 작업에는 거의 반응하지 않습니다.** 56건 중 제안 1건, load 0건.
- `st-048` "Yesterday's release went fine. Now list the branches that were merged more than 30 days ago…" → "release" 단어로 `semver-release`를 0.51로 제안.
- 근소하게 관문 아래에서 멈춘 예: `st-149`(git rebase 질문, need 0.495), `st-082`(실패 테스트 수정, need 0.495).
- 다만 이 조심성은 판단력이 아니라 점수가 낮게 눌려 있기 때문이고, 같은 이유로 필요한 작업도 못 찾습니다.

## 이 결과가 보여 주는 것과 보여 주지 않는 것

**보여 주는 것 (합성 데이터 한정)**
- 데이터와 러너는 구조적으로 온전하고, 제품의 `selectSkills`·decision log·`calibrationReport` 경로가 160건을 실패 없이 처리합니다.
- BM25 후보 검색이 병목입니다. 기본 후보 8개에서 gold skill의 0.7083333333333334만 judge에 도달하고, 한국어 작업은 0.40816326530612246입니다. 원격 judge의 품질과 무관한 상한입니다.
- `local` 규칙 단독으로는 기본 임계값에서 자동 load가 0건입니다. 제안 수준에서도 한국어는 recall 0, 혼동군은 precision 0.3333333333333333입니다.

**보여 주지 않는 것**
- **Jev와 OpenAI judge의 정확도, calibration, 지연, 토큰 사용량: 미측정.** 이 평가의 본래 목적이었고 실행되지 못했습니다.
- **supervisor 판단의 품질: 미측정.**
- chain(local → jev)이 원격 호출을 얼마나 줄이는지: 미측정.
- 실제 작업에서 품질·시간·비용이 나아지는지: 이 러너로는 원래 알 수 없습니다. 측정 대상은 합성 작업에 대한 판단 정확도이지 end-to-end 효과가 아닙니다.
- hook을 실제 Claude Code/Codex 세션에 설치했을 때의 동작: 다루지 않았습니다.
- 라벨 품질: 두 라벨이 100% 일치하지만 독립성이 확인되지 않았고 사람 검토가 없습니다.
- 반복 실행의 분산: 한 번 실행했습니다(`local`은 결정적이라 분산이 없지만 원격 arm은 그렇지 않습니다).

**main 병합 판단에 대해:** 이 보고서는 "실제 효과 미측정" 항목을 해소하지 못했습니다. 오히려 실제 API 평가 전에 한국어 후보 검색이라는 구체적 약점을 하나 더 드러냈습니다.

## 러너에서 고친 것

1. **OpenAI 자체 timeout 반영** (`qa/kernel/lib/harness.mjs`): 제품 commit `9166142` 이후 OpenAI judge는 `kernel.providers.openai.timeoutMs`(기본 2500ms, 최대 5000ms)를 따로 쓰므로 러너의 `--timeout-ms 20000`이 적용되지 않았습니다. README의 "지연을 자르지 않는다"는 설명이 OpenAI에는 틀렸습니다. 러너가 이 값을 제품 최대치 5000ms로 올리도록 하고 README에 예외를 적었습니다. `shareOverBudgetMs`에 2500ms 기준을 추가했습니다. (실제 API로는 검증하지 못했습니다.)
2. **잘못된 "LIVE API" 표시** (`qa/kernel/run-eval.mjs`): `local`만 돌려 요청이 0건인 실행도 요약 첫 줄에 "LIVE API"로 찍혔습니다. `metrics.json`에 `remoteArms`를 추가하고, 원격 arm이 없으면 "OFFLINE (local judge only, no API call)"로 표시합니다.
3. **`qa/kernel/dataset-agreement.mjs` 추가**: supervisor 라벨 일치도는 원격 arm을 돌려야만 `metrics.json`에 들어가므로, API 없이 두 suite의 일치도를 계산해 결과 폴더에 남기는 스크립트를 추가했습니다.
4. 데이터 README 두 개의 "두 번째 라벨러 없음" 문구가 blind 파일 추가 뒤로 낡아서, 맨 위에 갱신 메모를 달았습니다.

## 재현

```bash
# 이 보고서의 수치 (API 호출 없음)
env -u TYPESAFE_API_KEY -u OPENAI_API_KEY node qa/kernel/run-eval.mjs --run-id 20261125-local-only --arms local --suite skills --force
node qa/kernel/dataset-agreement.mjs > qa/kernel/results/20261125-local-only/dataset-agreement.json
node qa/kernel/data/validate-skill-tasks.mjs
TMPDIR="$(cd /tmp && pwd -P)" node --test qa/kernel/test/run-eval.test.mjs
```
