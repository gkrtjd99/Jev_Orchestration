# 모델·effort 라우팅 3-arm 실험: 사전 등록 프로토콜

- 작성: 2026-11-26, 세션을 하나도 시작하기 **전**에 작성했습니다.
- 평가 context 이름: `desktop-auto-v1`
- 상태: 고정. 이 문서와 `FROZEN.json`에 적힌 파일은 첫 세션이 시작된 뒤에는 바꾸지 않습니다(규칙 3).
- 독립 검토 뒤, **첫 세션을 시작하기 전에** 과제 글·채점기·도구·이 문서를 고쳤습니다. 무엇을 고쳤는지는 9절에 있습니다.
  세션은 아직 하나도 실행되지 않았습니다.
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

R과 L은 같은 기준 registry(`base-registry.json`)에서 출발하고, 차이는 registry 항목의 `enabled` 값 한 가지입니다
(`make-arm-config.mjs`가 만들고, 테스트가 실제 설치기와 설치된 hook으로 확인합니다). L의 설치 프로필 파일은 R의
부분집합이고, 이름이 같은 파일은 내용이 byte 단위로 같습니다. 그래서 사용자 수준 agents 폴더에는 R의 파일 집합 하나만 두면 됩니다.

## 3. 고정 실행 설정

"실행 세션이 기입"은 세션을 실제로 돌리는 소유자 쪽 세션만 알 수 있는 값입니다. **세션을 시작하기 전에** 채워서 커밋합니다. 그 밖의 칸은
지금 고정된 값입니다. 실제 설치값이 이 표와 다르면 고치지 말고 8절 "편차 기록"에 적습니다.

