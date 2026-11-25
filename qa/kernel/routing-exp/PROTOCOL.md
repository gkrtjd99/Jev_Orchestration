# 모델·effort 라우팅 3-arm 실험: 사전 등록 프로토콜

- 작성: 2026-11-26, 세션을 하나도 시작하기 **전**에 작성했습니다.
- 평가 context 이름: `desktop-auto-v1`
- 상태: 고정. 이 문서와 `FROZEN.json`에 적힌 파일은 첫 세션이 시작된 뒤에는 바꾸지 않습니다(규칙 3).
- **과제, 프로젝트 템플릿, 채점기, 참조 해법과 결함 해법은 모두 모델이 만든 합성 자료입니다.** 실제 업무 과제의 표본이 아닙니다.

## 1. 무엇을 알고 싶은가

서브에이전트 위임을 hook이 고른 프로필(모델·effort)로 보내면,

1. 과제 품질(채점기 통과 수)이 유지되는가,
2. 비용에 해당하는 측정값(모델별 토큰, Main 토큰, judge 토큰, 시간)이 어떻게 달라지는가,
3. 더 낮은 모델만 쓰게 해도 품질이 유지되는가

를 실제 Claude Code 데스크톱 세션에서 처음으로 재 봅니다. 이전 skill 주입 pilot은 모든 arm이 모든 과제를 통과해서(천장) 품질 질문에
답하지 못했습니다. 그래서 이번 과제에는 약한 모델이 틀릴 수 있는 것을 넣었습니다(4절).

이 실험이 답하지 **않는** 것: 통계적으로 유의한 차이, 다른 프로젝트·다른 과제로의 일반화, 프로필 하나하나의 실력.

## 2. Arm

세 arm 모두 같은 프로젝트 템플릿의 새 사본에서, 같은 Main prompt(`main-prompt.txt`) 하나로, 같은 Main 모델·effort와 권한 모드 `auto`로,
서로 다른 폴더에서 같은 시각에 시작합니다. Main은 과제 12개를 정해진 순서로 하나씩, 과제마다 `Agent` 호출 한 번
(`subagent_type: general-purpose`, prompt는 과제 글 그대로)으로 위임하고 자신은 아무 작업도 하지 않습니다.

| arm | 이름 | hooks | 라우터가 고를 수 있는 것 |
|---|---|---|---|
| N | 라우팅 없음 | 프로젝트에 hook을 전혀 설치하지 않음 | 없음. 서브에이전트는 harness의 `general-purpose` 기본값으로 실행됨(이 환경에서는 Main 모델을 상속) |
| R | 라우팅 | 설치, 전역 `active` | 설치된 registry의 활성 claude 항목 전부 |
| L | 낮은 모델만 | 설치, 전역 `active` | 활성 claude 항목 중 **가장 낮은 slot의 backend**를 쓰는 항목만(나머지 claude 항목은 `enabled: false`) |

R과 L의 차이는 registry 한 가지입니다(`make-arm-config.mjs`가 만들고, 테스트가 실제 설치기로 확인합니다). L의 설치 프로필 파일은 R의
부분집합이고, 이름이 같은 파일은 내용이 byte 단위로 같습니다. 그래서 사용자 수준 agents 폴더에는 R의 파일 집합 하나만 두면 됩니다.

## 3. 고정 실행 설정

"실행 세션이 기입"은 세션을 실제로 돌리는 소유자 쪽 세션만 알 수 있는 값입니다. **세션을 시작하기 전에** 채워서 커밋합니다. 그 밖의 칸은
지금 고정된 값입니다. 실제 설치값이 이 표와 다르면 고치지 말고 8절 "편차 기록"에 적습니다.

