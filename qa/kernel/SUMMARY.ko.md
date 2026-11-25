# Decision kernel QA 요약 (2026-11-25, branch `qa/kernel-eval`, 제품 트리 `8c5c33e`)

## 결론

- **이 브랜치는 저장소 소유자의 결정으로 `main`에 병합됩니다(2026-11-25).** 아래 6개 항목의 상태(해결 2, 부분 해결 3, 미해결 1)는 병합으로 바뀌지 않습니다. 새 기능은 기본 설정에서 모두 꺼져 있고, 실제 작업 개선 효과는 여전히 측정되지 않았습니다.
- 6개 미결 항목: **해결 2, 부분 해결 3, 미해결 1.** 미해결은 가장 중요한 항목(실제 효과)입니다.
- 확인된 것: 합성 데이터에서 skill 판정이 라벨과 얼마나 일치하는가(개발 세트와 held-out 세트 1개), 실제 데스크톱 세션에서 hook이 동작하는 것(`advisory` 세션 4개, `active` 세션 3개), 기본 임계값에서 supervisor 조언이 Main에 전달되는 것(재확인 세션의 위임 3건 중 3건), 오프라인 테스트 전체 통과, 기본 동작 불변.
- 확인되지 않은 것: **이 기능이 실제 작업의 품질·시간·비용을 개선하는가.** 주입 있음/없음을 짝지은 작은 pilot(합성 과제, arm당 1회)을 한 번 돌렸지만 두 arm 모두 6/6이어서 이득을 잴 수도 배제할 수도 없었습니다. 재확인 세션은 서브에이전트의 작업 결과를 채점하지 않았습니다. Codex도 확인하지 않았습니다.
- 실제 세션의 `active` 모드(서브에이전트 prompt 재작성)는 권한 모드 `auto`에서 확인했습니다. 재작성된 호출이 실행된 것은 pilot의 위임 16건 중 15건, 재확인 세션의 3건 중 3건입니다.
- 권한 모드 `auto`에서는 host가 고쳐진 호출을 한 번 거부하고 Main이 다시 호출합니다. 재작성된 위임마다 Main 왕복이 한 번 더 듭니다. 이 확장은 이 거부를 우회하지 않습니다.
- pilot에서 찾은 결함(다시 발행된 위임을 한 번 더 판단. judge 요청 94건 중 46건)은 고쳤습니다(`6ac6014`, `87a72a4`). 수정 뒤 실제 세션 1개에서 재발행 3건에 judge 요청이 0건이었습니다(`results/real-session-reissue-20261125/summary.json`).
- judge 토큰을 처음 쟀습니다. 그 세션 1회(위임 3건, skill 60개 카탈로그)에서 위임 1건당 입력 약 14,134.3·출력 1,734 토큰입니다(네 지점 합 42,403 / 5,202를 3으로 나눔). 금액은 계산하지 않았습니다.
- 세션이 끝난 뒤 결정과 결과를 잇는 **결과 수집기**와, 별칭 registry를 위한 `resolvesTo` 선언이 생겼습니다. 수집기는 로컬에서만 읽고 쓰며 그 자체로는 라우팅을 바꾸지 않습니다. 측정 도구이지 측정이 아니어서 항목 1(실제 효과)은 그대로 미해결입니다(아래 "결과 수집기와 `resolvesTo` 선언").
- **평가 저장소는 여전히 0행입니다.** 수집 경로는 있지만 자료가 없습니다. pilot 세션 2개에 수집기를 돌린 결과 위임 16건에서 평가 행은 0건이고, 라벨은 arm B의 약한 라벨 384개뿐입니다(`results/collector-20261125-r2/`).
- 숫자는 근거 파일의 표기를 그대로 옮겼습니다. 측정하지 않은 값은 "미측정"으로 적었습니다.

## 6개 항목 상태