| 항목 | arm N | arm R | arm L |
|---|---|---|---|
| Main prompt | `main-prompt.txt` 그대로 한 번(해시는 `FROZEN.json`) | 같음 | 같음 |
| 프로젝트 | `template/`의 새 사본, 저장소 밖 폴더 | 같음(다른 폴더) | 같음(다른 폴더) |
| 권한 모드 | `auto` | `auto` | `auto` |
| Main 모델 | 시작하는 세션의 값을 상속: `claude-fable-5-2`. 실제 값은 실행 뒤 transcript에서 확인해 보고 | N과 같음 | N과 같음 |
| Main effort | 시작하는 세션의 값을 상속(앞선 실제 세션들에서 관측된 값은 `medium`). 실제 값은 실행 뒤 hook 이벤트/transcript에서 확인해 보고 | N과 같음 | N과 같음 |
| Claude Code 데스크톱 버전 | 데스크톱 앱 `6.28899.6`, Agent SDK `0.3.330`(이 표를 채운 세션의 환경 변수 기준. 실제 값은 transcript에서 확인) | N과 같음 | N과 같음 |
| 제품(`orchestration/`) 커밋 | 해당 없음 | `orchestration/` 트리 `e4049248b6d22300368a2044868bfb7888527516`(이 폴더를 채운 시점의 HEAD `17ce2b7`; 제품 코드를 마지막으로 바꾼 커밋은 `8c5c33e`, 버전 3.2.0). 이 트리에서 일회용 홈에 설치 | R과 같음 |
| 실험 자료 커밋(이 폴더) | `17ce2b7`(`node freeze.mjs --check` 통과: tasks.json `c77df42cc499`, main-prompt.txt `0d6f6bb0674b`, check.mjs `d1c4013e1870`). 이 표만 채운 커밋이 그 위에 하나 더 있음 | 같음 | 같음 |
| 세션 시작 시각 | 세 세션을 소유자가 요청한 한 턴 안에서 N, R, L 순서로 잇달아 시작(폴더 신뢰 확인 창이 하나씩 떠야 해서 동시에 호출하지 않음. 간격은 수 초~수십 초). 실제 시각은 transcript의 첫 행에서 읽어 결과에 기재 | 같음 | 같음 |
| 프로젝트 수준 hooks(`.claude/settings.json`) | 없음 | 일회용 설치(`home-r`)를 가리킴 | 일회용 설치(`home-l`)를 가리킴 |
| 전역 모드 `JEV_MODE` | 해당 없음 | `active` | `active` |
| `delegation.skills` (`JEV_SKILLS_MODE`) | 해당 없음 | `off` | `off` |
| `supervisor.outcome` (`JEV_SUPERVISOR_MODE`) | 해당 없음 | `off` | `off` |
| `delegation.classify`, `delegation.profile` | 해당 없음 | `active`(설치 기본값) | `active`(설치 기본값) |
| 평가 context (`JEV_EVALUATION_CONTEXT`) | 해당 없음 | `desktop-auto-v1` | `desktop-auto-v1` |
| 기준 registry | 해당 없음 | `base-registry.json`(해시는 `FROZEN.json`): 제품의 예시 registry에서 활성 claude 세 항목을 alias로 바꾼 것. light = `sonnet`, standard = `opus`, strategic = `opus` | 같음 |
| arm registry | 해당 없음 | 기준 registry + 아래 선언 + 아래 가용성 | R의 registry에서 backend가 `sonnet`이 아닌 활성 claude 항목(standard, strategic)을 `enabled: false`. 그 밖에는 R과 같음 |
| `resolvesTo` 선언 | 해당 없음 | backend `sonnet` → `claude-sonnet-5-5`, backend `opus` → `claude-opus-5-5`. 기준 registry의 활성 claude 세 항목 모두에 걸림(선언 없는 활성 항목 0개) | 같음(활성인 light 항목에 `claude-sonnet-5-5`) |
| 활성 claude 항목의 `availability` | 해당 없음 | 셋 다 `confirmed`. 도구가 정하지 않고, 실행 세션이 `--confirm-availability sonnet --confirm-availability opus`로 진술. 확인 근거: 이 머신의 2026-11-25 실제 세션들(pilot 두 세션과 재확인 세션)에서 `jev4_*` 프로필로 실행된 서브에이전트의 모델이 host 기록상 `claude-sonnet-5-5`와 `claude-opus-5-5`였음(`qa/kernel/results/pilot-20261125/`, `collector-alias-20261125-r2/`). effort `max`는 그 세션들에서 실행된 적이 없어 확인되지 않음 | light 항목 `confirmed`(같은 명령) |
| `optimization.requireConfirmedAvailability` | 해당 없음 | `true`(제품 기본값, 바꾸지 않음) | `true` |
| 설치된 registry의 claude 항목(slot, backend, availability, resolvesTo) | 해당 없음 | light/`sonnet`, standard/`opus`, strategic/`opus`. `--verify` 결과: `ok: true`, 활성 claude 항목 3개, 프로필 파일 27개 | light/`sonnet`. `--verify` 결과: `ok: true`, 활성 항목 1개(`claude-light`, `confirmed`, `resolvesTo: [claude-sonnet-5-5]`), 프로필 파일 9개 |
| 설치된 프로필 파일 수 | 해당 없음 | 27(이 기준 registry에서. 이름은 `routing-exp-arm-R/summary.json`의 `profileFiles`). 실행 세션이 확인 | 9(R의 27개 중 `_light_` 9개, 내용 동일). 실행 세션이 확인 |
| `JEV_ALLOW_EGRESS` | 해당 없음 | `true`(아니면 judge를 부르지 않아 라우팅이 없음) | `true` |
| judge 체인(classify·profile) | 해당 없음 | `jev`(설치 기본값). 실행 세션이 설치값을 확인해 기입 | R과 같음 |
| judge 모델 `JEV_MODEL` | 해당 없음 | `jev-latest`(설치된 `.env`의 값) | R과 같음 |
| `timeoutMs` / `routeDeadlineMs` | 해당 없음 | 1200 / 3000(기본값, 바꾸지 않음) | R과 같음 |
| `minimumConfidence` / `selectionConfidence` / `selectionMargin` | 해당 없음 | 0.55 / 0.65 / 0.15(기본값, 바꾸지 않음) | R과 같음 |
| `objective` / `failureMode` | 해당 없음 | `balanced` / `native`(기본값, 바꾸지 않음) | R과 같음 |
| hook 상태 폴더 | 없음 | `home-r` 아래, 이 arm 전용 | `home-l` 아래, 이 arm 전용 |
| 사용자 수준 `~/.claude/agents`의 `jev4_*` 파일 | arm R의 집합이 있음(세 세션이 같은 시각에 돌기 때문) | arm R의 집합 | arm R의 집합(L은 그 부분집합만 고름) |
| 사용자 수준 skill·plugin·MCP | **끄지 않음**(소유자의 실제 설정을 바꾸지 않음). 사용자 수준 skill과 MCP 서버가 켜져 있고 세 arm에 똑같이 적용됨. 프로젝트 템플릿에는 skill이 없음 | N과 같음 | N과 같음 |
| 사용자 수준·관리 설정의 `jev-hook` 명령 | 없음(`preflight.mjs`로 확인. 본 파일 목록: `~/.claude/settings.json`, `~/.claude/settings.local.json`, `/Library/Application Support/ClaudeCode/managed-settings.json`) | 없음(프로젝트 수준 hooks만) | 없음(프로젝트 수준 hooks만) |
| 앱이 물려받는 환경의 `JEV_*`, `TYPESAFE_*`, `CLAUDE_CODE_SUBAGENT_MODEL*` 변수 | 없음 | 없음(hook은 환경을 `.env`보다 먼저 읽음). `preflight.mjs` 결과: `overridingEnvironmentNames: []`, `keyFromEnvironment: true`(환경의 `TYPESAFE_API_KEY`가 `.env`의 키를 대신함. arm 설정은 덮지 않음) | 없음 |
| `preflight.mjs` 결과 | 설정 파일·환경 변수 점검은 이 표를 채울 때 `ok: true`. 사용자 수준 agents 폴더 점검은 프로필을 복사한 직후, 세션 시작 직전에 다시 돌리고 `ok: true`가 아니면 시작하지 않음(결과는 결과 폴더에 기재) | 같음 | 같음 |
| 프로젝트의 `.claude/skills`, `CLAUDE.md` | 없음 | 없음 | 없음 |

