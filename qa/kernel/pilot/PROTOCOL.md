# Skill 주입 paired pilot: 사전 등록 프로토콜

작성 시점: 2026-11-25, **어떤 세션도 시작하기 전**. 이 문서와 `tasks.json`, `main-prompt.txt`, `template/`, `checkers/`,
`analyze.mjs`, `compare.mjs`는 같은 커밋으로 고정됩니다. 첫 세션을 시작한 뒤에는 아래 "미리 정한 규칙"에 따라 바꾸지 않습니다.

**첫 세션 전 수정 기록 (2026-11-25).** 첫 커밋(`545b661`) 뒤 독립 검토에서 문제 13건이 보고되었고, 13건 모두 사실로 확인되어
**어떤 세션도 실행되기 전에** 고쳤습니다. 바뀐 것: skill 설명 60개 전부와 distractor 12개 교체(1), 채점기 검사 4곳 완화·명확화와
skill 문구 1곳(2, 3, 8, 9), 과제 사이 결합 보고와 테스트 파일 분리(10), 분석기의 호출별 귀속·load 판정·목록 노출 측정·부분 측정
경고(4, 5, 7, 11), 과제 문장 3개(12), 이 문서의 실행 설정 표와 규칙(6, 13). 과제의 내용(무엇을 만들라는지)과 1차 결과의 정의는
바뀌지 않았습니다. 이 수정은 결과를 본 뒤의 변경이 아닙니다. 그때까지 실제 세션 결과는 존재하지 않았습니다.

## 먼저 밝혀 둘 것

- **과제, skill 60개, 채점기, 참조/naive 답안은 모두 모델이 작성한 합성 자료입니다.** 실제 프로젝트나 실제 사용자 요청에서 온 것이
  아닙니다. skill 6개의 "규칙"은 이 pilot을 위해 지어낸 것이고, 추측할 수 없도록 일부러 임의로 정했습니다.
- 이 문서를 쓴 세션은 실제 Claude 세션을 하나도 실행하지 않았습니다. 확인한 것은 채점기 self-test, 분석기 테스트, 누출 grep,
  그리고 제품 카탈로그 로더(`loadSkillCatalog`)가 `template/`의 skill 60개를 건너뛰지 않고 읽는다는 것뿐입니다.
- 분석기가 가정하는 transcript와 hook 상태의 모양은 과제 설명에 적힌 것이며, 실제 세션 파일로 확인하지 않았습니다. 모양이 다르면
  해당 값은 `null`과 경고로 나옵니다. `skills` 이벤트의 필드 이름만은 제품 코드(`orchestration/src/hooks.mjs`의 `skillsEvent`)에서
  읽어 맞췄습니다. harness가 subagent에게 skill 목록을 넘기는 행의 모양은 오프라인에서 확인하지 못했습니다.

## 질문

subagent에게 가는 위임 prompt에 `<jev-skills>` 블록(선택된 skill의 이름과 `SKILL.md` 경로, 먼저 load하라는 한 줄)을 붙이면,
subagent가 하는 일과 결과물이 객관적 검사를 통과하는지가 달라지는가?

앞선 실제 세션에서는 skill이 4개뿐이었고 subagent가 매번 스스로 맞는 skill을 찾았습니다. 그래서 주입의 효과는 알 수 없었습니다.
이번에는 카탈로그를 60개로 늘리고, 추측할 수 없는 규칙을 가진 skill 6개를 씁니다.

## 설계

- **paired**: 같은 과제 8개를 두 arm에서 각각 한 번씩 수행합니다. 짝의 단위는 과제입니다.
- arm마다 `template/`의 새 복사본 하나, 새 세션 하나. 모델, 권한, 버전, judge 체인은 아래 "고정 실행 설정" 표의 값으로 두 arm이
  같습니다.
- Main 세션은 `main-prompt.txt`를 **한 번** 받습니다. 그 prompt는 과제를 정해진 순서로 하나씩, 과제마다 Agent 호출 정확히 한 번
  (`subagent_type: general-purpose`), 과제 문장을 글자 그대로 넘기고, Main은 직접 일하지 않고 힌트도 붙이지 않으며, 마지막 보고 뒤에
  멈추라고 지시합니다. prompt에는 skill, hook, 규칙, 검사에 대한 언급이 없습니다.
