# Decision kernel 평가 보고서 (2026-11-25, 최종 정리판)

## 먼저 읽을 것

이 보고서의 첫 판(commit `e8333f9`)은 "실제 API 평가는 실행되지 않았고 `results/20261125-full/`은 존재하지 않는다"고 적었습니다. **그 서술은 더 이상 사실이 아니어서 고쳤습니다.**

- `qa/kernel/results/20261125-full/`이 존재합니다. `metrics.json` 기준 2026-11-25T04:32:45Z~04:33:41Z에 제품 commit `e8333f94`로 실행됐고, **실제 HTTP 요청 683건**(api.typesafe.ai 403, api.openai.com 280)을 보냈습니다. 6개 rows 파일은 160/160/160/160/120/120행, 실패 0건, 재시도 0건입니다. 아래 원격 arm 수치는 모두 이 폴더의 `metrics.json`에서 옮겼습니다.
- **누가 어떤 승인으로 이 실행을 했는지는 저장소 안에서 확인할 수 없습니다.** 첫 판을 쓴 단계는 실행이 권한 단계에서 거부됐다고 보고했고, 그 뒤에 폴더가 생겼습니다. 실제 API 사용 승인은 워크플로 과제 문구에만 있었고 사용자 본인의 승인 기록은 없습니다. 이 최종 정리 단계에서는 실제 API를 **한 번도 호출하지 않았습니다**(0건). 결과 폴더는 증거 보존을 위해 커밋했으며, 폐기 여부는 사용자가 정할 일입니다.
- 이 브랜치에서 일어난 실제 API 호출 중 파일로 확인되는 것은 **최소 783건**입니다.

| 실행 | api.typesafe.ai | api.openai.com | 근거 |
|---|---|---|---|
| `sanity-live-5` (러너 배선 확인, 결과 아님) | 15 | 10 | `results/sanity-live-5/metrics.json` → `liveRequests` |
| `20261125-full` (이 보고서의 원격 수치) | 403 | 280 | `results/20261125-full/metrics.json` → `liveRequests` |
| `20261125-e2e` 최종 실행 (설치된 hook 경유) | 57 | 18 | `results/20261125-e2e/hooks.txt` 221행 |
| e2e 드라이버의 그 이전 실행들 | null (기록 없음) | null (기록 없음) | 저장된 파일 없음 |

- 데이터는 전부 **모델이 만든 합성 데이터**이고 정확도는 **작성자 gold 기준**입니다(라벨 잡음 미측정, 아래 "라벨 일치도"). 이 수치는 "합성 작업에서 judge가 라벨과 얼마나 일치하는가"이지, 실제 작업의 품질·시간·비용 효과가 아닙니다.
- `full` 실행은 QA에서 찾은 제품 결함을 고치기 **전** 트리(`e8333f94`)에서 돌았습니다. 고친 내용(보류 시 skill 안내, 50ms 경계, 네트워크 오류 코드, 잠금 대기, `escalateBelow` env)은 `selectSkills`·supervisor 판정 계산을 바꾸지 않으므로 다시 돌리지 않았습니다. 다시 돌려서 확인한 것은 아닙니다.

## 무엇을 어떻게 시험했나

| 항목 | 내용 | 근거 파일 |
|---|---|---|
| 제품 코드 (`full`) | 3.2.0, commit `e8333f94`, `dirty: false` | `20261125-full/metrics.json` → `product` |
| skill 데이터 | 가짜 skill 40개, 위임 작업 160건(영어 96, 한국어 64 / none 56, single 56, confusable 32, multi 16) | `metrics.json` → `dataset.skills` |
| supervisor 데이터 | 작업자 보고 120건, outcome 4종 각 30건 | `metrics.json` → `dataset.supervisor` |
| 실행한 arm | skill: `jev`, `openai`, `local`, `chain`(local → jev, `escalateBelow` 0.6) 각 160건. supervisor: `jev`, `openai` 각 120건. 실패 0건 | `metrics.json` → `plan`, `*.operations` |
| 모델 | `jev-1.14.0`, `gpt-6-luna`, `local-rules` (응답의 `model` 필드) | rows 파일 |
| 임계값 | 제품 기본값: need 0.5, autoLoad 0.9, suggest 0.5, 후보 8개, load 최대 3개, supervisor confidence 0.65 | `metrics.json` → `thresholds`, `settings` |
| 러너 timeout | 20000ms (제품 기본 1200/2500ms가 아님. 지연을 자르지 않고 재기 위함) | `metrics.json` → `options` |
| 반복 | 1회. 분산 미측정 | — |

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