## 4. 과제

`tasks.json`의 12개, 고정된 순서. 서로 독립입니다(과제마다 고칠 수 있는 파일이 겹치지 않음: `allowedPaths`). 한국어 6개, 영어 6개.
난이도는 만든 쪽이 의도한 등급이고 세션에는 보이지 않습니다(`main-prompt.txt`에 등급, hook, 라우팅, 모델, 채점, 평가에 관한 말이 없다는
것을 `build-main-prompt.mjs --check`가 확인합니다).

| id | 언어 | 등급 | 내용 | 숨은 검사가 보는 것 |
|---|---|---|---|---|
| t01 | en | moderate | cursor 방식 페이지 나누기 `paginateAfter` 추가와, 그것을 쓰는 handler `listMembersAfter` | 꽉 찬 마지막 페이지의 `nextCursor`, 모르는 cursor, limit 검증, 빈 목록; handler가 query 글을 기존 `listMembers`와 같은 방식으로 읽는가(빈 값은 기본값, 정수가 아닌 글은 거부) |
| t02 | ko | routine | 설정 `maxWaitlist` 추가 | 빈 문자열은 기본값, `'2.5'`·`'12명'` 거부, 기존 항목 유지 |
| t03 | en | hard | 표시 이름 중복·길이 버그(증상 보고) | 유니코드 정규화(NFC/NFD), grapheme 단위 길이(emoji, 결합 문자, 풀어 쓴 한글), 악센트가 다른 이름은 구분 |
| t04 | ko | moderate | 대기자 우선순위 `orderWaitlist`와 `next()` | 동순위의 입력 순서 유지, UTC offset이 다른 시각 비교, 입력 배열 보존, `entries()`는 등록 순서 유지(과제 글에 적혀 있음) |
| t05 | en | routine | `formatDuration` 추가 | 0인 부분 생략, `0m`, 입력 검증 |
| t06 | ko | hard | 수업료 나누기 `splitCharge` | 합계가 정확히 일치, 통화별 최소 단위(KRW 0자리, KWD 3자리), 누구도 최소 단위 하나 이상 벗어나지 않음. total이 0인 경우는 과제 글에 없으므로 검사하지 않음 |
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
결함 해법 32개는 모두 `passed: false`이고 실패 이유가 그 결함을 잡으려고 쓴 숨은 검사임.

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
12. **작은 차이의 읽기.** 두 arm의 통과 수 차이가 **1이면 "구별되지 않음"**으로 보고합니다. 한 번 실행에서 과제 하나는 흔들림 안에
    있습니다. 차이가 **2 이상일 때만 "차이"로 기술**하고, 그때도 기술 통계일 뿐입니다(규칙 6). 어느 과제가 어느 arm에서만 통과했는지는
    차이의 크기와 관계없이 과제 이름과 실패한 검사 이름으로 적되, 그것을 arm의 우열로 쓰지 않습니다. `compare.mjs`가 arm 쌍마다
    이 판정을 찍습니다.