| 항목 | arm N | arm R | arm L |
|---|---|---|---|
| Main prompt | `main-prompt.txt` 그대로 한 번(해시는 `FROZEN.json`) | 같음 | 같음 |
| 프로젝트 | `template/`의 새 사본, 저장소 밖 폴더 | 같음(다른 폴더) | 같음(다른 폴더) |
| 권한 모드 | `auto` | `auto` | `auto` |
| Main 모델 | 실행 세션이 기입 | N과 같음 | N과 같음 |
| Main effort | 실행 세션이 기입 | N과 같음 | N과 같음 |
| Claude Code 데스크톱 버전 | 실행 세션이 기입 | N과 같음 | N과 같음 |
| 제품(`orchestration/`) 커밋 | 해당 없음 | 실행 세션이 기입 | R과 같음 |
| 실험 자료 커밋(이 폴더) | 실행 세션이 기입(`node freeze.mjs --check` 통과) | 같음 | 같음 |
| 세션 시작 시각 | 실행 세션이 기입 | 실행 세션이 기입 | 실행 세션이 기입 |
| 프로젝트 수준 hooks(`.claude/settings.json`) | 없음 | 일회용 설치(`home-r`)를 가리킴 | 일회용 설치(`home-l`)를 가리킴 |
| 전역 모드 `JEV_MODE` | 해당 없음 | `active` | `active` |
| `delegation.skills` (`JEV_SKILLS_MODE`) | 해당 없음 | `off` | `off` |
| `supervisor.outcome` (`JEV_SUPERVISOR_MODE`) | 해당 없음 | `off` | `off` |
| `delegation.classify`, `delegation.profile` | 해당 없음 | `active`(설치 기본값) | `active`(설치 기본값) |
| 평가 context (`JEV_EVALUATION_CONTEXT`) | 해당 없음 | `desktop-auto-v1` | `desktop-auto-v1` |
| registry | 해당 없음 | 설치된 registry + 아래 선언 | R의 registry에서, 가장 낮은 활성 claude backend가 아닌 claude 항목을 모두 비활성 |
| `resolvesTo` 선언 | 해당 없음 | backend `sonnet` → `claude-sonnet-5-5`, backend `opus` → `claude-opus-5-5` | 같음 |
| 설치된 registry의 claude 항목(slot, model, backend) | 해당 없음 | 실행 세션이 기입(`routing-exp-arm-R/summary.json`의 `enabledClaudeEntries`) | 실행 세션이 기입(`routing-exp-arm-L/summary.json`) |
| 설치된 프로필 파일 수 | 해당 없음 | 실행 세션이 기입(light/standard/strategic 세 항목이 활성인 registry면 27) | 실행 세션이 기입(같은 registry면 9) |
| `JEV_ALLOW_EGRESS` | 해당 없음 | `true`(아니면 judge를 부르지 않아 라우팅이 없음) | `true` |
| judge 체인(classify·profile) | 해당 없음 | `jev`(설치 기본값). 실행 세션이 설치값을 확인해 기입 | R과 같음 |
| judge 모델 `JEV_MODEL` | 해당 없음 | `jev-latest`(기본값). 실행 세션이 기입 | R과 같음 |
| `timeoutMs` / `routeDeadlineMs` | 해당 없음 | 1200 / 3000(기본값). 실행 세션이 기입 | R과 같음 |
| `minimumConfidence` / `selectionConfidence` / `selectionMargin` | 해당 없음 | 0.55 / 0.65 / 0.15(기본값). 실행 세션이 기입 | R과 같음 |
| `objective` / `failureMode` | 해당 없음 | `balanced` / `native`(기본값). 실행 세션이 기입 | R과 같음 |
| hook 상태 폴더 | 없음 | `home-r` 아래, 이 arm 전용 | `home-l` 아래, 이 arm 전용 |
| 사용자 수준 `~/.claude/agents`의 `jev4_*` 파일 | arm R의 집합이 있음(세 세션이 같은 시각에 돌기 때문) | arm R의 집합 | arm R의 집합(L은 그 부분집합만 고름) |
| 사용자 수준 skill·plugin·MCP | 실행 세션이 기입 | N과 같음 | N과 같음 |
| 프로젝트의 `.claude/skills`, `CLAUDE.md` | 없음 | 없음 | 없음 |

## 4. 과제

`tasks.json`의 12개, 고정된 순서. 서로 독립입니다(과제마다 고칠 수 있는 파일이 겹치지 않음: `allowedPaths`). 한국어 6개, 영어 6개.
난이도는 만든 쪽이 의도한 등급이고 세션에는 보이지 않습니다(`main-prompt.txt`에 등급, hook, 라우팅, 모델, 채점, 평가에 관한 말이 없다는
것을 `build-main-prompt.mjs --check`가 확인합니다).