따라서 아래의 모든 정확도는 **"작성자 gold 기준, 라벨 잡음 미측정"** 입니다. `category` 필드는 gold 개수를 완전히 결정합니다(none→0개 56건, single→1개 56건, confusable→1개 32건, multi→2개 16건, 예외 0). judge에게는 작업 문장(`item.task`)만 전달되므로 판정 입력으로의 누출은 없지만, 다시 라벨링할 때는 `category`를 뺀 파일을 줘야 합니다.

구조 검증(직접 실행, 오류 0건): 각 파일 줄 수와 id 일대일 대응, 중복 id·중복 문장 없음, gold 이름이 모두 카탈로그에 있음, 한글 포함 여부와 `lang` 일치, `secretLike`에 걸리는 항목 0건. 하니스 자체 오프라인 테스트 5건 통과.

## 결과: skill 라우팅

### arm별 요약 (실제 API, `20261125-full/metrics.json` → `skills.<arm>.gold.consensus`, n = 160)

| 지표 | `jev` | `openai` | `local` | `chain` (local → jev) |
|---|---|---|---|---|
| need accuracy | 0.8375 | 0.8375 | 0.625 | 0.81875 |
| need tp / fp / tn / fn | 79 / 1 / 55 / 25 | 78 / 0 / 56 / 26 | 45 / 1 / 55 / 59 | 76 / 1 / 55 / 28 |
| load precision | 1 (tp 80, fp 0) | 0.9411764705882353 (tp 80, fp 5) | null (load 0건) | 1 (tp 77, fp 0) |
| load recall (gold 120개) | 0.6666666666666666 | 0.6666666666666666 | 0 | 0.6416666666666667 |
| load F1 | 0.8 | 0.7804878048780487 | null | 0.7817258883248732 |
| load 집합 완전 일치 | 0.775 | 0.75 | 0.35 | 0.7625 |
| load+consider precision / recall | 0.8947368421052632 / 0.7083333333333334 | 0.8804347826086957 / 0.675 | 0.640625 / 0.3416666666666667 | 0.9010989010989011 / 0.6833333333333333 |
| none 작업 오주입률 (load) | 0 (0/56) | 0 (0/56) | 0 | 0 (0/56) |
| none 작업 오주입·오제안률 | 0.017857142857142856 (1/56) | 0 | 0.017857142857142856 | 0.017857142857142856 |
| gold 작업 miss율 (load 기준, 104건) | 0.27884615384615385 | 0.27884615384615385 | 1 | 0.3076923076923077 |
| 영어 load recall (71개) | 0.8591549295774648 | 0.8591549295774648 | 0 | 0.8591549295774648 |
| **한국어 load recall (49개)** | **0.3877551020408163** (19/49) | **0.3877551020408163** (19/49) | 0 | **0.32653061224489793** (16/49) |
| 한국어 need accuracy (64건) | 0.640625 | 0.65625 | 0.359375 | 0.59375 |
| confusable load precision / recall | 1 / 0.59375 | 0.95 / 0.59375 | null / 0 | 1 / 0.5625 |
| multi load recall | 0.53125 | 0.53125 | 0 | 0.5 |
| 실패 / timeout | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

읽는 법:

- **원격 judge는 후보에 든 gold는 거의 다 고르고, 잘못 load한 것은 Jev 0건·OpenAI 5건입니다.** Jev가 load하지 못한 gold 40개 중 35개는 BM25 후보 8개에 들지 못해 judge에게 가지도 않았고(`goldSkillNotLoadedByStage.retrieval`), 나머지 5개는 consider에 머물렀습니다. 즉 recall 0.667은 judge의 한계가 아니라 **후보 검색의 상한 0.708**에 막힌 값입니다.
- **한국어 작업의 load recall은 0.388입니다.** 영어 0.859의 절반 이하이고, 원인은 아래 "검색 상한"입니다.
- OpenAI의 오load 5건(`rows-skills-openai.jsonl`)은 전부 gold skill에 더해 일반 skill 하나를 같이 고른 경우입니다: `st-050`, `st-063`, `st-089`, `st-098`은 `code-quality-guidelines`, `st-116`은 `css-design-tokens`. 5건 중 4건이 한국어입니다.