13. **arm N이 hook 없이 돌았는지 확인합니다.** arm N의 기록에 거부된 `Agent` 호출이 있거나, 재발행된 호출이나 서브에이전트의 agent
    type이 `general-purpose`가 아니면(`analyze.mjs`의 `totals.noRoutingCheck.clean`이 `false`) 그 실행은 "라우팅 없음" 기준선이
    아닙니다. 인프라 사유(규칙 2)로 보고 한 번 다시 돌릴 수 있고, 다시 돌리지 않으면 N의 숫자를 기준선으로 쓰지 않는다고 적습니다.

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
- **L의 합계는 "낮은 모델만"의 숫자가 아닐 수 있습니다.** L의 registry에는 낮은 slot의 역할(research, documentation, implement)만
  남습니다. judge가 과제를 그 밖의 역할(review, plan)로 분류하면 고를 프로필이 없어 route가 보류됩니다(`no_compatible_profile`).
  오프라인 hook 구동에서 review와 plan으로 답하게 한 위임은 R에서는 standard·strategic 프로필로 재작성됐고 L에서는 둘 다
  보류됐습니다(`verify-arm-install.mjs`). **보류된 위임은 `general-purpose`로 실행되어 Main 모델을 상속합니다.** Main 모델이 이
  실험에서 가장 높은 모델일 수 있으므로, L의 arm 합계(1차 결과)에는 더 높은 모델이 푼 과제가 들어갈 수 있습니다. 따라서
  "낮은 모델로도 품질이 유지되는가"는 L의 합계가 아니라 **라우팅된 것끼리의 비교**(규칙 5)와 **모델별 표**에서 읽습니다.
  `compare.mjs`는 L의 통과 수 옆에, 그중 몇 개가 라우팅된 프로필로 실행됐고 몇 개가 적용된 route 없이(어느 모델로) 통과했는지
  찍습니다. L에서 보류가 많으면 그 arm은 낮은 모델에 대해 말해 주는 것이 그만큼 적습니다.
- **R과 L에서 재작성이 일어나려면 registry의 활성 claude 항목이 `confirmed`여야 합니다**(제품 기본값
  `requireConfirmedAvailability: true`). 하나도 `confirmed`가 아니면 모든 위임이 `CAPABILITIES_UNCONFIRMED`로 그대로 통과해서 R과 L이
  N과 같은 실행이 되고, 일부만 `confirmed`면 R이 L처럼 됩니다. 설치는 어느 경우에도 성공합니다. 그래서 `make-arm-config.mjs`는
  확인 진술이 없으면 멈추고, `verify-arm-install.mjs`는 설치된 hook에 합성 이벤트를 넣어 실제 재작성을 확인합니다. 실제 실행에서
  라우팅이 0건이면(R의 `routing.routed`가 0) 그것은 결과가 아니라 설정 문제로 보고 8절에 적습니다.
- 선언은 3절의 둘뿐이고 기준 registry의 활성 claude 세 항목에 모두 걸립니다. 기준 registry가 아닌 것으로 설치했거나
  (`--allow-other-base`) 선언 없는 항목을 허용했으면(`--allow-undeclared`) `summary.json`에 기록되고, 8절에 적습니다. 선언한 id
  (`claude-sonnet-5-5`, `claude-opus-5-5`)는 이 머신의 이전 실제 세션에서 관찰된 값입니다. host가 이번에 다른 id를 기록하면 그 실행은
  평가 행이 되지 않고(수집기가 이유와 함께 보류), 그 수를 2차 결과로 보고합니다.
- **난이도 등급은 만든 쪽의 의도입니다.** 독립 검토에서, 과제 글과 템플릿만 보고 쓴 해법이 12개를 모두 통과했고, "서둘러 쓴" 해법은
  t03, t06, t07, t08, t10, t11에서는 의도한 숨은 검사에 걸렸지만 t01, t02, t04에서는 통과했습니다. 그 뒤 t01에는 기존 handler의
  동작에 맞춰야 하는 두 번째 변경을 넣었고 t04에서는 offset 예시를 뺐습니다. 그래도 t04는 곧바로 떠오르는 올바른 구현
  (`Date`로 비교하는 안정 정렬)이 통과하는 과제입니다. 등급별 표의 moderate 줄은 그 점을 감안해 읽습니다. hard 등급도 과제 글이
  요구 사항을 추론할 수 있게 적혀 있으므로(추론할 수 없는 숨은 요구는 넣지 않았습니다) 강한 모델에게는 쉬울 수 있습니다.