- subagent는 매번 새 컨텍스트로 시작합니다. **가정(확인 대상):** harness는 hook과 무관하게 모든 subagent에게 프로젝트 skill
  목록(이름과 설명)을 보여 주고, 따라서 어느 arm에서든 subagent가 스스로 skill을 load할 수 있다. 이 가정은 오프라인에서 확인하지
  못했습니다. 목록에는 크기 한도가 있을 수 있고 소유자의 사용자 수준 skill과 plugin skill도 함께 실립니다. 그래서 분석기가
  과제마다 **target skill의 이름이 subagent에게 실제로 보였는지**(`targetListedToSubagent`)를 재고 arm별로 보고합니다. 가정이
  성립할 때에만 이 pilot은 "skill이 있고 없고"가 아니라 "주입 블록이 있고 없고"를 잽니다. target이 목록에 없었던 과제는 "보였지만
  주입하지 않음"이 아니라 "보이지 않음"으로 따로 적습니다.

| arm | hooks | 전역 모드 | `delegation.skills` 지점 | subagent prompt |
|---|---|---|---|---|
| A `baseline` | 설치 | active | off | routing packet만 붙음. skill 블록 없음 |
| B `assisted` | 설치 | active | active | routing packet 뒤에 `<jev-skills>` 블록이 붙음 (선택된 skill이 있을 때) |

두 arm 모두 위임은 같은 종류의 agent profile로 라우팅됩니다. 차이는 skill 블록뿐이어야 합니다.

### 고정 실행 설정

첫 세션을 시작하기 전에 이 표의 **모든 칸이 채워져 커밋되어 있어야 합니다.** "실행 세션이 기입"이라고 적힌 칸은 이 문서를 쓴
세션이 알 수 없는 값(소유자 환경에서 정해지는 값)입니다. 세션을 실행하는 쪽이 첫 세션 전에 실제 값으로 바꿔 커밋하고, 그 뒤에는
바꾸지 않습니다. 빈 칸이 남은 채로 실행했다면 그 사실을 결과보다 먼저 적습니다.