### chain(local → jev)은 "비용 절감"이 아닙니다

`chain`은 원격 호출 160건 중 37건을 보내지 않았습니다(`operations.chain`: escalation 0.76875, `savedCallRate` 0.23125). 하지만 이것을 절감으로 쓰면 안 됩니다.

- 보내지 않은 37건은 전부 `local`이 BM25 점수 0이라 need를 0으로 답한 항목입니다. need 0은 확신 `|2p-1|` = 1로 계산되어 `escalateBelow` 0.6을 넘으므로 Jev로 넘어가지 않습니다. **확신이 높아서가 아니라 아무 단어도 안 겹쳐서** 멈춘 것입니다.
- 37건 중 36건이 한국어이고, 21건(0.5675675675675675)은 실제로 skill이 필요한 작업입니다(`rows-skills-chain.jsonl`에서 계산).
- 그 결과 `jev` 단독보다 load된 gold가 3개 적고(77 대 80, 3개 모두 한국어: 16/49 대 19/49), need accuracy가 0.81875 대 0.8375, miss율이 0.3077 대 0.2788입니다.
- 토큰은 `jev` 243021 in / 26240 out 대 `chain` 187037 in / 20172 out입니다. 줄어든 만큼 한국어 recall을 잃었습니다. 가격은 계산하지 않았습니다(null).

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

**이것이 이번에 확인한 가장 중요한 사실입니다:** Jev나 OpenAI judge가 완벽하더라도, 이 데이터에서 gold skill recall은 0.7083333333333334을, 한국어에서는 0.40816326530612246을 넘을 수 없습니다. 실제 실행에서 Jev는 그 상한에 거의 붙었습니다(load+consider recall 0.7083333333333334, 한국어 load recall 0.3877551020408163).

### `local` arm (BM25 어휘 규칙, 오프라인)

출처: `20261125-local-only/metrics.json` → `skills.local.gold.consensus` (API 호출 0건). `20261125-full`의 `local` arm도 같은 정확도 수치를 냅니다(지연만 다름). consensus가 전체와 같으므로 n = 160입니다.

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

### 임계값 sweep (기록된 확률 재생, 추가 호출 없음)

출처: `skills.<arm>.autoLoadSweep.points[*].consensus`. 기본 임계값 재생 불일치 0건. 값은 load precision / load recall.

| autoLoad | `jev` | `openai` | `chain` | `local` |
|---|---|---|---|---|
| 0.5 | 0.8947368421052632 / 0.7083333333333334 | 0.8804347826086957 / 0.675 | 0.9010989010989011 / 0.6833333333333333 | 0.640625 / 0.3416666666666667 |
| 0.6 | 0.9042553191489362 / 0.7083333333333334 | 0.9101123595505618 / 0.675 | 0.9111111111111111 / 0.6833333333333333 | 0.875 / 0.23333333333333334 |
| 0.7 | 0.9325842696629213 / 0.6916666666666667 | 0.9195402298850575 / 0.6666666666666666 | 0.9404761904761905 / 0.6583333333333333 | 0.9090909090909091 / 0.08333333333333333 |
| 0.8 | 0.9761904761904762 / 0.6833333333333333 | 0.9195402298850575 / 0.6666666666666666 | 0.9634146341463414 / 0.6583333333333333 | 1 / 0.008333333333333333 |
| **0.9 (기본)** | **1 / 0.6666666666666666** | **0.9411764705882353 / 0.6666666666666666** | **1 / 0.6416666666666667** | null / 0 |
| 0.95 | 1 / 0.6333333333333333 | 0.963855421686747 / 0.6666666666666666 | 1 / 0.6166666666666667 | null / 0 |

임계값을 0.5까지 내려도 Jev의 recall은 0.667 → 0.708밖에 오르지 않습니다. 임계값이 아니라 후보 검색이 병목이라는 뜻입니다. 이 sweep은 같은 160건에 대한 재생이므로 **임계값을 이 표로 고르면 과적합입니다.** 별도 데이터로 확인하지 않았습니다.

### Calibration

