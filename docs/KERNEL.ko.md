# Decision kernel (3.2.0)

기존 native hook 경로(`shadow`/`advisory`/`active`)의 모든 판단이 지나가는 공통 계층입니다. 코드는 `orchestration/src/kernel/`에 있습니다. ultracode 계획 보조와 `controller` 모드는 이 문서의 지점을 호출하지 않습니다.

## 왜 만들었나

원칙은 하나입니다. **흐름은 코드가 갖고, judge는 typed 확률만 공급합니다.**

- 언제 묻는지, 무엇을 묻는지, 임계값, 주입 문구, 실패 시 동작은 모두 코드에 고정되어 있습니다.
- judge(Jev, OpenAI Decisions, 로컬 규칙)는 `noul`(예/아니오 확률), `choice`(선택지 분포), `score`(단계 분포) 세 가지 형태로만 답합니다. 자유 서술은 받지 않습니다.
- 답은 공통 검증기(`answers.mjs`)를 통과해야 쓰입니다. 범위 밖 확률, 합이 1이 아닌 분포, 모르는 선택지는 거부합니다.
- 그래서 judge 제공자를 바꾸거나 체인으로 묶어도 hook 로직은 그대로입니다.

기본 설정에서는 3.1.0과 같은 판단을 같은 횟수로 요청합니다. 새 기능(skill 라우팅, supervisor, OpenAI judge)은 모두 꺼진 채로 설치됩니다.

## 여섯 개의 결정 지점