| 항목 | 값 (두 arm 공통, 표시한 곳만 다름) |
|---|---|
| arm 순서 | **A(baseline)와 B(assisted)를 같은 턴에 서로 다른 폴더에서 동시에 시작합니다.** (첫 세션 전 변경, 2026-11-25: 실제 세션은 소유자가 직접 요청한 턴에서만 시작할 수 있어 순차 실행이 불가능합니다. 두 arm은 별도 프로젝트 사본·별도 hook 상태 디렉터리를 쓰므로 서로의 파일을 건드리지 않습니다. 동시 실행은 wall time에 영향을 줄 수 있으나 두 arm에 대칭입니다. wall time은 보조 지표이며 이 영향을 보고서에 적습니다.) |
| Main 모델 id / effort | 시작하는 세션의 값을 상속: 모델 `claude-fable-5-2`, effort는 상속값(앞선 실제 세션에서 hook 이벤트로 관측된 값은 `medium`). 두 arm 동일. 실제 값은 실행 뒤 hook 이벤트/세션 기록에서 확인해 보고 |
| subagent 모델 / effort | hook의 route가 정함(`route` 이벤트의 `model`, `effort`로 과제별 기록). 두 arm의 kernel 설정이 같아야 함 |
| 권한 모드 | 시작하는 세션의 모드를 상속(앞선 실제 세션에서 관측된 값은 `auto`). 두 arm 동일. 조건: 프로젝트 안 파일 편집과 `node --test` 실행에 **확인 창이 뜨지 않는** 모드. 확인 창 때문에 소유자가 개입했다면 규칙 4의 위반으로 보고 |
| Claude Code(데스크톱) 버전 | 데스크톱 앱 `6.28899.6`, Agent SDK `0.3.330` (이 표를 채운 세션의 환경 변수 기준) |
| hooks 버전 | 이 pilot 커밋과 같은 저장소 커밋의 `orchestration/` (기입 시 `git rev-parse HEAD` 값). 기입: `orchestration/` 트리 해시 `382fa5634c81efcae6678b33a76eaf2f07c44469` (커밋 `287d08d`와 `e879a38`에서 동일, 버전 3.2.0). 두 arm 모두 이 트리에서 일회용 HOME에 설치한 runtime을 프로젝트 수준 hook으로 연결. `jev4_*` agent 프로필 27개는 실행 동안만 사용자 수준 `~/.claude/agents`에 복사하고 끝나면 제거 |
| 전역 모드 | `active` (두 arm) |
| `delegation.skills` 지점 | **A: `off` / B: `active`.** 두 arm의 kernel 설정에서 다른 것은 이 한 줄뿐 |
| skills judge 체인과 `escalateBelow` | **`jev` 단독, `escalateBelow` 0** (제품 기본값), 임계값도 기본값(need 0.5, autoLoad 0.9, suggest 0.5, maxLoaded 3). (예: `jev` 단독, 또는 `local,jev`와 임계값). B의 주입 내용을 정하므로 첫 세션 뒤에는 바꾸지 않음 |
| skills retrieval / `maxJudged` / `chunk` | 제품 기본값 `full` / 64 / 32 (바꾸면 기입). 60개는 64 안쪽이라 모든 skill이 judge에게 감 |
| 그 밖의 kernel 지점(supervisor 등) | 제품 기본값: `delegation.classify`·`delegation.profile`·`failure.classify` active, `supervisor.outcome` off, 읽기 조언 off. 외부 전송 동의 `JEV_ALLOW_EGRESS=true`, judge는 실제 Jev. 두 arm 동일 |
| 사용자 수준 skill, plugin, MCP | 가능하면 두 arm 모두 **끈 상태**(특히 skill 검색용 MCP와 그것을 쓰라고 하는 skill). 끌 수 없으면 켜져 있던 목록을 여기에 기입. 두 arm 동일. 기입: **끄지 않았습니다**(소유자의 실제 설정을 바꾸지 않기로 함). 소유자 환경에는 사용자 수준 skill과 MCP 서버가 켜져 있고, 그중에는 skill 검색용 MCP(`skill-rag`)와 그것을 쓰라고 안내하는 skill이 있습니다. 두 arm에 똑같이 적용되지만, subagent가 이 경로로 skill을 찾으면 주입 효과가 가려질 수 있습니다. 분석에서 subagent의 해당 도구 호출 여부를 과제별로 세어 보고합니다 |
| hook 상태 폴더 | arm마다 새 빈 폴더 |

## 재료

- `template/`: 의존성 없는 Node ESM 합성 프로젝트 `parceldesk`. `.claude/skills/`에 skill 60개 = target 6 + distractor 54
  (범용처럼 들리는 3개 `repo-tour`, `release-day-checklist`, `who-owns-what`). target마다 **같은 코드베이스, 같은 폴더를 다루지만
  상황이 다른** 이웃이 2개 이상 있습니다(예: `src/jobs`의 새 작업 추가가 target이면, 이미 있는 작업의 주기 변경과 두 번 실행된 작업
  추적이 이웃). 설명은 60개 모두 한 문장이고, "이럴 때는 쓰지 말 것" 같은 자기 배제 문구가 없습니다. 길이는 target과 distractor가
  같은 범위입니다(`node catalog-stats.mjs` 출력: 영어 target 132~138자, 영어 distractor 113~141자, 한국어 target 58자, 한국어
  distractor 49~68자). `src/` 경로는 target 6개와 distractor 16개의 설명에 나오고, `parceldesk`라는 이름은 distractor 3개에만
  나옵니다. 설명 60개 중 13개가 한국어입니다. 60개는 제품 기본 `maxJudged`(64) 안쪽이라 모든 skill이 judge에게 갑니다.
- `tasks.json`: 과제 8개, 고정 순서. skill 과제 6개(영어 3, 한국어 3)와 control 2개(영어 1, 한국어 1).

| 순서 | id | 언어 | 종류 | target skill |
|---|---|---|---|---|
| 1 | t01 | en | skill | `partner-file-exports` |
| 2 | t02 | ko | skill | `runtime-settings` |
| 3 | t03 | en | control | 없음 |
| 4 | t04 | ko | skill | `periodic-job-contract` |
| 5 | t05 | en | skill | `domain-failure-types` |
| 6 | t06 | ko | skill | `read-endpoints` |
| 7 | t07 | ko | control | 없음 |
| 8 | t08 | en | skill | `customer-text-messages` |

