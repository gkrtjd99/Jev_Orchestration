# 사전 등록 결정 규칙: skill 후보 검색 기본값 (`kernel.skills.retrieval`)

작성일 2026-11-25. **이 파일은 검색 방식별 실제(live) 개발 세트 실행이 한 번도 이루어지기 전에 작성했습니다.** 이 파일을 추가한 commit 시점에 `qa/kernel/results/`에는 `--retrieval`로 원격 judge를 돌린 결과가 없습니다. 있는 것은 stub judge의 오프라인 분석(`results/dev-retrieval-offline/`)과 `local` arm 배선 확인(`results/20261125-wiring-local-retrieval/`)뿐이며, 둘 다 결과가 아닙니다.

규칙을 바꿔야 한다면 실제 개발 세트 실행 **전에** 이 파일을 고치고 commit합니다. 실행 뒤에는 고치지 않습니다. 실행 뒤에 규칙이 부적절했다는 것을 알게 되면 규칙을 고치는 대신 그 사실을 보고서에 적습니다.

## 무엇을 결정하는가

제품의 기본 후보 검색 방식 하나: `lexical`(현재 기본값), `adaptive`, `full`.

비교 대상은 이 세 방식이고, 나머지 설정은 전부 제품 기본값 그대로입니다(`minCoverage 0.25`, `maxJudged 64`, `chunk 32`, `maxCandidates 8`, `need 0.5`, `autoLoad 0.9`). 이 값들은 이 규칙으로 조정하지 않습니다.

## 입력: 개발 세트 실제 실행 1회

- 데이터: `qa/kernel/data` (개발 세트). judge: Jev (`--arms jev`).
- 실행 명령(이 형태 그대로, run id만 정함):

```bash
node qa/kernel/run-eval.mjs --run-id <run-id> --suite skills --arms jev \
  --retrieval lexical,adaptive,full --gold consensus \
  --labels skill-tasks.gold.jsonl,relabel/skill-tasks.blind2.jsonl
```

- consensus 부분집합: `skill-tasks.gold.jsonl`과 `relabel/skill-tasks.blind2.jsonl`의 skill 집합이 정확히 일치하는 항목. `--labels`로 두 파일을 명시하므로 둘 중 하나가 없으면 실행이 거부됩니다(다른 라벨 파일로 조용히 바뀌지 않음).
- 실패한 항목은 러너의 기본 채점대로 "아무것도 고르지 않음"으로 셉니다.

## 규칙

`metrics.json`의 `skills["jev-<mode>"]`에서 읽습니다.

1. **자격 조건** (둘 다 만족해야 함)
   - skill이 필요 없는 작업의 오주입률이 0.02 이하: `gold.consensus.noneTasks.falseInjectionRate <= 0.02`
   - Jev judge의 작업당 지연 p95가 1500 ms 이하: `operations.taskLatencyMs.p95 <= 1500` (작업 하나의 chunk 요청 전체에 걸친 wall clock, 실패한 작업 포함)
2. **선택**: 자격을 갖춘 방식 중 consensus 부분집합의 load F1(`gold.consensus.loaded.f1`)이 가장 높은 방식.
3. **동률**: 가장 높은 F1과의 차이가 0.01 이내인 자격 방식은 동률로 보고, 그중 작업당 요청 수(`operations.retrieval.requestsPerTask.mean`)가 적은 방식을 고릅니다.
4. **자격을 갖춘 방식이 없으면** 기본값은 `lexical`로 둡니다.

### 위 규칙이 말하지 않는 경우에 대한 보충 (같은 시점에 미리 정함)

아래 세 가지는 저장소 소유자가 준 규칙 문장에는 없고, 규칙을 기계적으로 적용할 수 있도록 QA 작성자가 덧붙인 것입니다.

- 오주입률의 gold는 F1과 같은 consensus 부분집합입니다. author gold 전체 기준 수치는 함께 보고하지만 자격 판정에는 쓰지 않습니다.
- `loaded.f1`이 `null`인 방식(load가 한 건도 없음)은 자격이 없는 것으로 봅니다.
- 3번에서 요청 수까지 같으면 더 단순한 쪽을 고릅니다: `lexical`, `adaptive`, `full` 순.

실행이 오류로 중단되어 `metrics.json`이 쓰이지 않았다면 새 run id로 다시 실행하고, 중단된 run id도 보고서에 적습니다. `metrics.json`이 쓰인 첫 실행이 결정에 쓰이는 실행입니다. 수치가 마음에 들지 않는다는 이유로 다시 실행하지 않습니다.

## 결정에 쓰지 않는 것

- 러너와 `dev-retrieval-analysis.mjs`가 내는 모든 sweep(`autoLoadSweep`, BM25 top-k, `minCoverage` 격자 등). 전부 "development analysis - not a result"로 표시되며 기본값 선택의 근거가 아닙니다.
- `openai`, `local`, `chain` arm의 수치.
- held-out 세트의 어떤 수치도.

## Held-out 세트

- held-out 세트는 **한 번만** 채점합니다: 위 규칙으로 고른 방식과 `lexical` 기준선. 고른 방식이 `lexical`이면 `lexical`만 돌립니다.
- held-out 결과를 본 뒤에는 **아무것도 조정하지 않습니다**: 기본 검색 방식, `minCoverage`, 임계값, 프롬프트, 토크나이저, 이 규칙 모두. held-out 수치는 보고만 합니다. 개발 세트에서 고른 방식이 held-out에서 더 나쁘게 나와도 선택을 뒤집지 않고 그 사실을 그대로 적습니다.
- 러너가 이를 강제합니다: `HOLDOUT.json`이 있는 폴더는 해시 검증 → `--spend-holdout "<이유>"` 없으면 거부 → 첫 요청 전에 `HOLDOUT_LEDGER.jsonl`에 기록 → 항목별 파일과 sweep 없이 집계 수치만 출력. ledger에 두 줄 이상이 있으면 "한 번만"이 지켜지지 않은 것이므로 보고서에 모든 줄을 적습니다.

```bash
node qa/kernel/run-eval.mjs --run-id <run-id> --data-dir <held-out 폴더> --suite skills --arms jev \
  --retrieval lexical,<고른 방식> --gold consensus \
  --spend-holdout "DECISION_RULE.md에 따른 1회 채점: <고른 방식> 대 lexical"
```

## 이 규칙의 한계

- 합성 데이터, judge 하나(Jev), 실행 1회입니다. 반복 실행의 분산을 재지 않으므로 0.01 F1 차이가 잡음보다 큰지는 알 수 없습니다. 동률 폭 0.01은 그 대신 둔 값이지 추정한 값이 아닙니다.
- 0.02와 1500 ms는 미리 정한 한도이지 측정에서 나온 값이 아닙니다.
- 실제 작업의 품질·시간·비용(end-to-end 효과)은 이 규칙으로 판단하지 않습니다.