| id | 언어 | 등급 | 내용 | 숨은 검사가 보는 것 |
|---|---|---|---|---|
| t01 | en | moderate | cursor 방식 페이지 나누기 `paginateAfter` 추가 | 꽉 찬 마지막 페이지의 `nextCursor`, 모르는 cursor, limit 검증, 빈 목록 |
| t02 | ko | routine | 설정 `maxWaitlist` 추가 | 빈 문자열은 기본값, `'2.5'`·`'12명'` 거부, 기존 항목 유지 |
| t03 | en | hard | 표시 이름 중복·길이 버그(증상 보고) | 유니코드 정규화(NFC/NFD), grapheme 단위 길이(emoji, 결합 문자, 풀어 쓴 한글), 악센트가 다른 이름은 구분 |
| t04 | ko | moderate | 대기자 우선순위 `orderWaitlist`와 `next()` | 동순위의 입력 순서 유지, UTC offset이 다른 시각 비교, 입력 배열 보존 |
| t05 | en | routine | `formatDuration` 추가 | 0인 부분 생략, `0m`, 입력 검증 |
| t06 | ko | hard | 수업료 나누기 `splitCharge` | 합계가 정확히 일치, 통화별 최소 단위(KRW 0자리, KWD 3자리), 누구도 최소 단위 하나 이상 벗어나지 않음 |
| t07 | en | moderate | 결제 기록의 idempotency key | 동시에 온 재시도, 실패 뒤 재시도, 다른 결제에 같은 key |
| t08 | ko | hard | 정원 초과 예약(증상 보고) | 동시 요청에서 정확히 정원만큼 성공, 같은 회원의 연타, 거절 뒤에도 계속 동작, 다른 수업에 영향 없음 |
| t09 | ko | routine | `toCsv` 추가 | 따옴표 두 번 쓰기, `0`·`false` 유지, 머리글 규칙 |
| t10 | en | hard | 주간 수업 시각이 1년에 두 번 한 시간 밀림(증상 보고) | 여러 시간대의 DST 전환, 범위 조회의 경계, except 날짜 유지 |
| t11 | ko | moderate | 캐시에 `set`/`delete` 추가 | "없음"으로 캐시된 키, 목록 캐시 무효화, 다른 키의 캐시 유지 |
| t12 | en | routine | `normalizeEmail`, `maskEmail` 추가 | 가리는 길이, `@`가 둘인 주소, 한쪽이 빈 주소 |

채점기(`checkers/check.mjs`)는 프로젝트의 공개 함수를 자식 프로세스에서 불러 **동작**만 봅니다. 소스 글, helper 이름, 형식은 보지 않습니다.

- `done`: "basic" 검사가 모두 통과. 요청한 것이 있고 대표 동작이 됨.
- `passed`: `done`이고 "hidden" 검사가 모두 통과. 과제 글과 기존 코드에서 추론할 수 있지만 글에 낱낱이 적혀 있지는 않은 경우들.

`checkers/selftest.mjs`가 임시 사본에서 확인합니다: 손대지 않은 템플릿은 12개 모두 `done: false`, 참조 해법은 12개 모두 `passed: true`,
결함 해법 30개는 모두 `passed: false`이고 실패 이유가 그 결함을 잡으려고 쓴 숨은 검사임.

## 5. 결과

### 1차 결과

- arm별 **통과한 과제 수**(12개 중, 채점기의 `passed`), 그리고 난이도 등급별(routine / moderate / hard 각 4개 중) 통과 수.

### 2차 결과

- 서브에이전트 토큰: **모델별로 따로**, 입력 / 출력 / cache read / cache creation. 서로 다른 모델의 토큰은 더하지 않습니다.
- Main 세션 토큰(같은 네 가지, 모델별), Main API turn 수, `Agent` 호출 수와 거부된 호출 수.
- judge 요청 수, judge 토큰, judge 지연 시간(decision log의 `usage`, `latencyMs`). log에 `usage`가 없으면 토큰은 `null`.
- 시간: 서브에이전트 wall time, 첫 `Agent` 호출부터 서브에이전트 마지막 행까지, Main 세션 전체.
- 라우팅된 프로필의 분포(arm R, L), 보류된 route와 그 이유, route가 실제로 적용됐는지(host가 기록한 agent type이 route의 프로필인가).
- 서브에이전트의 실제 모델·effort·agent type(host 기록: `agent-<id>.meta.json`과 서브에이전트 자신의 행).
- 결과 수집기가 arm R과 L에 대해 context `desktop-auto-v1`로 만든 **평가 행 수**, 보류한 과제 수와 이유별 수.
- 참고: `done` 수, 실패한 검사 이름, 과제 밖 파일 변경(`unattributedChanges`), Main이 `Agent` 말고 쓴 tool.

