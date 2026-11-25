# Skill 주입 paired pilot: 사전 등록 프로토콜

작성 시점: 2026-11-25, **어떤 세션도 시작하기 전**. 이 문서와 `tasks.json`, `main-prompt.txt`, `template/`, `checkers/`,
`analyze.mjs`, `compare.mjs`는 같은 커밋으로 고정됩니다. 첫 세션을 시작한 뒤에는 아래 "미리 정한 규칙"에 따라 바꾸지 않습니다.

## 먼저 밝혀 둘 것

- **과제, skill 60개, 채점기, 참조/naive 답안은 모두 모델이 작성한 합성 자료입니다.** 실제 프로젝트나 실제 사용자 요청에서 온 것이
  아닙니다. skill 6개의 "규칙"은 이 pilot을 위해 지어낸 것이고, 추측할 수 없도록 일부러 임의로 정했습니다.
- 이 문서를 쓴 세션은 실제 Claude 세션을 하나도 실행하지 않았습니다. 확인한 것은 채점기 self-test, 분석기 테스트, 누출 grep,
  그리고 제품 카탈로그 로더(`loadSkillCatalog`)가 `template/`의 skill 60개를 건너뛰지 않고 읽는다는 것뿐입니다.
- 분석기가 가정하는 transcript와 hook 상태의 모양은 과제 설명에 적힌 것이며, 실제 세션 파일로 확인하지 않았습니다. 모양이 다르면
  해당 값은 `null`과 경고로 나옵니다.

## 질문

subagent에게 가는 위임 prompt에 `<jev-skills>` 블록(선택된 skill의 이름과 `SKILL.md` 경로, 먼저 load하라는 한 줄)을 붙이면,
subagent가 하는 일과 결과물이 객관적 검사를 통과하는지가 달라지는가?

앞선 실제 세션에서는 skill이 4개뿐이었고 subagent가 매번 스스로 맞는 skill을 찾았습니다. 그래서 주입의 효과는 알 수 없었습니다.
이번에는 카탈로그를 60개로 늘리고, 추측할 수 없는 규칙을 가진 skill 6개를 씁니다.

## 설계

- **paired**: 같은 과제 8개를 두 arm에서 각각 한 번씩 수행합니다. 짝의 단위는 과제입니다.
- arm마다 `template/`의 새 복사본 하나, 새 세션 하나. 모델과 권한 설정은 두 arm이 같습니다.
- Main 세션은 `main-prompt.txt`를 **한 번** 받습니다. 그 prompt는 과제를 정해진 순서로 하나씩, 과제마다 Agent 호출 정확히 한 번
  (`subagent_type: general-purpose`), 과제 문장을 글자 그대로 넘기고, Main은 직접 일하지 않고 힌트도 붙이지 않으며, 마지막 보고 뒤에
  멈추라고 지시합니다. prompt에는 skill, hook, 규칙, 검사에 대한 언급이 없습니다.
- subagent는 매번 새 컨텍스트로 시작합니다. harness는 hook과 무관하게 모든 subagent에게 프로젝트 skill 목록(이름과 설명)을
  보여 주므로, **어느 arm에서든 subagent가 스스로 skill을 load할 수 있습니다.** 이 pilot이 재는 것은 "skill이 있고 없고"가 아니라
  "주입 블록이 있고 없고"입니다.

| arm | hooks | 전역 모드 | `delegation.skills` 지점 | subagent prompt |
|---|---|---|---|---|
| A `baseline` | 설치 | active | off | routing packet만 붙음. skill 블록 없음 |
| B `assisted` | 설치 | active | active | routing packet 뒤에 `<jev-skills>` 블록이 붙음 (선택된 skill이 있을 때) |

두 arm 모두 위임은 같은 종류의 agent profile로 라우팅됩니다. 차이는 skill 블록뿐이어야 합니다.

## 재료

- `template/`: 의존성 없는 Node ESM 합성 프로젝트 `parceldesk`. `.claude/skills/`에 skill 60개 = target 6 + distractor 54
  (target마다 혼동될 만한 이웃 2개 이상, 범용처럼 들리는 3개 `repo-tour`, `release-day-checklist`, `who-owns-what`).
  설명 60개 중 12개가 한국어입니다. 60개는 제품 기본 `maxJudged`(64) 안쪽이라 모든 skill이 judge에게 갑니다.
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
- 과제끼리는 건드리는 파일이 겹치지 않고 순서에 의존하지 않습니다(self-test [4]에서 참조 답안을 하나씩만 적용해 확인).

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
| target skill load 비율 | skill 과제 중, 그 과제의 subagent가 target skill을 load한 비율. load = `Skill` 호출의 `input.skill`이 skill 이름과 같음, 또는 `.claude/skills/<이름>/SKILL.md`로 끝나는 경로의 `Read` | subagent transcript |
| control의 잘못된 주입 | assisted arm에서 control 2개 중 `skills` 이벤트가 `injected: true`인 개수. 어떤 skill이 들어갔는지도 보고 | hook 상태의 `skills` 이벤트 |
| skill 과제의 주입 | arm별로 skill 과제 중 `injected: true`인 개수와, 주입된 `load` 이름에 target이 들어 있는지 | 같은 이벤트 |
| subagent tool 호출 수 | subagent transcript의 `tool_use` 항목 수 (같은 id는 한 번) | subagent transcript |
| subagent 토큰 | `message.usage`의 `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` 합. 같은 `message.id`는 한 번만 셈. usage가 없으면 `null` | subagent transcript |
| subagent 소요 시간 | 첫 줄과 마지막 줄 timestamp의 차이. timestamp가 없으면 `null` | subagent transcript |

