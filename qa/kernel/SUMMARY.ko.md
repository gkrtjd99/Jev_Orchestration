# Decision kernel QA 요약 (2026-11-25, branch `qa/kernel-eval`)

**결론: main에 병합할 상태가 아닙니다.** 6개 미결 항목 중 해결 2, 부분 해결 3, 미해결 1입니다. 가장 중요한 항목(실제 효과)은 그대로 미해결입니다. 이 브랜치는 push도 merge도 하지 않았습니다.

## 6개 항목 상태

| # | 항목 | 상태 | 근거 | 남은 것 |
|---|---|---|---|---|
| 1 | 실제 효과 측정 | **미해결** | 합성 데이터의 판정 일치도만 측정 (`results/20261125-full/metrics.json`) | 실제 작업의 품질·시간·비용은 한 건도 재지 않음. pilot 미실행 |
| 2 | 실제 hook / 실제 세션 종단 실행 | **부분 해결** | 설치된 entrypoint 직접 호출 100회, 212 PASS / 0 FAIL / soft miss 2 (`results/20261125-e2e/hooks.txt`) | 실제 Claude Code 세션은 BLOCKED (`results/20261125-e2e/real-session.json`). skill이 주입된 서브에이전트 실행 미확인 |
| 3 | OpenAI 첫 호출 timeout | **부분 해결** | 제공자별 timeout 2500ms + 테스트. 실제 cold 호출 14건 최대 778ms, timeout 0 (`results/20261125-e2e/hooks.json` s17) | 2500ms는 초기값(표본 14건). 수정 뒤 실제 호출로 재확인 안 함 |
| 4 | 수정 뒤 기본 동작 바이트 비교 | **해결** | 최종 트리에서 `npm run compare:default`: 출력 108개·judge 호출 21건 일치, 차이 0 (`orchestration/scripts/compare-default-behavior.mjs`) | 없음 (검사 범위 밖은 주장하지 않음) |
| 5 | macOS 기본 TMPDIR에서 `npm test` | **해결** | `/var/folders/...` 그대로 509/509 통과 (`orchestration/test/fixture-paths.test.mjs`, `test/helpers.mjs`) | 없음 |
| 6 | 심볼릭 링크된 skill 폴더 | **부분 해결** | 프로젝트 안을 가리키는 링크는 읽음 (`orchestration/test/kernel-skills.test.mjs`, commit `95e30f1`) | 프로젝트 밖을 가리키는 링크는 여전히 읽지 않음(의도된 제한, `JEV_SKILL_DIRS` 필요). 실제 프로젝트 미확인 |

상세는 `docs/KERNEL.ko.md`의 "검증 상태", 전체 수치는 `qa/kernel/REPORT.ko.md`.

## 평가 수치 (`results/20261125-full/metrics.json`에서 그대로 옮김)

합성 데이터(가짜 skill 40개, 작업 160건, 보고 120건), 작성자 gold 기준, 1회 실행, 실제 API 683건(api.typesafe.ai 403, api.openai.com 280), 실패 0.

**skill 라우팅 (n 160, 기본 임계값)**

| arm | need accuracy | load precision | load recall | 한국어 load recall | none 작업 오주입률 | ECE (need) | 지연 p50 / p95 ms | 토큰 in / out |
|---|---|---|---|---|---|---|---|---|
| `jev` | 0.8375 | 1 | 0.6666666666666666 | 0.3877551020408163 | 0 | 0.13256249999999994 | 184.68791599999986 / 242.53812500000004 | 243021 / 26240 |
| `openai` | 0.8375 | 0.9411764705882353 | 0.6666666666666666 | 0.3877551020408163 | 0 | 0.16843750000000013 | 516.2512920000008 / 838.8699579999993 | 378233 / 0 |
| `local` | 0.625 | null (load 0건) | 0 | 0 | 0 | 0.2874131544419385 | 0.06116699999984121 / 0.09304200000042329 | API 미사용 |
| `chain` (local → jev) | 0.81875 | 1 | 0.6416666666666667 | 0.32653061224489793 | 0 | 0.1903125 | 175.5742920000048 / 235.2783749999944 | 187037 / 20172 |