| # | 항목 | 상태 | 확인한 것 (근거 파일) | 남은 것 |
|---|---|---|---|---|
| 1 | 실제 효과 (작업 품질·시간·비용) | **미해결** | 판정 일치도만 측정. 합성 데이터, 개발 세트와 held-out 세트 1개 (`results/dev-retrieval-decision-1/`, `results/holdout-1-score-1/`, `results/20261125-full/`). 주입 있음/없음 paired pilot 1회: 실제 세션 2개, 합성 프로젝트(skill 60개), 위임 8건씩. 규칙 검사 통과는 두 arm 모두 skill 과제 6/6. 주입이 없는 arm에서도 서브에이전트 6개 전부가 harness의 skill 목록에서 target을 스스로 load함 (`results/pilot-20261125/`, 아래 "Skill 주입 paired pilot") | 이득은 여전히 미측정. pilot은 baseline이 만점이라 차이가 날 자리가 없었음(천장 효과). 이득이 없다는 증거도 아님. 짝 6개, arm당 1회, 합성 과제. 관찰된 비용 절감 없음(차이가 실행 간 편차 안). pilot의 judge 토큰은 미측정. 재확인 세션(`results/real-session-reissue-20261125/summary.json`)은 hook 동작만 확인했고 작업 결과를 채점하지 않음. 결과 수집기는 재는 도구일 뿐이고 그것으로 모은 평가 행은 0건 |
| 2 | 실제 hook / 실제 세션 종단 실행 | **부분 해결** | 설치된 entrypoint 직접 호출 100회(그중 실제 judge 시나리오 88회, 나머지 12회는 loopback 장애 주입): 기대 214개 중 212 PASS / 0 FAIL / soft miss 2 (`results/20261125-e2e/hooks.txt`, `hooks.json`). 실제 데스크톱 세션 4회, `advisory` 모드: 실제 Agent 호출에서 hook 실행, 실제 Jev로 라우팅·skill 선택, hand-back 경로에서 supervisor 판정, 세션 4에서 조언이 Main에 전달 (`results/real-session-20261125/summary.json`). pilot의 실제 세션 2개(`active` 모드): 위임 16건 중 15건에서 재작성된 호출이 실행됨(`results/pilot-20261125/`). 재발행 수정 뒤 실제 세션 1개(`active` 모드, 기본 임계값, 위임 3건): 3건 모두 재작성, host 거부, 재발행 인식(judge 요청 0건), 실행, supervisor 판정, Main으로 조언 전달(확신 0.88, 1.00, 0.99). `hook_error`·`failure`·`unverified_prompt` 이벤트 없음 (`results/real-session-reissue-20261125/summary.json`) | 실제 세션에서 미확인: Codex(실행 없음), 결합 수정 뒤 harness 알림 줄이 있는 hand-back prompt 형태(fixture로만 확인. 재확인 세션에서 나왔는지 알 수 없음), 120초보다 늦은 재발행, `auto`가 아닌 권한 모드의 `active`. Codex와 알림 줄 형태가 남아 있어 "해결"로 올리지 않음 |
| 3 | OpenAI 첫 호출 timeout | **부분 해결** | 제공자별 timeout 추가, 기본 2500 ms. 실제 요청 280건 최대 928 ms (`results/20261125-full/summary.txt`), cold 프로세스 요청 14건 최대 778 ms (`results/20261125-e2e/hooks.json` s17). timeout 0건 | 2500 ms는 분포에서 정한 값이 아닌 초기값. 설정 근거는 1200 ms를 넘긴 cold 호출 1건이고 그 지속 시간은 기록되지 않음(`orchestration/src/kernel/judges.mjs`의 주석). 그 뒤 확인한 cold 표본은 14건뿐(최대 778 ms). 그 뒤 OpenAI를 실제로 다시 부르지 않음 |
| 4 | 기본 동작 바이트 비교 | **해결** | 이 문서를 쓰며 다시 실행: `npm run compare:default` IDENTICAL, hook 출력 168개·judge 호출 21건, HEAD `50e86eb` (`orchestration/scripts/compare-default-behavior.mjs`) | 없음. 검사가 다루지 않는 범위(기본값이 아닌 kernel 설정, 실제 호출 등)는 주장하지 않음 |
| 5 | macOS 기본 `TMPDIR`에서 `npm test` | **해결** | 이 문서를 쓰며 다시 실행: `TMPDIR=/var/folders/...` 그대로 653/653 통과 (HEAD `50e86eb`) | 없음 |
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