| 지점 | 기본 모드 | 무엇을 정하나 | 호출 시점 |
|---|---|---|---|
| `delegation.classify` | active | 위임 작업의 역할·범위·위험·추론 수준·정보 충분성·문서 필요 | 위임 `PreToolUse` |
| `delegation.profile` | active | 허용된 모델×effort 후보 중 프로필 선택 또는 보류 | 위임 `PreToolUse` |
| `delegation.skills` | **off** | worker가 시작 전에 읽을 skill (load / consider) | 위임 `PreToolUse`, 분류와 병렬 |
| `supervisor.outcome` | **off** | worker 보고의 분류(`complete`/`retry`/`replan`/`escalate`)와 근거 수준 | 보고가 응답에 들어 오는 runtime은 위임 `PostToolUse`, 비동기로 실행하는 runtime은 `SubagentHandback` `PostToolUse`. [Supervisor](#supervisor-supervisoroutcome) |
| `failure.classify` | active | 실패한 위임의 실패 범주 | 위임 `PostToolUse`/`PostToolUseFailure` (실패 응답) |
| `read.advice` | active | 읽으려는 문서의 종류와 읽기 방식 힌트 | Read `PreToolUse` |

`failure.classify`는 기존 `classifyFailures`, `read.advice`는 기존 `JEV_READ_ADVICE=true`가 켜져 있어야 호출됩니다. 이 조건은 3.1.0과 같습니다.

## 모드: off / shadow / active

각 지점은 자기 모드를 갖습니다.

| 지점 모드 | judge 호출 | decision log | 결과 사용 |
|---|---|---|---|
| `off` | 안 함 | 안 남김 | 안 함 |
| `shadow` | 함 | 남김 | 안 함 (기록만) |
| `active` | 함 | 남김 | 함 |

지점 모드는 전역 `JEV_MODE` **안에서만** 의미가 있습니다. 전역 모드가 먼저 적용됩니다.

| 전역 `JEV_MODE` | 지점이 `active`일 때 일어나는 일 |
|---|---|
| `off` | hook 전체가 아무 일도 하지 않음 |
| `shadow` (기본) | 판단하고 세션 상태·log에 기록. Main에게 아무것도 보이지 않음 |
| `advisory` | 판단 결과를 Main에게 조언으로 표시. 대기 중인 호출은 그대로 |
| `active` | 위임 호출을 검토된 프로필로 재작성 (Codex는 기존 별도 승인 필요) |
| `controller` | 이 kernel 지점을 호출하지 않음 |

기존 지점을 `off`/`shadow`로 낮췄을 때의 동작입니다.

| 지점 | `shadow` | `off` |
|---|---|---|
| `delegation.classify` | 분류는 decision log에 기록만. Main에게 아무것도 보이지 않고 원래 호출 유지. 세션 상태에는 `routing_skipped`(`classification_point_shadow_only`)만 남김 | judge를 부르지 않고 원래 호출 유지. 오류가 아니므로 경고도, `failureMode=block`의 차단도 없음. 세션 상태에 `routing_skipped`(`classification_point_off`) |
| `delegation.profile` | 선택은 기록만. 정책상 기본 후보(incumbent) 사용 | judge 없이 정책상 기본 후보 사용 |
| `failure.classify` | 판단·기록만. 세션 상태와 Main 표시에는 반영 안 함 | 호출 안 함 |
| `read.advice` | 판단·기록만. 표시 안 함 | 호출 안 함 |

`delegation.classify`가 `off`이면 라우팅 자체를 끈 것으로 보고 같은 위임의 skill 판단(`delegation.skills`)도 시작하지 않습니다. `shadow`이면 skill 판단은 자기 모드대로 실행·기록되지만, route가 없으므로 블록은 어디에도 붙지 않습니다.

모든 위임 지점은 기존 조건을 그대로 따릅니다. `JEV_ALLOW_EGRESS=true`가 아니면 위임 경계에서 어떤 judge도(로컬 포함) 호출하지 않습니다. custom agent, resume, 명시적 native 설정, 비밀 유사 문자열 같은 기존 보존 guard가 먼저 적용됩니다.

## Judge 제공자와 체인

| 제공자 | 무엇인가 | 네트워크 |
|---|---|---|
| `jev` | TypeSafe의 Jev. 기존 `JevClient` 그대로 | `api.typesafe.ai` |
| `openai` | OpenAI Decisions 어댑터. `POST /v1/decisions`로 질문을 `predicate`/`choice`/`score`로 변환해 보냄 | `api.openai.com` |
| `local` | 프로세스 내부 규칙. 현재 `delegation.skills`용 어휘(BM25) 규칙만 있음 | 없음 |

`local`은 다른 지점에서는 항상 기권(`LOCAL_ABSTAIN`)합니다. `local`의 skill 확률은 BM25 점수를 `s/(s+4)`로 눌러 만든 **순서 보존용 숫자이며 calibration된 확률이 아닙니다.**

`local`은 skill 지점에서도 **어휘 신호가 전혀 없으면 기권합니다.** 작업의 어휘 신호([후보 검색 방식](#후보-검색-방식)의 `lexicalSignal`)가 0, 곧 모든 BM25 점수가 0이면 답하지 않고 `LOCAL_ABSTAIN`을 냅니다. 신호가 0보다 크면 `minCoverage`보다 낮아도 답합니다. 처음에는 `minCoverage` 미만에서도 기권하게 했는데, 독립 리뷰에서 결함으로 확인되어 되돌렸습니다. 어휘 신호는 작업이 길수록, 카탈로그가 작을수록 낮아지므로, 같은 언어이고 BM25 일치가 뚜렷한 작업도 0.25 아래로 내려갑니다(skill 3~10개 카탈로그, 위임 지시문 안에 든 한 줄 작업). 그 상태에서는 `local` 단독 설정과 기본 CLI가 대부분의 작업에 답하지 못했습니다. 예전에는 이 경우 `need = 0`을 확신 1로 답해서 `local,jev` 체인이 Jev로 넘어가지 않았습니다. 겹치는 단어가 없다는 것은 skill이 필요 없다는 근거가 아니기 때문입니다. 지금은 체인이면 다음 judge로 넘어가고, `local` 단독이면 그 작업의 결과가 `status: unavailable`(`code: LOCAL_ABSTAIN`)입니다.

### 체인과 escalation

지점마다 `judges`(1~3개, 중복 없음)와 `escalateBelow`(0~1)를 가집니다.

1. 체인의 첫 judge부터 순서대로 묻습니다.
2. judge가 **실패**하면(동의 없음, timeout, 잘못된 응답 등) 다음 judge로 넘어갑니다.
3. judge가 답했지만 **확신이 `escalateBelow` 미만**이고 뒤에 judge가 남아 있으면, 그 답을 보류해 두고 다음 judge로 넘어갑니다. 마지막 judge의 답은 확신이 낮아도 채택합니다.
4. 뒤의 judge가 모두 실패하거나 예산이 끝나면 **보류해 둔 답 중 확신이 가장 높은 것을 채택합니다.** 그래서 judge를 추가해도 첫 judge 하나만 쓸 때보다 실패가 늘지 않습니다. 이때 `trail`에는 `KERNEL_LOW_CONFIDENCE` 단계와 실패한 단계가 함께 남습니다.
5. 유효한 답이 하나도 없을 때만 마지막 오류 코드로 실패합니다. 호출부는 기존 실패 정책(`failureMode`)을 따릅니다.

- 확신은 한 번의 호출에 담긴 모든 답 중 **최솟값**입니다. `noul`은 `|2p-1|`, `choice`/`score`는 judge가 준 `confidence`입니다.
- `escalateBelow`의 기본값은 `0`입니다. 즉 기본으로는 실패했을 때만 다음 judge로 갑니다.
- 예산은 judge별이 아니라 **체인 전체 예산**입니다. 크기는 체인에 든 제공자의 요청 timeout 중 **가장 큰 값 하나**입니다(`jev`는 전역 `timeoutMs`, `openai`는 `kernel.providers.openai.timeoutMs`, `local`은 없음). 합이 아니므로 judge를 늘려도 대기 시간이 곱해지지 않습니다. 기본 체인 `["jev"]`에서는 예전과 똑같이 전역 `timeoutMs`입니다.
- 호출부의 상한이 항상 이깁니다. 분류·skill 판단은 `routeDeadlineMs`, 프로필 선택은 route deadline에서 남은 시간을 상한으로 줍니다. 다음 judge로 넘어갈 때 남은 예산이 50ms 미만이면 `KERNEL_DEADLINE`으로 멈춥니다. 첫 judge는 호출부가 준 예산 자체가 50ms 미만일 때만 거부됩니다. 그래서 timeout을 허용 최솟값 50ms로 두어도 첫 judge에게 요청이 나갑니다(예전에는 예산 50ms에서 남은 시간이 49.99ms로 계산되어 judge를 부르지 않았습니다).
- 각 judge는 그 예산 안에서 자기 timeout을 다시 적용합니다. 자세한 내용은 [제공자별 timeout](#제공자별-timeout)을 보세요.
- 요청 수 상한(`circuit.maxRequestsPerSession`)과 circuit은 `delegation.skills`·`supervisor.outcome`이 나머지 네 지점과 **따로** 셉니다. 선택 지점을 켜도 라우팅의 요청 예산을 쓰지 않습니다. 대신 두 지점을 켜면 세션당 요청 수의 상한은 최대 두 배가 됩니다. `delegation.skills`와 `supervisor.outcome`은 서로 **같은** 상한과 circuit을 씁니다. 넓은 판정은 위임 하나에 요청을 여러 개 쓰므로 [넓은 판정](#넓은-판정-fan-out)의 요청 수 제한을 함께 보세요.
- 채택된 답은 앞선 judge의 답과 섞지 않습니다. 한 결정은 한 judge의 답입니다.
- 연결 자체가 실패하면(거부, DNS 실패 등) `JEV_NETWORK_ERROR` 또는 `DECISIONS_NETWORK_ERROR`로 기록합니다. timeout(`JEV_TIMEOUT`, `DECISIONS_TIMEOUT`), HTTP 오류(`JEV_HTTP_<상태>`, `DECISIONS_HTTP_<상태>`)와 구분됩니다.

### 제공자별 timeout

전역 `timeoutMs`(기본 1200ms, `JEV_TIMEOUT_MS`)는 Jev에 맞춘 값입니다. OpenAI judge는 이 값을 물려받지 않고 `kernel.providers.openai.timeoutMs`를 씁니다.

| 항목 | 값 |
|---|---|
| 기본값 | 2500ms |
| 허용 범위 | 정수 50~5000 (전역 `timeoutMs`와 같은 범위). 벗어나면 `INVALID_KERNEL_OPENAI_TIMEOUT` |
| env | `JEV_OPENAI_DECISIONS_TIMEOUT_MS` (숫자만, 같은 범위). 잘못되면 `INVALID_JEV_OPENAI_DECISIONS_TIMEOUT_MS` |

- 기본값의 근거: 실제 관측 1회에서 첫(cold) 요청이 1200ms를 넘겼고 이후 요청은 280~580ms였습니다. cold 요청이 실제로 얼마나 걸렸는지는 기록되지 않았습니다. 2500ms는 넘겼던 한도의 약 두 배이고, 기본 `routeDeadlineMs`(3000ms)에서 프로필 선택에 500ms를 남깁니다. **측정된 분위수가 아닌 초기값입니다.**
- 실제 요청 한도는 `min(제공자 timeout, 호출부가 준 체인의 남은 예산)`입니다. 제공자 timeout을 5000으로 올려도 `routeDeadlineMs`가 300이면 300ms 근처에서 `DECISIONS_TIMEOUT`으로 끝납니다.
- OpenAI judge는 호출 시작 시점에 마감 시각을 하나 정합니다. 요청 전의 cache 잠금·요청 수 잠금 대기는 그 마감에서 끊기고(`LOCK_BUSY`), 마감이 지났으면 요청을 보내지 않으며 요청 수와 circuit 실패로도 세지 않습니다(`DECISIONS_TIMEOUT`). 요청이 끝난 뒤 성공·실패 횟수를 적는 짧은 잠금은 별도 한도(최대 1500ms)를 그대로 쓰므로, 잠금 경합이 심하면 호출이 마감보다 늦게 끝날 수 있습니다. 경합 상황은 테스트 한 건(cache 잠금 대기)으로만 확인했습니다.
- **숨은 재시도나 warm-up 요청은 없습니다.** timeout된 요청은 한 번의 실패로 세고 체인의 다음 judge로 넘어갑니다.
- skill 판단이 여러 요청으로 나뉘어도([넓은 판정](#넓은-판정-fan-out)) 이 관계는 같습니다. 요청들은 동시에 나가고 모두 같은 체인 예산 하나를 받으며, skill 작업 전체는 여전히 `routeDeadlineMs`에서 끊깁니다. 요청 수가 늘어도 대기 시간은 늘지 않습니다.
- hook 전체 한도와의 관계: 위임 `PreToolUse`는 분류와 프로필 선택이 `routeDeadlineMs`(최대 5500ms) 하나를 나눠 쓰고, 그 외 이벤트는 hook 한 번에 체인 하나만 실행하며 그 예산은 최대 5000ms입니다. 둘 다 `bin/jev-hook.mjs`의 watchdog(7000ms)과 설치된 hook timeout(8초)보다 짧습니다. hand-back `UserPromptSubmit`은 judge를 부르지 않고 진행 중인 판정을 기다리기만 하며, 그 대기는 handler 시작 후 3500ms를 넘지 않습니다([보고가 오는 두 경로](#보고가-오는-두-경로)).

### 설정 예시

설치된 `config.json`의 `kernel` 객체입니다. 없거나 일부만 있으면 기본값과 병합합니다. 모르는 지점 이름이나 잘못된 값은 `INVALID_KERNEL_*`로 거부합니다.

```json
{
  "kernel": {
    "log": true,
    "providers": {
      "openai": { "endpoint": "https://api.openai.com", "model": "gpt-6-luna", "approved": false, "timeoutMs": 2500 }
    },
    "points": {
      "delegation.classify": { "mode": "active", "judges": ["jev"], "escalateBelow": 0 },
      "delegation.profile":  { "mode": "active", "judges": ["jev"], "escalateBelow": 0 },
      "delegation.skills":   { "mode": "shadow", "judges": ["local", "jev"], "escalateBelow": 0.6 },
      "supervisor.outcome":  { "mode": "off",    "judges": ["jev"], "escalateBelow": 0 },
      "failure.classify":    { "mode": "active", "judges": ["jev"], "escalateBelow": 0 },
      "read.advice":         { "mode": "active", "judges": ["jev"], "escalateBelow": 0 }
    },
    "skills": { "dirs": [], "maxCandidates": 8, "need": 0.5, "autoLoad": 0.9, "suggest": 0.5, "maxLoaded": 3, "maxSuggested": 3,
                "retrieval": "full", "minCoverage": 0.25, "maxJudged": 64, "chunk": 32 },
    "supervisor": { "maxReportChars": 1600, "confidence": 0.65 }
  }
}
```

위 예시에서 `delegation.skills`만 기본값과 다릅니다. 로컬 규칙이 먼저 답하고, 확신이 0.6 미만이거나 로컬 규칙이 기권하면 Jev에게 넘깁니다. `escalateBelow`는 config 또는 env(`JEV_SKILLS_ESCALATE_BELOW` 등, [환경 변수](#환경-변수))로 설정합니다. 체인만 `local,jev`로 바꾸고 `escalateBelow`를 0으로 두면 `local`이 답하는 한 Jev를 부르지 않습니다. kernel 설정을 바꾸면 정책 지문이 달라져 대기 중이던 호출은 `POLICY_CHANGED_DURING_PENDING_CALL`로 무효화됩니다.

## 제공자별 동의 관문

체인에 이름을 넣는 것만으로는 전송되지 않습니다. 각 judge는 호출 시점에 아래를 모두 확인하고, 하나라도 빠지면 typed 오류로 실패합니다(체인의 다음 judge로 넘어감).

| 제공자 | 필요한 것 | 빠졌을 때 |
|---|---|---|
| `jev` | `JEV_ALLOW_EGRESS=true`, `TYPESAFE_API_KEY` | 기존 Jev 오류 코드 |
| `openai` | `JEV_ALLOW_EGRESS=true` | `EGRESS_NOT_APPROVED` |
| | `JEV_OPENAI_DECISIONS_APPROVED=true` | `OPENAI_DECISIONS_NOT_APPROVED` |
| | `OPENAI_API_KEY` | `MISSING_OPENAI_API_KEY` |
| | endpoint가 정확히 `https://api.openai.com` | `OPENAI_ENDPOINT_NOT_APPROVED` |
| `local` | 없음 (네트워크 없음) | — |

- `OPENAI_API_KEY`는 private `.env`에서 실행 환경으로만 전달됩니다. config 파일에는 저장하지 않습니다.
- OpenAI로 보내기 전에도 상태에 키와 비슷한 문자열이 있으면 `SECRET_GUARD`로 중단합니다. 요청은 512KiB, 응답은 256KiB로 제한합니다.
- `score` 답의 분포는 어댑터가 보낸 단계 label(`0`..`n-1`)로 읽습니다. 응답의 `value`가 label과 일정한 차이(예: 1부터 시작)만 나면 `score`를 같은 눈금으로 옮기고, 그렇게 맞출 수 없으면 `INVALID_DECISIONS_ENVELOPE`로 거부합니다.
- OpenAI judge는 QA 실행에서 실제 API로 호출됐습니다(합성 데이터, 기본 모델 `gpt-6-luna`, `predicate`/`choice`/`score` 응답 모두 검증 통과, 실패 0건). 다만 그 실행의 승인 근거는 확인되지 않았고 결함 수정 뒤에는 다시 호출하지 않았습니다. [검증 상태](#검증-상태)를 보세요.

## Skill 라우팅 (`delegation.skills`)

### 왜 위임 경계에서 고르나

skill을 Main에게 "이걸 써 보세요"라고 추천하면 두 가지 문제가 생깁니다. Main의 컨텍스트에 모든 skill 설명이 올라가고, 실제로 일하는 worker에게 전달될지는 Main의 재량에 달립니다. 반면 위임 경계에서는 **작업 내용이 한 건으로 확정되어 있고**, 그 일을 할 worker가 정해져 있습니다. 그래서 여기서 고르면 다음이 가능합니다.

- 필요한 worker의 brief에만, 필요한 skill 이름만 들어갑니다.
- 선택 근거가 결정 단위로 기록되어 나중에 "왜 안 골랐나"를 답할 수 있습니다.
- Main이 skill 명령을 직접 호출할 필요가 없습니다.

### 파이프라인

```text
카탈로그 → 후보 검색(lexical / adaptive / full) → judge → 임계값 → (active일 때) brief에 블록 주입
```

| 단계 | 하는 일 |
|---|---|
| 카탈로그 | 프로젝트 `.claude/skills/<폴더>/SKILL.md`와 `JEV_SKILL_DIRS`를 읽음. frontmatter의 `name`, `description`만 사용 |
| 후보 검색 | 작업 문장과 이름(가중치 3)·설명의 어휘 일치(BM25)로 순위를 매김. 한글·한자·가나는 글자 bigram도 사용. 기본(`retrieval: full`)은 카탈로그 전체(최대 `maxJudged` 64개)를 이 순위대로 judge에게 보냄. `lexical`은 상위 `maxCandidates`(8)개만 보냄. [후보 검색 방식](#후보-검색-방식) |
| judge | 요청 하나마다 `need`(skill이 필요한 작업인가) 1문항 + 그 요청에 든 skill별 `skill_N`(직접 적용 가능한가) 문항. 모두 `noul` |
| 임계값 | `need < 0.5`이면 아무것도 고르지 않음. 그 외에는 확률이 높은 순서로 ≥ `autoLoad`(0.9) → **load**(최대 3), ≥ `suggest`(0.5) → **consider**(최대 3). `autoLoad`를 넘었지만 load 자리가 없는 skill은 consider로 내려감 |

카탈로그는 다음을 건너뛰고 이유를 `skipped`에 남깁니다: 심볼릭 링크, 256KiB 초과, frontmatter 없음, 규칙에 안 맞는 이름·폴더명(`[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`), 설명 없음, 중복 이름, 프로젝트 밖으로 벗어나는 경로.

프로젝트의 `.claude` 또는 `.claude/skills`가 심볼릭 링크여도 됩니다.

| 경우 | 동작 |
|---|---|
| 링크의 실제 경로가 실제 프로젝트 **안**에 있음 (예: `.claude/skills → shared/skills`) | 따라가서 읽음. 일반 디렉터리일 때와 같은 이름·설명·주입 경로가 나옴 |
| 실제 경로가 프로젝트 **밖** (절대 경로, `..`, 안에서 시작해 밖으로 나가는 다단 링크, 이름만 프로젝트로 시작하는 형제 디렉터리) | 프로젝트 skill 전체를 읽지 않음 (`root_outside_project`) |
| 끊어진 링크 | 카탈로그 없음으로 취급. 오류 아님 |

root를 따라간 뒤에도 그 안의 규칙은 같습니다. 심볼릭 링크인 skill 폴더(`symlink_folder`)와 `SKILL.md`(`symlink_file`)는 계속 건너뜁니다.

안전 관련 동작은 다음과 같습니다.

- judge 실패·timeout·잘못된 답이면 **아무 skill도 고르지 않습니다**(`status: unavailable`). 라우팅 자체는 계속됩니다. 요청이 여러 개로 나뉜 경우에는 실패한 요청에 든 skill만 빠지고, 모든 요청이 실패했을 때 `unavailable`입니다.
- skill 작업은 `routeDeadlineMs`에서 강제로 끊깁니다(`SKILLS_DEADLINE`). 라우팅을 그 이상 늦추지 않습니다.
- `maxTaskChars`를 넘는 작업은 분류도 하지 않으므로 skill 라우팅도 건너뜁니다.
- skill 설명과 본문은 신뢰하지 않는 데이터입니다. judge에게 상태로만 보내고 brief에는 넣지 않습니다.

### 후보 검색 방식

skill 설명은 대개 영어인데 작업 문장은 한국어일 수 있습니다. 그러면 겹치는 단어가 없어 BM25 점수가 전부 0이 되고, 상위 8개는 이름순으로 채워질 뿐 관련 순서가 아닙니다. 개발용 데이터에서 한국어 작업의 gold skill이 후보 8개 안에 든 비율은 0.408이었습니다. 그래서 judge에게 무엇을 보여 줄지를 설정으로 고를 수 있게 했습니다.

| `kernel.skills.retrieval` | judge에게 가는 것 |
|---|---|
| `lexical` (이 설정이 생기기 전의 동작) | BM25 상위 `maxCandidates`개. 요청 1개 |
| `full` (**기본**) | 카탈로그 전체. `maxJudged`(기본 64)개를 넘으면 BM25 상위 `maxJudged`개 |
| `adaptive` | 작업의 어휘 신호가 `minCoverage` **이상**이면 `lexical`과 같고, **미만**이면 `full`과 같음 |

기본값은 `full`입니다. 사전 등록한 규칙을 실제 judge로 돌린 개발 세트 실행에 적용해 정했습니다([결정 기록](#결정-기록)). `kernel.skills`에 `retrieval`이 없는 이전 config도 `full`로 채워집니다. 예외는 두 가지입니다. (1) `retrieval`이 없는 이전 config가 `delegation.skills`를 켜 두었고(config 또는 `JEV_SKILLS_MODE`) 요청 상한 `circuit.maxRequestsPerSession`이 `full`에 필요한 값(기본 8)보다 작으면, 읽을 때 `lexical`로 유지합니다. 그 config는 기본값이 바뀌기 전에 문제없이 읽혔으므로, `INVALID_KERNEL_SKILLS_FANOUT_CAP`으로 모든 hook이 실패하는 대신 이전 동작을 그대로 둡니다. 설치기도 같은 규칙을 적용하고 그 결과(`lexical`)를 config에 적습니다. config나 env가 `full`·`adaptive`를 직접 지정했는데 상한이 작으면 지금처럼 거부합니다. (2) 설치기는 병합된 기본값을 config 파일에 적습니다. 그래서 기본값이 `lexical`이던 릴리스 전 중간 빌드로 설치한 config에는 `"retrieval": "lexical"`이 사용자가 고른 값처럼 남아 있고, 새 기본값을 받지 않습니다. `full`을 쓰려면 그 키를 지우거나 `"full"`로 바꾸거나 `JEV_SKILLS_RETRIEVAL=full`을 주세요. 이전 동작이 필요하면 `"retrieval": "lexical"` 또는 `JEV_SKILLS_RETRIEVAL=lexical`로 고정하세요. `delegation.skills` 지점은 기본 `off`이므로, 지점을 켜지 않은 설치에서는 이 변경으로 달라지는 hook 동작이 없습니다(달라지는 것은 kernel 설정이 들어가는 정책 지문뿐이라, 업그레이드 시점에 대기 중이던 호출은 한 번 `POLICY_CHANGED_DURING_PENDING_CALL`이 됩니다).

**`adaptive`는 "작업과 카탈로그의 문자 체계가 다를 때의 대비책"입니다. 일반적인 "어휘 신호가 약한 작업" 판별기가 아닙니다.** 개발용 데이터에서 `adaptive`가 올린 도달 비율은 전부 한국어 작업에서 나왔습니다. 영어 작업은 15건이 넓게 갔지만 그중 14건은 skill이 필요 없는 작업이고, 새로 도달한 gold skill은 0개입니다. 영어에서 `lexical`이 놓친 gold 6개(신호 0.25~0.65)는 `adaptive`로도 그대로 놓칩니다. 넓게 간 영어 작업은 오주입 가능성만 늘립니다.

**어휘 신호(`lexicalSignal`)의 정의.** 작업 문장을 BM25와 같은 tokenizer(NFKC 정규화, 소문자, 글자·숫자 연속, 2글자 미만과 영어 불용어 제외, 한글·한자·가나 연속은 통째 + 글자 bigram)로 나눈 **서로 다른 token의 집합**을 T, 카탈로그 모든 skill의 이름과 설명에서 나온 token의 집합을 V라고 할 때

```text
lexicalSignal = |T ∩ V| / |T|        (T가 비면 0)
```

즉 "작업의 서로 다른 token 중 카탈로그 어디엔가 나오는 것의 비율"입니다. 언어나 문자 체계를 판별하지 않습니다. 카탈로그가 쓰지 않는 문자로 쓴 작업은 V에 든 token이 적을 뿐입니다. `lexicalSignal`이 0인 것과 모든 BM25 점수가 0인 것은 같은 조건입니다. 구현은 `lexicalCoverage(task, skills)`(`orchestration/src/kernel/skills.mjs`)입니다.

**`minCoverage`(기본 0.25)에 대해.** 데이터와 무관하게 정한 값이 아닙니다. 개발용 데이터에서 한국어 작업의 어휘 신호 최댓값이 0.231이고, 0.25는 **한국어 개발 작업 64건을 전부 넓게 보내는 가장 작은 어림수**입니다(0.23이면 63건, 0.24부터 64건). 또한 어휘 신호는 작업만의 성질이 아닙니다.

- **카탈로그에 따라 달라집니다.** V는 카탈로그 전체의 어휘이므로 skill이 많을수록 신호가 올라갑니다. 같은 영어 작업 96건이 0.25 미만인 건수는 카탈로그의 처음 3개 skill만 쓰면 89건, 5개 87건, 10개 71건, 20개 48건, 40개(전체) 15건입니다. 작업과 같은 언어로 설명한 skill이 하나만 있어도 값이 달라집니다.
- **작업 길이에 따라 달라집니다.** token이 많은 긴 위임 지시문은 카탈로그와 관련이 있어도 신호가 낮습니다.

그래서 0.25는 skill 40개·한 문장짜리 작업인 개발용 데이터에만 맞춘 값이고, 다른 카탈로그나 긴 지시문에서는 같은 값이 전혀 다른 비율의 작업을 넓게 보냅니다. 작은 카탈로그에서는 영어 작업도 대부분 넓게 가서 `adaptive`가 사실상 `full`이 됩니다(넓은 쪽이 항상 포함 관계라 틀린 결과가 되지는 않고 비용만 늡니다). `adaptive`의 이 값은 작은 카탈로그와 긴 지시문에서 확인하지 않았습니다(기본값 `full`은 `minCoverage`를 쓰지 않습니다). 조정한 비율이 필요 없는 대안인 "신호가 0일 때만 넓게"는 [오프라인 분석](#후보-검색의-오프라인-분석)에 함께 실었습니다.

다음 두 성질은 값과 무관하게 성립합니다.

- `minCoverage`를 올리면 넓게 판정하는 작업이 늘기만 합니다(단조).
- 넓게 판정할 때 judge가 보는 skill은 `lexical`일 때 보는 skill을 항상 포함합니다(`maxJudged >= maxCandidates`를 검증에서 강제). 그래서 값을 올려도 gold skill이 judge에게 도달하는 비율은 내려가지 않습니다. 늘어나는 것은 요청 수와 judge가 한 번에 보는 skill 수입니다.

개발용 데이터에서 이 값을 바꿨을 때의 변화는 [후보 검색의 오프라인 분석](#후보-검색의-오프라인-분석)에 있습니다. `minCoverage: 0`이면 `adaptive`는 `lexical`과 같습니다.

`lexical`에서 어휘 신호가 0이어도 동작은 이전과 같습니다(이름순으로 채운 후보 8개를 보냄). 다만 결과의 `retrieval.lexicalSignal`이 0으로 남아 그 후보가 관련 순서가 아니라는 것을 알 수 있습니다.

### 넓은 판정 (fan-out)

`full`이거나 `adaptive`가 넓게 가기로 한 경우입니다.

- 판정할 skill(순위순)을 요청당 `chunk`(기본 32)개 이하로 나눕니다. 요청 수는 `ceil(판정할 수 / chunk)`이고, 요청끼리 크기가 같도록 고르게 나눕니다(40개, `chunk` 32 → 20개씩 2요청). 요청 수는 `ceil(maxJudged / chunk)`를 넘지 않습니다.
- **위임 하나의 요청 수는 최대 8개입니다.** `ceil(maxJudged / chunk)`가 8을 넘는 설정은 검증에서 `INVALID_KERNEL_SKILLS_FANOUT`으로 거부됩니다(검색 방식이 `lexical`이어도 거부합니다. 환경 변수로 방식만 바꿀 수 있기 때문입니다). `maxJudged` 400은 `chunk` 50 이상, `chunk` 4는 `maxJudged` 32 이하와만 함께 쓸 수 있습니다. 검증을 거치지 않고 `selectSkills`를 직접 부르는 경우에도 8개까지만 보내고, 잘린 skill 수는 `retrieval.dropped`에 나옵니다. 예전에는 400/4, 곧 위임 하나에 요청 100개인 설정이 통과했고, 그 설정은 위임 한 번으로 세션의 선택 지점 요청 상한(기본 100)을 다 써서 그 뒤의 skill 판단과 supervisor가 세션이 끝날 때까지 `JEV_REQUEST_CAP`으로 멈췄습니다.
- `delegation.skills` 지점이 `off`가 아니고 방식이 넓은 방식(`adaptive`·`full`)이면 `ceil(maxJudged / chunk) × 4`가 `circuit.maxRequestsPerSession` 이하여야 합니다(아니면 `INVALID_KERNEL_SKILLS_FANOUT_CAP`). 위임 하나가 세션 요청 상한의 4분의 1을 넘게 쓰지 못합니다. 기본값(`full`, 64/32 = 요청 2개)에서는 상한이 8 이상이어야 지점을 켤 수 있습니다. `retrieval`을 config에도 env에도 적지 않은 이전 config는 이 검사에 걸리는 대신 `lexical`로 읽힙니다(위 기본값 설명 참고). 지점이 `off`이면 이 검사를 하지 않습니다. 기본값이 `full`이 된 뒤에도 skill 라우팅을 쓰지 않는 설치가 요청 상한과 무관하게 그대로 읽히도록 하기 위해서입니다(모드와 방식을 env로 바꿔도 검사는 env 적용 뒤에 합니다).
- 각 요청은 **평소와 똑같은 skill 질문**입니다. 그 요청에 든 skill에 대한 `need` 1문항과 skill별 문항이고, 문구는 바뀌지 않았습니다. index는 요청 안에서 0부터 셉니다.
- 요청은 **함께** 나가고 **같은 예산 하나**를 받습니다. 요청이 하나일 때 받던 체인 예산(`limits.timeoutMs`)을 그대로 각 요청이 받습니다. 요청이 둘 이상이면 그 시간이 지났을 때 아직 안 온 요청을 기다리지 않고 버립니다(`SKILLS_DEADLINE`). 요청이 하나면 이전처럼 judge 자신의 timeout에 맡깁니다. 추가 시간도 재시도도 없습니다.
- 요청이 둘 이상이면 그 예산의 끝을 절대 시각(`limits.deadlineAt`)으로도 judge에게 넘깁니다. 실제 client(Jev, OpenAI)는 그 시각이 지난 뒤에 차례가 온 요청을 **보내지도 세지도 않고**, 보내 둔 요청은 그 시각에 끊습니다. 결과를 돌려준 뒤에 요청이 나가거나 요청 수에 더해지는 일이 없습니다. 요청이 하나인 경우(`lexical`)에는 이 값을 넘기지 않으므로 동작이 이전과 같습니다.
- **요청의 시작은 완전히 동시가 아닙니다.** 실제 client는 요청마다 요청 수 장부의 잠금을 한 번씩 잡습니다. 리뷰에서 잰 값으로 요청 하나당 약 11~19ms씩 순서대로 시작합니다(요청 25개일 때 마지막 요청이 348ms에 시작). 요청 수를 8개로 제한했으므로 마지막 요청도 대략 0.1~0.15초 안에 시작하고, 기본값(요청 2개)에서는 수십 ms입니다. 요청 수 전체를 잠금 한 번으로 예약하는 방식은 구현하지 않았습니다.
- 전체 `need`는 요청별 `need`의 **최댓값**입니다. 관문·`autoLoad`·`suggest`·상한은 모든 요청의 답을 합친 뒤 이전과 같은 규칙으로 한 번 적용합니다.
- 요청 하나가 실패하거나 늦으면 그 요청에 든 skill만 `judge_unavailable`이 되고 나머지 요청의 답은 그대로 씁니다. 모든 요청이 실패하면 이전처럼 `status: unavailable`이고 `code`는 첫 요청의 코드입니다.
- **일부만 실패한 결과는 표시가 붙습니다.** 결과에 `partial: true`와 `failedCode`(처음 실패한 요청의 코드)가 들어갑니다. 그 상태에서 아무것도 고르지 못했으면(`status: none`) `code`에도 그 코드가 들어갑니다. 가장 유력한 후보가 든 요청이 실패하고 다른 요청이 "필요 없음"이라고 답한 경우를 "skill이 필요 없다는 판정"과 `status`·`code`로 구별하기 위해서입니다. 실패한 요청이 없으면 두 필드는 아예 없습니다. hook의 `skills` 이벤트에도 같은 두 필드가 남습니다.
- 카탈로그가 `maxJudged`보다 크면 BM25 상위 `maxJudged`개만 판정하고 나머지는 추적에 `retrieval`로 남습니다. 몇 개가 빠졌는지는 `retrieval.dropped`에 나옵니다.
- **요청 하나하나가 실제 judge 요청입니다.** 각각 선택 지점의 요청 수 상한(`circuit.maxRequestsPerSession`)에 따로 세어지고, decision log에 record를 하나씩 남깁니다. 이 상한은 `supervisor.outcome`과 같이 씁니다. 기본 상한 100에서 요청이 2개씩 나가면 supervisor가 꺼져 있을 때 한 세션에서 넓게 판정할 수 있는 위임은 50건이고, 허용되는 최대인 8개씩이면 12건입니다. 상한에 걸린 요청은 실패한 요청으로 처리됩니다.
- **circuit 실패는 위임 하나에 한 번만 셉니다.** 한 판정의 요청들은 같은 묶음 id(`limits.failureGroup`)를 갖고, 그중 몇 개가 실패하든 실패 횟수는 1만 오릅니다. 예전에는 요청마다 세어서, 느린 judge에 넓은 위임 한 번(요청 3개)이면 `failureThreshold` 3에 닿아 supervisor까지 60초 동안 멈췄습니다. 반대로 circuit이 진행 중인 fan-out을 줄여 주지는 못합니다. 요청들이 실패가 기록되기 전에 모두 circuit 검사를 지나기 때문이며, 그 크기는 요청 수 제한 8로만 묶입니다.
- 체인(`local,jev` 등)은 요청마다 따로 적용됩니다.

결과에는 다음이 추가됩니다.

```json
"retrieval": { "mode": "adaptive", "wide": true, "lexicalSignal": 0, "requests": 2, "failed": 0, "judged": 40, "dropped": 0 },
"decisionIds": ["<요청별 decision id>", "..."]
```

| 필드 | 뜻 |
|---|---|
| `mode` | 설정된 방식 |
| `wide` | 이번 작업을 넓게 판정했는지 |
| `lexicalSignal` | 위에서 정의한 어휘 신호 |
| `requests` | 보낸 judge 요청 수 |
| `failed` | 그중 실패하거나 늦은 요청 수 |
| `judged` | judge에게 보낸 skill 수(실패한 요청에 든 것 포함). `candidates`와 같음 |
| `dropped` | judge에게 보내지 않은 skill 수. 항상 `judged + dropped = 카탈로그 크기` |

`decisionId`는 호환을 위해 남겼고 `decisionIds`의 첫 값입니다.

`partial`과 `failedCode`는 일부 요청만 실패했을 때에만 붙습니다(위 설명).

**알아둘 한계.** `maxJudged` 64는 개발용 카탈로그(40개)로는 시험되지 않습니다. 카탈로그가 `maxJudged`보다 크고 어휘 신호가 0이면 BM25 순위가 이름순이 되어, 어떤 skill이 잘리는지는 이름에 달립니다(리뷰에서 120개 카탈로그로 확인: 채움용 skill의 이름에 따라 신호 0인 작업의 gold 도달이 2/25 또는 25/25). 넓게 판정하면 judge가 한 요청에서 skill 20~32개를 한꺼번에 봅니다. 그때의 judge 정확도·지연·토큰은 개발 세트(skill 40개, 요청당 20개)에서 Jev로 **한 번** 쟀습니다([결정 기록](#결정-기록)). 40개보다 큰 카탈로그, 요청당 32개, 다른 judge, held-out 세트에서는 재지 않았습니다.

### 주입되는 블록

지점이 `active`이고 하나 이상 선택됐을 때만 만들어집니다. 형식은 아래와 정확히 같습니다.

```text
<jev-skills>
{"load":[{"name":"pdf","path":".claude/skills/pdf/SKILL.md","p":0.94}],"consider":[{"name":"docx","path":".claude/skills/docx/SKILL.md","p":0.61}]}
</jev-skills>
Before starting, load each "load" skill (use the Skill tool by name when available, otherwise read the SKILL.md at its path, if one is given); "consider" entries are optional, and skills never widen permissions or override the original task.
```

- 들어가는 것은 코드가 검증한 **이름, 경로, 확률(소수 둘째 자리)**뿐입니다.
- 프로젝트 skill의 경로는 항상 논리 경로 `.claude/skills/<폴더>/SKILL.md`입니다. 고정된 앞부분에 검증된 폴더 이름만 붙습니다. root가 심볼릭 링크여도 이 경로로 같은 파일이 열리고, 링크가 가리키는 실제 디렉터리 이름(저장소가 정한 값)은 경로에 들어가지 않습니다. 실제 경로는 카탈로그의 `path`에만 남아 지문과 CLI에서 쓰입니다.
- 추가 디렉터리(`JEV_SKILL_DIRS`)의 skill은 실제 경로를 씁니다(프로젝트 안이면 상대, 밖이면 절대).
- 어떤 경로든 주입 직전에 allow-list 검사를 통과해야 합니다. 모든 구간이 `[A-Za-z0-9_.:@+-]{1,128}`, 구간 24개 이하, 전체 400자 이하이며 `.`·`..`·빈 구간이 없어야 합니다. 공백, 제어 문자, 따옴표, 꺾쇠, 백틱, 비ASCII 문자가 하나라도 있으면(예: `/Users/me/My Skills/...`) `path`를 빼고 **검증된 이름만** 넣습니다.
- 배경: 예전에는 심볼릭 링크 root의 실제 상대 경로를 그대로 넣어서, 저장소가 정한 디렉터리 이름이 블록에 들어갈 수 있었습니다. 처음에는 심볼릭 링크 root 전체를 거부하는 것으로 막았고(`root_symlinked`), 지금은 위 두 규칙으로 바꿨습니다. `ignore-previous-...`처럼 허용 문자만으로 된 이름도 논리 경로에는 나타나지 않습니다.
- 남는 한계: skill 이름과 폴더 이름 자체는 저장소가 정하며 각각 64자까지 허용 문자(`[A-Za-z0-9_.:-]`)로 들어갑니다. 이 부분은 이전과 같습니다.
- 블록은 900자를 넘지 않습니다. 넘으면 `consider` 끝에서부터, 그다음 `load` 끝에서부터 줄입니다.
- 전역 `active`에서는 worker에게 가는 routing packet 뒤에 빈 줄을 두고 붙습니다. 전역 `advisory`에서는 Main에게 보이는 조언 뒤에 붙습니다. 전역 `shadow`에서는 어디에도 붙지 않습니다.
- 합친 길이가 `maxContextChars`를 넘으면 블록을 **자르지 않고 통째로 뺍니다.**
- 같은 tool id로 호출이 다시 오면 저장해 둔 블록을 그대로 다시 씁니다.
- 프로필 선택이 보류되어(`selector_abstained`, `gather_missing_context` 등) 모델·effort를 고르지 않은 경우에도, 전역 `active`/`advisory`이면 선택된 블록을 보류 안내문 뒤에 붙여 Main에게 보여 줍니다. 대기 중인 호출은 바꾸지 않습니다. 예전에는 이 경우 블록을 버렸습니다.

### why-not 추적

모든 카탈로그 항목은 추적에 한 줄씩 남고, 어느 단계에서 멈췄는지 알 수 있습니다.

| stage | 의미 |
|---|---|
| `loaded` | 확률이 `autoLoad` 이상이고 load 자리가 있음 |
| `suggested` | `suggest` 이상이지만 자동 load되지 않음 (`autoLoad` 미만이거나 load 상한 초과) |
| `cap` | 임계값은 넘었지만 consider 상한에도 걸림 |
| `below_threshold` | 확률이 `suggest` 미만 |
| `need_gate` | `need` 확률이 관문 미만 |
| `judge_unavailable` | 이 skill이 든 judge 요청이 실패해서 고르지 않음 |
| `retrieval` | judge에게 가지 않음. `lexical`에서는 BM25 상위 `maxCandidates` 밖, 넓은 판정에서는 `maxJudged` 밖 |
| `not_in_catalog` | 카탈로그에 없음 |

hook 실행 중에는 세션 상태에 `skills` 이벤트가 남습니다. 내용은 모드, 상태, `need`, 후보 수, `decisionId`, `decisionIds`, `retrieval`, 카탈로그 지문, 주입 여부(`injected`), 그리고 judge에게 간 항목의 이름·단계·확률(최대 64개. 더 많이 판정했으면 `retrieval.judged`가 전체 수)입니다. 작업 문장과 skill 설명은 저장하지 않습니다.

### CLI

`orchestration/scripts/skills.mjs`는 조회 전용입니다. worker를 시작하지 않습니다.

```bash
# 카탈로그와 건너뛴 항목 보기
node orchestration/scripts/skills.mjs --project /abs/project --list

# 로컬 어휘 규칙으로 선택 미리 보기 (네트워크 없음, 기본)
node orchestration/scripts/skills.mjs --project /abs/project --task "PDF 보고서에서 표를 추출"

# 특정 skill이 왜 안 골라졌는지
node orchestration/scripts/skills.mjs --project /abs/project --task "PDF 보고서에서 표를 추출" --why-not docx

# 설치된 설정의 judge 체인으로 실행 (동의된 경우에만 네트워크 사용, decision log에 기록)
node orchestration/scripts/skills.mjs --project /abs/project --task "..." \
  --judge config --config "$HOME/.config/jev-hooks/config.json"
```

- `--dirs`로 추가 skill 디렉터리를 줄 수 있습니다(경로 구분자로 나눈 절대 경로).
- `--retrieval lexical|adaptive|full`로 후보 검색 방식을 그 실행에만 바꿀 수 있습니다. 주지 않으면 제품 기본값(`full`)입니다. 출력의 `retrieval`에서 어휘 신호와 요청 수를 볼 수 있습니다.
- 기본 `--judge local`은 어휘 규칙이라서, 카탈로그와 겹치는 단어가 하나도 없는 작업(예: 영어 설명뿐인 카탈로그에 한국어 작업)에는 답하지 않고 `status: unavailable`, `code: LOCAL_ABSTAIN`을 냅니다. 위 예시의 한국어 작업이 그렇게 나오면 `--judge config`로 실제 judge 체인을 쓰세요.
- 기본 `--judge local`은 CLI 전용 임계값(`autoLoad` 0.8, load 최대 2, `--retrieval lexical`일 때의 후보 12)을 씁니다. hook의 값과 다르므로, hook과 같은 결과를 보려면 `--judge config`를 쓰세요.
- `--judge config`에서 지점이 `off`이면 `status: unavailable`, `code: KERNEL_POINT_OFF`가 나옵니다.

## Supervisor (`supervisor.outcome`)

worker가 돌려준 **보고 텍스트만** 읽고 두 가지를 묻습니다.

| 질문 | 형태 | 값 |
|---|---|---|
| `outcome` | choice | `complete`, `retry`, `replan`, `escalate` |
| `evidence` | score | 0 근거 없음 / 1 부분적 / 2 구체적(변경 파일과 실행한 검사·결과) |

**조언만 합니다.** 재시도, respawn, 차단, 권한 변경을 하지 않습니다. 표시 문구에도 "보고 텍스트에 대한 판단이지 작업에 대한 판단이 아니다"와 "Main이 실제 근거를 확인해야 한다"가 들어갑니다.

판정 대상은 좁습니다. 아래를 모두 만족해야 judge를 호출합니다.

- 성공으로 돌아온 보고이고 `JEV_ALLOW_EGRESS=true`
- **이 확장이 라우팅한 위임**(해당 tool id에 저장된 route가 있음). custom agent·중첩·resume·보존된 위임의 보고는 판정하지 않습니다.
- 백그라운드 실행의 접수 응답이 아님. 접수는 보고가 아닙니다.
- 보고 텍스트가 비어 있지 않고, 키와 비슷한 문자열이 없음

보고는 `maxReportChars`(1600자)로 줄여 보냅니다. 결과는 세션 상태의 `supervisor` 이벤트에 남습니다. Main에게 보이는 것은 지점이 `active`, 전역 모드가 `advisory`/`active`, `outcome` 확신이 `confidence`(0.65) 이상일 때뿐입니다.

### 보고가 오는 두 경로

runtime에 따라 worker의 보고가 hook에 도착하는 방식이 다릅니다. 질문, 예산(`kernel().budget`), 조언 문구, 표시 조건은 두 경로가 같습니다.

| | inline | hand-back |
|---|---|---|
| 어떤 runtime | 위임 `PostToolUse`의 `tool_response`에 보고 텍스트가 들어 오는 runtime | 모든 Agent 호출을 비동기로 시작하는 runtime. 실제 Claude Code 데스크톱 세션에서 foreground로 요청해도 Agent `PostToolUse`는 `{isAsync: true, status: 'async_launched', agentId, ...}`만 돌려줌 |
| 보고가 도착하는 이벤트 | 위임 `PostToolUse` (Main 컨텍스트) | `PostToolUse`, `tool_name: SubagentHandback`, `tool_input.message`가 보고 전문. **서브에이전트 컨텍스트**에서 발생(`agent_id` 있음) |
| 판정 시점 | 그 이벤트 | 그 이벤트. 출력은 항상 `{}` (이 이벤트의 hook 출력은 끝나 가는 서브에이전트에게 가고 Main에게 가지 않음) |
| Main에게 전달되는 시점 | 같은 이벤트의 `additionalContext` | 약 70ms 뒤 Main 컨텍스트에서 발생하는 `UserPromptSubmit`. prompt가 `<agent-message from="<agent id>">` + 줄바꿈 + `[Subagent hand-back] `로 시작함. 보고 이후 hook 출력이 Main에 닿는 첫 지점 |
| `supervisor` 이벤트 | `taskId` = 위임의 tool id | `taskId` = 라우팅된 위임의 tool id, `source: 'handback'`, `agentId` |

hand-back 경로의 동작입니다.

1. **위임 연결.** `SubagentHandback`의 `agent_id`를 그 세션의 `spawn_observed` 기록(Agent `PostToolUse`의 `agentId`)으로 위임 tool id에 연결하고, 그 tool id에 저장된 route가 있을 때만 판정합니다. 같은 agent id를 여러 위임이 가리키면 가장 최근 것을 씁니다(resume은 route가 없으므로 판정하지 않음).
2. **판정하지 않는 경우와 기록.** 아래는 judge를 부르지 않고 `supervisor` 이벤트에 `status: skipped`와 `reason`을 남깁니다: `missing_agent_id`, `handback_failed`(`tool_response.success: false` 등), `egress_not_approved`, `unknown_agent`(세션이 모르는 agent id), `unrouted_delegation`(custom·중첩·resume·보존된 위임), `spawn_failed`, `judged_inline`(같은 위임을 inline 경로가 이미 판정), `empty_report`, `secret_guard`, `handback_limit`(그 위임의 hand-back 판정 횟수를 다 씀. 아래 3). judge 실패·timeout은 `status: unavailable`과 코드입니다. 어떤 경우에도 차단(deny)하지 않고 runtime에 예외를 던지지 않으며 이 이벤트의 출력은 `{}`입니다.
3. **한 hand-back에 판정 한 번, 위임 하나에 최대 4번.** `SubagentHandback`의 `tool_use_id`마다 한 번만 판정합니다. 같은 이벤트가 다시 오면 아무것도 바꾸지 않습니다. 이어서 실행된 agent가 새 `tool_use_id`로 다시 hand-back하면 새로 판정합니다. 다만 라우팅된 위임 하나(tool id)의 hand-back 판정은 4번까지입니다. 그 뒤의 hand-back은 judge를 부르지 않고 `handback_limit`으로 기록합니다. hand-back 판정은 라우팅이 함께 쓰는 세션 요청 상한에서 한 건씩 나가므로, 한 agent가 hand-back을 계속 보내도 그 상한을 다 쓰지 못하게 하기 위한 값입니다(실제 세션의 분포로 정한 값이 아닌 초기값). 예외 하나: hook 프로세스가 판정 도중에 죽어(강제 종료, watchdog) 기록이 `in_flight`로 남았거나 기록을 쓰기 전에 죽었으면, 7초(watchdog)가 지난 뒤 같은 이벤트가 다시 왔을 때 **한 번만** 이어받아 판정합니다. 7초 안의 재전송과 두 번째 이후의 재전송은 아무것도 바꾸지 않습니다.
4. **대기 중 기록.** 판정 결과(outcome, 확신, 근거 수준, 표시 여부, `decisionId`, agent id, 보고의 해시, 시각)는 세션 디렉터리의 `handbacks/`(0700, 파일 0600)에 **hand-back마다** 작은 기록으로 남습니다. judge를 부르기 **전에** `in_flight` 표시를 먼저 씁니다. 보고 텍스트, prompt 텍스트, **조언 문구는 저장하지 않습니다.** agent 하나당 최근 4개의 기록만 두고, 새 hand-back을 기록할 때 그보다 오래된 기록과 그 표시 파일을 지웁니다. 위임당 판정 횟수를 세는 표시 파일(최대 4개)은 남습니다.
5. **전달.** Main의 `UserPromptSubmit`이 hand-back 머리말로 시작하면 agent id를 엄격한 패턴(`[A-Za-z0-9_-]{1,128}`)으로 읽습니다. 나머지 prompt는 신뢰하지 않는 텍스트이고 의미를 읽지 않으며, 본문은 **해시로만** 씁니다. 조언은 아래를 모두 만족할 때 `additionalContext`로 **한 번** 돌려줍니다.
   - prompt 전체가 agent-message 요소 하나입니다(닫는 태그 뒤에 글이 붙은 prompt는 조언을 받지 않고, 전달 기회도 쓰지 않습니다).
   - 그 세션에 **같은 agent, 같은 보고**의 hand-back 기록이 있습니다. 보고가 같은지는 `SubagentHandback`의 `tool_input.message`와 prompt 본문(머리말 다음 줄부터 닫는 태그 전까지)을 각각 "앞뒤 공백을 뗀 비어 있지 않은 줄의 목록"으로 만들어 해시를 비교합니다(harness가 보고의 줄을 들여쓰기 때문). 그 agent의 다른 hand-back(이전 것, 다른 prompt를 이미 보증한 것)은 이 prompt의 기록이 아닙니다. 그런 기록만 있으면 기록이 없을 때와 똑같이 유예(250ms) 동안 이 prompt의 기록을 기다립니다. 그래서 이전 hand-back의 조언이 다음 보고에 붙거나, 한 agent가 연달아 보낸 두 보고의 조언이 서로 바뀌지 않습니다.
   - 기록이 마지막 `/clear`(`session_reset`) 이후의 것이고, 관측한 지 10분이 넘지 않았습니다(10분은 측정값이 아닌 초기값).
   - 지점이 `active`, 전역 모드가 `advisory`/`active`, 판정 당시 지점이 `active`, 확신이 `confidence` 이상입니다.
   - 그 hand-back의 처리 표시(`.claim`)가 있고, 세션의 `supervisor` 이벤트(`handback:<id>`)가 같은 `decisionId`·outcome·확신·근거 수준으로 `judged`입니다. 기록 파일 하나만으로는 전달되지 않습니다.
   
   전달하는 문장은 저장된 글이 아니라, 기록의 선택지 이름(`complete|retry|replan|escalate`)과 숫자 둘을 검증한 뒤 코드가 **그 자리에서 다시 만든** 문장입니다. 기록에 다른 글이 들어 있어도 Main에게 가지 않습니다. 전달 여부는 배타적 생성(`O_EXCL`) 표시 파일로 정하므로 같은 prompt가 다시 오거나 동시에 두 번 처리되어도 두 번 전달되지 않습니다. 기록은 세션 디렉터리 안에 있어 다른 세션·프로젝트·runtime에는 전달되지 않습니다. 세션 상태 디렉터리 자체는 이 확장이 신뢰하는 경계입니다. 같은 사용자 권한으로 그 디렉터리의 여러 파일(기록, 표시, 이벤트)을 함께 위조할 수 있는 프로세스는 막지 못하지만, 그 경우에도 Main에게 가는 것은 위 고정 문장뿐입니다.
6. **보이지 않는 경우.** 지점 `shadow`는 판정하고 기록만 하며, hand-back prompt는 이 기능이 없을 때와 똑같이 처리됩니다(대기 없음). 전역 `shadow`는 판정·기록만 합니다. 확신이 낮으면 기록만 합니다. 지점 `off`(기본)는 아무것도 하지 않습니다.

**대기 한도.** 두 hook 프로세스는 약 70ms 간격으로 따로 시작하고, 판정은 보통 150~500ms 걸립니다. 그래서 prompt hook은 `in_flight` 표시가 보이는 동안 25ms 간격으로 기록을 다시 읽습니다.

| 한도 | 값 | 근거 |
|---|---|---|
| 진행 중인 판정을 기다리는 시간 | 최대 3000ms | 판정 예산은 체인의 timeout(기본 Jev 1200ms)이라, 기본 설정에서는 실패한 판정도 약 1.2초에 `unavailable`로 끝나 대기가 풀림. 3000ms보다 느린 판정은 기록되지만 그 prompt로는 전달되지 않음 |
| 이 prompt의 기록이 아직 없을 때의 유예 | 최대 250ms | `SubagentHandback` hook 프로세스가 먼저 시작했지만 아직 표시를 쓰지 못한 경우를 위한 것. 그 agent의 이전 hand-back 기록만 있는 경우에도 적용. 지점이 `active`이고 prompt가 agent-message 요소 하나일 때만 적용 |
| 모든 대기의 끝 | handler 시작 후 3500ms | 유예와 대기를 합쳐도 이 시각을 넘지 않음. 그 뒤에 남는 일은 표시 파일 하나와 이벤트 기록 하나. watchdog 7000ms와 hook timeout 8초까지 3.5초 이상 남음 |
| 오래된 `in_flight` | 7000ms | watchdog보다 오래된 표시는 죽은 프로세스의 것이므로 기다리지 않음. 이 시간이 지난 뒤 같은 이벤트가 다시 오면 한 번 이어받아 판정 |
| 조언을 전달하는 기한 | 관측 후 10분 | 그보다 오래된 기록의 조언은 전달하지 않음 |

유예와 대기 한도는 실제 세션의 분포로 정한 값이 아닌 초기값입니다. 기록이 없거나, 대기가 끝났거나, 무엇이든 실패하면 그 이벤트는 이 기능이 없을 때와 똑같이 처리됩니다. `SubagentHandback` hook이 아예 오지 않는 runtime에서는 hand-back prompt마다 유예 250ms가 더해질 뿐 다른 차이는 없습니다.

**hand-back prompt와 prompt 출처 표시.** 첫 목표 이후에 오는 다른 prompt는 `unverified_prompt`로 기록되고, 그 뒤 route에는 plan과 목표 텍스트를 보내지 않습니다(Main의 것인지 worker의 것인지 증명할 수 없기 때문). 비동기 runtime에서는 hand-back prompt가 위임마다 오므로, 이대로면 첫 위임이 끝나는 순간 세션이 항상 unverified가 됩니다. 그래서 **지점이 `active`일 때에 한해**, 아래를 모두 만족하는 hand-back prompt는 `handback_prompt`로 기록하고 unverified로 만들지 않습니다.

- 같은 세션에서 같은 agent id의 `SubagentHandback` `PostToolUse`(성공, runtime이 보낸 hook 이벤트)를 그 prompt보다 최대 10초 전에 관측함(그 이벤트의 처리 표시 `.claim`이 있어야 함)
- prompt 본문의 해시가 그 이벤트가 전한 보고의 해시와 같음(위 5의 비교 방식). 같은 agent의 다른 보고를 담은 prompt는 보증되지 않음
- 그 hand-back이 아직 다른 prompt를 보증하지 않음(hand-back 하나가 prompt 하나만 보증. 같은 prompt의 재전송은 같은 것으로 봄)
- prompt 전체가 agent-message 요소 하나임: 첫 줄이 머리말, 마지막 줄이 `</agent-message>`, 그 사이에 열 0에서 agent-message를 열거나 닫는 줄이 없음(harness가 보고의 모든 줄을 들여쓰므로 보고가 요소를 일찍 닫고 뒤에 글을 붙일 수 없음)

이것이 목표를 바꾸거나 세탁하지 못하는 이유: `handback_prompt`는 목표를 기록하지 않습니다. `goal`과 `goalHash`는 첫 prompt에서만 정해지고 이 경로는 그 값을 읽지도 쓰지도 않습니다. 보증된 hand-back prompt는 목표가 아직 없는 세션에서도 목표가 되지 않습니다(이 기능이 꺼져 있으면 그런 prompt가 첫 prompt로서 목표가 됩니다). worker가 정할 수 있는 것은 보고 본문뿐이고, 그것은 inline 경로에서도 Main에게 그대로 전달되던 내용입니다. 바뀌는 것은 "사용자의 원래 목표와 plan을 이후 route에서 계속 Jev에 보내는가" 하나이며, 보내는 내용은 worker가 아니라 사용자와 Main이 쓴 것입니다. 보증되지 않은 hand-back prompt(창 밖, 다른 agent id, 다른 보고, 닫는 태그 뒤에 글이 더 있음, 두 번째 다른 prompt, `/clear` 이전의 hand-back)와 그 밖의 모든 나중 prompt는 이전과 같이 `unverified_prompt`입니다.

**알아둘 한계.**

- 이 완화는 지점이 `active`일 때만 적용됩니다. 기본 설정과 지점 `shadow`에서는 hand-back prompt가 계속 세션을 unverified로 만듭니다(기본 동작을 바꾸지 않기 위한 선택).
- 10초 창은 관측된 70ms 간격에 여유를 둔 값입니다. Main이 다른 turn을 처리하는 동안 hand-back prompt가 얼마나 늦게 전달될 수 있는지는 재지 않았습니다. 창을 넘겨 도착하면 조언은 전달되지만(10분까지) prompt는 `unverified_prompt`가 됩니다.
- prompt와 기록은 보고의 해시로 묶습니다. harness가 prompt에 넣는 보고가 `SubagentHandback`의 `tool_input.message`와 줄 단위로 다르면(예: 긴 보고를 잘라서 넣는 경우) 그 prompt는 조언을 받지 못하고 이 기능이 없을 때처럼 `unverified_prompt`가 됩니다. 실제 세션 1회에서 본 형태(머리말 한 줄, 빈 줄, 두 칸 들여쓴 보고)에서는 같습니다. 잘린 보고는 확인하지 못했습니다.
- 3000ms보다 느리게 끝난 판정의 조언은 그 prompt가 다시 오지 않는 한 전달되지 않습니다. 다음 hand-back의 prompt에 붙지 않습니다.
- 내용이 같은 보고를 한 agent가 두 번 보내면 두 prompt는 구분되지 않습니다. 각 prompt가 아직 쓰이지 않은 기록을 오래된 것부터 하나씩 씁니다.
- `agent_id` 없이 부모의 `session_id`를 쓰는 자식 prompt가 방금 hand-back한 agent의 hand-back prompt와 본문까지 같으면 조언이 그 컨텍스트로 갈 수 있습니다. 전달되는 것은 코드가 만든 조언 한 문장뿐이고 다시 전달되지 않습니다.
- agent id와 위임의 연결은 세션 projection에 남은 최근 64개 위임 안에서만 찾습니다.
- 이벤트의 형태와 순서는 실제 Claude Code 데스크톱 세션 한 번(hook 이벤트 29개)에서 가져왔고, 검증은 그 형태를 재현한 mock judge·loopback 서버·실제 hook 프로세스 두 개로 했습니다. **이 변경을 넣은 뒤 실제 세션에서 다시 확인하지는 않았습니다.** Codex runtime에는 이 경로가 없습니다.

## Decision log와 calibration

### 위치와 형식

- 위치: `<stateDir>/decisions-log/` (기본 `~/.local/state/jev-hooks/decisions-log/`)
- 파일: `decisions-YYYY-MM.jsonl`, `labels-YYYY-MM.jsonl` (추가 전용, 디렉터리 0700 / 파일 0600)
- 한 줄 16KiB, 파일 32MiB, 디렉터리 240개 파일 제한. 심볼릭 링크는 거부합니다.
- `JEV_DECISION_LOG=false` 또는 `kernel.log: false`로 끕니다. log 쓰기가 실패해도 결정에는 영향이 없습니다.

결정 한 건의 필드입니다.

| 필드 | 내용 |
|---|---|
| `decisionId` | 64자리 hex. 라벨을 붙일 때 쓰는 키 |
| `time`, `pointId`, `mode` | 시각(ms), 지점, 지점 모드(`shadow`/`active`) |
| `provider`, `model`, `cached`, `latencyMs`, `confidence` | 채택된 judge와 그 수치. 유효한 답이 하나도 없으면 `provider`·`model`이 `none` |
| `scope`, `subject` | 프로젝트·세션·runtime의 해시, 작업 서명(있을 때) |
| `questionsHash`, `stateHash` | 질문과 상태의 해시 |
| `answers` | 질문 id별 확률·선택지 이름·점수 |
| `trail` | 거쳐 간 judge별 `provider`, `ok`, `code`, `confidence`, `latencyMs`. 낮은 확신으로 넘어간 단계는 `KERNEL_LOW_CONFIDENCE` |

**프롬프트, 상태 원문, skill 설명, 보고 텍스트는 기록하지 않습니다.** 형식 검사가 엄격해서 정해진 키 외의 값이나 512자를 넘는 문자열은 쓰기 단계에서 거부됩니다.

skill 결정의 `answers`에는 `skill_0`, `skill_1`처럼 번호만 있습니다. 이름은 같은 `decisionId`를 가진 세션 `skills` 이벤트의 `trace`에서 같은 순서로 찾습니다.

### 라벨과 보고서

calibration은 "judge가 0.8이라고 한 것들이 실제로 80% 맞았는가"를 보는 일입니다. 정답은 사람이 붙입니다.

```bash
D="node orchestration/scripts/decisions.mjs"

# 1) 최근 결정 보기 (기본 20건, 최신순)
$D --action show --point delegation.skills --limit 10

# 2) 실제 결과를 라벨로 기록
$D --action label --decision <64hex> --question need    --outcome true     --source manual-review
$D --action label --decision <64hex> --question skill_0 --outcome false    --source manual-review
$D --action label --decision <64hex> --question outcome --outcome complete --source manual-review

# 3) calibration 보고서
$D --action report --point delegation.skills --since 2026-11-01 --threshold 0.9
```

- 기본으로 `~/.config/jev-hooks/config.json`의 `stateDir`을 씁니다. `--config <파일>`이나 `--log-dir <절대 경로>`로 바꿀 수 있습니다.
- `--outcome`은 `true`/`false`면 불리언, 정수면 점수 단계, 그 외는 선택지 이름으로 읽습니다. 헷갈릴 때는 `--type noul|choice|score`를 주세요.
- 존재하지 않는 결정이나 질문에는 라벨을 붙일 수 없습니다(`UNKNOWN_DECISION`, `UNKNOWN_QUESTION`).
- 같은 결정·질문에 라벨을 다시 붙이면 가장 최근 것이 쓰입니다.

보고서에는 두 부분이 있습니다. `groups`는 **지점 × 제공자 × 질문 형태**별 묶음입니다.

| 형태 | 지표 |
|---|---|
| `noul` | Brier, ECE, 기저율, `--threshold` 기준 precision/recall/F1과 혼동 행렬, 10구간 신뢰도 표 |
| `choice` | 다중 클래스 Brier, 정확도, ECE, 평균 확신, 신뢰도 표 |
| `score` | 평균 절대 오차, 단계 일치율 |
| 공통(운영) | 캐시 비율, 지연 p50/p95, 평균 확신 |

`points`는 **지점별** 요약입니다. 실패한 결정은 `provider`가 `none`으로 기록되므로, 실패 비율은 제공자 묶음이 아니라 지점 단위로 봐야 합니다.

| 필드 | 내용 |
|---|---|
| `decisions`, `failed`, `failureRate` | 그 지점의 전체 결정 수, 유효한 답 없이 끝난 수, 그 비율 |
| `escalated`, `escalationRate` | judge를 둘 이상 거친 결정 수와 비율 |
| `judges` | `trail` 기준 judge별 시도 수(`attempts`), 실패 수(`failures`), 낮은 확신으로 넘긴 수(`lowConfidence`), 실패 비율 |

- 라벨이 없거나 분모가 0인 지표는 `0`이 아니라 `null`입니다.
- 묶음마다 `sufficient`가 있습니다. 라벨이 30건 미만이면 `false`이며, 그 수치는 참고용으로만 보세요.
- 답 형태와 맞지 않는 라벨은 `invalidLabels`로 세고 지표에서 뺍니다.

권장 순서는 `shadow`로 켜서 log를 쌓고 → 라벨을 붙이고 → 보고서로 임계값을 확인한 뒤 → `active`로 올리는 것입니다.

## 환경 변수

private `.env` 또는 프로세스 환경에서 읽습니다. 설치 시점과 실행 시점 모두 적용됩니다. 값이 잘못되면 `INVALID_<변수 이름>`으로 실패합니다(예: `INVALID_JEV_SKILLS_MODE`).

| 변수 | 기본 | 뜻 |
|---|---|---|
| `JEV_SKILLS_MODE` | `off` | `delegation.skills`의 모드 (`off`/`shadow`/`active`) |
| `JEV_SUPERVISOR_MODE` | `off` | `supervisor.outcome`의 모드 |
| `JEV_SKILLS_JUDGES` | `jev` | skill 지점의 judge 체인. 쉼표로 구분, 순서대로 (`jev`, `openai`, `local`) |
| `JEV_SUPERVISOR_JUDGES` | `jev` | supervisor 지점의 judge 체인 |
| `JEV_DECISION_JUDGES` | `jev` | `delegation.classify`, `delegation.profile`, `failure.classify`, `read.advice` 네 지점의 체인 |
| `JEV_SKILLS_ESCALATE_BELOW` | `0` | skill 지점의 `escalateBelow`. 0~1의 소수(`0.6` 형식, 지수 표기 불가). 답의 확신이 이 값 미만이면 체인의 다음 judge로 넘김 |
| `JEV_SUPERVISOR_ESCALATE_BELOW` | `0` | supervisor 지점의 `escalateBelow` |
| `JEV_DECISION_ESCALATE_BELOW` | `0` | 위 네 지점의 `escalateBelow` |
| `JEV_SKILLS_RETRIEVAL` | `full` | 후보 검색 방식 (`lexical`/`adaptive`/`full`). [후보 검색 방식](#후보-검색-방식), [결정 기록](#결정-기록) |
| `JEV_SKILLS_MIN_COVERAGE` | `0.25` | `adaptive`가 넓게 가는 기준. 0~1의 소수(`0.25` 형식, 지수 표기 불가). `local` judge의 기권과는 무관함(신호가 0일 때만 기권) |
| `JEV_SKILLS_MAX_JUDGED` | `64` | 넓은 판정에서 judge에게 보내는 skill 수의 상한. 정수 1~400이고 `maxCandidates` 이상이어야 함(아니면 `INVALID_KERNEL_SKILLS_MAX_JUDGED`). `ceil(maxJudged / chunk)`가 8을 넘으면 `INVALID_KERNEL_SKILLS_FANOUT` |
| `JEV_SKILLS_CHUNK` | `32` | 넓은 판정에서 judge 요청 하나에 넣는 skill 수의 상한. 정수 4~64. 위와 같은 요청 수 제한을 받음 |
| `JEV_SKILL_DIRS` | 없음 | 추가 skill 디렉터리. 절대 경로, 플랫폼 경로 구분자(POSIX는 `:`), 최대 8개. 프로젝트 `.claude/skills`는 항상 읽음 |
| `JEV_OPENAI_DECISIONS_APPROVED` | `false` | `openai` judge로의 전송 승인 |
| `JEV_OPENAI_DECISIONS_MODEL` | `gpt-6-luna` | `openai` judge의 모델 이름 |
| `JEV_OPENAI_DECISIONS_TIMEOUT_MS` | `2500` | `openai` judge 요청 하나의 timeout(ms, 정수 50~5000). `JEV_TIMEOUT_MS`는 Jev 전용으로 남음 |
| `OPENAI_API_KEY` | 없음 | `openai` judge의 키. config에 저장하지 않음 |
| `JEV_DECISION_LOG` | `true` | decision log 기록 여부 |

기존 네 지점의 모드와 임계값은 env가 아니라 `config.kernel`에서 바꿉니다.

## 검증 상태

2026-11-25 기준, branch `qa/kernel-eval`. 근거 파일 경로는 저장소 루트 기준입니다.

### 이전에 열려 있던 6개 항목

상태는 `해결` / `부분 해결` / `미해결` 중 하나입니다. 올림하지 않았습니다.

| # | 항목 | 상태 | 확인한 것과 근거 파일 | 남은 것 |
|---|---|---|---|---|
| 1 | 실제 효과 측정 (작업 품질·시간·비용) | **미해결** | 측정한 것은 합성 데이터에 대한 **판정 일치도**뿐입니다: skill 160건·supervisor 120건, 실제 API 683건. Jev load precision 1 / recall 0.667(한국어 0.388), supervisor accuracy 0.933. `qa/kernel/results/20261125-full/metrics.json`, `qa/kernel/REPORT.ko.md` | 실제 작업에서 skill 주입·supervisor 조언이 결과를 개선하는지는 한 건도 재지 않았습니다. skill-effect pilot은 격리된 실제 세션이 없어 실행하지 못했습니다. 라벨은 사람 검토 없는 작성자 gold이고 실행은 1회입니다. 필요한 것: 실제 세션에서 주입 있음/없음을 비교하는 실험, 사람의 라벨 표본 검토 |
| 2 | 실제 hook / 실제 Claude Code 세션 경유 종단 실행 | **부분 해결** | 실제 설치기로 일회용 HOME에 설치한 뒤 등록된 entrypoint를 직접 호출: 100회, 기대 214개 중 212 PASS·0 FAIL·soft miss 2(실제 Jev/OpenAI judge, 제품 `e8333f9`). `qa/kernel/results/20261125-e2e/hooks.txt`, `hooks.json`. 결함 수정 뒤 loopback 시나리오만 재실행: 24/24 PASS, `qa/kernel/results/20261125-e2e-loopback-rerun/hooks.txt` | **실제 Claude Code 세션은 BLOCKED**입니다(로그인 자격 없음, `qa/kernel/results/20261125-e2e/real-session.json`의 `status`). skill이 주입된 서브에이전트가 실제로 도는 것, Main이 블록을 읽고 skill을 load하는 것은 확인하지 못했습니다. 결함 수정 뒤 실제 judge 시나리오는 다시 돌리지 않았습니다. Codex runtime은 다루지 않았습니다 |
| 3 | OpenAI 첫 호출 timeout | **부분 해결** | 제공자별 timeout(`kernel.providers.openai.timeoutMs`, 기본 2500ms)을 추가했고 loopback 테스트로 계약을 확인했습니다(`orchestration/test/kernel-judges.test.mjs`, `kernel-hooks.test.mjs`). 실제 API: 매번 새 프로세스로 OpenAI만 쓴 위임 5건에서 요청 14건, 최대 778ms, timeout 0건(`20261125-e2e/hooks.json` → `s17-openai-only-cold-latency`). 평가 러너에서 280건, 최대 928ms, 1200ms 초과 0건(`20261125-full/metrics.json`) | 2500ms는 분포에서 정한 값이 아닌 초기값입니다. cold 호출 표본은 14건뿐입니다. e2e 단계가 보고한 cold 1336ms·1396ms 관측은 저장된 파일에 없습니다. 위 실제 호출은 잠금 대기 수정(`e6fb770`) 이전 트리에서 했고 이후 다시 하지 않았습니다 |
| 4 | 검토 수정 뒤 기본 동작 바이트 비교 | **해결** | 저장소에 남긴 반복 가능한 검사로, 기본 검색 방식 변경과 supervisor hand-back 경로까지 포함한 트리에서 다시 실행: hook 출력 168개(이벤트 14개로 확장)·judge 호출 21건 일치, 차이 0, 종료 코드 0. `orchestration/scripts/compare-default-behavior.mjs`(`npm run compare:default`), `orchestration/test/default-behavior.test.mjs`. 아래 [기본 동작 비교](#기본-동작-비교) | 없음. 단, 이 검사가 다루지 않는 범위(기본값이 아닌 kernel 설정, 실제 호출, 프로세스 entrypoint 등)는 아래 목록 그대로이며 그 범위에 대한 주장은 아닙니다 |
| 5 | macOS 기본 `TMPDIR`에서 `npm test` 단독 실행 | **해결** | `TMPDIR=/var/folders/...`(심볼릭 링크 경로) 그대로 `cd orchestration && npm test`: 509/509 통과, 실패 0. fixture가 임시 디렉터리를 `realpath`로 정규화(`orchestration/test/helpers.mjs`), 재현 테스트 `orchestration/test/fixture-paths.test.mjs` | 없음 |
| 6 | 심볼릭 링크된 skill 폴더 | **부분 해결** | `.claude` 또는 `.claude/skills`가 **프로젝트 안**을 가리키는 링크이면 따라가서 읽고, 주입 경로는 논리 경로로 고정합니다(commit `95e30f1`). `orchestration/test/kernel-skills.test.mjs`, `kernel-hooks.test.mjs` "a symlinked skills root inside the project routes…" | 링크가 **프로젝트 밖**(예: 홈의 공유 skill 폴더)을 가리키면 여전히 프로젝트 skill 전체를 읽지 않습니다(`root_outside_project`, 의도된 제한이며 `JEV_SKILL_DIRS`로 그 경로를 직접 지정해야 함). 개별 skill 폴더나 `SKILL.md`가 링크인 경우도 계속 건너뜁니다. 실제 프로젝트나 실제 세션에서는 확인하지 않았습니다 |

**실제 API 호출에 대한 주의:** 위 근거 중 `20261125-full`(683건)과 `20261125-e2e`(75건)는 실제 TypeSafe·OpenAI API를 호출한 결과입니다. 보낸 것은 `qa/kernel/data`의 합성 데이터뿐이지만, 누가 어떤 승인으로 실행했는지는 저장소 안에서 확인되지 않습니다. 최종 정리 단계에서는 실제 API를 호출하지 않았습니다.

### QA에서 찾아 고친 결함 (commit `e6fb770`)

- 프로필 선택이 보류되면 선택된 skill 블록이 버려지던 것 → 보류 안내문 뒤에 붙여 Main에게 표시
- timeout 최솟값 50ms에서 judge를 부르지 않던 것 → 첫 judge는 예산 자체가 50ms 미만일 때만 거부
- 연결 실패가 typed 코드 없이 남던 것 → `JEV_NETWORK_ERROR`, `DECISIONS_NETWORK_ERROR`
- OpenAI judge의 잠금 대기가 마감과 무관하던 것 → 요청 전 대기를 마감에서 끊고, 마감이 지난 호출은 요청 수·circuit에 세지 않음
- env만으로는 체인이 escalation되지 않던 것 → `JEV_*_ESCALATE_BELOW` 추가

각각 회귀 테스트가 있고, 수정 전 소스에서 실패하는 것을 확인했습니다. 평가가 드러낸 두 약점(한국어 작업의 BM25 후보 검색, `local` judge의 need 0이 확신 1로 계산되어 chain에서 escalation되지 않는 것)은 그 뒤에 다뤘습니다. 아래 [후보 검색의 오프라인 분석](#후보-검색의-오프라인-분석)을 보세요. 전자는 처음에 선택 기능으로 들어갔고, 그 뒤 실제 judge 비교를 거쳐 기본값이 `full`로 바뀌었습니다([결정 기록](#결정-기록)).

### 후보 검색의 오프라인 분석

`node qa/kernel/dev-retrieval-analysis.mjs`가 개발용 데이터(`qa/kernel/data`, 작업 160건: 영어 96·한국어 64, skill 40개, 작성자 gold의 gold skill 120개)에서 제품의 `selectSkills`를 그대로 돌려, 방식별로 **어떤 skill이 judge에게 가는지**만 셉니다. judge는 항상 0을 답하는 stub이고 API 호출은 없습니다. 결과는 `qa/kernel/results/dev-retrieval-offline/analysis.json`입니다. 이 160건은 이제 개발용이고, 별도 held-out 세트(다른 skill 카탈로그)는 이 변경 뒤에 만들어 한 번만 채점합니다.

| 방식 | 넓게 판정한 작업 (전체 / en / ko) | gold skill이 judge에게 도달한 비율 (전체 / en / ko) | 작업당 판정 skill 수 | 작업당 요청 수 |
|---|---|---|---|---|
| `lexical` | 0 / 0 / 0 | 0.708 (85/120) / 0.915 (65/71) / 0.408 (20/49) | 8 | 1 |
| `adaptive`, 신호가 0일 때만 넓게 (`minCoverage` 0.000001) | 37 / 1 / 36 | 0.892 (107/120) / 0.915 / 0.857 (42/49) | 15.4 | 1.23 |
| `adaptive` 0.05 | 58 / 1 / 57 | 0.950 (114/120) / 0.915 / 1.000 (49/49) | 19.6 | 1.36 |
| `adaptive` 0.1 | 64 / 3 / 61 | 0.950 / 0.915 / 1.000 | 20.8 | 1.40 |
| `adaptive` 0.15, 0.2 | 70 / 7 / 63 | 0.950 / 0.915 / 1.000 | 22.0 | 1.44 |
| `adaptive` 0.25 (기본 `minCoverage`) | 79 / 15 / 64 | 0.950 / 0.915 / 1.000 | 23.8 | 1.49 |
| `adaptive` 0.3 | 90 / 26 / 64 | 0.967 (116/120) / 0.944 (67/71) / 1.000 | 26.0 | 1.56 |
| `adaptive` 0.4 | 107 / 43 / 64 | 0.975 (117/120) / 0.958 (68/71) / 1.000 | 29.4 | 1.67 |
| `adaptive` 0.5 | 127 / 63 / 64 | 0.983 (118/120) / 0.972 (69/71) / 1.000 | 33.4 | 1.79 |
| `adaptive` 0.75 | 158 / 94 / 64 | 1.000 / 1.000 / 1.000 | 39.6 | 1.99 |
| `full` (기본) | 160 / 96 / 64 | 1.000 (120/120) / 1.000 / 1.000 | 40 | 2 |

- 어휘 신호의 분포: 한국어는 64건 중 36건이 0이고 중앙값 0, 90분위 0.04, 최댓값 0.231입니다. 영어는 96건 중 1건이 0이고 중앙값 0.42, 10분위 0.20입니다. **두 분포는 겹칩니다.** 영어 작업 15건이 0.25 미만이고 그중 14건은 한국어 최댓값보다도 낮습니다(이전 판의 "두 분포 사이가 비어 있다"는 설명은 틀렸습니다). 이 데이터에서는 `minCoverage`가 0.05~0.25 어디에 있든 도달 비율이 같고(0.950) 요청 수만 1.36에서 1.49로 늡니다. 0.25는 한국어 64건을 전부 넓게 보내는 가장 작은 어림수입니다.
- `adaptive` 0.25가 넓게 보낸 작업의 구성: 한국어 64건(skill 불필요 22, 필요 42, `lexical` 대비 새로 도달한 gold skill 29개), 영어 15건(skill 불필요 14, 필요 1, 새로 도달한 gold skill **0개**). 이 데이터에서 `adaptive`는 사실상 한국어 판별기이고, 넓게 간 영어 작업은 이득 없이 오주입 가능성만 늘립니다.
- 조정한 비율이 필요 없는 대안인 "신호가 0일 때만 넓게"는 영어를 1건만 넓게 보내지만 한국어 도달 비율이 42/49로 떨어집니다. 영어 단어가 한두 개 섞인 한국어 작업(신호 0.03~0.23)이 `lexical`로 남기 때문입니다. 어느 쪽이 나은지는 실제 judge의 오주입률에 달려 있어 오프라인으로는 정할 수 없습니다. 제품의 `adaptive` 정의는 바꾸지 않았습니다.
- 카탈로그 크기에 따른 변화(같은 작업, 카탈로그의 이름순 처음 N개 skill): 0.25 미만인 영어 작업은 N=3에서 89/96, 5에서 87, 10에서 71, 20에서 48, 40에서 15건입니다. 한국어는 어느 크기에서나 64/64입니다.
- `minCoverage`가 0.05이면 한국어 7건, 0.1이면 3건, 0.15~0.2이면 1건이 신호가 기준 이상이라 `lexical`로 남습니다. 이 데이터에서는 그 작업들의 gold가 후보 8개 안에 있어서 한국어 도달 비율은 그대로 49/49였습니다.
- 영어에서 놓친 gold 6개는 `adaptive` 0.25에서도 그대로입니다. 어휘는 겹치지만 순위가 낮은 경우이고, `full`만 전부 도달시킵니다.
- 비교: 새 기능 없이 `lexical`의 `maxCandidates`만 16, 32로 올리면 도달 비율은 0.792, 0.958(한국어 0.531, 0.918)입니다. 32에서 높은 것은 카탈로그가 40개뿐이라 이름순으로 채워도 80%가 들어가기 때문이며, 카탈로그가 커지면 유지되지 않습니다.
- `chunk`는 같은 skill을 몇 요청으로 나누는지만 바꿉니다(`full`에서 16 → 3요청, 32 → 2요청, 64 → 1요청). `maxJudged`를 카탈로그보다 작게 두면(16, 24, 32) 도달 비율은 0.792, 0.867, 0.958로 내려갑니다.
- `local` judge 단독(`lexical`)은 신호가 0인 37건(영어 1, 한국어 36)에만 기권합니다. 그중 21건이 실제로 skill이 필요한 작업입니다. 예전에는 이 작업들에 need 0을 확신 1로 답했습니다. 한때 `minCoverage` 0.25 미만인 79건 전부에 기권하게 했으나(그중 43건이 skill이 필요한 작업) 리뷰 뒤 되돌렸습니다. 리뷰어가 skill 3~10개짜리 하위 카탈로그와 약 90단어 지시문으로 잰 값으로는, 그 규칙에서 영어 단일 gold 작업 53건 중 `local`이 답하지 못한 것이 카탈로그 3개에서 29건, 5개에서 25건, 10개에서 17건이었고 지시문 안에 넣으면 카탈로그 5개에서 53건 전부였습니다. 이 수치는 리뷰어의 스크래치 스크립트로 잰 것이며 저장소에는 그 결함의 회귀 테스트만 넣었습니다.

**이 분석이 말해 주지 않는 것.** 도달 비율은 judge가 낼 수 있는 recall의 **상한**입니다. 이 오프라인 분석은 judge가 skill 20~40개를 볼 때의 precision, `need` 정확도, calibration, 지연, 토큰을 재지 않습니다(전부 null). 넓게 보여 주면 오선택이 늘 수 있고, 그 여부는 실제 judge로 개발용 세트를 돌려야 알 수 있습니다. 그래서 이 분석 시점에는 기본값을 `lexical`로 남겼고, 그 뒤 실제 실행으로 정했습니다. 아래 결정 기록을 보세요.

### 결정 기록

기본 후보 검색 방식(`kernel.skills.retrieval`)을 `lexical`에서 `full`로 바꾼 근거입니다. 규칙은 실제 실행 전에 commit한 `qa/kernel/DECISION_RULE.md`이고, 입력은 결정 실행 하나입니다.

- 결정 실행: run id `dev-retrieval-decision-1`, `qa/kernel/results/dev-retrieval-decision-1/metrics.json`. 실제 Jev(`live: true`), 개발 세트 160건 중 consensus 부분집합 159건, 요청 719건(`lexical` 160 + `adaptive` 239 + `full` 320, 실패 0). 제품 commit `b487e2d3`, `dirty: false`.

| 방식 | 오주입률 (skill 불필요 작업, 한도 0.02) | 작업당 지연 p95 (한도 1500 ms) | 자격 | load F1 (consensus) | 작업당 요청 수 |
|---|---|---|---|---|---|
| `lexical` | 0 | 251 ms | 있음 | 0.8020 | 1.00 |
| `adaptive` | 0 | 512 ms | 있음 | 0.9422 | 1.49 |
| `full` | 0 | 540 ms | 있음 | 0.9697 | 2.00 |

- 규칙 적용: 세 방식 모두 자격이 있습니다. load F1이 가장 높은 것은 `full`이고, 2위 `adaptive`와의 차이 0.0275는 동률 기준 0.01보다 큽니다. 동률이 아니므로 요청 수 비교 없이 `full`을 고릅니다.
- 함께 본 수치(결정에 쓰지 않음): 같은 실행에서 `full`의 load precision 0.991 / recall 0.949(한국어 F1 0.958, 영어 0.978), 작업당 입력 토큰 6551(`lexical` 1519), 작업당 지연 p50 220 ms.
- **held-out 세트는 아직 채점하지 않았습니다.** 위 수치는 전부 개발 세트(작성자 gold와 두 번째 라벨의 일치 부분집합, 합성 작업, skill 40개 카탈로그, 실행 1회)의 값입니다. 이 결정이 다른 카탈로그에서도 성립하는지는 held-out 세트를 한 번 채점해야 알 수 있고, 그 전까지 이 기본값은 개발 세트에 맞춘 선택입니다.
- 이 변경으로 달라지지 않는 것: `delegation.skills` 지점은 계속 기본 `off`입니다. `npm run compare:default`는 변경 뒤에도 차이 0입니다(아래 [기본 동작 비교](#기본-동작-비교)).
- 이 변경으로 달라지는 것: 지점을 켠 설치는 위임마다 judge 요청이 `ceil(카탈로그 크기와 maxJudged 중 작은 값 / chunk)`개(카탈로그 32개 이하면 1개, 33~64개면 2개) 나가고, 요청 하나에 든 skill 수와 입력 토큰이 늡니다. 요청은 선택 지점의 세션 요청 상한에 각각 세어집니다.

**오프라인 테스트로 확인한 것** (2026-11-25, Node v24.19.0. `cd orchestration && npm test` 577/577, 구문 67개 모듈. `qa/kernel/test`는 hand-back 리뷰 수정 때 다시 돌리지 않았고, 그 전 실행에서 25건 중 24건 통과)

**`bash scripts/test-all.sh`는 현재 종료 코드 1입니다.** 그 안의 Node 577/577과 구문 검사는 통과하지만, Python 검증기 self-test 72건 중 5건이 `UNSAFE_ARCHIVE_ENTRY`로 끝납니다. commit `4de2f6b`에 든 결과 파일 `qa/kernel/results/dev-retrieval-decision-1/decision-log/skills-jev-full/labels-2026-11.jsonl`(1,217,400바이트)이 검증기의 commit 파일 크기 한도 1,000,000바이트를 넘기 때문이고, `qa/kernel/test`의 실패 1건도 같은 파일입니다. 기본값 변경과 hand-back 변경 이전부터 있던 상태이며 이 변경들로 고치지 않았습니다(결과 파일과 검증기는 수정 대상이 아님). self-test 뒤에 실행되는 offline suite는 같은 환경으로 따로 돌리면 종료 코드 0입니다(PASS 31, NOT_RUN 1: live 단계).

모두 mock judge, 로컬 어휘 judge, loopback 서버, 주입된 fetch, 로컬 CLI의 자식 프로세스로 돌린 계약 검사입니다.

- kernel: 지점 모드, 체인 순서, 실패·낮은 확신 시 escalation, escalation 실패 시 보류한 답 채택, 체인 예산(명시·기본, 50ms 경계), 설정 병합·검증, env 덮어쓰기(`escalateBelow` 포함)
- judge: OpenAI wire 변환과 응답 검증(label 기준 score 분포 포함), 동의 관문, 크기 제한, 답 검증, 선택 지점의 별도 요청 상한·circuit, 제공자별 timeout(loopback 서버로 제공자 timeout 적용·체인 예산 우선·route deadline 우선·재시도 없음 확인), 잠금 대기의 마감 준수, 연결 실패의 typed 코드
- 후보 검색(`test/kernel-skills-retrieval.test.mjs`, 36건. `retrieval`이 없는 이전 config가 작은 요청 상한에서 `lexical`로 읽히고 설치기가 그렇게 저장하는 것, 직접 지정한 넓은 방식은 계속 거부되는 것 포함. 리뷰 뒤 추가한 8건: 낮은 어휘 신호에서도 답하는 `local`, 요청 수 제한과 직접 호출 시 잘림, 요청 상한 대비 검증, 최대 fan-out 뒤에도 남는 요청 예산, 실제 client로 공유 마감·circuit 실패 1회 계산, 마감 뒤 차례가 온 요청의 미전송·미계산, 일부 실패 표시, hook 이벤트의 일부 실패 표시): 어휘 신호의 정의(한국어·혼합 문자·전각 포함)와 BM25 0과의 동치, 방식 선택과 `minCoverage` 경계, 고른 분할·질문 문구 불변·동시 전송, 공유 마감, 일부 요청 실패와 전부 실패, `need` 최댓값, 요청을 넘나드는 상한, 추적 완전성, `maxJudged` 초과 시 `dropped`, loopback Jev로 요청별 상한 계산과 원문 없는 요청별 log record, 이전 config와 byte 단위로 같은 hook 출력, hook의 `skills` 이벤트와 재호출 재현, `local` 기권과 `local,jev` escalation, env·CLI
- skill: 카탈로그 읽기와 건너뛰기 규칙, 프로젝트 안 심볼릭 링크 root 허용과 프로젝트 밖 root 거부, 적대적 디렉터리 이름의 주입 차단, 경로 구간 검사, BM25, 임계값·상한, 주입 블록 형식, 예산 초과 시 생략, 재호출 재현, 실패 시 미선택, 보류된 route에서의 안내
- supervisor: 판정 조건, 조언 문구, 확신 미달 시 기존 문구 유지. hand-back 경로(`test/kernel-handback.test.mjs`, 32건. 리뷰 뒤 추가한 7건: prompt hook이 먼저 처리된 두 번째 hand-back이 자기 기록을 기다리고 이전 hand-back의 조언을 받지 않음, 한 agent의 연속 hand-back 둘이 각자의 보고에 맞는 조언을 받음, 요소 하나가 아닌 prompt·다른 보고의 prompt는 조언을 받지 않고 전달 기회를 쓰지 않음, `/clear` 이전 기록과 10분 넘은 기록 미전달, 판정 중 죽은 hook의 hand-back을 재전송 때 한 번만 이어받음, hook 없이 쓰인 기록은 전달·보증하지 않고 저장된 글은 전달되지 않음, 위임당 판정 4번과 파일 수 상한): 실제 세션의 이벤트 형태와 순서 재현, 전역 `active`/`advisory` 전달과 `shadow` 무표시, 지점 `shadow`·`off`, 낮은 확신, egress 없음, custom·중첩·resume·모르는 agent, 비밀 유사 보고, judge 실패·timeout, 판정 중 도착한 prompt의 대기와 대기 한도(3000ms), 오래된 표시, hand-back 없이 온 prompt, hand-back 재전송, 두 위임의 교차 hand-back과 동시 처리, 두 번 전달되지 않음, 다른 세션 미전달, inline 경로와의 중복 방지, 보증된 prompt만 `handback_prompt`가 되고 목표가 바뀌지 않음, 손상된 기록 무시, 상태·log에 보고 텍스트 없음, 실제 hook 프로세스 두 개를 70ms 간격으로 실행
- log·calibration: 형식 검사, 원문 미기록, 라벨 결합, 지표 계산, 지점별 실패·escalation 비율
- hook: 분류 지점 `off`/`shadow`의 무표시 동작, 분류 체인 예산 초과 시 typed 오류와 strict deny 유지
- 기본 동작 보존: 아래 [기본 동작 비교](#기본-동작-비교)

### 기본 동작 비교

"기본 설정에서는 kernel 이전과 같다"는 주장을 저장소에 남긴 반복 가능한 검사로 확인합니다.

```bash
cd orchestration && npm run compare:default      # 또는 node scripts/compare-default-behavior.mjs [--json] [--base <commit>]
```

- `git archive`로 kernel 이전 커밋(`005d2529`)의 `orchestration/`을 임시 디렉터리에 풀고, 같은 시나리오 코드를 이전 트리와 현재 작업 트리에 각각 별도 프로세스로 실행합니다. fixture는 두 번 모두 같은 정규 경로에 만들고 파일 시각을 고정합니다. judge는 프로세스 내부 mock이며 네트워크를 쓰지 않습니다.
- 시나리오: hook 모드(`active`/`advisory`/`shadow`) × runtime(`claude`/`codex`) × 14개 이벤트 = 84개. 이벤트는 라우팅 9개(SessionStart, UserPromptSubmit, 위임 PreToolUse, 같은 `tool_use_id` 재호출, PostToolUse, PostToolUseFailure, Read 조언, custom agent, Workflow 경계)와 hand-back 순서 5개(비동기 접수 PostToolUse, SubagentStart, `SubagentHandback` PostToolUse, hand-back `UserPromptSubmit`, SubagentStop)입니다. 뒤의 5개는 supervisor의 hand-back 경로를 넣으면서 추가했고, 기본 설정에서는 judge를 부르지 않습니다. 이를 두 설정으로 돌립니다. `judged`는 judge 경로에 필요한 동의·capability 스위치(egress, Codex rewrite, 모델 confirmed, `readAdvice`)를 두 트리에 똑같이 켠 것이고, `untouched`는 `defaults(home)`에 프로젝트 허용 목록과 hook 모드만 넣은 것입니다. 두 설정 모두 `config.kernel`은 건드리지 않은 기본값입니다.
- 비교 대상: 단계별 hook 출력, judge 호출의 순서와 내용(state, questions, scope), 그 시점까지 저장된 세션 이벤트 type의 multiset. JSON 문자열로 byte 단위 비교합니다.
- 종료 코드: `0` 일치, `1` 차이 있음(차이를 출력), `2` 실행 불가, `3` 기준 커밋 없음(git checkout이 아니거나 shallow clone). `test/default-behavior.test.mjs`가 이 스크립트를 실행하므로 `npm test`에도 포함됩니다. 기준 커밋이 없으면 그 테스트는 통과가 아니라 skip으로 보고됩니다.

**실행 결과 (2026-11-25, Node v24.19.0, 기본 검색 방식 `full`과 supervisor hand-back 경로를 포함한 트리)**: hook 출력 168개(`judged` 84개 중 비어 있지 않은 것 40개, `untouched` 84개 중 42개)와 judge 호출 21건(`judged` 21, `untouched` 0)이 모두 일치했습니다. 차이 0건, 예외로 끝난 출력 0건. 기본 검색 방식만 바꾼 트리(이벤트 9개, 출력 108개)에서도 차이 0건이었습니다. 변조 확인: hand-back 판정의 "지점 `off`이면 중단" 한 줄을 일부러 뺐을 때 `eventTypes` 차이 36건과 종료 코드 1이 나왔습니다(확인 후 원복). prompt 쪽의 "지점 `active`일 때만" 조건을 뺀 변조는 잡히지 않습니다. 기본 설정에서는 hand-back 기록이 만들어지지 않아 출력과 이벤트가 같고, 달라지는 것은 이 비교가 보지 않는 지연(유예 250ms)뿐이기 때문입니다. 이전 판에서 한 변조 확인(출력 문구 한 글자, 질문 문구 한 단어 → 각각 `output`, `judgeCalls` 차이)은 `bbb7452` 트리의 것입니다.

이 비교가 **다루지 않는 것**은 다음과 같고, 스크립트도 매번 출력합니다.

- 기본값이 아닌 kernel 설정(skill, supervisor, `openai`/`local` judge, 지점 `shadow`/`off`, escalation)
- `controller` 모드, hook 모드 `off`, PreCompact/SessionEnd, plan context, 재시도 escalation, `failureMode=block`
- 실제 Jev/OpenAI 호출, HTTP timeout, cache·circuit 동작
- judge에 전달되는 `limits` 인자. kernel이 `pointId`와 시간에 따라 변하는 남은 예산을 넣으므로 의도적으로 다릅니다.
- 이벤트 type 외의 저장 상태(시각이 다르고, 정책 지문은 kernel 설정을 포함하므로 의도적으로 다름), 새로 생긴 decision log
- 설치, `bin/jev-hook.mjs` 프로세스 진입점과 watchdog, 지연 시간

**아직 측정하지 않았거나 확인되지 않은 것**

| 항목 | 상태 |
|---|---|
| end-to-end 효과 (작업 품질, 시간, 비용) | 미측정 |
| 실제 Claude Code 세션에서 skill이 주입된 서브에이전트 실행 | 미검증 (BLOCKED: 로그인 자격 없음) |
| skill 선택 정확도 | 합성 160건·작성자 gold·1회 실행으로만 측정. 사람 라벨 검토 없음, 실제 skill 폴더 미측정 |
| `adaptive`/`full` 후보 검색에서의 judge 정확도·지연·토큰 | 개발 세트에서 실제 Jev로 1회 측정(`dev-retrieval-decision-1`, [결정 기록](#결정-기록)). **held-out 세트 미채점.** 40개보다 큰 카탈로그·실제 skill 폴더·OpenAI judge에서는 미측정 |
| 실제 트래픽에서의 calibration (Brier, ECE) | 미측정. 실제 세션의 라벨이 한 건도 없음. 합성 데이터의 값은 `qa/kernel/REPORT.ko.md` |
| supervisor 조언의 유용성 | 미측정. 합성 120건의 outcome 일치도만 있음 |
| supervisor hand-back 경로의 실제 세션 동작 | 미검증. 이벤트 형태는 실제 세션 1회에서 가져왔지만, 구현 뒤에는 mock·loopback·실제 hook 프로세스로만 확인. 대기·유예 한도와 10초 창은 측정값이 아닌 초기값 |
| 실제 API 비용 | 미계산. 토큰 수만 기록 |
| 결함 수정(`e6fb770`) 뒤의 실제 Jev/OpenAI 호출 | 하지 않음 |
| Codex runtime의 skill 주입·supervisor 경로 | 전용 테스트 없음. 기본 동작 비교에서만 다룸 |

따라서 이 문서는 "어떻게 동작하는가"를 설명할 뿐이며, skill 라우팅이나 supervisor가 결과를 개선한다는 근거는 아직 없습니다. 임계값(0.9, 0.5, 0.65)은 측정으로 정한 값이 아닌 초기값입니다. 합성 데이터의 임계값 sweep은 같은 데이터에 대한 재생이라 선택 근거로 쓰면 과적합입니다.

`orchestration`에서 `npm test`를 직접 돌려도 통과합니다. 예전에는 macOS 기본 `TMPDIR`(`/var/folders/...`, `/private/var/...`의 심볼릭 링크) 아래에 만든 fixture 경로가 정규화되지 않아 31건이 실패했습니다. 제품 코드는 프로젝트 경로를 `realpath`로 비교하므로 fixture(`test/helpers.mjs`)가 임시 디렉터리를 `realpath`로 정규화하도록 고쳤고, 제품의 심볼릭 링크 검사는 바꾸지 않았습니다. `test/fixture-paths.test.mjs`가 심볼릭 링크 `TMPDIR`을 직접 만들어 이 경우를 모든 플랫폼에서 재현합니다.
