# Decision kernel QA 요약 (2026-11-25, branch `qa/kernel-eval`, 제품 트리 `31e1c26`)

## 결론

- **이 브랜치는 push도 merge도 하지 않았습니다.** 병합할지는 저장소 소유자가 정합니다. 이 문서는 판단 근거만 적습니다.
- 6개 미결 항목: **해결 2, 부분 해결 3, 미해결 1.** 미해결은 가장 중요한 항목(실제 효과)입니다.
- 확인된 것: 합성 데이터에서 skill 판정이 라벨과 얼마나 일치하는가(개발 세트와 held-out 세트 1개), 실제 데스크톱 세션에서 hook이 동작하고 supervisor 조언이 Main에 전달되는 것(`advisory` 모드), 오프라인 테스트 전체 통과, 기본 동작 불변.
- 확인되지 않은 것: **이 기능이 실제 작업의 품질·시간·비용을 개선하는가.** 한 건도 재지 않았습니다. 실제 세션의 `active` 모드(서브에이전트 prompt에 skill 블록 주입)와 Codex도 확인하지 않았습니다.
- 숫자는 근거 파일의 표기를 그대로 옮겼습니다. 측정하지 않은 값은 "미측정"으로 적었습니다.

## 6개 항목 상태

| # | 항목 | 상태 | 확인한 것 (근거 파일) | 남은 것 |
|---|---|---|---|---|
| 1 | 실제 효과 (작업 품질·시간·비용) | **미해결** | 판정 일치도만 측정. 합성 데이터, 개발 세트와 held-out 세트 1개 (`results/dev-retrieval-decision-1/`, `results/holdout-1-score-1/`, `results/20261125-full/`) | 미측정. 주입 있음/없음을 짝지은 비교를 하지 않음. 실제 세션에서는 서브에이전트가 skill 4개짜리 프로젝트에서 맞는 skill을 스스로 load해서 주입의 이득을 알 수 없음 |
| 2 | 실제 hook / 실제 세션 종단 실행 | **부분 해결** | 설치된 entrypoint 직접 호출 100회(그중 실제 judge 시나리오 88회, 나머지 12회는 loopback 장애 주입): 기대 214개 중 212 PASS / 0 FAIL / soft miss 2 (`results/20261125-e2e/hooks.txt`, `hooks.json`). 실제 데스크톱 세션 4회, `advisory` 모드: 실제 Agent 호출에서 hook 실행, 실제 Jev로 라우팅·skill 선택, hand-back 경로에서 supervisor 판정, 세션 4에서 조언이 Main에 전달 (`results/real-session-20261125/summary.json`) | 실제 세션에서 미확인: `active` 모드(서브에이전트 prompt 재작성), 결합 수정 뒤 harness 알림 줄이 있는 prompt 형태(fixture로만 확인), Codex |
| 3 | OpenAI 첫 호출 timeout | **부분 해결** | 제공자별 timeout 추가, 기본 2500 ms. 실제 요청 280건 최대 928 ms (`results/20261125-full/summary.txt`), cold 프로세스 요청 14건 최대 778 ms (`results/20261125-e2e/hooks.json` s17). timeout 0건 | 2500 ms는 분포에서 정한 값이 아닌 초기값. 설정 근거는 1200 ms를 넘긴 cold 호출 1건이고 그 지속 시간은 기록되지 않음(`orchestration/src/kernel/judges.mjs`의 주석). 그 뒤 확인한 cold 표본은 14건뿐(최대 778 ms). 그 뒤 OpenAI를 실제로 다시 부르지 않음 |
| 4 | 기본 동작 바이트 비교 | **해결** | 이 문서를 쓰며 다시 실행: `npm run compare:default` IDENTICAL, hook 출력 168개·judge 호출 21건 (`orchestration/scripts/compare-default-behavior.mjs`) | 없음. 검사가 다루지 않는 범위(기본값이 아닌 kernel 설정, 실제 호출 등)는 주장하지 않음 |
| 5 | macOS 기본 `TMPDIR`에서 `npm test` | **해결** | 이 문서를 쓰며 다시 실행: `TMPDIR=/var/folders/...` 그대로 590/590 통과 | 없음 |
| 6 | 심볼릭 링크된 skill 폴더 | **부분 해결** | 프로젝트 안을 가리키는 링크는 따라가서 읽음 (commit `95e30f1`, `orchestration/test/kernel-skills.test.mjs`) | 프로젝트 밖으로 풀리는 링크는 읽지 않음. 의도된 제한이며 `JEV_SKILL_DIRS`로 지정해야 함. 실제 프로젝트에서는 미확인 |

