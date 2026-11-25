# Decision kernel 평가 러너

`run-eval.mjs`는 `orchestration/src`의 **실제 제품 코드**(`createKernel`, `DecisionLog`, `loadSkillCatalog`, `selectSkills`, `skillContext`, `localSkillResolver`, `supervisorQuestions`, `supervisorAdvice`, `calibrationReport`, `defaults`)를 그대로 불러 `qa/kernel/data`의 합성 데이터로 skill 라우팅(`delegation.skills`)과 supervisor(`supervisor.outcome`)를 측정합니다. 판단 로직을 다시 구현하지 않습니다. 러너가 직접 계산하는 것은 채점과 통계뿐입니다.

## 실행

```bash
# 저장소(worktree) 루트에서. 키는 환경 변수로만 받습니다.
node qa/kernel/run-eval.mjs --run-id 20261125-full
node qa/kernel/run-eval.mjs --run-id smoke --limit 5                     # 앞에서 5건씩만
node qa/kernel/run-eval.mjs --run-id sk --suite skills --arms local,chain
# 후보 검색 방식 비교: arm x 방식마다 하나의 arm (jev-lexical, jev-adaptive, jev-full)
node qa/kernel/run-eval.mjs --run-id rt --suite skills --arms jev --retrieval lexical,adaptive,full
# 다른 데이터 세트(자기 skills/ 카탈로그 포함)
node qa/kernel/run-eval.mjs --run-id other --suite skills --arms jev --data-dir path/to/dataset
```

| 옵션 | 기본 | 뜻 |
|---|---|---|
| `--run-id <id>` | 필수 | 결과 폴더 이름. 이미 있으면 `QA_RUN_ID_EXISTS`로 거부. `--force`는 오프라인·주입 전송 결과만 지우고 다시 돌립니다. **live 원격 실행의 결과가 든 폴더는 `--force`로도 지우지 않습니다**(`QA_RUN_ID_HAS_LIVE_RESULT`, 새 run id를 쓰세요) |
| `--arms` | `jev,openai,local,chain` | 실행할 arm |
| `--retrieval` | 없음 | `lexical`, `adaptive`, `full` 중 쉼표로 나열. skill arm마다 나열한 방식을 **교차**해 `<arm>-<방식>`이라는 arm으로 돌립니다(조합마다 별도 `stateDir`·decision log·rows 파일). 주지 않으면 arm 이름 그대로 제품 기본 방식(`lexical`)으로 한 번만 돕니다. `minCoverage`·`maxJudged`·`chunk`는 항상 제품 기본값입니다. supervisor에는 영향이 없습니다 |
| `--data-dir <dir>` | `qa/kernel/data` | 데이터 세트 폴더. 그 안의 `skills/`가 카탈로그입니다. `--data`는 같은 뜻의 예전 이름 |
| `--gold` | consensus가 있으면 `consensus`, 없으면 `author` | 대표(headline) gold. 요약에서 먼저 나오고 제품 decision log 라벨에 쓰입니다. **어느 쪽을 고르든 consensus 부분집합과 author gold 전체 수치가 둘 다 나옵니다.** `consensus`를 명시했는데 두 번째 라벨 파일이 없으면 `QA_NO_CONSENSUS`로 거부 |
| `--labels <A,B>` | `skill-tasks.gold.jsonl`과, 있으면 `relabel/skill-tasks.blind2.jsonl`, 없으면 `skill-tasks.blind.jsonl` | consensus를 계산할 skill 라벨 파일 두 개(데이터 폴더 기준 상대 경로, 폴더 밖은 거부). 명시한 파일이 없으면 `DATA_FILE_MISSING` |
| `--spend-holdout "<이유>"` | 없음 | `HOLDOUT.json`이 있는 폴더를 돌릴 때 필수. 아래 "Held-out 세트" 참고 |
| `--respend-holdout "<이유>"` | 없음 | 이미 기록된 실행이 있는 held-out 세트를 **다시** 돌릴 때 `--spend-holdout`에 더해 필수. 없으면 `QA_HOLDOUT_ALREADY_SPENT` |
| `--suite` | `all` | `skills`, `supervisor`, `all` |
| `--limit n` | 없음 | 각 데이터 파일의 앞 n건만 |
| `--timeout-ms` | `20000` | 요청당(체인은 체인 전체) 예산. 아래 "제품과 다른 점" 참고 |
| `--concurrency` | `4` | 동시 요청 수 |
| `--openai-model` | 제품 기본값(`gpt-6-luna`) | OpenAI judge 모델 이름 |
| `--max-requests` | `3000` | arm·suite 하나가 보낼 수 있는 HTTP 요청 상한. 넘으면 `QA_REQUEST_BUDGET` |
| `--no-retry` | 꺼짐 | 전송 오류 1회 재시도를 끔 |
| `--out` | `qa/kernel/results` | 출력 위치 |