## Skill 주입 paired pilot (`results/pilot-20261125/`)

실제 데스크톱 세션 2개를 동시에 시작했습니다. arm A는 `delegation.skills` off, arm B는 active이고 전역 모드는 둘 다 `active`, judge는 실제 Jev입니다. 합성 프로젝트(skill 60개: target 6, distractor 54)에서 세션마다 위임 8건(skill 과제 6, control 2)을 했습니다. `jev4_*` 프로필 27개는 실행 동안만 사용자 수준에 설치하고 끝난 뒤 제거했습니다. 프로토콜은 세션 전에 고정했습니다(`pilot/PROTOCOL.md`). arm당 1회 실행이라 아래는 기술 값입니다.

| | arm A (주입 없음) | arm B (주입 있음) |
|---|---|---|
| 1차 결과: 규칙 검사 통과 (skill 과제) | 6 / 6 | 6 / 6 |
| control 완료 | 2 / 2 | 2 / 2 |
| target skill이 서브에이전트의 skill 목록에 있었음 | 6 / 6 | 6 / 6 |
| 서브에이전트가 target을 load (`Skill` 도구) | 6 / 6 | 6 / 6 |
| target load가 첫 도구 호출 | 5 / 6 | 5 / 6 |
| skill 과제에 블록 주입 / control에 잘못 주입 | 미측정 (지점 off) | 5 / 6, 0 / 2 |
| 서브에이전트 도구 호출 / 토큰 / 시간, 조건이 같은 7개 짝 | 69 / 3,146,768 / 363.3초 | 62 / 3,241,312 / 363.4초 |
| skill judge 요청 / 지연 합 / 토큰 | 0 | 32건 / 12,008 ms / 미측정 |

- **읽는 법:** 주입이 없어도 서브에이전트가 스스로 skill을 load해 규칙을 지켰으므로 이 설정에서 블록은 겹쳤습니다. baseline이 만점이라 이 pilot은 이득을 잴 수도, 이득이 없다고 할 수도 없습니다.
- **비용:** 블록이 어느 쪽에도 없던 짝(t01, t03, t07)의 토큰 차이가 −7.7%, +23.7%, +1.7%였습니다. 블록이 간 짝의 차이는 이 범위 안이라 절감도 증가도 블록 때문이라고 할 수 없습니다.
- **조건이 달랐던 짝:** t04는 arm A에서 라우팅이 보류되어 `general-purpose` / `claude-fable-5-2` / effort `medium`, arm B에서 `jev4_implement_standard_xhigh` / `claude-opus-5-5` / effort `xhigh`로 실행됐습니다. 위 표의 비용 행에서 뺐습니다.
- **프로토콜과 달랐던 것:** 권한 모드 `auto`에서 harness가 hook이 고친 Agent 호출을 거부하고 Main이 다시 호출해, 16건 중 15건이 호출 2개가 됐습니다. 분석기는 세션 뒤에 두 번 고쳤고(읽기 방식·연결 규칙, 독립 검증 뒤의 표시), 2차 측정은 모두 사후에 정한 연결 규칙으로 읽은 값입니다. arm A는 앞선 세션에 쓰던 폴더 경로를 다시 썼습니다(내용은 새 사본).
- 원자료(transcript, hook 상태)는 저장소에 넣지 않았습니다. 전체 내용은 `results/pilot-20261125/notes.txt`와 `compare.txt`에 있습니다.

## 재발행 수정 뒤 실제 세션 재확인 (`results/real-session-reissue-20261125/summary.json`)

로그인된 Claude Code 데스크톱 세션 1개, 권한 모드 `auto`, 제품 트리 `c09cd2e`입니다. pilot 프로젝트의 일회용 사본(skill 60개)에서 프로젝트 수준 hook을 썼습니다. 전역 모드 `active`, `delegation.skills`와 `supervisor.outcome`도 `active`, judge는 실제 Jev, 임계값은 기본값입니다. 위임 3건(skill 과제 2, control 1)을 하나씩 했습니다. `jev4_*` 프로필은 실행 동안만 사용자 수준에 복사했다가 제거했습니다.