## Skill 라우팅: 개발 세트와 held-out 세트

조건은 같습니다: judge는 실제 Jev, 기본 임계값(need 0.5, autoLoad 0.9), 실행 1회, 실패 0건. 수치는 각 폴더의 `summary.txt` 표기 그대로이며 consensus 라벨 기준입니다.

| | 개발 세트 | held-out 세트 1 |
|---|---|---|
| 근거 | `results/dev-retrieval-decision-1/` | `results/holdout-1-score-1/` |
| 카탈로그 / 작업 | skill 40개 / 160건 (consensus 159건) | skill 72개 / 180건 (consensus 180건) |
| 실제 요청 | 719건 (`adaptive` 포함 3방식) | 540건 (2방식) |
| 쓰임 | 기본값 결정에 사용 | 결정 뒤 한 번만 채점, 집계 수치만 저장 |

기본값은 사전 등록 규칙(`DECISION_RULE.md`)을 개발 세트에 적용해 `lexical`에서 `full`로 바꿨습니다(commit `1e05985`). held-out 결과로는 아무것도 조정하지 않았습니다.

**전체**

| 방식 | 세트 | need accuracy | load precision | load recall | load F1 | 정확 일치 | 오주입률 (skill 불필요 작업) |
|---|---|---|---|---|---|---|---|
| `lexical` (이전 기본) | 개발 | 83.6% | 1.000 | 0.669 | 0.802 | 78.0% | 0.0% |
| `lexical` | held-out | 81.1% | 0.963 | 0.578 | 0.722 | 70.0% | 1.6% |
| `full` (현재 기본) | 개발 | 100.0% | 0.991 | 0.949 | 0.970 | 95.6% | 0.0% |
| `full` | held-out | 97.2% | 0.967 | 0.881 | 0.922 | 88.9% | 1.6% |

**언어별 (load precision / recall / F1)**

| 방식 | 세트 | 영어 | 한국어 | 혼합 |
|---|---|---|---|---|
| `lexical` | 개발 | 1.000 / 0.870 / 0.930 (n 95) | 1.000 / 0.388 / 0.559 (n 64) | 해당 작업 없음 |
| `lexical` | held-out | 1.000 / 0.738 / 0.849 (n 81) | 0.882 / 0.278 / 0.423 (n 72) | 0.947 / 0.900 / 0.923 (n 27) |
| `full` | 개발 | 1.000 / 0.957 / 0.978 (n 95) | 0.979 / 0.939 / 0.958 (n 64) | 해당 작업 없음 |
| `full` | held-out | 1.000 / 0.951 / 0.975 (n 81) | 0.935 / 0.796 / 0.860 (n 72) | 0.947 / 0.900 / 0.923 (n 27) |

**비용과 지연 (작업 하나 기준)**

| 방식 | 세트 | 요청 수 | 판정 skill 수 | 입력 / 출력 토큰 | 지연 p50 / p95 / 최대 ms |
|---|---|---|---|---|---|
| `lexical` | 개발 | 1.00 | 8.0 | 1518.9 / 164.0 | 181 / 251 / 489 |
| `lexical` | held-out | 1.00 | 8.0 | 1612.8 / 164.0 | 181 / 256 / 534 |
| `full` | 개발 | 2.00 | 40.0 | 6551.2 / 780.0 | 220 / 540 / 666 |
| `full` | held-out | 2.00 | 64.0 | 10341.2 / 1236.0 | 808 / 924 / 1026 |

금액은 계산하지 않았습니다(미측정). 반복 실행의 분산도 미측정입니다.

**사전 등록 규칙이 함께 보고하라고 한 수치** (`DECISION_RULE.md`의 "함께 보고하되 결정에 쓰지 않는 것". 각 `metrics.json`의 `skills["jev-<방식>"]`, 결정에는 쓰지 않음)