종료 코드: `0` 성공, `2` 필요한 키 없음(`QA_MISSING_KEYS`), `64` 잘못된 옵션, `1` 그 밖의 실패. 선택한 arm이 요구하는 키만 확인합니다(`jev`·`chain` → `TYPESAFE_API_KEY`, `openai` → `OPENAI_API_KEY`, `local` → 없음). 키 값은 출력하지 않으며, 결과 파일을 쓰기 직전에 키 값이 들어 있는지 검사해 들어 있으면 `QA_SECRET_IN_OUTPUT`으로 중단합니다.

후보 검색 방식의 오프라인 분석(API 미사용, 키 불필요). 제품의 `selectSkills`를 stub judge로 돌려 `lexical`/`adaptive`(`minCoverage` 격자)/`full`에서 gold skill이 judge에게 도달하는 비율, 넓게 판정한 작업 수, 작업당 판정 skill 수와 요청 수를 `results/dev-retrieval-offline/analysis.json`에 씁니다. recall의 상한일 뿐 judge 정확도는 재지 않습니다:

```bash
node qa/kernel/dev-retrieval-analysis.mjs        # [--data dir] [--out file]
```

이 스크립트 전체가 sweep이므로 출력에 "development analysis - not a result"가 붙고, `HOLDOUT.json`이 있는 폴더에서는 `QA_HOLDOUT_NO_SWEEPS`로 거부합니다.

하니스 자체의 오프라인 테스트(주입된 가짜 전송, **측정이 아님**):

```bash
TMPDIR="$(cd /tmp && pwd -P)" node --test qa/kernel/test/*.test.mjs
```

`run-eval.test.mjs`는 러너의 기본 경로, `retrieval-holdout.test.mjs`는 검색 방식 교차, consensus 계산, held-out 규율(해시 검증, `--spend-holdout` 없는 실행 거부, 두 번째 실행 거부, ledger 기록, 항목별 출력 억제), `freeze-holdout.mjs`, 입력 파일 해시와 `RUN_LEDGER.jsonl`, rows 파일 분할을 다룹니다. 임시 폴더의 작은 fixture와 주입된 전송만 씁니다. 예외는 저장소의 실제 파일을 읽는 두 검사입니다: `qa/kernel/results`·`qa/kernel/data` 아래에 1,000,000바이트를 넘는 파일이 없는지(`bash scripts/test-all.sh`의 Python 검증이 commit된 파일에 거는 제한), `DECISION_RULE.md`에 적힌 라벨 파일 sha256과 consensus 크기가 현재 데이터와 같은지.

## 실행 기록 (`results/RUN_LEDGER.jsonl`)

모든 실행(개발 세트·held-out, 오프라인 포함)은 **첫 요청 전에** `<out>/RUN_LEDGER.jsonl`에 한 줄을 덧붙입니다: `runId`, `timestamp`, `productCommit`(+`productDirty`, `productVersion`), `dataDir`, `transport`, `remoteArms`, `arms`, `retrievalModes`, `suites`, `limit`, `gold`, `labels`, `inputs`(읽은 작업·라벨 파일별 sha256과 카탈로그 fingerprint), `replacedExistingResult`(`--force`로 이전 결과를 지웠는지), `holdout`(held-out이면 manifest sha256·이유·이전 기록 수). 같은 `inputs`가 `metrics.json`에도 들어가고 요약의 라벨 파일 이름 옆에 sha256 앞 12자가 찍힙니다. 이 파일은 추가 전용이고 실행 뒤 결과 폴더와 함께 commit합니다. `DECISION_RULE.md`가 "결정에 쓰이는 실행"을 이 기록의 순서와 해시로 가려냅니다.