| 위임 | 종류 | 첫 호출 | host 거부 뒤 재발행 | supervisor |
|---|---|---|---|---|
| 1 | skill | 라우팅됨(`implement / standard / opus / high`). skill 블록 주입(`domain-failure-types`, p 0.98). skill judge 요청 2건 | 15,625 ms 뒤 재발행으로 인식. judge 요청 0건. 실행됨 | hand-back에서 `complete`, 확신 0.88. `handback_prompt`로 기록. 조언이 Main에 전달됨 |
| 2 | control | 라우팅됨(같은 프로필). 주입 없음. skill judge 요청 2건 | 5,126 ms 뒤 인식. judge 요청 0건. 실행됨 | `complete`, 확신 1.00. `handback_prompt`로 기록. 조언 전달됨 |
| 3 | skill | 라우팅됨(같은 프로필). skill 블록 주입(`read-endpoints`, p 0.99). skill judge 요청 2건 | 6,674 ms 뒤 인식. judge 요청 0건. 실행됨 | `complete`, 확신 0.99. `handback_prompt`로 기록. 조언 전달됨 |

- 3건 모두 host가 고쳐진 호출을 한 번 거부했고 Main이 다시 발행했습니다. 이 확장은 이 거부를 우회하지 않습니다. 재작성된 위임마다 Main 왕복이 한 번 더 듭니다.
- 재발행된 3건에 judge 요청은 0건이었습니다. pilot(수정 전)에서는 judge 요청 94건 중 46건이 재발행된 호출에 쓰였습니다.
- supervisor 조언은 기본 임계값 0.65에서 3건 중 3건이 Main에 전달됐습니다.
- `hook_error`, `failure`, `unverified_prompt` 이벤트는 기록되지 않았습니다.

**Judge 토큰 (처음 측정).** decision log의 `usage` 합계입니다. 위임 3건, 실행 1회, skill 60개 카탈로그의 값이므로 일반화할 수 없습니다.

| 지점 | 기록 수 | 입력 / 출력 토큰 (3건 합) | 위임 1건당 입력 / 출력 (합 ÷ 3) |
|---|---|---|---|
| `delegation.classify` | 3 | 5,220 / 1,065 | 1,740 / 355 |
| `delegation.profile` | 3 | 7,693 / 462 | 약 2,564.3 / 154 |
| `delegation.skills` | 6 | 26,099 / 3,480 | 약 8,699.7 / 1,160 |
| `supervisor.outcome` | 3 | 3,391 / 195 | 약 1,130.3 / 65 |
| 합계 | 15 | 42,403 / 5,202 | 약 14,134.3 / 1,734 |

금액은 계산하지 않았습니다. 거부 뒤 재호출에 드는 Main 쪽 토큰은 요약 파일에 없습니다(미측정).

**이 재확인이 다루지 않은 것:** 서브에이전트의 작업이 맞았는지(채점하지 않음. hook 동작만 확인), harness 알림 줄이 있는 hand-back prompt 형태(이 세션에서 나왔는지 알 수 없음), Codex runtime, 120초보다 늦은 재발행. 원자료(hook 상태, transcript)는 저장소 밖 임시 디렉터리에만 두었고 위 파일은 검토된 요약입니다.

## 결과 수집기와 `resolvesTo` 선언 (`results/collector-20261125-r2/`, `results/collector-alias-20261125-r2/`)

**결과 수집기**(`orchestration/scripts/collect.mjs`, `orchestration/src/collector.mjs`)는 세션이 끝난 뒤 hook 상태와 그 세션의 대화 기록을 로컬에서 읽어 세 가지를 씁니다: 위임별 관찰 기록, 기록된 결정의 결과 라벨(라벨마다 근거가 얼마나 강한지 말하는 출처가 붙음), 평가 행 후보. 아무것도 전송하지 않고, 후보를 자동으로 가져오지 않으며, 그 자체로는 라우팅을 바꾸지 않습니다. 이것은 재는 도구이고 측정 결과가 아닙니다.