| 방식 | 세트 | 넓게 간 작업의 비율 (`operations.retrieval.wideShareByLanguage`) | 넓게 간 skill 불필요 작업의 오주입 (`gold.consensus.wideNoneTasksByLanguage`, load된 작업 / 작업) | 일부 요청만 실패하고 아무것도 고르지 못한 작업 (`operations.retrieval.tasksPartialNothingSelected`) |
|---|---|---|---|---|
| `lexical` | 개발 | 영어 0 (0/96), 한국어 0 (0/64) | 넓게 간 작업 없음 (빈 객체) | 0 |
| `adaptive` | 개발 | 영어 0.15625 (15/96), 한국어 1 (64/64) | 영어 0/14, 한국어 0/22 | 0 |
| `full` | 개발 | 영어 1 (96/96), 한국어 1 (64/64) | 영어 0/34, 한국어 0/22 | 0 |
| `lexical` | held-out | 영어 0 (0/81), 한국어 0 (0/72), 혼합 0 (0/27) | 넓게 간 작업 없음 (빈 객체) | 0 |
| `full` | held-out | 영어 1 (81/81), 한국어 1 (72/72), 혼합 1 (27/27) | 영어 0/28, 한국어 0/25, 혼합 1/10 (오주입률 0.1) | 0 |

`adaptive`는 held-out에서 돌리지 않았으므로 held-out 값이 없습니다(미측정). `lexical`은 넓게 간 작업이 없어 이 항목으로는 오주입이 집계되지 않습니다. `lexical`의 held-out 오주입 1건은 위 전체 표의 오주입률 1.6%에 들어 있습니다.

**약점**

1. `full`의 held-out F1(0.922)은 개발 세트(0.970)보다 낮습니다. 기본값은 개발 세트에 맞춘 선택입니다.
2. 한국어 recall이 held-out에서 떨어졌습니다(0.939 → 0.796). 집계상 놓친 한국어 gold 11개 중 6개는 judge에게 도달하지 못했고 5개는 제안에 그쳤습니다(`metrics.json`의 `goldSkillNotLoadedByStage`). 카탈로그 72개가 `maxJudged` 64를 넘는 것이 원인으로 의심되지만, 항목별 출력을 남기지 않아 확인하지 못했습니다.
3. held-out에서 skill이 필요 없는 작업 63건 중 1건에 오주입이 있었습니다(혼합 언어 작업 10건 중 1건, `lexical`과 `full` 모두).
4. `full`은 작업당 요청 2건이고, 입력 토큰은 `lexical`의 약 4.3배(개발), 약 6.4배(held-out)입니다(위 표의 값으로 계산). held-out의 작업당 p95 924 ms는 제품의 judge 예산 1200 ms에 가깝습니다(최대 1026 ms).
5. `full`은 load하지 않고 제안만 하는 skill이 많습니다. 제안까지 세면 F1이 0.785(개발), 0.683(held-out)입니다. held-out에서 load하거나 제안한 skill 중 gold가 아닌 것이 114개이고 그중 load된 것은 4개입니다(`holdout-1-score-1/metrics.json`의 `loadedOrSuggested` tp 129 / fp 114 / fn 6, precision 0.531; `loaded` fp 4). 제안만 된 것의 수는 따로 저장되어 있지 않습니다.
6. 라벨은 모델이 합성 작업에 붙인 것입니다. held-out의 작성자 gold와 blind 라벨 두 벌은 180/180 일치하지만, blind 라벨러는 카탈로그와 작업 파일만 읽었으므로 이 일치는 작업이 라벨링 모델에게 모호하지 않다는 것만 보여 줍니다. gold가 독립적으로 검증된 것은 아니고, 사람은 라벨을 검토하지 않았습니다. held-out은 항목별 결과를 남기지 않아 수치를 독립적으로 다시 계산하지 못했습니다.

OpenAI·`local`·`chain` arm과 `adaptive`는 held-out에서 돌리지 않았습니다. `local` 기권 변경 뒤의 `chain`도 실제 judge로 다시 돌리지 않았습니다.

## Supervisor (`results/20261125-full/summary.txt`, `metrics.json`)

합성 보고 120건(outcome 4종 각 30건), 실행 1회, 제품 `e8333f94`. 그 뒤 다시 돌리지 않았고 supervisor용 held-out 세트는 없습니다.