출처: `skills.<arm>.calibration.direct.labelGold`. 네 arm 모두 제품의 `calibrationReport()`와 러너의 직접 계산이 일치합니다(`crossCheck.agrees = true`).

| arm | need Brier | need ECE | skill별 Brier (n 1280) | skill별 ECE |
|---|---|---|---|---|
| `jev` | 0.12170062499999998 | 0.13256249999999994 | 0.020069999999999935 | 0.057328125000000084 |
| `openai` | 0.156260625 | 0.16843750000000013 | 0.03698703125000001 | 0.04098437499999996 |
| `local` | 0.2968023072247311 | 0.2874131544419385 | 0.06665466466653219 | 0.12270427336917493 |
| `chain` | 0.17309812499999994 | 0.1903125 | 0.017843203124999964 | 0.04149218749999996 |

need의 실제 양성 비율은 0.65이고 Jev의 평균 예측은 0.5276874999999995입니다(과소). need ECE에는 후보 검색이 놓친 한국어 작업(judge가 관련 skill을 못 보고 "필요 없음"이라 답한 경우)이 섞여 있어 judge만의 calibration이 아닙니다. `local`의 숫자는 확률이 아니라 순위용 점수입니다.

### 지연·토큰·주입 크기

출처: `skills.<arm>.operations`. 지연은 러너 프로세스 안에서 잰 judge 호출 시간이며(동시 4, timeout 20000ms), hook 프로세스의 cold start는 포함하지 않습니다.

| arm | 지연 p50 / p95 / max (ms) | API가 돌려준 토큰 in / out | HTTP 요청 | 1200 / 2500ms 초과 비율 |
|---|---|---|---|---|
| `jev` | 184.68791599999986 / 242.53812500000004 / 364.794375 | 243021 / 26240 | 160 | 0 / 0 |
| `openai` | 516.2512920000008 / 838.8699579999993 / 927.8905840000007 | 378233 / 0 | 160 | 0 / 0 |
| `local` | 0.06116699999984121 / 0.09304200000042329 / 1.4845830000012938 | API 미사용 | 0 | 0 / 0 |
| `chain` | 175.5742920000048 / 235.2783749999944 / 349.39700000000084 | 187037 / 20172 | 123 | 0 / 0 |

- OpenAI의 출력 토큰 0은 응답 본문의 `usage.output_tokens`가 0으로 온 그대로입니다. 과금 기준인지는 확인하지 않았습니다.
- 주입 블록은 Jev가 고른 80건에서 평균 395.2375자, 최대 585자이고 카탈로그 40개를 전부 나열하면 9589자입니다(`operations.context`). 글자 수이지 토큰 수가 아니며, **주입이 작업 결과에 도움이 되는지는 측정하지 않았습니다.**
- 비용(원·달러)은 계산하지 않았습니다(null).

## 결과: supervisor

출처: `supervisor.<arm>.gold`. outcome은 consensus(= 작성자 gold, n 120) 기준입니다.

| 지표 | `jev` | `openai` |
|---|---|---|
| outcome accuracy | 0.9333333333333333 | 0.9666666666666667 |
| macro F1 | 0.9318221653591279 | 0.9665178571428572 |
| 틀린 방향 | retry→complete 6, retry→replan 1, replan→escalate 1 | retry→complete 4 |
| confidence ≥ 0.65에서 표시되는 비율 | 0.8333333333333334 (100건) | 0.7333333333333333 (88건) |
| 표시된 조언의 accuracy | 0.98 (틀린 조언 2건 표시) | 1 (0건) |
| 숨겨진 조언의 accuracy | 0.7 | 0.875 |
| calibration ECE / Brier | 0.06508333333333338 / 0.1091883333333333 | 0.12916666666666662 / 0.08853833333333337 |
| evidence 단계 일치율 — **두 라벨이 일치한 110건** | 0.9272727272727272 (MAE 0.1381818181818181) | 0.4636363636363636 (MAE 0.5621818181818181) |
| evidence 단계 일치율 — **작성자 gold 120건 전체** | 0.875 (MAE 0.18349999999999994) | 0.4583333333333333 (MAE 0.5812499999999999) |
| 지연 p50 / p95 / max (ms) | 170.562791999997 / 199.35845900000277 / 239.12574999999924 | 459.1704580000005 / 602.4735000000001 / 796.9110839999994 |
| 토큰 in / out | 78552 / 7892 | 59787 / 0 |
| 실패 / timeout | 0 / 0 | 0 / 0 |