## Arm

| arm | 판단 지점의 judge 체인 | `escalateBelow` | suite |
|---|---|---|---|
| `jev` | `jev` | 0 | skills, supervisor |
| `openai` | `openai` | 0 | skills, supervisor |
| `local` | `local` (BM25 어휘 규칙) | 0 | skills |
| `chain` | `local` → `jev` | 0.6 | skills |

`--retrieval`을 주면 skill arm은 `jev-lexical`, `jev-adaptive`, `jev-full`처럼 arm x 검색 방식의 조합이 됩니다. judge 체인은 arm의 것이고 `kernel.skills.retrieval`만 다릅니다.

arm·suite(와 검색 방식 조합)마다 임시 `stateDir`을 새로 만들고, 그 설정에서만 `safety.allowEgress=true`, `kernel.providers.openai.approved=true`로 둡니다. 설치된 사용자 설정은 읽지도 바꾸지도 않습니다. 임시 디렉터리는 decision log를 결과 폴더로 복사한 뒤 지웁니다.

## 제품과 다른 점 (결과를 읽을 때 알아야 할 것)

- **timeout**: 제품은 `timeoutMs`를 5000ms까지만 허용하고 기본값은 1200ms, skill 지점은 `routeDeadlineMs`(3000ms)에서 끊습니다. 러너는 지연을 자르지 않고 재려고 기본 20000ms로 돕니다(나머지 설정은 `validateConfig`를 통과). 그래서 제품에서 timeout이 됐을 호출도 여기서는 답으로 채점됩니다. 대신 `operations.shareOverBudgetMs`가 1200/2500/3000/5000ms를 넘긴 호출의 비율을 알려 줍니다. **예외: OpenAI judge**는 제품이 자체 상한 `kernel.providers.openai.timeoutMs`(기본 2500ms, 최대 5000ms)를 따로 두므로 `--timeout-ms`로 풀리지 않습니다. 러너는 이 값을 제품 최대치 5000ms로 올려 돌리며, 5000ms를 넘긴 OpenAI 호출은 `DECISIONS_TIMEOUT` 실패로 남습니다.
- **scope**: 항목·시도마다 새 scope를 쓰고 `cacheTtlMs=0`입니다. 모든 항목이 실제 호출이고, 세션 요청 상한과 circuit이 항목끼리 영향을 주지 않습니다. 따라서 circuit open에 따른 연쇄 실패는 이 측정에 나타나지 않습니다.
- **지점 모드**: `shadow`. judge 호출과 log 기록은 `active`와 같습니다. 주입 블록 크기는 `active`였다면 만들어졌을 `skillContext()` 결과로 잽니다.
- **카탈로그**: 제품은 프로젝트의 `.claude/skills`만 프로젝트 skill로 읽으므로, `data/skills`를 임시 프로젝트의 `.claude/skills`로 복사해 `loadSkillCatalog`에 넘깁니다.
- **supervisor**: hook과 같은 순서(빈 보고·키 유사 문자열이면 보내지 않음 → `redact(text, maxReportChars)` → `decide` → `supervisorAdvice`)를 따릅니다. "이 확장이 라우팅한 위임인가" 같은 세션 조건은 평가 대상이 아닙니다.
- **넓은 판정의 부분 실패**: `adaptive`/`full`에서 작업 하나가 여러 chunk 요청으로 나뉘었을 때 일부만 실패하면 제품은 답이 온 chunk만으로 판정합니다. 러너도 그대로 채점하고 재시도하지 않으며, `operations.retrieval.failedRequests`와 `tasksWithPartialFailure`에 셉니다. 전부 실패한 작업만 `unavailable`이고 아래 재시도 대상입니다.
- **재시도**: 전송 오류(타입 없는 fetch 예외, HTTP 429/5xx, `LOCK_BUSY`)만 한 번 다시 보내고 `retriedTransportErrors`에 셉니다. timeout(`JEV_TIMEOUT`, `DECISIONS_TIMEOUT`, `KERNEL_DEADLINE`)과 그 밖의 typed 오류는 다시 보내지 않고 코드와 함께 실패로 남깁니다. 첫 시도의 실패 분포는 `failuresFirstPassByCode`에 따로 있습니다.

## Gold

