[English](README.en.md) | 한국어

# Jev Orchestration

**Claude Code·Codex subagent 위임을 위한 모델·effort 선택과 skill 라우팅 hook**

Jev Orchestration은 [Claude Code hook](https://code.claude.com/docs/en/hooks)(훅)과 [OpenAI Codex hook](https://developers.openai.com/codex/hooks)에 연결되는 확장으로, Main 에이전트가 subagent(서브에이전트)에게 일을 위임하는 순간에 작은 decision model(기본값 TypeSafe Jev)에게 물어 그 서브에이전트가 쓸 모델·effort와 skill(스킬)을 골라 줍니다.

skill이 많은 프로젝트에서 subagent가 필요한 skill만 받게 하고, 위임마다 모델·effort를 사용자가 확인한 프로필 중에서 고르게 하려는 도구입니다. Claude Code와 Codex를 대체하지 않고 hook으로만 동작합니다. 설치하면 hook과 프로필 정의 파일이 HOME에 추가되고, 사용자가 켜기 전에는 위임을 바꾸지 않으며 아무것도 외부로 보내지 않습니다.

**상태: 실험적.** 판단이 정답 라벨과 얼마나 일치하는지는 측정했고, 실제 작업의 품질·시간·비용이 좋아지는지는 아직 측정하지 않았습니다.

```text
Main이 subagent에게 위임  →  hook이 judge에게 질문      →  모델·effort 프로필 + 필요한 skill 선택
subagent가 보고를 반환    →  hook이 보고 텍스트를 분류  →  Main에게 조언 (조언만 함)
```

이 문서의 용어: **Main**은 사용자가 대화하는 세션, **subagent**는 Main이 일을 위임하는 에이전트, **호스트**는 Claude Code 또는 OpenAI Codex, **judge**는 글 대신 확률로만 답하는 작은 decision model, **프로필**은 모델 하나와 effort(추론 강도) 하나의 조합입니다(예: 예시 registry의 `claude-sonnet-5` + `high`).

## Jev Orchestration은 무엇인가요?

Jev Orchestration은 사용자 HOME에 설치되는 Node hook 스크립트 묶음이고, 허용한 프로젝트에서만 동작합니다. 자체 에이전트 루프, 새 CLI, MCP 서버, 런타임 npm 의존성이 없습니다. 풀려는 문제는 세 가지입니다.

- **스킬 라우팅.** skill을 Main에게 추천하면 모든 skill 설명이 Main의 문맥에 실리고, subagent가 그 skill을 실제로 받는지는 Main의 재량입니다. Jev Orchestration은 작업과 subagent가 정해진 위임 시점에 skill을 골라 위임 지시문에 붙입니다. 이렇게 하면 토큰이 줄거나 subagent 결과가 나아지는지는 측정하지 않았습니다.
- **모델·effort 선택.** 위임 작업의 모델과 effort는 보통 그때그때 정해집니다. Jev Orchestration은 사용자가 확인한 프로필 중에서 고르거나, 확신이 없으면 고르지 않습니다.
- **보고 검토.** subagent의 보고는 대개 그대로 받아들여집니다. Jev Orchestration은 보고 텍스트를 분류해 Main에게 조언만 합니다.

Jev Orchestration은 Claude Code의 `PreToolUse` hook(훅)에서 서브에이전트 모델 라우팅을 합니다. Main이 `Agent`나 `Task` 도구(Codex는 `spawn_agent`)를 호출하면, hook이 judge에게 물어 사용자가 확인한 모델·effort 프로필 중 하나를 고르거나 보류합니다.

### 기본 Claude Code·Codex와 무엇이 다른가

| 항목 | 기본 Claude Code / Codex | Jev Orchestration을 더했을 때 |
|---|---|---|
| 에이전트 실행·권한·승인 | 호스트가 담당 | 그대로 호스트가 담당 |
| subagent의 skill | Main이 skill 설명을 문맥에 두고 재량으로 전달 | 위임 시점에 judge 확률로 골라 이름·경로·확률을 지시문에 추가 |
| subagent의 모델·effort | 위임할 때마다 Main이 결정 | 확인된 프로필 중 선택하거나 보류 |
| subagent 보고 | Main이 그대로 읽음 | 보고 텍스트를 분류해 조언을 덧붙임 |
| 판단 기록 | 없음 | 원문 없이 해시·숫자만 남기는 로컬 decision log |

## Jev Orchestration이 하는 일: 모델·effort 선택, 스킬 라우팅, 보고 검토

| 기능 | 하는 일 | 켜는 설정 |
|---|---|---|
| 모델·effort 선택 | 위임 작업의 성격을 판단하고, 확인된 프로필 중 하나를 고르거나 보류 | 외부 전송 허용 + registry에서 `confirmed`로 표시한 모델 |
| skill 라우팅 | 프로젝트 skill 중 이 작업에 필요한 것을 확률로 선택 | `JEV_SKILLS_MODE=active` (기본 `off`) |
| 보고 검토 | subagent 보고를 complete / retry / replan / escalate로 분류해 조언 | `JEV_SUPERVISOR_MODE=active` (기본 `off`) |
| 결과 수집 (선택) | 세션이 끝난 뒤 로컬 기록을 읽어 위임별 관찰 기록, 기록된 판단의 결과 라벨(근거 강도를 말하는 출처가 붙음. 외부 검증 없이는 약한 라벨), 평가 행 후보를 씀. 아무것도 전송하지 않고 자동으로 가져오지 않으며 그 자체로는 라우팅을 바꾸지 않음 | 직접 실행: `node orchestration/scripts/collect.mjs` ([결과 수집기](docs/KERNEL.ko.md#결과-수집기)) |

`JEV_MODE`가 전체 상한이고, 개별 설정은 그 안에서 기능을 켜고 끕니다. 새로 설치하면 `JEV_MODE=shadow`, `JEV_ALLOW_EGRESS=false`입니다. `JEV_ALLOW_EGRESS=true`로 바꾸기 전에는 어떤 기능도 judge를 부르지 않고, `JEV_MODE`를 `advisory`나 `active`로 바꾸기 전에는 Main에게 아무것도 보이지 않으며 위임도 바뀌지 않습니다.

judge는 `jev`(TypeSafe Jev), `openai`(OpenAI Decisions API), `local`(네트워크 없는 어휘 규칙, skill 전용) 중 1~3개를 순서대로 묶을 수 있습니다. 앞의 judge가 실패하면 다음으로 넘어갑니다. 확신이 낮을 때도 넘기려면 `JEV_SKILLS_ESCALATE_BELOW` 같은 값을 설정해야 합니다(기본 0). 여섯 개의 결정 지점과 흐름 전체는 [Decision kernel 문서](docs/KERNEL.ko.md)에 있습니다.

## 빠른 시작: Jev Orchestration 설치와 해제

**필요한 것**: Node 22.13 이상, Git, 로그인된 Claude Code 또는 Codex, TypeSafe API 키(Claude·Codex 로그인과 별개).

```bash
git clone https://github.com/gkrtjd99/Jev_Orchestration.git
cd Jev_Orchestration

# 1) 모델 registry와 env 파일을 저장소 밖에 준비
mkdir -p "$HOME/.config"
cp orchestration/config/registry.example.json "$HOME/.config/jev-models.local.json"
cp orchestration/.env.example "$HOME/.config/jev-setup.env"
chmod 600 "$HOME/.config/jev-setup.env"   # 600이 아니면 설치기가 거부합니다
```

2) 두 파일을 편집합니다. registry에서는 내 계정으로 실제로 쓸 수 있는 모델만 `availability`를 바꿉니다. `confirmed`인 모델이 없으면 프로필 후보가 생기지 않습니다. env 파일에는 `TYPESAFE_API_KEY=` 뒤에 키를 적습니다.

```text
"model": "claude-sonnet-5", ...  "availability": "declared"     ← 바꾸기 전
"model": "claude-sonnet-5", ...  "availability": "confirmed"    ← 바꾼 뒤
```

```bash
# 3) 설치 계획 보기 (아무것도 쓰지 않음). 하나만 쓰면 --runtime claude 또는 --runtime codex
node orchestration/scripts/install.mjs \
  --project /absolute/path/to/your-project --runtime both \
  --registry "$HOME/.config/jev-models.local.json" \
  --env-file "$HOME/.config/jev-setup.env" --mode shadow

# 4) 계획을 확인했으면 --yes 를 붙여 적용
node orchestration/scripts/install.mjs \
  --project /absolute/path/to/your-project --runtime both \
  --registry "$HOME/.config/jev-models.local.json" \
  --env-file "$HOME/.config/jev-setup.env" --mode shadow --yes
```

설치 후 Claude Code 또는 Codex 세션을 다시 시작하고 `/hooks`에서 등록된 hook을 확인·신뢰합니다. 설치기는 `~/.claude/settings.json`, `~/.claude/agents`, `~/.codex/hooks.json`, `~/.codex/agents`, `~/.config/jev-hooks`, `~/.local/share/jev-hooks`에 쓰고, 프로젝트 폴더와 Main 모델, 기존 로그인은 바꾸지 않습니다. 다른 프로젝트를 추가하려면 `--project`만 바꿔 같은 명령을 다시 실행합니다.

```bash
node orchestration/scripts/doctor.mjs                    # 설치 상태 점검 (읽기 전용)
node orchestration/scripts/skills.mjs --project /absolute/path/to/your-project --list   # skill 카탈로그 보기 (오프라인)
node orchestration/scripts/decisions.mjs --action report # 로컬 decision log 요약
node orchestration/scripts/uninstall.mjs                 # 해제 계획. --yes 를 붙이면 적용
```

당장 멈추려면 `~/.config/jev-hooks/.env`에서 `JEV_MODE=off`로 바꿉니다. 해제해도 설정, 키, 백업, 상태는 남습니다. 자세한 절차는 [설치 문서](docs/SETUP.ko.md)를 보세요.

## 처음 결과 보기: shadow에서 advisory, active로

빠른 시작을 마친 상태(`shadow`, 외부 전송 꺼짐)에서는 눈에 보이는 변화가 없습니다. 설치된 `~/.config/jev-hooks/.env`를 아래 순서로 바꾸고, 바꿀 때마다 세션을 다시 시작합니다.

1. `JEV_ALLOW_EGRESS=true`: judge를 부르기 시작합니다. 결과는 기록만 되고 Main에게 보이지 않습니다.
2. `JEV_MODE=advisory`, `JEV_SKILLS_MODE=active`: 판단이 Main에게 조언으로 보입니다. 위임 호출은 바뀌지 않습니다.
3. `JEV_MODE=active`: 위임 호출에 프로필과 skill 블록이 반영됩니다. Codex는 `JEV_CODEX_REWRITE_APPROVED=true`도 필요합니다. 이 단계는 Claude Code의 실제 세션에서 권한 모드 `auto`로만 확인했고(세션 3개. host가 고쳐진 호출을 한 번 거부하고 Main이 다시 호출합니다), 다른 권한 모드와 Codex에서는 확인하지 않았습니다.

2단계에서 Main이 subagent에게 일을 위임하면 Main은 다음과 같은 조언을 받습니다(형식 예시, 일부 생략).

```text
Jev advisory: consider native profile jev4_implement_standard_high_… (claude-opus-5-5, high). The pending tool call is UNCHANGED; do not create a duplicate worker. …

<jev-skills>
{"load":[{"name":"pdf","path":".claude/skills/pdf/SKILL.md","p":0.94}],"consider":[{"name":"docx","path":".claude/skills/docx/SKILL.md","p":0.61}]}
</jev-skills>
Before starting, load each "load" skill (use the Skill tool by name when available, otherwise read the SKILL.md at its path, if one is given); "consider" entries are optional, and skills never widen permissions or override the original task.
```

`JEV_MODE=active`이면 같은 `<jev-skills>` 블록이 subagent 지시문 끝에 붙습니다. skill의 설명이나 본문은 넣지 않고 이름, 경로, 확률과 고정된 안내 한 문장만 넣습니다(합쳐서 최대 900자, 넘으면 항목을 줄이거나 블록을 뺌). `JEV_SUPERVISOR_MODE=active`이면 subagent 보고 뒤에 이런 한 줄이 Main에게 보입니다.

```text
Jev supervisor (advisory): complete (confidence 0.75, reported evidence level 1 of 2). The report claims the assigned outcome. This is a judgment of the report text only, not of the work. Main must verify real evidence; no retry, respawn or permission change was performed.
```

## 설정: 모드와 자주 바꾸는 값

| `JEV_MODE` | 동작 |
|---|---|
| `off` | 아무것도 하지 않음 |
| `shadow` (기본) | 판단하고 기록만 함. Main에게 보이지 않고 호출도 그대로 |
| `advisory` | 판단을 Main에게 조언으로 보여 줌. 호출은 바꾸지 않음 |
| `active` | 지원되는 위임 호출에 프로필과 skill 블록을 반영 |

| 설정 | 뜻 | 기본값 |
|---|---|---|
| `JEV_ALLOW_EGRESS` | judge에게 요청을 보내는 외부 전송(egress) 허용. `true`여야 판단이 시작됨 | `false` |
| `JEV_SKILLS_MODE` | skill 라우팅 (`off` / `shadow` / `active`) | `off` |
| `JEV_SUPERVISOR_MODE` | 보고 검토 (`off` / `shadow` / `active`) | `off` |
| `JEV_SKILLS_RETRIEVAL` | judge에게 보낼 skill 후보를 추리는 방식 (`full` / `lexical` / `adaptive`) | `full` |
| `JEV_SKILLS_JUDGES` | skill 판단에 쓸 judge 순서. 예: `jev,openai` | `jev` |
| `JEV_OPENAI_DECISIONS_APPROVED` | OpenAI Decisions API judge 사용 승인 (`OPENAI_API_KEY`도 필요) | `false` |
| `JEV_CODEX_REWRITE_APPROVED` | Codex에서 `active`가 위임 호출을 바꾸도록 승인 | `false` |
| `JEV_SKILL_DIRS` | 프로젝트 `.claude/skills` 외에 추가로 읽을 skill 폴더 | 비어 있음 |

## 측정 결과: 판단 일치도 (실제 작업 개선 효과는 미측정)

측정한 것은 Jev Orchestration의 판단이 정답 라벨과 얼마나 일치하는가입니다. 아래 수치는 모두 버전 3.2.0, 2026-11-25, 실제 TypeSafe Jev, 1회 실행 결과이고, 작업과 라벨은 모델이 만든 합성 데이터이며 사람이 검토하지 않았습니다.

- **skill 라우팅 (합성 held-out 세트: 처음 보는 skill 72개, 작업 180건).** 이 세트에서 load한 skill의 96.7%가 라벨과 일치했고, 라벨된 skill의 11.9%는 load하지 못했습니다(precision 0.967, recall 0.881, F1 0.922). skill이 필요 없는 작업 63건 중 1건에 skill이 들어갔습니다. [held-out 요약](qa/kernel/results/holdout-1-score-1/summary.txt)
- **한국어 작업.** 같은 held-out 세트에서 한국어 작업 72건의 recall은 0.796, 영어 작업 81건은 0.951이었습니다. 한국어 작업에서 skill을 더 많이 놓칩니다.
- **개발 세트 (skill 40개, 두 라벨이 일치한 159건 / 전체 160건).** load F1 0.970입니다. 기본값을 정하는 데 쓴 세트라 held-out보다 높게 나옵니다. [개발 세트 요약](qa/kernel/results/dev-retrieval-decision-1/summary.txt)
- **지연과 judge 사용량.** skill 라우팅을 켜고 skill 72개 카탈로그를 쓰면 위임 1건이 judge를 0.8~0.9초쯤 기다렸습니다(p50 808 ms, p95 924 ms, 요청 2건, 입력 약 10,341 토큰·출력 약 1,236 토큰, 기본 `full` 방식). skill 40개 개발 세트에서는 p50 220 ms였습니다. 실제 세션 1회(위임 3건, skill 60개)에서 judge 토큰은 위임 1건당 입력 약 14,134·출력 1,734였습니다(분류·프로필·skill·보고 검토의 합 42,403 / 5,202를 3으로 나눈 값). [재확인 요약](qa/kernel/results/real-session-reissue-20261125/summary.json)
- **보고 분류 (합성 보고 120건).** 전체 정확도는 93.3%입니다. Main에게 보일 만큼 확신한 100건(83.3%)에서는 98.0%였습니다. 재시도가 필요한 `retry` 보고 30건 중 6건을 `complete`로 분류한 것이 주된 오류입니다. [전체 실행 요약](qa/kernel/results/20261125-full/summary.txt)

### 아직 모르는 것

- **실제 작업의 품질·시간·비용이 좋아지는지는 아직 모릅니다.** skill 주입 있음/없음을 짝지은 작은 pilot(실제 세션 2개, 합성 과제 6쌍, 각 1회 실행)에서는 두 쪽 모두 6개 중 6개가 규칙 검사를 통과했고, 주입이 없는 쪽에서도 subagent가 맞는 skill을 스스로 읽었습니다. 그래서 이 pilot으로는 주입의 이득을 잴 수도, 이득이 없다고 할 수도 없습니다. [pilot 결과](qa/kernel/results/pilot-20261125/README.md)
- 실제 세션 확인은 배선 확인까지입니다. Claude Code 데스크톱 세션 4회(`advisory`)에서 실제 `Agent` 호출에 hook이 실행되고 실제 judge가 skill을 고르는 것을 확인했습니다. 4회 모두 subagent가 스스로 맞는 skill을 읽었으므로 이 세션들은 효과를 보여 주지 않습니다. [실제 세션 요약](qa/kernel/results/real-session-20261125/summary.json)
- 실제 세션의 `active` 모드(subagent 지시문 재작성)는 권한 모드 `auto`에서만 확인했습니다. 고쳐진 호출이 실행된 것은 pilot 세션 2개의 위임 16건 중 15건, 재확인 세션 1개의 3건 중 3건입니다. `auto`에서는 host가 고쳐진 호출을 한 번 거부하고 Main이 다시 호출하므로 그런 위임마다 Main 왕복이 한 번 더 듭니다. Jev Orchestration은 이 거부를 우회하지 않습니다. [재확인 요약](qa/kernel/results/real-session-reissue-20261125/summary.json)
- 그 재확인 세션에서 supervisor 조언은 기본 임계값으로 위임 3건 중 3건에서 Main에 전달됐습니다. 이 세션은 hook 동작만 확인했고 subagent의 작업이 맞았는지는 채점하지 않았습니다.
- 세션 결과를 판단 기록에 잇는 수집 경로는 생겼지만 모인 자료가 없습니다. 모델·effort 선택에 쓰이는 평가 저장소는 0행이고, pilot 세션 2개에 수집기를 돌려도 위임 16건에서 평가 행은 0건이었습니다. 실제 세션에서 나온 calibration 수치는 합성 pilot 세션 1개의 약한 라벨(skill 판단 32개 중 12개)뿐이고, 보고서도 충분하지 않다고 표시합니다. 수집기는 Claude Code 데스크톱 한 버전의 기록 형태만 읽고 Codex 기록은 읽지 못합니다. [수집기 결과](qa/kernel/results/collector-20261125-r2/README.md), [평가 행이 만들어지려면](docs/KERNEL.ko.md#평가-행이-만들어지려면)
- Codex 런타임은 확인하지 않았습니다. harness 알림 줄이 붙은 hand-back과 120초보다 늦은 재호출도 실제 세션에서 확인하지 않았습니다.
- judge 호출에 드는 금액은 계산하지 않았고, 반복 실행의 편차도 재지 않았습니다.
- 한국어 recall은 skill 40개 개발 세트의 0.939에서 skill 72개 held-out 세트의 0.796으로 떨어졌습니다. 한 번에 판단하는 skill 수 상한(64개)이 원인으로 의심되지만 확인하지 못했습니다.

전체 수치, hook 직접 호출 결과, 남은 일은 [QA 요약](qa/kernel/SUMMARY.ko.md)에 있습니다.

## 지원 범위: 런타임, judge, 운영체제

| 구분 | 상태 | 비고 |
|---|---|---|
| Claude Code `shadow` / `advisory` | 확인됨 | 데스크톱 앱 실제 세션에서 `advisory`까지 확인 |
| Claude Code `active` | 실제 세션에서 확인됨 (권한 모드 `auto`만) | 세션 3개. `auto`에서는 고쳐진 위임마다 Main 왕복 1회 추가 |
| Codex `shadow` / `advisory` / `active` | 지원하지만 실제 세션 미확인 | `active`는 `JEV_CODEX_REWRITE_APPROVED=true` 필요. 없으면 조언만 함 |
| judge: TypeSafe Jev | 확인됨 | 기본값 |
| judge: OpenAI Decisions API, `local` | 지원 | OpenAI는 별도 승인과 키 필요, held-out 세트 미측정. `local`은 skill 전용이고 정확도를 맞추지 않은 규칙 |
| macOS | 확인됨 | 로컬 테스트를 macOS에서 실행 |
| Linux, WSL | 지원 대상이나 미확인 | Windows native shell은 대상이 아니며 확인하지 않음 |
| 그 밖의 에이전트 도구 (예: opencode) | 미지원 | 설치기는 `--runtime both\|claude\|codex`만 받음 |

그 밖의 한계:

- Claude `Workflow` 스크립트 안의 `agent()` 호출에는 subagent별 hook 지점이 없어 모델·effort를 바꿀 수 없습니다.
- Main이 위임하지 않은 작업에는 관여하지 않습니다. `active`도 위임을 강제하지 않습니다.
- 재시도와 재실행은 하지 않습니다. 차단은 기본값에서는 없고, `JEV_WORKFLOW_POLICY=block`처럼 사용자가 켠 경우에만 합니다.

## 안전과 동의

- **기본값은 아무것도 보내지 않습니다.** `JEV_MODE=shadow`, `JEV_ALLOW_EGRESS=false`로 설치됩니다.
- **`JEV_ALLOW_EGRESS=true`부터 전송이 시작됩니다.** 위임 텍스트와 제한된 문서 메타데이터가 TypeSafe로 갑니다. `JEV_SKILLS_MODE`를 켜면 프로젝트 skill의 이름과 설명이, `JEV_SUPERVISOR_MODE`를 켜면 subagent 보고 텍스트(최대 1600자)가 함께 갑니다. 소스 전체나 대화 전체를 자동으로 올리지 않지만, 위임문에 직접 넣은 코드는 위임 텍스트의 일부입니다.
- **OpenAI judge는 따로 승인합니다.** `JEV_OPENAI_DECISIONS_APPROVED=true`와 `OPENAI_API_KEY`가 모두 있어야 하고, 켜면 같은 내용이 api.openai.com으로 갑니다.
- **기록에는 원문이 없습니다.** decision log는 해시, 숫자, 선택지 이름만 `~/.local/state/jev-hooks/decisions-log`에 남깁니다(파일 권한 0600).
- **권한을 넓히지 않습니다.** 설치기는 hook 신뢰 절차를 건너뛰는 설정을 넣지 않고 Main 모델과 로그인을 바꾸지 않습니다. hook은 OS 수준 보안 경계가 아닙니다.

자세한 경계는 [보안·한계 문서](docs/SECURITY.ko.md)에 있습니다.

## 자주 묻는 질문

**Jev Orchestration은 Claude Code나 Codex를 대체하나요?**
아니요. Jev Orchestration은 Claude Code와 Codex 위에 얹는 hook(훅) 확장입니다. Main, subagent 실행, 권한, 승인은 호스트가 그대로 맡습니다.

**Jev Orchestration은 opencode 같은 다른 에이전트 도구에서도 되나요?**
아니요. Jev Orchestration이 지원하는 런타임은 Claude Code와 Codex 두 가지뿐이고, 설치기도 이 둘만 받습니다.

**Jev Orchestration은 Claude Code 서브에이전트에 줄 스킬을 어떻게 고르나요?**
Jev Orchestration은 프로젝트 `.claude/skills`의 skill 이름과 설명을 judge에게 보내 skill별 필요 확률을 받고, 코드가 임계값으로 자릅니다. 기본값으로 확률 0.9 이상은 "load", 0.5 이상은 "consider"로 각각 최대 3개까지 넣습니다. 기본 `full` 방식은 위임 1건당 skill 64개(`JEV_SKILLS_MAX_JUDGED`)까지만 judge에게 보냅니다.

**TypeSafe Jev가 무엇이고, API 키는 어디서 받나요?**
Jev는 TypeSafe가 제공하는 decision model로, 글을 쓰는 대신 예/아니오 확률·선택지 분포·점수 같은 정해진 형태의 답을 냅니다. Jev Orchestration은 Jev를 기본 judge로 쓰며 TypeSafe API 키가 따로 필요합니다. 키 발급과 요금은 [TypeSafe 문서](https://docs.typesafe.ai/api.md)에서 확인하세요. 이 저장소는 judge 호출 금액을 계산하지 않았습니다.

**TypeSafe Jev와 OpenAI Decisions API 중 어느 judge를 써야 하나요?**
Jev Orchestration의 기본값은 Jev이고, 추가 승인 없이 켜지는 judge도 Jev뿐입니다. 합성 개발 세트의 이전 실행(버전 3.2.0, 2026-11-25, 1회, `full`이 기본이 되기 전의 후보 추림 방식)에서 skill 라우팅 160건의 load F1은 Jev 0.800(p50 185 ms), OpenAI Decisions API 0.780(p50 516 ms)이었고, 보고 분류 120건의 정확도는 Jev 93.3%, OpenAI 96.7%였습니다. OpenAI judge는 held-out 세트에서 돌리지 않았습니다.

**Jev Orchestration을 쓰면 내 코드가 외부로 전송되나요?**
기본 설정의 Jev Orchestration은 아무것도 전송하지 않습니다. `JEV_ALLOW_EGRESS=true`로 바꾸면 위임 텍스트와 제한된 문서 메타데이터가 judge에게 가고, skill 라우팅을 켜면 skill 이름과 설명이, 보고 검토를 켜면 subagent 보고 텍스트(최대 1600자)가 함께 갑니다. 소스 전체나 대화 전체는 자동으로 보내지 않습니다.

**Jev Orchestration의 skill 라우팅이 토큰이나 비용을 아껴 주나요?**
알 수 없습니다. Jev Orchestration의 비용 절감 효과는 측정하지 않았고, skill 판단 자체가 skill 72개 held-out 세트에서 1건당 입력 약 10,341 토큰을 썼습니다. 실제 세션 1회(위임 3건, skill 60개)에서는 네 판단을 합쳐 위임 1건당 judge 입력 약 14,134 토큰이었습니다.

**Jev Orchestration을 실제 업무에 바로 써도 되나요?**
Jev Orchestration은 `shadow`나 `advisory`로 먼저 지켜보기를 권합니다. 판단 일치도는 측정했지만 실제 작업 개선 효과는 아직 측정하지 않았습니다.

## 더 읽을거리

- [설치·환경·인증](docs/SETUP.ko.md): 키, 모델 registry, 활성화 순서, 이전과 해제, 문제 해결.
- [Decision kernel 설계](docs/KERNEL.ko.md): 결정 지점, judge 체인, skill 라우팅, supervisor, decision log, 결과 수집기.
- [보안·한계](docs/SECURITY.ko.md): 신뢰 경계, 저장되는 상태, 네트워크.
- [측정 결과 전체](qa/kernel/SUMMARY.ko.md)와 [평가 보고서](qa/kernel/REPORT.ko.md).

그 밖의 문서: 실험적인 Claude 전용 [controller 모드 문서](docs/CONTROLLER.ko.md), hook 없이 계획 단계에서만 쓰는 [ultracode 계획 보조](docs/ULTRACODE.ko.md), [변경 기록](orchestration/CHANGELOG.md).

## 개발·기여

로컬 검사는 저장소 루트에서 `bash scripts/test-all.sh`로 돌립니다. 유료 API와 실제 모델을 호출하지 않으며, 검증기 때문에 Python 3.11 이상이 필요합니다(설치와 실행에는 필요 없음). 검증 방법은 [검증 문서](docs/VERIFICATION.ko.md)에, 버그와 제안은 [GitHub Issues](https://github.com/gkrtjd99/Jev_Orchestration/issues)에 남겨 주세요.

## 라이선스

[MIT](LICENSE)