pilot 세션 2개의 hook 상태 사본과 대화 기록에 오프라인으로 돌렸습니다(`results/collector-20261125-r2/README.md`). 앞선 폴더 `results/collector-20261125/`는 검토 이전 수집기의 결과이고 이 수치로 대체됐습니다.

| | arm A (skill 지점 off) | arm B (skill 지점 active) |
|---|---|---|
| 위임 / 대화 기록에 이은 위임 | 8 / 8 | 8 / 8 |
| 라우팅된 위임 | 7 (1건은 `route_deferred`) | 8 |
| 쓴 라벨 | 0 | 384, 전부 약한 라벨: `observed-load` 124, `observed-load-after-injection` 248, `external-verification-with-load` 3, `external-verification-with-load-after-injection` 9 |
| 라벨이 붙은 결정 / skill 지점의 결정 | 해당 없음 | 12 / 32 |
| 관찰 기록 | 8 | 8 |
| 검증 항목 일치 | 8/8 (통과 8) | 8/8 (통과 8) |
| 평가 행 / 보류 | 0 / 8 | 0 / 8 |

- **평가 행은 위임 16건에서 0건입니다.** 두 세션은 기본 평가 context(`native-default-unvalidated`)로 실행됐고, 라우팅된 15건은 host가 기록한 모델 id(`claude-opus-5-5`, `claude-sonnet-5-5`)가 registry의 `backend`(`opus`, `sonnet`)와 문자열이 달랐습니다.
- **calibration.** 실제 세션에서 나온 첫 수치가 있습니다(arm B, `delegation.skills`). 전부 약한 라벨이고, 합성 pilot 세션 1개(실행 1회)에서 나왔으며, 보고서의 `sufficient`는 모든 묶음에서 `false`(`weak_labels`)입니다. 임계값에 참고할 수 있는 묶음(블록 없음, `observed-load`)은 결정 4개(위임 2건)입니다. 수치는 근거 폴더의 README에 있고 여기에는 옮기지 않았습니다.
- **`resolvesTo` 선언.** registry 항목에 "host가 이 항목을 이 id로 기록한다"를 사용자가 적는 필드입니다. 가져오기는 실제로 돈 모델이 프로필의 `backend`와 같거나 그 항목에 선언된 id 중 하나와 완전히 같을 때만 평가 행을 받습니다. 선언을 바꾸면 그 프로필의 이전 자료는 세지 않습니다. 서로 다른 구체 모델의 실행은 한 표본으로 합치지 않습니다. 수집기는 선언을 쓰지 않습니다.
- **선언을 넣어 다시 돌려도 0행입니다**(`results/collector-alias-20261125-r2/README.md`. 앞선 폴더 `results/collector-alias-20261125/`는 대체됨). 세 경우(기록된 config 그대로, context 이름만 줌, context 이름과 선언을 함께 줌) 모두 두 arm에서 0행입니다. pilot 세션이 기본 context로, 그리고 선언 이전에 실행됐기 때문이며 설계된 동작입니다. 선언된 id로 행이 만들어지고 가져와지는 경로는 합성 세션 테스트로만 확인했습니다(`orchestration/test/collector.test.mjs`).
- **자료가 라우팅에 닿으려면** 사용자가 평가 context에 이름을 붙이고, host가 기록하는 id를 선언하고, 다시 설치하고, `active` 모드로 세션을 돌리고, 외부 검증 결과를 주고, 수집기를 돌리고, 후보를 검토해 명시적으로 가져와야 합니다. 그 뒤에도 프로필마다 같은 과제 집합에서 `minimumSamples` 30건과 성공률의 Wilson 95% 하한 0.85 이상이 필요합니다(`docs/KERNEL.ko.md`의 "평가 행이 만들어지려면"). 지금 저장소는 0행입니다.
- **한계.** Codex 대화 기록은 지원하지 않습니다. 대화 기록 읽기는 Claude Code 데스크톱 한 버전(`2.1.330`, 권한 모드 `auto`, 세션 2개)에서 본 형태에 의존합니다. `observed-load` 라벨은 서브에이전트의 행동이라 서브에이전트가 만들어 낼 수 있습니다. 라벨은 실행되고, 라우팅되고, 대화 기록에 이을 수 있는 위임의 결정에만 붙습니다.

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
| `6ac6014` | pilot에서 발견: 권한 모드 `auto`에서 host가 거부한 뒤 Main이 다시 발행한 위임을 hook이 한 번 더 라우팅·skill 판정하고, 서브에이전트가 받지 않은 결정을 기록함(pilot의 judge 요청 94건 중 46건) → 재발행을 인식해 judge를 부르지 않고 원래 결정에 연결. 수정 뒤 실제 세션에서 확인: 재발행 3건에 judge 요청 0건(`results/real-session-reissue-20261125/summary.json`) |
| `87a72a4` | 위 수정의 리뷰 지적. packet 모양 글이 든 관리 프로필 호출이 라우팅을 건너뜀 → 모양만으로는 아무것도 건너뛰지 않음. 재발행된 호출이 실패한 뒤의 같은 입력 재시도가 연결되지 않음 → 반복으로 연결. 재발행 연결이 host가 알린 실패를 지움, 깨진 색인·잠금이 hook 오류가 됨, 연결된 id의 다른 입력 재사용에 경고 없음 |
| `9519e8b` | 결과 수집기의 리뷰 지적. `need` 라벨을 요청 자신의 skill이 아니라 위임 전체의 load로 붙임(검토 이전 결과의 `need` false negative 7건 중 6건이 이 규칙에서 나옴) → 요청별로 붙임. 블록이 주입된 위임의 라벨이 다른 라벨과 한 출처에 섞임 → `-after-injection` 출처로 분리. 약한 라벨 496개(결정 16개)에 calibration 보고서가 `sufficient: true` → 라벨이 붙은 결정 수로 세고 약한 라벨에는 항상 `false`. 프로젝트 루트의 재귀 검색을 "skill 접근 없음"으로 읽음 → 판정 불가. 그 밖에: 적용되지 않은 route나 프로필과 다른 agent type에는 평가 행을 만들지 않음, 끝이 확인되지 않은 서브에이전트 기록은 잇지 않음, 고쳐진 검증 결과는 이전 라벨을 철회함 |
| `24d6898` | `resolvesTo`의 리뷰 지적 → 다른 항목의 `backend`인 id의 선언을 거부, 선언을 바꾼 뒤 같은 과제를 다시 가져올 수 있게 함, 한 표본에 두 모델의 실행을 합치지 않음 |
| `8c5c33e` | 선언 이전에 실행된 세션을 `declared`로 분류함(대체된 결과에서 15건) → `declared-not-in-force`로 분류. 수집기 요약에 registry 조각(`wouldNeed`)이 들어 있었음 → 제거 |