- **가장 위험한 오류는 "재시도해야 할 보고를 완료로 판정"하는 것이고, Jev 6건·OpenAI 4건이 그랬습니다**(retry 30건 중). 기본 임계값 0.65에서 Jev는 그중 2건을 Main에게 "complete" 조언으로 보여 줍니다.
- `summary.txt`의 `evMAE`/`evExact` 열은 n=120 열 옆에 있지만 실제로는 두 라벨의 evidence가 일치한 **110건**에서만 계산한 값입니다. 불일치 10건을 빼면 Jev 수치가 올라갑니다(0.875 → 0.927). 위 표에 둘 다 적었습니다.
- OpenAI의 evidence 단계 일치율 0.46은 outcome 정확도와 크게 다릅니다. score 눈금 해석이 다른 것인지 모델의 판단 차이인지는 분석하지 않았습니다.
- supervisor 조언이 Main의 다음 행동을 실제로 개선하는지는 측정하지 않았습니다.

임계값 sweep(`thresholdSweep`, 표시 건수 / 표시된 것의 accuracy / 틀린 조언 표시 건수): Jev 0.5 → 109 / 0.9541284403669725 / 5, 0.65 → 100 / 0.98 / 2, 0.8 → 93 / 1 / 0. OpenAI 0.5 → 102 / 1 / 0, 0.65 → 88 / 1 / 0. 같은 120건의 재생이므로 임계값 선택 근거로 쓰면 과적합입니다.

## 설치된 hook 경유 종단 시험 (`results/20261125-e2e/`)

`qa/kernel/e2e-hooks.mjs`가 일회용 HOME에 실제 설치기를 돌리고, 설치기가 `settings.json`에 등록한 명령(설치된 `bin/jev-hook.mjs`)에 Claude Code 형식의 이벤트 JSON을 넣었습니다. **실제 Claude Code 세션이 아니라 스크립트가 entrypoint를 직접 호출한 것입니다.**

| 항목 | 결과 | 근거 |
|---|---|---|
| 설치된 entrypoint 직접 호출 (실제 Jev/OpenAI judge, 제품 commit `e8333f9`) | 기대 214개 중 212 PASS, 0 FAIL, soft miss 2. hook 호출 100회(실제 judge 시나리오 88, loopback 12) | `20261125-e2e/hooks.txt` 219~221행, `hooks.json` |
| OpenAI만 쓰는 위임 5건, 매번 새 프로세스 | OpenAI 요청 14건, 최대 778ms, timeout 0건, 5/5 라우팅 | `hooks.json` → `scenarios.s17-openai-only-cold-latency` |
| **실제 Claude Code 세션** (`e2e-real-session.mjs`) | **BLOCKED.** 로그인 자격이 없어 1턴에서 "Not logged in"으로 끝남. hook 이벤트는 SessionStart, UserPromptSubmit뿐. skill이 주입된 서브에이전트가 도는 것은 **확인하지 못함** (`checks: null`) | `20261125-e2e/real-session.json` |
| 결함 수정 뒤 loopback 시나리오만 재실행 (최종 제품 트리, placeholder 키, 실제 API 0건) | 24/24 PASS. 연결 거부 시 경고 코드가 `JEV_NETWORK_ERROR`로 나옴 | `20261125-e2e-loopback-rerun/hooks.txt`, `hooks.json` |
| 결함 수정 뒤 실제 judge 시나리오 재실행 | **하지 않음.** 실제 API 호출은 사용자 승인이 필요해 이 단계에서 실행하지 않았습니다 | — |

soft miss 2건은 둘 다 아래 결함으로 이어졌습니다: (1) 한 위임에서 프로필 선택이 `selector_abstained`로 보류, (2) `JEV_TIMEOUT_MS=50`에서 judge를 부르지 않고 `KERNEL_DEADLINE`. e2e 단계가 보고한 "이전 실행에서 cold OpenAI 호출 1336ms·1396ms 관측"과 "실제 selector가 5건 중 3건 보류"는 **저장된 파일에 없어 확인할 수 없습니다.**

## QA에서 찾아 고친 제품 결함 (commit `e6fb770`)

