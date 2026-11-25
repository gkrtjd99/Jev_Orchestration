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
| `supervisor.outcome` | **off** | worker 보고의 분류(`complete`/`retry`/`replan`/`escalate`)와 근거 수준 | 위임 `PostToolUse` (성공 응답) |
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
- 요청 수 상한(`circuit.maxRequestsPerSession`)과 circuit은 `delegation.skills`·`supervisor.outcome`이 나머지 네 지점과 **따로** 셉니다. 선택 지점을 켜도 라우팅의 요청 예산을 쓰지 않습니다. 대신 두 지점을 켜면 세션당 요청 수의 상한은 최대 두 배가 됩니다.
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
- hook 전체 한도와의 관계: 위임 `PreToolUse`는 분류와 프로필 선택이 `routeDeadlineMs`(최대 5500ms) 하나를 나눠 쓰고, 그 외 이벤트는 hook 한 번에 체인 하나만 실행하며 그 예산은 최대 5000ms입니다. 둘 다 `bin/jev-hook.mjs`의 watchdog(7000ms)과 설치된 hook timeout(8초)보다 짧습니다.

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
    "skills": { "dirs": [], "maxCandidates": 8, "need": 0.5, "autoLoad": 0.9, "suggest": 0.5, "maxLoaded": 3, "maxSuggested": 3 },
    "supervisor": { "maxReportChars": 1600, "confidence": 0.65 }
  }
}
```

위 예시에서 `delegation.skills`만 기본값과 다릅니다. 로컬 규칙이 먼저 답하고, 확신이 0.6 미만이면 Jev에게 넘깁니다. `escalateBelow`는 config 또는 env(`JEV_SKILLS_ESCALATE_BELOW` 등, [환경 변수](#환경-변수))로 설정합니다. 체인만 `local,jev`로 바꾸고 `escalateBelow`를 0으로 두면 `local`이 답하는 한 Jev를 부르지 않습니다. kernel 설정을 바꾸면 정책 지문이 달라져 대기 중이던 호출은 `POLICY_CHANGED_DURING_PENDING_CALL`로 무효화됩니다.

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
- OpenAI judge는 **실제 API로 확인하지 않았습니다.** wire 계약과 기본 모델 이름 `gpt-6-luna`는 미확인입니다. [검증 상태](#검증-상태)를 보세요.

## Skill 라우팅 (`delegation.skills`)

### 왜 위임 경계에서 고르나

skill을 Main에게 "이걸 써 보세요"라고 추천하면 두 가지 문제가 생깁니다. Main의 컨텍스트에 모든 skill 설명이 올라가고, 실제로 일하는 worker에게 전달될지는 Main의 재량에 달립니다. 반면 위임 경계에서는 **작업 내용이 한 건으로 확정되어 있고**, 그 일을 할 worker가 정해져 있습니다. 그래서 여기서 고르면 다음이 가능합니다.

- 필요한 worker의 brief에만, 필요한 skill 이름만 들어갑니다.
- 선택 근거가 결정 단위로 기록되어 나중에 "왜 안 골랐나"를 답할 수 있습니다.
- Main이 skill 명령을 직접 호출할 필요가 없습니다.

### 파이프라인

```text
카탈로그 → BM25 후보 → judge → 임계값 → (active일 때) brief에 블록 주입
```

| 단계 | 하는 일 |
|---|---|
| 카탈로그 | 프로젝트 `.claude/skills/<폴더>/SKILL.md`와 `JEV_SKILL_DIRS`를 읽음. frontmatter의 `name`, `description`만 사용 |
| BM25 후보 | 작업 문장과 이름(가중치 3)·설명의 어휘 일치로 순위를 매겨 상위 `maxCandidates`(8)개 선택. 한글·한자·가나는 글자 bigram도 사용 |
| judge | `need`(skill이 필요한 작업인가) 1문항 + 후보별 `skill_N`(직접 적용 가능한가) 문항. 모두 `noul` |
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

- judge 실패·timeout·잘못된 답이면 **아무 skill도 고르지 않습니다**(`status: unavailable`). 라우팅 자체는 계속됩니다.
- skill 작업은 `routeDeadlineMs`에서 강제로 끊깁니다(`SKILLS_DEADLINE`). 라우팅을 그 이상 늦추지 않습니다.
- `maxTaskChars`를 넘는 작업은 분류도 하지 않으므로 skill 라우팅도 건너뜁니다.
- skill 설명과 본문은 신뢰하지 않는 데이터입니다. judge에게 상태로만 보내고 brief에는 넣지 않습니다.

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
| `judge_unavailable` | judge 실패로 아무것도 고르지 않음 |
| `retrieval` | BM25 후보에 들지 못해 judge에게 가지 않음 |
| `not_in_catalog` | 카탈로그에 없음 |

hook 실행 중에는 세션 상태에 `skills` 이벤트가 남습니다. 내용은 모드, 상태, `need`, 후보 수, `decisionId`, 카탈로그 지문, 주입 여부(`injected`), 그리고 judge에게 간 항목의 이름·단계·확률(최대 32개)입니다. 작업 문장과 skill 설명은 저장하지 않습니다.

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
- 기본 `--judge local`은 CLI 전용 임계값(후보 12, `autoLoad` 0.8, load 최대 2)을 씁니다. hook의 값과 다르므로, hook과 같은 결과를 보려면 `--judge config`를 쓰세요.
- `--judge config`에서 지점이 `off`이면 `status: unavailable`, `code: KERNEL_POINT_OFF`가 나옵니다.

## Supervisor (`supervisor.outcome`)

worker가 돌려준 **보고 텍스트만** 읽고 두 가지를 묻습니다.

| 질문 | 형태 | 값 |
|---|---|---|
| `outcome` | choice | `complete`, `retry`, `replan`, `escalate` |
| `evidence` | score | 0 근거 없음 / 1 부분적 / 2 구체적(변경 파일과 실행한 검사·결과) |

**조언만 합니다.** 재시도, respawn, 차단, 권한 변경을 하지 않습니다. 표시 문구에도 "보고 텍스트에 대한 판단이지 작업에 대한 판단이 아니다"와 "Main이 실제 근거를 확인해야 한다"가 들어갑니다.

판정 대상은 좁습니다. 아래를 모두 만족해야 judge를 호출합니다.

- 성공으로 돌아온 위임 응답이고 `JEV_ALLOW_EGRESS=true`
- **이 확장이 라우팅한 위임**(해당 tool id에 저장된 route가 있음). custom agent·중첩·보존된 위임의 보고는 판정하지 않습니다.
- 백그라운드 실행의 접수 응답이 아님. 접수는 보고가 아닙니다.
- 보고 텍스트가 비어 있지 않고, 키와 비슷한 문자열이 없음

보고는 `maxReportChars`(1600자)로 줄여 보냅니다. 결과는 세션 상태의 `supervisor` 이벤트에 남습니다. Main에게 보이는 것은 지점이 `active`, 전역 모드가 `advisory`/`active`, `outcome` 확신이 `confidence`(0.65) 이상일 때뿐입니다. 그 외에는 기존의 일반 안내 문구가 그대로 나갑니다.

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
| `JEV_SKILL_DIRS` | 없음 | 추가 skill 디렉터리. 절대 경로, 플랫폼 경로 구분자(POSIX는 `:`), 최대 8개. 프로젝트 `.claude/skills`는 항상 읽음 |
| `JEV_OPENAI_DECISIONS_APPROVED` | `false` | `openai` judge로의 전송 승인 |
| `JEV_OPENAI_DECISIONS_MODEL` | `gpt-6-luna` | `openai` judge의 모델 이름 |
| `JEV_OPENAI_DECISIONS_TIMEOUT_MS` | `2500` | `openai` judge 요청 하나의 timeout(ms, 정수 50~5000). `JEV_TIMEOUT_MS`는 Jev 전용으로 남음 |
| `OPENAI_API_KEY` | 없음 | `openai` judge의 키. config에 저장하지 않음 |
| `JEV_DECISION_LOG` | `true` | decision log 기록 여부 |

기존 네 지점의 모드와 임계값은 env가 아니라 `config.kernel`에서 바꿉니다.

## 검증 상태

**오프라인 테스트로 확인한 것** (`bash scripts/test-all.sh`, Node 503/503, 구문 64개 모듈, 2026-11-25. `orchestration`에서 `npm test`만 돌려도 503/503)

모두 mock judge, 로컬 어휘 judge, loopback 서버, 주입된 fetch, 로컬 CLI의 자식 프로세스로 돌린 계약 검사입니다.

- kernel: 지점 모드, 체인 순서, 실패·낮은 확신 시 escalation, escalation 실패 시 보류한 답 채택, 체인 예산(명시·기본), 설정 병합·검증, env 덮어쓰기
- judge: OpenAI wire 변환과 응답 검증(label 기준 score 분포 포함), 동의 관문, 크기 제한, 답 검증, 선택 지점의 별도 요청 상한·circuit, 제공자별 timeout(loopback 서버로 제공자 timeout 적용·체인 예산 우선·route deadline 우선·재시도 없음 확인)
- skill: 카탈로그 읽기와 건너뛰기 규칙, 프로젝트 안 심볼릭 링크 root 허용과 프로젝트 밖 root 거부, 적대적 디렉터리 이름의 주입 차단, 경로 구간 검사, BM25, 임계값·상한, 주입 블록 형식, 예산 초과 시 생략, 재호출 재현, 실패 시 미선택
- supervisor: 판정 조건, 조언 문구, 확신 미달 시 기존 문구 유지
- log·calibration: 형식 검사, 원문 미기록, 라벨 결합, 지표 계산, 지점별 실패·escalation 비율
- hook: 분류 지점 `off`/`shadow`의 무표시 동작, 분류 체인 예산 초과 시 typed 오류와 strict deny 유지
- 기본 동작 보존: 아래 [기본 동작 비교](#기본-동작-비교)

### 기본 동작 비교

"기본 설정에서는 kernel 이전과 같다"는 주장을 저장소에 남긴 반복 가능한 검사로 확인합니다.

```bash
cd orchestration && npm run compare:default      # 또는 node scripts/compare-default-behavior.mjs [--json] [--base <commit>]
```

- `git archive`로 kernel 이전 커밋(`005d2529`)의 `orchestration/`을 임시 디렉터리에 풀고, 같은 시나리오 코드를 이전 트리와 현재 작업 트리에 각각 별도 프로세스로 실행합니다. fixture는 두 번 모두 같은 정규 경로에 만들고 파일 시각을 고정합니다. judge는 프로세스 내부 mock이며 네트워크를 쓰지 않습니다.
- 시나리오: hook 모드(`active`/`advisory`/`shadow`) × runtime(`claude`/`codex`) × 9개 이벤트(SessionStart, UserPromptSubmit, 위임 PreToolUse, 같은 `tool_use_id` 재호출, PostToolUse, PostToolUseFailure, Read 조언, custom agent, Workflow 경계) = 54개. 이를 두 설정으로 돌립니다. `judged`는 judge 경로에 필요한 동의·capability 스위치(egress, Codex rewrite, 모델 confirmed, `readAdvice`)를 두 트리에 똑같이 켠 것이고, `untouched`는 `defaults(home)`에 프로젝트 허용 목록과 hook 모드만 넣은 것입니다. 두 설정 모두 `config.kernel`은 건드리지 않은 기본값입니다.
- 비교 대상: 단계별 hook 출력, judge 호출의 순서와 내용(state, questions, scope), 그 시점까지 저장된 세션 이벤트 type의 multiset. JSON 문자열로 byte 단위 비교합니다.
- 종료 코드: `0` 일치, `1` 차이 있음(차이를 출력), `2` 실행 불가, `3` 기준 커밋 없음(git checkout이 아니거나 shallow clone). `test/default-behavior.test.mjs`가 이 스크립트를 실행하므로 `npm test`에도 포함됩니다. 기준 커밋이 없으면 그 테스트는 통과가 아니라 skip으로 보고됩니다.

**실행 결과 (2026-11-25, Node v24.19.0, 제공자별 timeout·skill root 변경을 포함한 트리)**: hook 출력 108개(`judged` 54개 중 비어 있지 않은 것 28개, `untouched` 54개 중 30개)와 judge 호출 21건(`judged` 21, `untouched` 0)이 모두 일치했습니다. 차이 0건, 예외로 끝난 출력 0건. 같은 실행을 세 번 반복해 같은 결과를 얻었습니다. 출력 문구 한 글자와 질문 문구 한 단어를 일부러 바꿨을 때 각각 `output`, `judgeCalls` 차이로 잡히고 종료 코드 1이 나오는 것도 확인했습니다(확인 후 원복).

이 비교가 **다루지 않는 것**은 다음과 같고, 스크립트도 매번 출력합니다.

- 기본값이 아닌 kernel 설정(skill, supervisor, `openai`/`local` judge, 지점 `shadow`/`off`, escalation)
- `controller` 모드, hook 모드 `off`, SubagentStart/SubagentStop/PreCompact/SessionEnd, plan context, 재시도 escalation, `failureMode=block`
- 실제 Jev/OpenAI 호출, HTTP timeout, cache·circuit 동작
- judge에 전달되는 `limits` 인자. kernel이 `pointId`와 시간에 따라 변하는 남은 예산을 넣으므로 의도적으로 다릅니다.
- 이벤트 type 외의 저장 상태(시각이 다르고, 정책 지문은 kernel 설정을 포함하므로 의도적으로 다름), 새로 생긴 decision log
- 설치, `bin/jev-hook.mjs` 프로세스 진입점과 watchdog, 지연 시간

**측정하지 않은 것**

| 항목 | 상태 |
|---|---|
| 실제 TypeSafe(Jev) API로 새 지점 실행 | 미측정 |
| 실제 OpenAI API 호출. wire 계약(score 응답의 `value` 의미 포함)과 기본 모델 이름 `gpt-6-luna` | 미확인 |
| skill 선택의 정확도 (실제 모델 기준) | 미측정 |
| 실제 트래픽에서의 calibration (Brier, ECE) | 미측정. 라벨이 한 건도 없음 |
| supervisor 조언의 유용성 | 미측정 |
| end-to-end 효과 (작업 품질, 시간, 비용) | 미측정 |
| Codex runtime의 skill 주입·supervisor 경로 | 전용 테스트 없음. 기본 동작 비교에서만 다룸 |

따라서 이 문서는 "어떻게 동작하는가"를 설명할 뿐이며, skill 라우팅이나 supervisor가 결과를 개선한다는 근거는 아직 없습니다. 임계값(0.9, 0.5, 0.65)은 측정으로 정한 값이 아닌 초기값입니다.

`orchestration`에서 `npm test`를 직접 돌려도 통과합니다. 예전에는 macOS 기본 `TMPDIR`(`/var/folders/...`, `/private/var/...`의 심볼릭 링크) 아래에 만든 fixture 경로가 정규화되지 않아 31건이 실패했습니다. 제품 코드는 프로젝트 경로를 `realpath`로 비교하므로 fixture(`test/helpers.mjs`)가 임시 디렉터리를 `realpath`로 정규화하도록 고쳤고, 제품의 심볼릭 링크 검사는 바꾸지 않았습니다. `test/fixture-paths.test.mjs`가 심볼릭 링크 `TMPDIR`을 직접 만들어 이 경우를 모든 플랫폼에서 재현합니다.