- 과제는 합성이고 한 프로젝트 안의 12개입니다. 채점기도 같은 쪽이 만들었으므로, 채점기가 놓치는 결함과 과하게 요구하는 경우가 있을 수
  있습니다. `selftest.mjs`는 채점기가 **준비된** 참조·결함 해법을 구별한다는 것만 보여 줍니다.
- 과제는 순서대로 한 프로젝트 사본에서 실행됩니다. 앞 과제의 서브에이전트가 남긴 변경을 뒤 과제의 서브에이전트가 봅니다. 파일은 겹치지
  않게 했지만, 앞 과제가 허용 경로 밖을 건드리면 뒤 과제에 영향을 줄 수 있습니다(`unattributedChanges`로 보고).

### 천장과 천장에 가까운 결과

**세 arm이 모두 12개를 통과하면 천장입니다.** 그 경우 "낮은 모델로도 품질이 유지되는가"에 대한 답은 "이 과제들로는 가를 수 없었다"이고,
품질 질문은 **열린 채로 남습니다.** "차이가 없다"는 결론으로 쓰지 않습니다. 비용 쪽 측정값은 그대로 보고합니다. `compare.mjs`가 이 경우를
`CEILING`으로 표시합니다.

**세 arm이 모두 11개 이상을 통과하면(천장은 아님) 천장에 가까운 결과입니다**(`NEAR CEILING`). 이 경우도 품질 질문은 열린 채로
남습니다: arm 사이의 차이는 많아야 과제 하나이고, 규칙 12에 따라 "구별되지 않음"입니다. 독립 검토의 결과로 보면 천장이나 천장에
가까운 결과가 여전히 가장 일어나기 쉬운 결과입니다. 그렇게 나오면 이 실험이 답하는 것은 비용 쪽 측정값(모델별 토큰, Main 토큰,
judge 토큰, 시간)과 "수집 경로가 실제 세션에서 이어지는가"뿐이고, 품질에 대해서는 더 어렵거나 더 많은 과제가 필요하다는 것입니다.

그 밖의 경우에도 arm 쌍의 차이는 규칙 12로 읽습니다: 1이면 구별되지 않음, 2 이상이면 차이로 기술.

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
| 세션이 받은 Main prompt가 `main-prompt.txt`와 달랐음: ASCII `@` 4개가 전각 `＠`(U+FF20)로 바뀌었음. 또 세션을 시작한 쪽(실험자)이 `main-prompt.txt` 앞에 배경 문단을 붙였고(세 arm 같은 내용, 실험자 쪽 편차), host가 공유 노트 안내와 (R, L) 연결된 세션 목록을 붙였음. `@`는 과제 12에만 있음 | N, R, L (같은 치환) | 세션이 모두 끝난 뒤 분석기를 돌리고 | 분석기가 과제 12의 위임 글을 `tasks.json`과 잇지 못해 "위임 안 됨"으로 셈(arm마다 11/12). 채점기는 세 arm 모두 과제 12 통과(12/12). 분석기는 고치지 않았고 두 숫자를 함께 보고함. 치환이 어디서 일어났는지는 미확인 |
| L의 모든 위임이 라우팅되지 않음. 원인은 7절이 예상한 review·plan 분류가 아니라 "불확실한 분류는 최소 standard" 규칙(`optimizer.mjs`). 실행 전 점검이 합성 이벤트뿐이어서 잡지 못함 | L | 분석 때 | L은 낮은 모델에 대해 아무것도 말하지 못함(sonnet 실행 0건). 라우팅된 것끼리의 비교는 0건 |
| L의 과제 5에서 분류 요청이 timeout(`JEV_TIMEOUT`, 1,200 ms). 원래 호출이 그대로 통과 | L | 분석 때 | 보류가 아닌 judge 실패 1건. 결과는 다른 보류와 같음(기본 모델로 실행) |
| Main이 `update_plan` 12회와 `wrap_up` 1회를 호출(데스크톱 앱의 진행 표시 도구) | N, R, L | 분석 때 | 프로젝트 작업은 아님. 경고로 남김 |
| 재실행 없음. 첫 세션 뒤 고정 파일 변경 없음(`freeze.mjs --check` 통과). 분석기 수정 없음 | - | - | - |

## 9. 첫 세션 전에 고친 것 (독립 검토 반영)

이 폴더의 자료는 독립 검토를 받았고, 아래는 그 뒤 **세션을 하나도 시작하기 전에** 고친 내용입니다. 고친 뒤 `FROZEN.json`을 다시
만들었습니다. 이 뒤로는 규칙 3이 적용됩니다.