| 결함 | 심각도 | 수정 | 회귀 테스트 |
|---|---|---|---|
| 프로필 선택이 보류되면 높은 확신으로 고른 skill이 버려짐 (`hooks.mjs` 보류 분기) | major | 전역 `active`/`advisory`이고 skill 지점이 `active`이면 보류 안내문 뒤에 블록을 붙여 Main에게 보여 줌. 호출은 바꾸지 않음. 재호출 시 동일 | `kernel-hooks.test.mjs` "a deferred route keeps a selected skill…" |
| timeout을 허용 최솟값 50ms로 두면 judge를 한 번도 부르지 않음 (`kernel.mjs`) | minor | 첫 judge는 예산 자체가 50ms 미만일 때만 거부 | `kernel.test.mjs` 예산 테스트, `kernel-hooks.test.mjs` "the documented minimum timeout of 50 ms…" |
| 연결 거부가 `JEV_UNAVAILABLE` / `KERNEL_JUDGE_ERROR`로만 남음 | minor | `JEV_NETWORK_ERROR`, `DECISIONS_NETWORK_ERROR` | `kernel-hooks.test.mjs`, `kernel-judges.test.mjs` |
| OpenAI judge의 주석이 "마감을 넘지 않는다"고 했지만 잠금 대기는 마감과 무관했고, 마감이 지난 호출도 요청 수·circuit 실패로 셈 | minor | 요청 전 잠금 대기를 마감에서 끊고, 마감이 지난 호출은 세지 않음. 요청 후 기록용 잠금은 그대로이며 주석과 문서에 그렇게 적음 | `kernel-judges.test.mjs` "openai lock waits stop at the call deadline…" |
| env로 `local,jev` 체인만 설정하면 `escalateBelow`가 0이라 사실상 local 전용 | minor | `JEV_SKILLS_ESCALATE_BELOW`, `JEV_SUPERVISOR_ESCALATE_BELOW`, `JEV_DECISION_ESCALATE_BELOW` 추가 | `kernel-hooks.test.mjs` "escalateBelow can be set from the environment…" |

- 새 테스트 6건과 기존 테스트 1건에 추가한 단언은 수정 전 소스에서 모두 실패하고 수정 후 통과하는 것을 확인했습니다.
- 기존 단언 하나를 의도적으로 바꿨습니다: 보류된 route에서 `injected === false`를 기대하던 단언은 위 첫 결함 그 자체였습니다.
- 고친 뒤 실행 결과(2026-11-25, Node v24.19.0): `bash scripts/test-all.sh` 종료 코드 0, Node 테스트 509/509, 구문 64개 모듈. macOS 기본 `TMPDIR`(`/var/folders/...`)에서 `npm test` 509/509. `npm run compare:default` hook 출력 108개·judge 호출 21건 일치, 차이 0.
- **고치지 않은 것:** 한국어 작업의 후보 검색(영어 설명과 어휘가 겹치지 않음)은 이 평가가 드러낸 가장 큰 약점이지만 설계 변경이 필요해 손대지 않았습니다. chain에서 need 0이 확신 1로 계산되어 escalation되지 않는 것도 그대로입니다.

## 오류 패턴 (`local` arm, `rows-skills-local.jsonl`을 직접 읽음)

원격 arm의 오류는 위 절의 집계(load하지 못한 단계별 개수, OpenAI 오load 5건, supervisor 혼동)까지만 분석했고, 항목 단위로 읽은 것은 아래 `local` arm과 검색 단계뿐입니다. 원격 arm이 놓친 gold 40개 중 35개는 아래 1·4·5번과 같은 이유(후보 탈락)입니다.

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

**보여 주는 것 (합성 데이터, 작성자 gold, 1회 실행 한정)**
- Jev judge는 후보에 든 skill에 대해 잘못 load한 것이 0건이고(precision 1), skill이 필요 없는 56건에 load한 것도 0건입니다. OpenAI는 5건을 더 load했습니다.
- recall은 judge가 아니라 BM25 후보 검색에 막혀 있습니다: 전체 0.667, 한국어 0.388.
- supervisor outcome 정확도는 Jev 0.933, OpenAI 0.967이고, 위험한 방향(retry를 complete로)이 Jev 6건, OpenAI 4건 있습니다.
- 이 조건(동시 4, 따뜻한 프로세스)에서 지연은 Jev p95 243ms, OpenAI p95 839ms였고 683건 중 timeout·실패는 0건입니다.
- 설치된 hook entrypoint는 직접 호출 100회에서 deny·예외 없이 계약대로 동작했습니다.