## 이 문서를 쓰며 다시 실행한 검사 (2026-11-25, Node v24.19.0, HEAD `50e86eb`, 수집기와 선언을 반영하며 재실행)

실제 API는 한 건도 부르지 않았습니다.

| 명령 | 관측 결과 |
|---|---|
| `bash scripts/test-all.sh` | 종료 코드 0. Node 653/653(실패 0, skip 0), 구문 74개 모듈, Python 검증기 72건 OK, offline suite PASS 31·NOT_RUN 1(live 단계)·FAIL 0 |
| `cd orchestration && npm test` | 종료 코드 0. 653/653, 실패 0, skip 0 (`TMPDIR=/var/folders/...`) |
| `cd orchestration && npm run compare:default` | 종료 코드 0. `RESULT: IDENTICAL`, hook 출력 168개, judge 호출 21건, 예외 출력 0 |
| `node --test qa/kernel/test/*.test.mjs` (API 키 없이) | 종료 코드 0. 26/26 |

## 남은 일 (병합 뒤에도 그대로)

1. **실제 효과를 잰다.** 첫 pilot(`results/pilot-20261125/`)은 두 arm 모두 6/6이어서 효과를 볼 수 없었다. 다음 실험은 (가) baseline만 먼저 돌려 통과가 만점이 아닌 과제 세트를 확인하고(harness 목록이 잘릴 만큼 큰 카탈로그, 목록에 실리지 않는 skill, 설명이 과제 문장과 닮지 않은 skill), (나) arm당 여러 번 실행하고, (다) 두 arm의 profile·모델·effort를 같게 고정하고, (라) decision log의 judge 토큰(`usage`)을 함께 보고하고(결과 수집기의 관찰 보고서가 `usage`가 있는 log에서 judge 토큰 비중을 냄), (마) 사용자 수준 skill 검색 도구를 꺼야 한다. skill 60개에서는 서브에이전트가 스스로 skill을 찾았다. 이것 없이는 이 기능이 도움이 된다는 근거가 없다.
2. **수집 경로에 자료를 채운다.** 결과 수집기와 가져오기 경로는 있지만 평가 저장소는 0행이다. 평가 context 이름과 `resolvesTo` 선언을 정한 뒤 새 `active` 세션을 돌리고, 외부 검증 결과와 함께 수집해 검토하고 가져와야 한다(프로필마다 같은 과제 집합에서 30건). pilot 세션 2개는 어떤 설정으로도 가져올 수 없다. 수집기 자체의 남은 확인: 재발행 수정 이후 형태의 실제 자료 수집(테스트만 있음), hook이 남긴 모델 id와 대화 기록의 대조(테스트만 있음), "그 skill이 필요했는가"의 검증된 라벨을 만드는 방법(없음).
3. **`active` 모드의 남은 확인.** 중복 판단은 고쳤고 실제 세션에서 확인했다(위 재확인). 남은 것: `auto`가 아닌 권한 모드, 120초보다 늦은 재발행, 실패 뒤 Main이 어떤 입력으로 재시도하는지. `auto`에서 재작성된 위임마다 드는 Main 왕복 한 번은 host의 안전 장치라 없앨 수 없다. 받아들일지 소유자가 정한다(`active`에는 사용자 수준 `~/.claude/agents`의 `jev4_*` 프로필도 필요).
4. **harness 알림 줄이 있는 hand-back prompt**를 수정 뒤 실제 세션에서 확인한다. 지금은 fixture뿐이다. 재확인 세션에서 그 형태가 나왔는지는 알 수 없다.
5. **Codex runtime**의 skill·supervisor 경로를 확인한다. 실제 실행이 없다.
6. **64개를 넘는 카탈로그에서 한국어 recall 하락의 원인을 확인한다.** held-out 1은 다시 쓸 수 없으므로 새 세트가 필요하다.
7. **`full`의 비용을 받아들일지 정한다.** 요청 2건, 입력 토큰 수 배, 큰 카탈로그에서 p95가 예산에 근접. 실제 세션 1회에서 위임 1건당 judge 입력 약 14,134.3 토큰(그중 skill 판정 약 8,699.7). 금액은 미계산.
8. **supervisor의 "retry를 complete로" 오판**(Jev 6/30, 틀린 조언 2건 표시)을 받아들일지, 임계값 0.65를 유지할지 정한다.
9. **사람이 라벨 표본을 검토한다.** 지금 정확도는 전부 모델이 만든 라벨 기준이다.
10. **OpenAI timeout 2500 ms**를 cold 표본을 더 모아 확인한다. 지금 값은 분포에서 정한 것이 아니고 cold 표본은 14건뿐이다.
11. **실제 API 실행의 승인 기록을 정리한다.** `20261125-full`(683건)과 e2e(75건)는 저장소 안에서 승인 기록이 확인되지 않는다(`REPORT.ko.md`). 결과를 근거로 쓸지는 소유자가 정한다.

상세: `docs/KERNEL.ko.md`의 "검증 상태"와 "결정 기록". 초기 실행의 전체 수치는 `qa/kernel/REPORT.ko.md`.