| arm | accuracy | macro F1 | retry를 complete로 오판 | 0.65에서 표시 비율 | 표시된 것의 accuracy | 틀린 조언이 표시된 건수 | 지연 p50 / p95 ms |
|---|---|---|---|---|---|---|---|
| `jev` | 93.3% | 0.932 | 6 / 30 | 83.3% | 98.0% | 2 | 171 / 199 |
| `openai` | 96.7% | 0.967 | 4 / 30 | 73.3% | 100.0% | 0 | 459 / 602 |

임계값 0.65는 측정으로 정한 값이 아닙니다. 조언이 실제로 유용한지는 미측정입니다.

## 실제 데스크톱 세션 4회 (`results/real-session-20261125/summary.json`)

로그인된 Claude Code 데스크톱 앱, 일회용 합성 프로젝트, 프로젝트 수준 hook만 사용했습니다. 실제 `~/.claude`는 건드리지 않았습니다. 전역 모드 `advisory`, `delegation.skills`와 `supervisor.outcome`은 `active`, judge는 실제 Jev. 세션마다 위임 1건입니다.

| 세션 | 제품 | 확인된 것 | 확인되지 않았거나 드러난 문제 |
|---|---|---|---|
| 1 | `2a162d8` | 실제 Agent 호출에서 PreToolUse 실행. 실제 Jev로 라우팅과 skill 선택(`changelog-hollowbrook`, p 0.98). skill 블록이 Main에 표시됨. 결과물이 규칙을 따름 | 서브에이전트 prompt는 재작성되지 않음. 서브에이전트가 skill을 스스로 load함. supervisor가 실행되지 않음: 보고가 `SubagentHandback`으로 오는데 그 빌드는 해시만 했음 |
| 2 | `2a162d8` | hook 이벤트 29개의 실제 형태를 수집 | 판정 목적이 아님 |
| 3 | `8f7c976` | hand-back 경로에서 supervisor 판정(274 ms, `complete`, 확신 0.44). 확신이 0.65 미만이라 조언 미전달(의도된 동작) | harness가 알림 줄을 끼워 넣어 prompt 결합이 일치할 수 없었음(`unverified_prompt`). `7fb4ff2`, `31e1c26`에서 수정 |
| 4 | `31e1c26` | supervisor 판정(`complete`, 확신 0.75), prompt가 `handback_prompt`로 기록, 조언이 `UserPromptSubmit`에서 Main에 전달되고 Main 기록에서 확인됨(hand-back→prompt 60 ms, prompt→전달 238 ms). 상태 파일 0600, 보고 텍스트 저장 없음 | QA용 일회용 설정에서 확신 임계값을 0.3으로 낮췄음(제품 기본 0.65는 그대로이고 관측된 0.75는 기본값도 통과). 이 세션에는 harness 알림 줄이 없었음 |

원자료(hook 상태, 수집한 이벤트)는 로컬 경로와 세션 메타데이터가 들어 있어 저장소에 넣지 않았습니다. 위 파일은 검토된 요약입니다.

## QA에서 찾아 고친 결함

각 수정에 회귀 테스트가 있습니다. 상세는 `orchestration/CHANGELOG.md`와 `docs/KERNEL.ko.md`.

| commit | 고친 것 |
|---|---|
| `e6fb770` | 프로필 선택이 보류되면 선택된 skill이 버려짐. timeout 50 ms 경계에서 judge 미호출. 연결 실패에 typed 코드 없음. OpenAI judge의 잠금 대기가 마감과 무관. env만으로는 체인 escalation 불가 |
| `3b0b421` | 첫 보고서가 "실제 실행 없음"이라 했으나 683건이 실행돼 있었음. 원자료로 다시 씀 |
| `f036dd8`, `1003f5b` | 한국어 작업에서 BM25 후보 검색이 gold를 놓침 → 검색 방식 `adaptive`/`full` 추가. `local` judge가 어휘 신호 0에서 확신 1로 "불필요"라 답함 → 신호 0일 때만 기권. 위임 하나가 요청 100개까지 보낼 수 있었음 → 8개로 제한. 공유 마감 뒤에도 요청이 나감. circuit 실패를 요청마다 셈. 일부 실패가 "필요 없음"과 구별되지 않음 |
| `b6e4ff6` | 사전 등록 규칙이 고정되지 않음 → 라벨 파일 commit, sha256 기재, run ledger, held-out 재채점 거부 |
| `134faf8` | 실제 세션 1에서 발견: 비동기 runtime에서 supervisor가 한 번도 판정하지 않음 → `SubagentHandback` 경로 추가 |
| `d82c345` | 리뷰 지적 7건. 조언이 다른 hand-back의 보고에 붙을 수 있었음, 저장된 조언 문구를 그대로 전달, 판정 중 죽은 hook의 영구 `in_flight`, 판정 횟수 상한 없음, 이전 config가 새 기본값 `full`에서 읽기 실패해 모든 hook이 종료 코드 1 등 |
| `bed1243` | commit된 결과 파일 하나가 1,000,000바이트를 넘어 `scripts/test-all.sh`가 종료 코드 1 → 내용 변경 없이 분할 |
| `7fb4ff2` | 실제 세션 3에서 발견: harness 알림 줄 때문에 prompt 결합이 불가능 → 줄 해시 결합 |
| `31e1c26` | 모호한 prompt가 잘못된 기록에 묶임. 이전 형식으로 끝난 hand-back이 재전송 때 다시 판정됨 |