- `author`: `*.gold.jsonl` (항상 전체 항목). `blind`: 두 번째 라벨 파일(B).
- `consensus`: 라벨 파일 A와 B가 **정확히 일치하는 항목만**. skill은 집합으로 비교(순서 무관), supervisor는 outcome이 같으면 일치. supervisor의 consensus evidence는 두 라벨의 evidence도 같을 때만 있습니다.
- skill 라벨 파일: A는 기본이 `skill-tasks.gold.jsonl`, B는 `relabel/skill-tasks.blind2.jsonl`이 있으면 그것(범주 힌트 없이 다시 붙인 라벨), 없으면 `skill-tasks.blind.jsonl`. `--labels A,B`로 바꿉니다. A를 author gold가 아닌 파일로 주면 consensus는 그 두 파일의 일치이고, `gold.author`는 여전히 `skill-tasks.gold.jsonl` 전체입니다. supervisor는 항상 `supervisor-reports.gold.jsonl` 대 `supervisor-reports.blind.jsonl`입니다.
- **항상 둘 다 보고합니다**: `gold.consensus`(consensus 부분집합)와 `gold.author`(전체 항목). `gold.blind`도 같은 구조로 나옵니다. 대표 gold(`--gold`)는 요약 순서와 제품 log 라벨의 출처만 정합니다. 두 번째 라벨 파일이 없으면 `consensus`·`blind`는 `null`이고 요약에 그 사실이 나옵니다.
- `dataset.*`: 항목 수, 쓴 라벨 파일(`labelFiles`), consensus 수(`consensus`)와 전체 대비 비율(`consensusShareOfItems`), 라벨러 일치율(`exactSetMatchRate`, `outcomeExactRate`), Cohen's kappa(`anySkillKappa`: "skill이 하나라도 필요한가" 이진 판단, `outcomeKappa`: supervisor outcome), evidence 일치율, 카탈로그에 없는 gold 이름. 요약 첫머리에 일치율과 consensus 크기가 항상 찍힙니다.

## Held-out 세트

데이터 폴더에 `HOLDOUT.json`(`{frozen: true, sha256: {파일: 해시}, policy}`)이 있으면 그 폴더는 held-out 세트입니다. 만드는 법:

```bash
node qa/kernel/freeze-holdout.mjs --data-dir <dir> [--policy "<문장>"]
```

`skills/` 아래 모든 파일과 폴더 안의 모든 `.jsonl`(작업·라벨 파일, `HOLDOUT_LEDGER.jsonl` 제외)의 sha256을 적습니다. `HOLDOUT.json`이 이미 있으면 `QA_HOLDOUT_EXISTS`로 거부하고 덮어쓰지 않습니다. 기본 폴더가 없어서 `--data-dir`을 반드시 줘야 합니다(개발 세트를 실수로 얼리지 않도록). symlink가 있으면 거부합니다.

`HOLDOUT.json`이 있을 때 `run-eval.mjs`는 다음 순서로 동작합니다.