- 각 target skill 본문에는 스크립트로 확인할 수 있는 규칙이 3~4개 있습니다. 그 규칙의 고유 문자열은 `template/` 안에서 해당
  `SKILL.md` 밖 어디에도 나오지 않습니다(`sh leak-check.sh`로 확인). 과제 문장은 skill 이름이나 규칙을 말하지 않습니다.
- 과제끼리는 고쳐야 하는 소스 파일이 겹치지 않고 순서에 의존하지 않습니다(self-test [4]에서 참조 답안을 하나씩만 적용해 확인).
  다만 **완전히 독립은 아닙니다.** 알려진 결합 두 가지: (1) t04의 채점은 `src/jobs/index.mjs`를 import하는데, 그 파일은
  `door-watch-sweep.mjs`를 거쳐 t02가 고치는 `src/lockers/door-watch.mjs`를 import합니다. (2) t06의 채점은 `src/http/routes.mjs` →
  `handlers.mjs` → t05가 고치는 `src/lockers/assign.mjs`를 import합니다. t02나 t05의 subagent가 그 파일을 깨뜨리면 t04나 t06을
  정상적으로 채점할 수 없습니다. 이때 채점기는 `blockedBy`에 원인 과제를 적습니다. t04는 새 작업 모듈을 직접 import해서 채점하고
  (등록 여부는 `index.mjs` 소스에서 읽음), t06은 우회할 길이 없어 `done=false`가 됩니다. 어느 쪽이든 그 짝은 **오염된 짝**으로 따로
  보고합니다(self-test [8]). t02의 허용 경로에는 t04의 폴더 안 파일 `src/jobs/door-watch-sweep.mjs`가 들어 있습니다. 테스트 파일은
  과제마다 따로 쓰도록 `test/phone.test.mjs`, `test/tracking.test.mjs`, `test/time.test.mjs`로 나눴습니다. `test/jobs.test.mjs`는
  t02와 t04가 둘 다 고칠 수 있지만 채점기는 테스트 파일을 읽지 않습니다.

## 결과 정의와 계산 방법

모든 값은 `analyze.mjs`가 arm별로 계산해 JSON으로 쓰고, `compare.mjs`가 과제별 짝 표와 합계를 출력합니다.

### 과제별 채점 (`checkers/check.mjs`)

- `done`: 과제의 일반적 결과가 있는가. 프로젝트 모듈을 고정 입력으로 실행하거나 파일을 읽어 판정합니다. `done.*` 검사가 모두
  통과해야 `true`입니다.
- `convention`: skill 과제에서만. `done`이 `true`이고 그 skill의 `conv.*` 검사가 **전부** 통과하면 `true`. 하나라도 실패하면
  `false`. control은 항상 `null`입니다. 부분 점수는 없습니다(실패한 검사 이름은 `failedChecks`에 남습니다).
- control은 `done`과, 어느 과제의 경로에도 속하지 않는 파일 변경이 프로젝트에 없는지(`control.no_unattributed_changes`)를 봅니다.
- 검사 항목의 정확한 내용은 `checkers/probes.mjs`가 유일한 기준입니다.

### 1차 결과

**arm별로, skill 과제 6개 중 `convention`이 `true`인 개수** (`totals.primary_conventionPassed.yes`, 0~6).

### 2차 결과