- BM25 후보 8개 안에 gold가 드는 비율이 0.7083333333333334(한국어 0.40816326530612246)이라, 어떤 judge도 그 이상 recall을 낼 수 없습니다. Jev가 놓친 gold 40개 중 35개가 후보 탈락입니다.
- `chain`은 원격 호출을 0.23125 줄였지만 절감이 아닙니다. 줄인 37건 중 36건이 한국어이고 21건은 실제로 skill이 필요했으며, Jev 단독보다 gold 3개(전부 한국어)를 더 놓쳤습니다.

**supervisor (n 120)**

| arm | outcome accuracy | macro F1 | retry를 complete로 오판 | 0.65에서 표시 비율 / 표시된 것의 accuracy | evidence 일치율 (110건 / 120건) | 지연 p50 / p95 ms | 토큰 in / out |
|---|---|---|---|---|---|---|---|
| `jev` | 0.9333333333333333 | 0.9318221653591279 | 6 | 0.8333333333333334 / 0.98 | 0.9272727272727272 / 0.875 | 170.562791999997 / 199.35845900000277 | 78552 / 7892 |
| `openai` | 0.9666666666666667 | 0.9665178571428572 | 4 | 0.7333333333333333 / 1 | 0.4636363636363636 / 0.4583333333333333 | 459.1704580000005 / 602.4735000000001 | 59787 / 0 |

비용(금액)은 null(미계산)입니다. 반복 실행의 분산은 null(미측정)입니다.

## Skill-effect pilot

**실행하지 못했습니다.** 격리된 실제 세션(로그인된 Claude Code)이 없었습니다. 따라서 "skill을 주입하면 작업 결과가 나아지는가"에 대한 데이터는 없습니다(null).

## QA에서 찾아 고친 결함 (commit `e6fb770`, 각각 회귀 테스트 있음)

1. (major) 프로필 선택이 보류되면 선택된 skill이 버려짐 → 보류 안내문에 블록을 붙여 Main에게 표시.
2. timeout 최솟값 50ms에서 judge를 한 번도 부르지 않음 → 예산 자체가 50ms 미만일 때만 거부.
3. 연결 거부가 typed 코드 없이 `JEV_UNAVAILABLE`로만 남음 → `JEV_NETWORK_ERROR` / `DECISIONS_NETWORK_ERROR`.
4. OpenAI judge의 잠금 대기가 호출 마감과 무관하고 주석이 과장됨 → 요청 전 대기를 마감에서 끊고 주석·문서를 실제 보장 범위로 수정.
5. env만으로는 `local,jev` 체인이 escalation되지 않음 → `JEV_*_ESCALATE_BELOW` 추가.
6. (보고서) 첫 보고서가 "전체 실행은 없었고 수치는 모두 null"이라 했지만 실제로는 683건이 실행돼 있었음 → 원자료로 다시 씀. evidence 지표의 n=110 표기, chain "절감" 서술, README run-id도 수정.

수정 뒤: `bash scripts/test-all.sh` 종료 코드 0 (Node 509/509, 구문 64개 모듈), `npm test` 단독 509/509, `compare:default` 차이 0, e2e loopback 시나리오 24/24. 실제 judge를 쓰는 e2e는 **다시 돌리지 않았습니다.**

기각한 지적: 없음. 다만 "라벨 일치도 100%"와 "chain 절감" 지적은 제품 결함이 아니라 보고서 서술 문제여서 보고서에서 고쳤습니다.

## 후보 검색 변경에 대한 독립 리뷰 (2026-11-25)

리뷰 두 건(제품 코드, 방법론)의 지적을 코드와 데이터로 다시 확인했다. 기각한 지적은 없다. 실제 API는 한 건도 부르지 않았다.

고친 것 (각각 회귀 테스트가 있고, 수정 전 소스에서 실패하는 것을 확인):