참고로 함께 기록하는 것(결과가 아니라 프로토콜 준수 확인용): Main이 과제 문장을 글자 그대로 넘겼는지(`promptVerbatim`), 과제당
Agent 호출 수, 위임 순서, subagent의 첫 prompt에 `<jev-skills>` 블록이 실제로 있었는지(`promptHadSkillsBlock`), target을 첫 파일
쓰기 전에 load했는지, 과제 경로 밖 쓰기(`Write`/`Edit` 계열만. `Bash`로 쓴 것은 잡지 못함), route 이벤트의 profile/model/effort.

과제와 subagent의 연결: Main transcript에서 과제 문장이 `input.prompt`에 들어 있는 `Agent` 호출의 id → 그 id의
`spawn_observed` 이벤트의 `agentId` → `subagents/agent-<agentId>.jsonl`. 이벤트가 없으면 Main의 tool result에 적힌 agentId,
그것도 없으면 첫 prompt에 과제 문장이 든 subagent transcript가 정확히 하나일 때만 그것을 쓰고, 어느 경로였는지를
`agentIdSource`에 남깁니다.

## 미리 정한 규칙

1. **arm당 한 번만 실행합니다.** 결과를 보고 다시 돌리지 않습니다.
2. 세션이 **인프라 이유**(앱 종료, 네트워크 단절, 한도 초과, hook이 설치되지 않았음이 드러남 등 과제 내용과 무관한 이유)로
   끝까지 가지 못하면 그 arm을 새 복사본에서 **한 번** 다시 돌릴 수 있습니다. 다시 돌린 사실, 이유, 버린 실행에서 관찰한 것을
   모두 보고합니다. 두 번째도 실패하면 그 arm은 "측정 못 함"으로 보고합니다.
3. 첫 세션을 시작한 뒤에는 **과제, skill, 채점기, 기준을 바꾸지 않습니다.** 채점기에서 결함이 발견되면 원래 채점 결과를 그대로
   보고하고, 결함과 그 영향을 따로 적습니다. 고친 채점기로 다시 계산한 값은 사후 분석이라고 표시해서만 덧붙일 수 있습니다.
4. Main이 지시를 어긴 경우(과제 문장을 바꿈, 힌트를 붙임, 직접 작업함, 같은 과제를 두 번 위임함, 순서를 바꿈)에도 그 실행을
   버리지 않고 **그대로 채점하고 위반 내용을 보고합니다.** 같은 과제의 Agent 호출이 여럿이면 첫 호출을 그 과제의 것으로 씁니다.
5. **모든 실패와 측정하지 못한 값을 보고합니다.** `null`은 0이나 실패로 바꾸지 않고 "측정 못 함"으로 셉니다(합계의 `measured`).
   분석기와 채점기의 경고는 전부 보고에 포함합니다.
6. 짝 6개, arm당 1회입니다. 결과는 **기술(descriptive)일 뿐**입니다. 유의성 주장을 하지 않고, 검정 통계량을 계산하지 않으며,
   실제 프로젝트로 일반화하지 않습니다. "6개 중 몇 개"와 과제별 표를 그대로 보고합니다.
7. 두 arm의 차이가 skill 블록 말고 다른 데 있었던 것이 드러나면(모델, 권한, profile, 템플릿 사본이 달랐음) 그 사실을 결과보다
   먼저 적습니다.

## 알려진 한계

- 한 번의 실행에는 모델의 무작위성이 그대로 들어 있습니다. arm 사이 차이가 주입 때문인지 우연인지 이 설계로는 가릴 수 없습니다.
- 과제 8개가 한 프로젝트 사본에서 순서대로 실행됩니다. 파일이 겹치지 않게 만들었지만, 뒤 과제의 subagent는 앞 과제가 남긴
  변경(다른 skill의 규칙을 따른 파일 포함)을 볼 수 있습니다. 순서는 두 arm이 같습니다.
- 규칙은 일부러 임의적입니다. 실제 프로젝트의 skill은 코드에서 일부 추론되는 경우가 많으므로, 여기서의 차이는 실제 효과의 상한에
  가깝다고 봐야 합니다.
- `convention`은 엄격합니다. skill을 load했지만 규칙 하나를 놓치면 `false`입니다. 실패한 검사 이름을 함께 봐야 합니다.
- 채점기는 프로젝트의 모듈을 자식 프로세스에서 import해 실행합니다(쓰기는 하지 않음, 과제당 20초 제한). subagent가 함수 이름이나
  호출 형태를 과제 문장과 다르게 만들면 `done`이 `false`가 됩니다.
- 분석기는 `Agent`라는 이름의 tool 호출만 위임으로 셉니다.