| 이름 | 정의 | 출처 |
|---|---|---|
| target skill load 비율 | skill 과제 중, 그 과제의 subagent가 target skill을 load한 비율. load로 세는 것 세 가지: (1) `Skill` 호출의 `input.skill`이 skill 이름과 같음(`접두사:이름` 꼴이면 마지막 조각이 카탈로그에 있을 때 그 이름으로 셈, 원래 값은 `raw`에 남김), (2) `.claude/skills/<이름>/SKILL.md`로 끝나는 경로의 `Read`, (3) `<이름>/SKILL.md`를 이름으로 가리키는 `Bash` 명령(`cat`, `sed`, `head` 등). 세 경로 모두 비율에 들어가고 경로별 개수(`targetSkillLoadedVia`)를 따로 보고. `Grep`/`Glob`, 폴더만 가리키는 `Bash`, skills 폴더 전체를 훑는 명령은 읽었는지 알 수 없으므로 load로도 "load 안 함"으로도 세지 않고 `null`(측정 못 함)과 경고 | subagent transcript |
| target skill 노출 | skill 과제 중, subagent의 첫 assistant 응답 이전 행에서 찾은 skill 목록(카탈로그 이름이 3개 이상 든 행. `<jev-skills>` 블록은 빼고 찾음)에 target 이름이 들어 있던 개수. 목록을 찾지 못하면 `null`과 경고. 목록에 실린 카탈로그 이름 수(60개 중)도 기록 | subagent transcript |
| control의 잘못된 주입 | assisted arm에서 control 2개 중 `skills` 이벤트가 `injected: true`인 개수. 어떤 skill이 들어갔는지도 보고 | hook 상태의 `skills` 이벤트 |
| skill 과제의 주입 | arm별로 skill 과제 중 `injected: true`인 개수와, 주입된 `load` 이름에 target이 들어 있는지 | 같은 이벤트 |
| subagent tool 호출 수 | subagent transcript의 `tool_use` 항목 수 (같은 id는 한 번) | subagent transcript |
| subagent 토큰 | `message.usage`의 `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` 합. 같은 `message.id`는 한 번만 셈. usage가 없으면 `null`. assistant 메시지 일부에만 usage가 있으면 합은 부분합이고 경고가 붙음(`messages` 대 `assistantMessages`) | subagent transcript |
| subagent 소요 시간 | timestamp가 있는 행 중 가장 이른 것과 가장 늦은 것의 차이. timestamp가 없으면 `null`. 일부 행에만 있으면 경고(`timestampCoverage`) | subagent transcript |

참고로 함께 기록하는 것(결과가 아니라 프로토콜 준수 확인용): Main이 과제 문장을 글자 그대로 넘겼는지(`promptVerbatim`), 과제당
Agent 호출 수, 위임 순서, subagent의 첫 prompt에 `<jev-skills>` 블록이 실제로 있었는지(`promptHadSkillsBlock`), target을 첫 파일
쓰기 전에 load했는지, 과제 경로 밖 쓰기(`Write`/`Edit` 계열만. `Bash`로 쓴 것은 잡지 못함), route 이벤트의 profile/model/effort.

과제와 subagent의 연결은 **Agent 호출 단위**로 합니다. Main transcript에서 과제 문장이 `input.prompt`에 들어 있는 `Agent` 호출 중
**첫 번째 호출**이 그 과제의 호출입니다. hook 이벤트(`skills`, `route`, `spawn_observed`)와 subagent는 그 호출의 id로만 찾고,
같은 과제의 다른 호출 것을 섞지 않습니다. 그 호출의 `spawn_observed`에 `agentId`가 있으면 `subagents/agent-<agentId>.jsonl`.
`spawn_observed`가 `failed: true`이면 그 과제의 subagent는 `null`(측정 못 함)입니다. 이벤트에 agentId가 없으면 Main의 tool
result에 적힌 agentId를 씁니다. `spawn_observed` 이벤트가 **아예 없고** 그 과제의 Agent 호출이 **정확히 하나**일 때에만, 첫 prompt에
과제 문장이 든 subagent transcript가 정확히 하나이면 그것을 씁니다. 어느 경로였는지는 `agentIdSource`에 남습니다. 같은 과제의
나머지 호출은 `otherCalls`에 id, agentId, 주입 여부만 적고 채점에 쓰지 않습니다. 한 subagent가 두 과제에 연결되면(한 호출에 과제
문장 둘) 합계에서는 한 번만 셉니다.

## 미리 정한 규칙

1. **arm당 한 번만 실행합니다.** 결과를 보고 다시 돌리지 않습니다.
2. 세션이 **인프라 이유**(앱 종료, 네트워크 단절, 한도 초과, hook이 설치되지 않았음이 드러남 등 과제 내용과 무관한 이유)로
   끝까지 가지 못하면 그 arm을 새 복사본에서 **한 번** 다시 돌릴 수 있습니다. 다시 돌린 사실, 이유, 버린 실행에서 관찰한 것을
   모두 보고합니다. 두 번째도 실패하면 그 arm은 "측정 못 함"으로 보고합니다.