## 이 문서를 쓰며 다시 실행한 검사 (2026-11-25, Node v24.19.0, HEAD `f7234c1`, 사실 확인 뒤 정정하며 재실행)

실제 API는 한 건도 부르지 않았습니다.

| 명령 | 관측 결과 |
|---|---|
| `bash scripts/test-all.sh` | 종료 코드 0. Node 590/590(실패 0, skip 0), 구문 67개 모듈, Python 검증기 72건 OK, offline suite PASS 31·NOT_RUN 1(live 단계)·FAIL 0 |
| `cd orchestration && npm test` | 종료 코드 0. 590/590, 실패 0, skip 0 (`TMPDIR=/var/folders/...`) |
| `cd orchestration && npm run compare:default` | 종료 코드 0. `RESULT: IDENTICAL`, hook 출력 168개, judge 호출 21건, 예외 출력 0 |
| `node --test qa/kernel/test/*.test.mjs` (API 키 없이) | 종료 코드 0. 25/25 |

## 병합 전 남은 일

1. **실제 효과를 잰다.** 같은 작업을 skill 주입 있음/없음으로 짝지어 품질·시간·비용을 비교한다. 서브에이전트가 스스로 skill을 찾기 어려운 크기의 카탈로그가 필요하다. 이것 없이는 이 기능이 도움이 된다는 근거가 없다.
2. **실제 세션에서 `active` 모드를 확인한다.** 사용자 수준(`~/.claude/agents`)의 `jev4_*` 프로필이 필요하다. 프로젝트 수준 사본은 설계상 거부된다.
3. **harness 알림 줄이 있는 hand-back prompt**를 수정 뒤 실제 세션에서 확인한다. 지금은 fixture뿐이다.
4. **Codex runtime**의 skill·supervisor 경로를 확인한다. 실제 실행이 없다.
5. **64개를 넘는 카탈로그에서 한국어 recall 하락의 원인을 확인한다.** held-out 1은 다시 쓸 수 없으므로 새 세트가 필요하다.
6. **`full`의 비용을 받아들일지 정한다.** 요청 2건, 입력 토큰 수 배, 큰 카탈로그에서 p95가 예산에 근접. 금액은 미계산.
7. **supervisor의 "retry를 complete로" 오판**(Jev 6/30, 틀린 조언 2건 표시)을 받아들일지, 임계값 0.65를 유지할지 정한다.
8. **사람이 라벨 표본을 검토한다.** 지금 정확도는 전부 모델이 만든 라벨 기준이다.
9. **OpenAI timeout 2500 ms**를 cold 표본을 더 모아 확인한다. 지금 값은 분포에서 정한 것이 아니고 cold 표본은 14건뿐이다.
10. **실제 API 실행의 승인 기록을 정리한다.** `20261125-full`(683건)과 e2e(75건)는 저장소 안에서 승인 기록이 확인되지 않는다(`REPORT.ko.md`). 결과를 근거로 쓸지는 소유자가 정한다.

상세: `docs/KERNEL.ko.md`의 "검증 상태"와 "결정 기록". 초기 실행의 전체 수치는 `qa/kernel/REPORT.ko.md`.