| 무엇 | 고친 내용 | 이유 |
|---|---|---|
| 과제 글 t03 | "가족 emoji", "특정 휴대폰의 한국어 이름"이라는 예시를 빼고 증상(휴대폰에서 가입한 회원의 `NAME_TOO_LONG`, 프런트에서 다시 치면 되기도 함)만 남김 | 숨은 검사가 보는 경우를 글이 거의 그대로 말하고 있었음 |
| 과제 글 t07 | 재시도의 두 경우를 나열한 문장을 빼고 "성공 응답을 받을 때까지 다시 보낸다"는 제공자의 동작만 남김 | 같은 이유 |
| 과제 글 t10 | "모든 시간대에서, 그 모듈이 계산하는 모든 것에서"를 뺌 | 같은 이유. 요구(주간 수업은 항상 같은 스튜디오 시각)는 그대로이고 범위 조회도 같은 파일의 같은 증상 |
| 과제 t01 | `src/api/handlers.mjs`에 `listMembersAfter`를 추가하는 두 번째 변경을 넣음(허용 경로 추가, 참조 해법·결함 해법 2개·검사 4개 추가) | 곧바로 떠오르는 구현이 모든 숨은 검사를 통과해 routine처럼 동작했음. 기존 `listMembers`가 query를 읽는 방식에 맞춰야 하는 요구를 넣음 |
| 과제 글 t04 | offset 예시(`+09:00`)를 빼고 "표기가 통일되어 있지 않다"로 바꿈. `entries()`를 비롯한 나머지 동작은 그대로(등록 순서)라는 문장을 넣음 | 예시가 숨은 검사를 무력화했음. `entries()`의 순서는 글에 없는데 검사하고 있었음(올바른 해법이 떨어질 수 있었음) |
| 과제 글 t02 | "이번에는 `src/config/settings.mjs`만 고치면 된다"를 넣음 | 글의 목적 문장 때문에 `src/app.mjs`에 연결하는 것이 합리적인 해석이었고, 그러면 과제 밖 변경으로 보고됐음 |
| 채점기 t06 | total이 `0.00`일 때 0을 돌려주는지 보는 단언을 뺌 | 과제 글에 없고, 코드에는 0원 결제를 거부하는 선례가 있어 올바른 해법이 떨어질 수 있었음 |
| `base-registry.json`, `make-base-registry.mjs` | 기준 registry를 파일로 고정하고 해시를 `FROZEN.json`에 넣음. 설치 1단계의 `--registry`를 필수로 함 | 기준 registry가 사전 등록되어 있지 않았고, 기본 registry로 설치하면 선언이 아무 항목에도 걸리지 않았음 |
| `make-arm-config.mjs` | 활성 claude 항목이 `confirmed`가 아니면 멈춤(`--confirm-availability`는 실행하는 쪽의 진술). 선언 없는 활성 항목, 기준이 아닌 registry에서도 멈춤. `--verify`가 가용성, egress, 환경 변수 이름을 봄 | README대로 설치하면 모든 단계가 성공하는데도 R과 L에서 아무것도 라우팅되지 않았음(`CAPABILITIES_UNCONFIRMED`) |
| `verify-arm-install.mjs`, `tools.test.mjs` | 설치된 hook에 합성 `Agent` 이벤트를 넣어 R은 `jev4_*` 프로필로, L은 light 프로필로 재작성되는지 확인 | 설치 확인이 hook의 결정을 보지 않았음 |
| `preflight.mjs`, `analyze.mjs`, `compare.mjs` | 실행 전 점검 도구 추가. arm N의 기록에서 hook의 흔적을 찾아 경고(규칙 13). L의 통과 수를 라우팅된 것과 아닌 것으로 나눠 표시. 작은 차이의 판정(규칙 12)과 `NEAR CEILING` 표시. 읽을 수 없는 수집기 파일을 분명한 오류로 | 오염된 arm N이 드러나지 않았음. L의 합계가 "낮은 모델만"이 아닐 수 있었음. 천장에 가까운 결과의 읽는 법이 없었음 |
| `README.md` | 수집기 명령을 셸 함수로 바꿈 | 변수에 담은 명령은 zsh에서 실행되지 않았음 |
| 이 문서 | 3절에 기준 registry·가용성·점검 줄, 6절에 규칙 12·13, 7절에 L의 보류·가용성·등급의 한계, 천장에 가까운 결과 | 위와 같음 |