1. **해시 검증이 가장 먼저**입니다. 적힌 파일 하나라도 내용이 다르면 `QA_HOLDOUT_HASH_MISMATCH`, 없으면 `QA_HOLDOUT_FILE_MISSING`. 이번 실행이 읽는 파일(작업·라벨 파일)이나 `skills/` 아래 파일이 목록에 없으면 `QA_HOLDOUT_UNLISTED_FILE`. `HOLDOUT.json`이 형식에 맞지 않으면 `QA_HOLDOUT_INVALID`(held-out이 아닌 것으로 취급하지 않음).
2. `--spend-holdout "<이유>"`가 없으면 `QA_HOLDOUT_REQUIRES_SPEND`로 거부합니다. `local` arm처럼 API를 부르지 않는 실행도 같습니다. 반대로 `HOLDOUT.json`이 없는 폴더에 `--spend-holdout`을 주면 `QA_HOLDOUT_NOT_FROZEN`입니다.
3. **이미 기록된 실행이 있으면 거부합니다**(`QA_HOLDOUT_ALREADY_SPENT`). `<data-dir>/HOLDOUT_LEDGER.jsonl`에 줄이 있거나, 출력 폴더의 `RUN_LEDGER.jsonl`에 같은 `HOLDOUT.json`(sha256)으로 돌린 기록이 있으면 해당합니다. 그래서 세트의 ledger를 지워도 초기화되지 않습니다. 첫 실행이 오류로 죽었을 때처럼 정말 다시 봐야 하면 `--respend-holdout "<이유>"`를 더하고, 그 사실을 보고서에 적습니다.
4. 키·라벨·run id 검사를 통과한 뒤, **첫 요청 전에** `<data-dir>/HOLDOUT_LEDGER.jsonl`에 한 줄을 덧붙입니다: `runId`, `timestamp`, `productCommit`(+`productDirty`, `productVersion`), `arms`, `retrievalModes`, `plan`, `suites`, `limit`, `gold`, `labels`, `transport`, `remoteArms`, `reason`(+`respendReason`), `manifestSha256`, `inputs`. 실행이 중간에 죽어도 줄은 남습니다. 1~3번이나 그 뒤의 사전 검사에서 거부된 실행은 요청을 보내지 않았으므로 줄을 남기지 않습니다.
5. 출력은 **집계 수치뿐**입니다. `rows-*.jsonl`과 `decision-log/` 사본을 쓰지 않고, `metrics.retrieval`(BM25 top-k sweep)·`autoLoadSweep`·`thresholdSweep`은 `{suppressed: ...}`로 바뀌며, `dataset.*.issues`는 항목 id 대신 개수만 담습니다. 결과 폴더에는 `metrics.json`과 `summary.txt`만 남고 `metrics.holdout`에 정책·ledger 줄·이전 기록 수가 들어갑니다.

**강제하지 못하는 것.** 이 규율은 로컬 파일로만 지켜집니다. `HOLDOUT.json`, `HOLDOUT_LEDGER.jsonl`, `RUN_LEDGER.jsonl`을 모두 지우고 데이터를 고친 뒤 다시 freeze하면 로컬에는 흔적이 없습니다. freeze 전에 `HOLDOUT.json` 없이 돌려 항목별 출력을 본 것도 러너는 알 수 없습니다. 그래서 freeze 직후 `HOLDOUT.json`을, 채점 직후 두 ledger와 결과 폴더를 commit해야 하고, git 기록이 유일한 외부 근거입니다.

기본 검색 방식을 어떻게 고르고 held-out을 어떻게 쓰는지는 `DECISION_RULE.md`에 실제 실행 전에 적어 두었습니다.

## 출력

`qa/kernel/results/<run-id>/`

| 파일 | 내용 |
|---|---|
| `metrics.json` | 아래의 모든 수치. `live: true`는 전송을 주입하지 않았다는 뜻이고(테스트용 전송을 주입하면 `live: false`, `transport: "injected"`), `remoteArms: false`면 원격 API를 부르는 arm이 없었다는 뜻입니다(`local`만 돌린 실행). 실제로 보낸 요청 수는 `liveRequests`에 있습니다 |
| `summary.txt` | 화면에 찍힌 요약 |
| `rows-skills-<arm>.jsonl` | 항목별 원자료: id, 언어, 범주, 상태·오류 코드, `need`, `retrieval`(제품이 돌려준 `mode`/`wide`/`lexicalSignal`/`requests`/`failed`/`judged`/`dropped`), 후보별 BM25 순위·점수·확률·단계, load/suggest, 전체 순위, `calls`(요청별 skill 이름·성공 여부·코드·지연·`need`·judge·usage·`decisionId`), `decisions`(요청별 log 기록의 `trail`), `latencyMs`(작업 wall clock), usage 합, gold, `partial`·`partialCode`(일부 요청만 실패한 작업). `--retrieval`을 주면 `<arm>`은 `<arm>-<방식>`. **파일 하나는 900,000바이트를 넘지 않습니다.** 넘으면 이어지는 줄이 `rows-skills-<arm>.part2.jsonl`, `.part3.jsonl`, …에 쓰이고 `metrics.files`에 모두 나열됩니다(이어 붙이면 원래 순서의 전체 rows). commit된 파일이 1,000,000바이트를 넘으면 `bash scripts/test-all.sh`의 Python 검증이 `UNSAFE_ARCHIVE_ENTRY`로 실패하기 때문입니다 |
| `rows-supervisor-<arm>.jsonl` | 항목별: outcome, 확신, 분포, evidence 점수·단계·분포, `advisory`, 지연, usage, `trail`, gold |
| `decision-log/<suite>-<arm>/` | 제품 `DecisionLog`가 쓴 `decisions-*.jsonl`, `labels-*.jsonl` 사본 |