금액은 2차 결과가 아닙니다. `compare.mjs`는 `--prices <파일>`을 준 경우에만 추정 금액을 냅니다. 가격은 이 저장소에 없고, 가격 파일에는
출처와 확인 날짜가 있어야 합니다. judge 요청에는 금액을 매기지 않습니다.

## 6. 미리 정한 규칙

1. **arm당 1회 실행.** 결과가 마음에 들지 않아서 다시 돌리지 않습니다.
2. **인프라 사유로 죽은 arm은 한 번만 다시 돌릴 수 있고, 그 사실을 보고합니다.** 인프라 사유: 앱·세션 crash, 인증·네트워크 오류, host가
   `Agent` tool을 띄우지 못함, hook 프로세스 오류로 세션이 멈춤. 과제 실패, 서브에이전트의 틀린 해법, judge의 보류, Main이 지시를
   어긴 것은 인프라 사유가 **아닙니다.** 다시 돌릴지는 그 arm에 `check.mjs`나 `analyze.mjs`를 돌리기 **전에** 정합니다. 다시 돌릴 때는
   템플릿의 새 사본과 새 hook 상태 폴더를 씁니다. 죽은 실행의 자료는 지우지 않습니다.
3. **첫 세션이 시작된 뒤에는 아무것도 바꾸지 않습니다**: 과제(`tasks.json`), Main prompt, 템플릿, 채점기와 그 검사, 통과 기준, 이 문서의
   규칙. `node freeze.mjs --check`가 통과해야 합니다. 분석기(`analyze.mjs`, `compare.mjs`)가 실제 파일 모양을 읽지 못하는 경우에 한해
   **읽는 방법**만 고칠 수 있고, 결과 정의는 바꾸지 않으며, 무엇을 왜 고쳤는지 8절에 적습니다.
4. **위임되지 않은 과제는 통과하지 못한 것으로 셉니다.** 프로젝트 파일이 우연히 맞아도 같습니다(`counted.passed`).
5. **보류된 route는 보고합니다.** route가 보류됐거나 적용되지 않은 위임은 harness 기본값으로 실행된 것이므로 "라우팅된 것끼리의 비교"에서는
   그 과제를 세 arm 모두에서 빼고, **arm 합계에는 그대로 넣습니다.** 두 숫자를 함께 보고합니다.
6. **기술 통계만 보고합니다.** 과제 12개, arm당 1회입니다. 유의성 주장도, 일반화도 하지 않습니다. 한두 과제의 차이는 한 번 실행의 흔들림
   안에 있을 수 있다고 적습니다.
7. 과제의 판정은 채점기의 `passed`뿐입니다. 서브에이전트나 Main의 보고 글은 판정에 쓰지 않습니다.
8. Main이 지시를 어긴 경우(직접 작업, 재시도, 과제 글에 덧붙임, 순서 변경, 동시에 여러 agent)는 고치지 않고 그대로 보고합니다. 채점은
   프로젝트의 최종 상태로 하고, 어느 과제에서 무엇이 달랐는지 적습니다. 한 과제에 서브에이전트가 여러 번 실행됐으면 첫 실행만 과제 행에
   적고 나머지는 `unlinkedSubagents`로 따로 보고합니다.
9. 읽지 못한 값은 `null`과 경고로 남깁니다. 추측해서 채우지 않습니다. 한 서브에이전트의 행에 모델이 둘 이상이면 그 과제의 모델은 `null`입니다.
10. 세 세션의 분석은 **세 세션이 모두 끝난 뒤** 합니다. 한 arm의 결과를 본 뒤에 다른 arm을 시작하거나 다시 돌리지 않습니다.
11. 이 실험은 평가 행 **후보를 만들기만 하고 가져오지 않습니다**(`feedback.mjs --accept-evidence`를 실행하지 않음).

## 7. 알려진 arm 차이와 한계

- **R과 L에는 위임마다 Main 왕복이 한 번 더 있습니다.** 권한 모드 `auto`에서 hook이 `Agent` 호출을 고치면 host가 그 호출을 한 번
  거부하고, Main이 hook이 만든 입력으로 다시 발행합니다(수정된 hook은 이 재발행을 알아보고 다시 판단하지 않습니다). N에는 이 왕복이
  없습니다. 그래서 Main 토큰과 Main 시간은 arm마다 따로 재서 보고하고, R·L의 Main 비용에는 이 왕복이 들어 있다고 적습니다.