3. 첫 세션을 시작한 뒤에는 **과제, skill, 채점기, 기준을 바꾸지 않습니다.** 채점기에서 결함이 발견되면 원래 채점 결과를 그대로
   보고하고, 결함과 그 영향을 따로 적습니다. 고친 채점기로 다시 계산한 값은 사후 분석이라고 표시해서만 덧붙일 수 있습니다.
4. Main이 지시를 어긴 경우(과제 문장을 바꿈, 힌트를 붙임, 직접 작업함, 같은 과제를 두 번 위임함, 순서를 바꿈)에도 그 실행을
   버리지 않고 **그대로 채점하고 위반 내용을 보고합니다.** 같은 과제의 Agent 호출이 여럿이면 첫 호출을 그 과제의 것으로 씁니다.
   프로젝트 폴더의 채점(`done`, `convention`)은 어느 호출이 만든 결과든 최종 상태를 그대로 봅니다.
   **위임되지 않은 과제**(Main이 일찍 멈춤 등)는 "측정 못 함"이 아니라 측정된 `done=false`, skill 과제면 `convention=false`로
   셉니다. 그 과제의 subagent 측정값만 `null`입니다.
5. **모든 실패와 측정하지 못한 값을 보고합니다.** `null`은 0이나 실패로 바꾸지 않고 "측정 못 함"으로 셉니다(합계의 `measured`).
   분석기와 채점기의 경고는 전부 보고에 포함합니다.
6. 짝 6개, arm당 1회입니다. 결과는 **기술(descriptive)일 뿐**입니다. 유의성 주장을 하지 않고, 검정 통계량을 계산하지 않으며,
   실제 프로젝트로 일반화하지 않습니다. "6개 중 몇 개"와 과제별 표를 그대로 보고합니다.
7. 두 arm의 차이가 skill 블록 말고 다른 데 있었던 것이 드러나면(모델, 권한, profile, 템플릿 사본, "고정 실행 설정" 표의 어느
   값이든 달랐음) 그 사실을 결과보다 먼저 적습니다.
8. 규칙 2의 "인프라 이유로 다시 돌릴지"는 그 arm에 `check.mjs`나 `analyze.mjs`를 **돌리기 전에** 정합니다. 채점 결과를 본 뒤에는
   다시 돌리지 않습니다.
9. arm 순서(A 먼저)와 "고정 실행 설정" 표의 값은 첫 세션 뒤에 바꾸지 않습니다. judge 체인이나 임계값을 첫 실행을 보고 조정하지
   않습니다.

## 알려진 한계

- 한 번의 실행에는 모델의 무작위성이 그대로 들어 있습니다. arm 사이 차이가 주입 때문인지 우연인지 이 설계로는 가릴 수 없습니다.
- 과제 8개가 한 프로젝트 사본에서 순서대로 실행됩니다. 파일이 겹치지 않게 만들었지만, 뒤 과제의 subagent는 앞 과제가 남긴
  변경(다른 skill의 규칙을 따른 파일 포함)을 볼 수 있습니다. 순서는 두 arm이 같습니다.
- 규칙은 일부러 임의적입니다. 실제 프로젝트의 skill은 코드에서 일부 추론되는 경우가 많으므로, 여기서의 차이는 실제 효과의 상한에
  가깝다고 봐야 합니다.
- `convention`은 엄격합니다. skill을 load했지만 규칙 하나를 놓치면 `false`입니다. 실패한 검사 이름을 함께 봐야 합니다.
- 다만 **검사 하나하나가 모두 "skill을 읽었다"는 증거는 아닙니다.** t08의 `conv.length`(영어 110자, 한국어 60자 이하)와 t01의
  `conv.crlf_every_line`, `conv.snake_case_columns`는 skill을 모르는 엔지니어도 기본으로 지킬 수 있는 것입니다. 이 셋이 통과했다는
  것만으로는 아무것도 말할 수 없습니다. 이진 결과 `convention`은 과제마다 추측할 수 없는 검사가 셋 이상 함께 걸려 있어 이 영향을
  받지 않습니다.
- t02의 `done`은 새 환경 변수 이름을 찾아야 판정됩니다. 찾는 방법은 세 가지입니다: `settings.mjs`, `.env.example`,
  `docs/settings.md`에 새로 생긴 대문자 토큰, 그 토큰에 접두사(`PARCELDESK_`, `PDESK_`, 새로 생긴 `_`로 끝나는 토큰)를 붙인 것,
  `loadSettings`가 env 인자에서 실제로 읽은 이름. 셋 모두에 잡히지 않는 구현(예: env의 모든 키를 훑어 패턴으로 고르는 코드)은
  동작해도 `done=false`가 됩니다.