원자료에는 작업 문장·보고 본문·키가 들어가지 않습니다. 측정하지 못한 값은 `0`이 아니라 `null`입니다. held-out 세트에서는 `metrics.json`과 `summary.txt`만 쓰입니다.

`metrics.json`의 `schema`는 2입니다. 1과 달라진 점: `rows-skills-*`의 `latencyMs`가 작업 wall clock이 됐고(요청별 값은 `calls[].latencyMs`), supervisor `thresholdSweep`이 배열에서 `{label, points}`로 바뀌었고, 위 표의 새 필드가 추가됐습니다. `--retrieval` 없이 돌린 `lexical` 실행의 채점 수치 정의는 그대로입니다.

## 지표: skill 라우팅 (`metrics.skills.<arm>`)

제품 기본 임계값을 그대로 씁니다: `need 0.5`, `autoLoad 0.9`, `suggest 0.5`, `maxCandidates 8`, `maxLoaded 3`, 넓은 판정은 `minCoverage 0.25`, `maxJudged 64`, `chunk 32`.

**sweep은 전부 개발용 분석입니다.** `metrics.retrieval`, `autoLoadSweep`, supervisor `thresholdSweep`에는 `label: "development analysis - not a result"`가 붙고 요약에도 같은 문구가 찍힙니다. 기본값 선택의 근거가 아니며(`DECISION_RULE.md`), held-out 세트에서는 만들지 않습니다.

**실패한 항목은 "아무것도 고르지 않음"으로 채점합니다**(제품이 실제로 그렇게 동작). judge가 답한 항목만의 수치는 각 gold 블록의 `answeredOnly`에 있습니다.