- **N의 서브에이전트는 Main 모델을 상속합니다**(이 환경에서 관찰된 동작). 실제로 어떤 모델·effort로 돌았는지는 host 기록에서 읽어 적습니다.
  따라서 N 대 R은 "Main 모델 그대로" 대 "라우터가 고른 프로필"의 비교이고, Main 모델이 무엇이냐에 따라 뜻이 달라집니다.
- R과 L에서 서브에이전트가 받는 prompt에는 과제 글 뒤에 routing packet과 고정 문장이 붙고, agent 정의(프로필 파일의 지시문)가 다릅니다.
  N에는 둘 다 없습니다. 품질 차이가 나더라도 모델·effort 때문인지 이 글 때문인지 이 설계로는 가르지 못합니다.
- 세 세션이 같은 시각에 돌기 때문에 사용자 수준 agents 폴더의 `jev4_*` 파일은 **N 세션에도 보입니다**(agent 목록에 나옴). N의 Main은
  `general-purpose`만 쓰라는 지시를 받습니다. 지켰는지는 Main 기록의 `subagent_type`으로 확인합니다.
- L의 registry에는 낮은 slot의 역할(research, documentation, implement)만 남습니다. 라우터가 그 밖의 역할로 분류하면 고를 프로필이
  없어 보류될 수 있습니다. 보류는 규칙 5대로 처리합니다.
- registry가 모델을 구체 id로 적고 있고 host가 다른 id를 기록하면(예: 선언표에 없는 backend) 그 항목의 실행은 평가 행이 되지 않습니다.
  `make-arm-config.mjs`가 그런 항목을 `notDeclared`로 알려 줍니다. 미리 정한 선언은 3절의 둘뿐이고, 다른 선언을 넣었으면 8절에 적습니다.
- 과제는 합성이고 한 프로젝트 안의 12개입니다. 채점기도 같은 쪽이 만들었으므로, 채점기가 놓치는 결함과 과하게 요구하는 경우가 있을 수
  있습니다. `selftest.mjs`는 채점기가 **준비된** 참조·결함 해법을 구별한다는 것만 보여 줍니다.
- 과제는 순서대로 한 프로젝트 사본에서 실행됩니다. 앞 과제의 서브에이전트가 남긴 변경을 뒤 과제의 서브에이전트가 봅니다. 파일은 겹치지
  않게 했지만, 앞 과제가 허용 경로 밖을 건드리면 뒤 과제에 영향을 줄 수 있습니다(`unattributedChanges`로 보고).

### 천장

**세 arm이 모두 12개를 통과하면 천장입니다.** 그 경우 "낮은 모델로도 품질이 유지되는가"에 대한 답은 "이 과제들로는 가를 수 없었다"이고,
품질 질문은 **열린 채로 남습니다.** "차이가 없다"는 결론으로 쓰지 않습니다. 비용 쪽 측정값은 그대로 보고합니다. `compare.mjs`가 이 경우를
`CEILING`으로 표시합니다.

### 평가 행과 `minimumSamples`

이 실행에서 수집기가 만들 수 있는 평가 행은 arm당 **최대 12개**(과제당 하나)이고, 여러 프로필에 나뉩니다. 라우터가 실측을 기준으로
쓰려면 기준 프로필과 후보 프로필이 **같은 과제 집합에서 각각 `minimumSamples`(기본 30)건 이상**이어야 하고, 평균 비용도 있어야 합니다
(수집기가 만든 행은 `costUsd`가 `null`입니다). 12개는 그에 한참 못 미칩니다. 따라서 **이 실행의 행을 가져오더라도 라우팅의 선택 기준은
바뀌지 않습니다**(`policy_prior_not_measured`가 유지됨). 다만 제품 문서에 따르면 가져온 행의 요약 통계는 그 관문에 못 미쳐도 프로필 선택
judge의 참고 입력에는 들어갑니다. 이 실험은 행을 가져오지 않으므로(규칙 11) 그 경로도 생기지 않습니다. 평가 행 수는 "수집 경로가
실제 세션에서 끝까지 이어지는가"를 보는 2차 결과일 뿐입니다.

## 8. 편차 기록

세션을 돌린 쪽이 채웁니다. 없으면 "없음"이라고 적습니다.

| 무엇이 이 문서와 달랐나 | 어느 arm | 언제 알았나 | 결과 읽기에 주는 영향 |
|---|---|---|---|
| | | | |