1. (major) `local` judge가 `minCoverage` 미만에서 기권 → 신호 0일 때만 기권.
2. (major) 위임 하나가 judge 요청을 100개까지 보낼 수 있었음(400/4 설정이 검증 통과) → 요청 수를 8개로 제한(`INVALID_KERNEL_SKILLS_FANOUT`), 넓은 방식은 세션 요청 상한의 4분의 1까지만(`INVALID_KERNEL_SKILLS_FANOUT_CAP`). 그 설정에서 위임 한 번이 선택 지점 요청 상한을 다 써서 supervisor까지 멈추던 문제도 같이 막힘.
3. (major) 넓은 판정의 요청이 공유 마감 뒤에도 나가고 세어짐 → 마감 시각을 judge에게 넘겨, 마감 뒤 차례가 온 요청은 보내지도 세지도 않고 보낸 요청은 마감에 끊음. 요청 시작이 잠금 때문에 순서대로 밀리는 것 자체는 고치지 않고 요청 수 제한으로 묶었다.
4. (minor) circuit 실패를 요청마다 세어 느린 넓은 위임 한 번이 circuit을 엶 → 위임 하나에 한 번.
5. (minor) 일부 요청만 실패하고 아무것도 못 고른 결과가 "필요 없음" 판정과 구별되지 않음 → `partial`/`failedCode`, `status: none`이면 `code`도.
6. (major) `bash scripts/test-all.sh`가 HEAD에서 실패(1,000,000바이트 넘는 rows 파일이 commit됨) → 그 결과 폴더를 지우고 수정된 코드로 다시 돌린 `results/20261125-wiring-local-retrieval-2/`로 교체. 러너는 rows 파일을 900,000바이트 이하로 나눠 쓰고, 테스트가 `results`·`data`의 파일 크기를 검사.
7. (blocker) 사전 등록 규칙이 고정되지 않음 → `relabel/` 라벨 파일 commit, `DECISION_RULE.md`에 sha256·consensus 크기(159/160)·결정 실행 run id 기재, 러너가 입력 파일 해시를 `metrics.json`과 추가 전용 `results/RUN_LEDGER.jsonl`에 기록, live 결과 폴더는 `--force`로 지우지 않음. 규칙 본문(자격·선택·동률·한도)은 바꾸지 않았다.
8. (major) 문서가 `adaptive`와 0.25를 실제보다 일반적인 것으로 서술 → `docs/KERNEL.ko.md`를 고침: `adaptive`는 문자 체계가 다를 때의 대비책이고, 0.25는 한국어 개발 작업 64건을 전부 넓게 보내는 가장 작은 어림수이며, 어휘 신호는 카탈로그 크기와 작업 길이에 따라 달라진다. "두 분포 사이가 비어 있다"는 틀린 서술 삭제.
9. held-out "한 번만"이 기록만 되고 강제되지 않음 → 기록된 실행이 있는 세트는 `--respend-holdout` 없이는 거부. 세트의 ledger를 지워도 `RUN_LEDGER.jsonl`의 manifest 해시로 걸린다.

수정 뒤(2026-11-25, Node v24.19.0): `bash scripts/test-all.sh` 종료 코드 0 (Node 542/542, 구문 65개 모듈, Python 검증 72건 OK), `npm test` 단독 542/542, `compare:default` 차이 0, `qa/kernel/test` 25/25. 실제 judge로는 아무것도 다시 돌리지 않았다.

고치지 않고 남긴 것:

- `adaptive`의 판별 기준 자체. 개발 세트에서 넓게 간 영어 작업 15건 중 14건이 skill 불필요 작업이고 새로 도달한 gold는 0개다. 대안("신호 0일 때만 넓게")은 영어를 1건만 넓게 보내지만 한국어 도달이 49/49에서 42/49로 떨어진다(오프라인, `results/dev-retrieval-offline/analysis.json`). 어느 쪽이 나은지는 실제 judge의 오주입률이 있어야 정할 수 있어 제품 정의는 그대로 두었다.
- 0.25를 작은 카탈로그·긴 지시문에서 검증하는 일, `maxJudged` 64를 그보다 큰 카탈로그에서 검증하는 일. 개발 카탈로그는 40개뿐이다.
- 넓은 판정 요청 전체를 잠금 한 번으로 예약하는 것, 넓은 skill 요청에 별도 요청 상한·circuit을 주는 것.
- held-out 규율의 한계: ledger·`HOLDOUT.json`을 모두 지우고 다시 freeze하는 것은 로컬에서 막을 수 없다. git 기록에 의존한다.
- 두 번째 라벨(`blind2`)과 작성자 gold의 일치도는 정확 일치 159/160(0.994), skill 유무 kappa 1.000이다. 두 라벨 모두 모델이 만들었고 데이터가 합성이라, 이 수치는 라벨이 서로 독립적으로 옳다는 근거가 아니라 작업 문장이 모호하지 않게 쓰였다는 것만 보여 준다.

## 병합 전 남은 일

1. **실제 효과를 잰다.** 로그인된 격리 세션에서 같은 작업을 skill 주입 있음/없음으로 돌려 품질·시간·비용을 비교한다. 이것 없이는 이 기능이 도움이 된다는 근거가 없다.
2. **실제 Claude Code 세션에서 종단 확인.** hook 설치 → 위임 → skill 블록이 들어간 서브에이전트가 실제로 skill을 load하는지. 지금은 BLOCKED.
3. **실제 API 실행의 승인 정리.** `20261125-full`(683건)과 e2e(75건 + 기록 없는 이전 실행)는 사용자 승인 기록 없이 실행됐다. 결과를 근거로 쓸지 폐기할지 사용자가 정해야 한다.
4. **한국어 후보 검색을 고친다.** 한국어 load recall 0.388은 judge가 아니라 BM25 단계 문제다. 고치지 않으면 한국어 사용자에게 skill 라우팅은 대부분 동작하지 않는다.
   - 후속(2026-11-25): 선택 기능 `kernel.skills.retrieval`(`adaptive`/`full`)을 추가했다. **기본값은 `lexical` 그대로라 위 수치는 바뀌지 않았다.** 오프라인(API 미사용)으로는 gold skill이 judge에게 도달하는 비율이 0.708(한국어 0.408) → `adaptive` 0.25에서 0.950(한국어 1.000)이다(`results/dev-retrieval-offline/analysis.json`). 이는 상한이고, 실제 judge의 recall·precision은 미측정(null)이다. 남은 것: 실제 judge로 개발용 세트 비교, held-out 세트 1회 채점, 기본값 결정.
5. **`local` 먼저 체인의 escalation 규칙.** BM25 점수 0 → need 0 → 확신 1이라 Jev로 넘어가지 않는다. 지금 형태의 `local,jev`는 권장할 수 없다.
   - 후속(2026-11-25): `local`은 어휘 신호가 **0일 때만** 기권하도록 바꿨다(mock 체인 테스트로 escalation 확인). 처음에는 `minCoverage` 0.25 미만에서도 기권하게 했으나, 독립 리뷰가 작은 카탈로그와 긴 지시문에서 `local` 단독이 대부분의 작업에 답하지 못하게 된다는 것을 보여 되돌렸다. 실제 judge로 `chain` arm을 다시 돌리지는 않았다. 위 표의 `local`·`chain` 수치는 변경 전 값이다.
6. **결함 수정 뒤 실제 judge로 e2e 재실행** (사용자 승인 후). 보류 시 skill 안내와 50ms 경계는 mock·loopback으로만 확인했다.
7. **supervisor의 "retry를 complete로" 오판**(Jev 6/30, 그중 2건이 Main에게 표시)을 받아들일지 결정. 임계값 0.65는 측정으로 정한 값이 아니다.
8. 사람이 라벨 표본을 검토한다. 지금 정확도는 전부 모델이 만든 라벨 기준이다.
9. OpenAI timeout 2500ms를 더 많은 cold 호출 표본으로 확인한다. Codex runtime의 skill·supervisor 경로는 전용 테스트가 없다.