| 위치 | 뜻 |
|---|---|
| `metrics.retrieval.<gold>[k]` | **sweep (`label: "development analysis - not a result"`).** arm과 무관. BM25 상위 k(4/8/12/16/40) 안에 gold skill이 들어온 비율(`goldSkillRecall`)과 gold가 전부 들어온 작업 비율, 전체·언어별. 카탈로그가 40개라 judge가 보기 전에 정답을 잃을 수 있고, **이 값이 뒤의 모든 recall의 상한**입니다. `inTopKWithPositiveScore`는 BM25 점수가 0보다 커서 들어온 것만 센 값(점수 0은 이름순 동률) |
| `gold.<g>.retrievalAtMaxCandidates` | 실제 실행에서 judge에게 간 후보(`lexical`은 8개, 넓게 판정한 작업은 최대 `maxJudged`개) 안의 gold recall |
| `gold.<g>.needGate` | "skill이 필요한가"(`need ≥ 0.5`) 대 gold(`gold`가 비어 있지 않음)의 accuracy/precision/recall과 tp/fp/tn/fn |
| `gold.<g>.loaded` | **load된 집합** 대 gold: micro precision/recall/F1(전 항목의 tp/fp/fn 합), `exactSetMatchRate`(집합이 정확히 같은 항목 비율, 둘 다 빈 경우 포함) |
| `gold.<g>.loadedOrSuggested` | load+consider를 양성으로 센 같은 지표 |
| `gold.<g>.noneTasks.falseInjectionRate` | gold가 빈 작업 중 skill이 하나라도 load된 비율. `falseInjectionOrSuggestionRate`는 consider 포함 |
| `gold.<g>.goldTasks.missRate` | gold가 있는 작업 중 gold skill이 **하나도** load되지 않은 비율. `incompleteRate`는 gold 전부가 load되지는 않은 비율. `...CountingSuggested`는 consider 포함 |
| `gold.<g>.goldSkillNotLoadedByStage` | load되지 못한 gold skill이 어디서 멈췄는가: `retrieval`, `need_gate`, `below_threshold`, `suggested`, `cap`, `judge_unavailable` |
| `gold.<g>.byLanguage`, `byCategory` | 위 지표의 언어별·범주별 분해. 언어별 load precision/recall은 `byLanguage.<lang>.loaded`이고 요약에도 표로 나옵니다 |
| `operations.retrieval` | 실제로 돈 후보 검색: `mode`와 설정값, `wideShare`(넓게 판정한 작업 비율, `wideShareByLanguage`), `requestsPerTask`(`mean`, `max`), `skillsJudgedPerTask`(`mean`, `max`), `failedRequests`(실패하거나 늦은 chunk 요청 수), `tasksWithPartialFailure` |
| `operations.taskLatencyMs` | **작업당** 지연 p50/p95/max: 작업의 첫 judge 요청을 보낸 때부터 `selectSkills`가 돌아올 때까지의 wall clock. 넓은 판정의 동시 chunk 요청은 한 번으로 셉니다. 실패한 작업 포함, 최종 시도 기준 |
| `operations.tokensPerTask` | API 응답 본문의 토큰 합(`http.wireUsage`)을 작업 수로 나눈 값(재시도한 요청 포함). 응답에 없으면 `null`(`local`은 항상 `null`) |
| `autoLoadSweep` | **sweep (`label: "development analysis - not a result"`).** 기록된 확률을 **실제 `selectSkills`에 다시 넣어**(replay judge, 추가 호출 없음) `autoLoad`를 0.5/0.6/0.7/0.8/0.9/0.95로 바꿨을 때의 load P/R/F1, 오주입률, miss율. `replayOfShippedThresholdsMismatches`는 기본 임계값으로 replay했을 때 실제 결과와 다른 항목 수(0이어야 함) |
| `calibration.product` | 답이 나온 **요청**(decision)마다 제품의 `log.label()`로 `need`와 `skill_i` 라벨을 쓰고 제품의 `calibrationReport()`를 돌린 결과(라벨은 대표 gold). 제품 보고서는 `need`와 `skill_i`를 한 `noul` 묶음으로 합칩니다. `need` 라벨은 요청이 하나인 작업에서는 전과 같이 "작업에 skill이 필요한가"이고, 요청이 여럿인 작업에서는 각 요청이 자기 chunk만 보고 답했으므로 "이 chunk 안에 gold skill이 있는가"입니다 |
| `calibration.direct` | 같은 라벨로 러너가 직접 계산한 Brier/ECE/기저율/신뢰도 표. `need`와 `perSkill`을 **따로** 보여 주고(`labelGold`), author gold 전체 기준(`author`)도 제공. 여기의 `need`는 작업 수준입니다: 제품이 gate에 쓰는 값(답이 온 요청들의 최댓값) 대 "작업에 skill이 필요한가" |
| `calibration.crossCheck` | 제품 보고서의 `noul` 묶음과 직접 계산의 Brier·ECE 차이. `agrees: true`면 라벨 수가 같고 차이가 1e-9 미만 |
| `operations.latencyMs` | judge **요청** 한 번(체인은 체인 전체)의 p50/p90/p95/max. 넓은 판정은 요청이 여럿이므로 작업당 지연은 `taskLatencyMs`를 보세요. 실패·재시도 포함. `latencySuccessfulMs`는 성공만, `latencyByJudgeMs`는 `trail` 기준 judge별 |
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
| `gold.<g>.thresholdSweep` | **sweep (`label: "development analysis - not a result"`).** `points`: 임계값을 0~0.95로 바꿨을 때의 같은 수치(오프라인) |
| `gold.<g>.byLanguage` | 언어별 정확도·evidence·임계값 효과 |
| `calibration.product`, `crossCheck` | `log.label()`로 `outcome`·`evidence` 라벨을 쓰고 `calibrationReport()`를 돌린 결과와, 직접 계산(Brier, accuracy, ECE, MAE, 단계 일치율)의 비교 |
| `operations` | skill과 같음. `skipped`는 보내지 않은 항목(`EMPTY_REPORT`, `SECRET_GUARD`), `truncatedReports`는 1600자로 잘린 보고 수 |

## 한계

- 합성 데이터에 대한 judge 정확도·calibration·지연·토큰만 잽니다. 실제 작업의 품질·시간·비용 개선(end-to-end 효과)은 이 러너로 알 수 없습니다.
- hook을 실제 Claude Code/Codex 세션에 설치해 도는 경로는 다루지 않습니다.
- 한 번 실행한 결과입니다. 반복 실행에 따른 분산은 재지 않습니다.
- 비용은 계산하지 않습니다. API가 돌려준 토큰 수만 기록합니다.