- target skill load 판정은 tool 호출의 입력만 봅니다. `Bash`로 skills 폴더 전체를 읽은 경우처럼 판정할 수 없으면 `null`입니다.
  `Bash`로 쓴 파일은 과제 경로 밖 쓰기 검사에 잡히지 않습니다.
- 소유자 환경의 사용자 수준 skill, plugin, MCP가 켜져 있으면 두 arm 모두의 subagent에게 보입니다. 프로젝트 카탈로그에 없는 skill을
  subagent가 load하면 경고로 남습니다.
- 채점기는 프로젝트의 모듈을 자식 프로세스에서 import해 실행합니다(쓰기는 하지 않음, 과제당 20초 제한). subagent가 함수 이름이나
  호출 형태를 과제 문장과 다르게 만들면 `done`이 `false`가 됩니다.
- 분석기는 `Agent`라는 이름의 tool 호출만 위임으로 셉니다.

## 세션 이후 분석기 수정 기록 (2026-11-25, 사후)

이 절은 두 세션을 **실행한 뒤에** 덧붙인 기록입니다. 위의 본문은 한 글자도 바꾸지 않았습니다. 과제, skill, 채점기, `main-prompt.txt`,
결과 정의는 그대로입니다. 바뀐 것은 `analyze.mjs`와 `compare.mjs`가 실제 세션 파일을 읽는 방식이고, 이 문서 첫머리의 "같은 커밋으로
고정"에서 벗어난 것이므로 여기에 밝힙니다.

- **왜:** 사전 등록한 분석기는 1차 결과(프로젝트 폴더 채점)는 읽었지만 2차 측정은 16개 과제 실행 중 1개에서만 읽었습니다. 실제
  transcript와 hook 상태의 모양이 가정과 달랐기 때문입니다.
- **읽기 방식 수정:** 대화 행(`user`/`assistant`/`attachment`)만 읽고 요청 기록 행(`api-request*`)의 중복 항목은 버립니다. subagent의
  첫 prompt는 harness 알림(`isMeta`)이 아닌 첫 user 글입니다. skill 목록은 `skill_listing` attachment의 `names`에서 읽습니다.
  `agent-<id>.meta.json`과 `decisions-log/*.jsonl`을 함께 읽습니다.
- **연결 규칙의 해석(결과를 본 뒤 정함):** 권한 모드 `auto`에서는 hook이 Agent 호출의 입력을 고치면 harness가 그 호출을 **실행하기
  전에 거부**하고, Main에게 고친 입력으로 다시 호출하라고 합니다. 그래서 위임 한 번이 Agent 호출 두 개(거부된 시도 + 실제로 시작된
  호출)로 남습니다. 본문의 "첫 번째 호출" 규칙을 글자 그대로 적용하면 거부된 시도가 과제의 호출이 되어 subagent 측정이 16개 중
  15개에서 `null`이 됩니다. 분석기는 **실행 전에 거부되지 않은 첫 호출**을 그 과제의 호출로 쓰고, 거부된 시도는 `attempts`,
  `delegationDetail`, `otherCalls`에 그대로 남깁니다. 모든 호출이 거부됐으면 본문 규칙대로 첫 호출입니다. 이 해석은 2차 측정을 어느
  subagent transcript에서 읽는지만 바꾸고, 1차 결과에는 영향을 주지 않습니다.
- **더해진 참고값(결과 정의가 아님):** 호출별 hook 판단(need, load/suggest 확률, target에 대한 judge 확률, route), judge 지연,
  토큰 구성, target load와 첫 쓰기의 순서, 사용자 수준 skill 검색 도구 사용, Main 세션 정보, 짝 차이.
- **끝내 측정하지 못한 값:** judge 토큰(결정 기록에 토큰 수가 없음), arm A의 `injected`(skills 이벤트가 없으므로 `false`가 아니라
  `null`), `Bash`로 쓴 파일의 귀속.
- 결과 파일과 자세한 목록: `../results/pilot-20261125/` (`notes.txt`).