**보여 주지 않는 것**
- **실제 작업에서 품질·시간·비용이 나아지는지: 미측정.** skill-effect pilot은 격리된 실제 세션이 없어 실행하지 못했습니다. 이 러너가 재는 것은 합성 작업에 대한 판정 일치도입니다.
- **실제 Claude Code/Codex 세션에서 skill이 주입된 서브에이전트가 도는지: 미검증**(BLOCKED).
- 라벨 품질: 사람 검토 없음. 두 라벨의 100% 일치는 독립성의 증거가 아닙니다.
- 반복 실행의 분산, 다른 데이터에서의 임계값 타당성, 비용.
- 실제 skill 폴더(이름·설명이 겹치고 수가 많은 경우)에서의 동작. 카탈로그는 가짜 skill 40개입니다.
- Codex runtime의 skill 주입·supervisor 경로.
- 결함 수정 뒤의 실제 API 동작(재실행하지 않음).

**main 병합 판단에 대해:** "실제 효과 미측정"과 "실제 세션 종단 미검증"은 여전히 열려 있습니다. 합성 판정 정확도는 이제 숫자가 있지만 그것이 병합 근거가 되지는 않습니다. 항목별 상태는 `qa/kernel/SUMMARY.ko.md`와 `docs/KERNEL.ko.md`의 "검증 상태"에 있습니다.

## 러너에서 고친 것

1. **OpenAI 자체 timeout 반영** (`qa/kernel/lib/harness.mjs`): 제품 commit `9166142` 이후 OpenAI judge는 `kernel.providers.openai.timeoutMs`(기본 2500ms, 최대 5000ms)를 따로 쓰므로 러너의 `--timeout-ms 20000`이 적용되지 않았습니다. README의 "지연을 자르지 않는다"는 설명이 OpenAI에는 틀렸습니다. 러너가 이 값을 제품 최대치 5000ms로 올리도록 하고 README에 예외를 적었습니다. `shareOverBudgetMs`에 2500ms 기준을 추가했습니다. (실제 API로는 검증하지 못했습니다.)
2. **잘못된 "LIVE API" 표시** (`qa/kernel/run-eval.mjs`): `local`만 돌려 요청이 0건인 실행도 요약 첫 줄에 "LIVE API"로 찍혔습니다. `metrics.json`에 `remoteArms`를 추가하고, 원격 arm이 없으면 "OFFLINE (local judge only, no API call)"로 표시합니다.
3. **`qa/kernel/dataset-agreement.mjs` 추가**: supervisor 라벨 일치도는 원격 arm을 돌려야만 `metrics.json`에 들어가므로, API 없이 두 suite의 일치도를 계산해 결과 폴더에 남기는 스크립트를 추가했습니다.
4. 데이터 README 두 개의 "두 번째 라벨러 없음" 문구가 blind 파일 추가 뒤로 낡아서, 맨 위에 갱신 메모를 달았습니다.

## 재현

```bash
# API를 부르지 않는 부분
env -u TYPESAFE_API_KEY -u OPENAI_API_KEY node qa/kernel/run-eval.mjs --run-id 20261125-local-only --arms local --suite skills --force
node qa/kernel/dataset-agreement.mjs > qa/kernel/results/20261125-local-only/dataset-agreement.json
node qa/kernel/data/validate-skill-tasks.mjs
TMPDIR="$(cd /tmp && pwd -P)" node --test qa/kernel/test/run-eval.test.mjs
bash scripts/test-all.sh
(cd orchestration && npm test && npm run compare:default)
# loopback 시나리오만 (placeholder 키, 실제 API 0건)
TYPESAFE_API_KEY=placeholder OPENAI_API_KEY=placeholder node qa/kernel/e2e-hooks.mjs --only install,f2,f4,f5,f6 --out <결과 파일>

# 실제 API를 부르는 부분: 저장소 소유자가 직접 실행하거나 승인해야 합니다 (약 700건 + 약 75건)
node qa/kernel/run-eval.mjs --run-id <새 run-id>
node qa/kernel/e2e-hooks.mjs --out qa/kernel/results/<run>/hooks.json
```
