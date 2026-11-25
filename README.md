[English](README.en.md) | 한국어

# Jev Orchestration

Jev Orchestration은 Claude Code와 Codex 사용자를 위한 hook 확장으로, Main 에이전트가 subagent에게 일을 위임하는 순간에 작은 decision model(기본값 TypeSafe Jev)에게 물어 그 subagent가 쓸 모델·effort와 skill을 골라 줍니다.

자체 에이전트 루프를 돌리지 않습니다. Claude Code와 Codex가 원래 하던 대로 Main, worker, 권한, 승인을 맡고, Jev Orchestration은 native hook에서 판단만 보탭니다. 흐름과 임계값은 코드가 갖고, decision model은 확률로 된 답만 냅니다. 설치만 해서는 아무것도 바뀌지 않고 아무것도 외부로 보내지 않습니다.

```text
Main이 subagent에게 위임  →  hook이 decision model에 질문  →  모델·effort 프로필 + 필요한 skill 선택
subagent가 보고를 반환    →  hook이 보고 텍스트를 분류     →  Main에게 조언 (재시도·차단은 하지 않음)
```

## Jev Orchestration은 무엇인가

Jev Orchestration은 Claude Code hooks와 Codex hooks에 연결되는 Node 스크립트 묶음입니다. 사용자 HOME(`~/.claude/settings.json`, `~/.codex/hooks.json`)에 설치되고, 허용한 프로젝트에서만 동작합니다.

- **대상**: Claude Code나 Codex에서 subagent 위임을 자주 쓰고, 프로젝트에 skill이 여러 개 있는 사람.
- **하는 방식**: 위임 직전·직후 같은 정해진 "결정 지점"에서 judge(판단을 맡는 decision model)에게 예/아니오 확률, 선택지 분포, 점수 분포를 묻습니다. 자유 서술은 받지 않습니다.
- **하지 않는 것**: 새 대화형 CLI, 별도 worker 실행 엔진, MCP 서버, `claude -p`·`codex exec` 재귀 실행이 없습니다. 런타임 npm 의존성도 없습니다.

## 왜 필요한가: 위임 시점의 모델·effort 선택과 skill 라우팅

Jev Orchestration의 목표는 subagent 위임에 따르는 세 가지 판단을 코드와 작은 decision model로 옮기는 것입니다.

1. **Skill 라우팅.** skill을 Main에게 추천하면 모든 skill 설명이 Main의 문맥에 실리고, worker가 그 skill을 실제로 받는지는 Main의 재량입니다. 위임 시점에는 작업과 worker가 정해져 있으므로, 그 자리에서 골라 worker brief(위임 지시문)에 붙일 수 있습니다.
2. **모델과 effort 선택.** 위임 작업의 모델×effort는 보통 그때그때 정해집니다. Jev Orchestration은 사용자가 확인한 프로필 중에서 고르거나, 확신이 없으면 고르지 않습니다.
3. **보고 검토.** worker의 보고는 대개 그대로 받아들여집니다. Jev Orchestration은 보고 텍스트를 분류해 Main에게 조언합니다.

### 기본 하네스(Claude Code, Codex)와 무엇이 다른가

| 항목 | 기본 Claude Code / Codex | Jev Orchestration을 더했을 때 |
|---|---|---|
| 에이전트 실행·권한·승인 | 호스트가 담당 | 그대로 호스트가 담당 |
| subagent의 skill | Main이 skill 설명을 문맥에 두고 재량으로 전달 | 위임 시점에 judge 확률로 골라 이름·경로·확률만 brief에 추가 |
| subagent의 모델·effort | 위임할 때마다 Main이 결정 | 확인된 프로필 중 선택하거나 보류 |
| subagent 보고 | Main이 그대로 읽음 | 보고 텍스트를 분류해 조언을 덧붙임 |
| 판단 기록 | 없음 | 원문 없이 해시·숫자만 남기는 decision log |

## 하는 일: 여섯 개의 결정 지점

Jev Orchestration 3.2.0에는 결정 지점이 여섯 개 있고, 각각 `off` / `shadow` / `active`로 따로 켭니다.

| 결정 지점 | 하는 일 | 기본값 |
|---|---|---|
| `delegation.classify` | 위임 작업의 역할·범위·위험·추론 수준을 판단 | active |
| `delegation.profile` | 허용된 모델×effort 프로필 중 하나를 선택하거나 보류 | active |
| `delegation.skills` | 프로젝트 skill 중 이 작업에 필요한 것을 선택 (skill 라우팅) | off |
| `supervisor.outcome` | worker 보고를 complete / retry / replan / escalate로 분류해 조언 | off |
| `failure.classify` | 실패한 위임의 실패 유형을 분류 | active |
| `read.advice` | 문서를 읽을 때 문서 종류와 읽는 방식 힌트 | 꺼짐 (`JEV_READ_ADVICE=false`) |

위임 한 건의 흐름은 다음과 같습니다.

```text
Main이 subagent 위임을 호출 (Agent / Task / spawn_agent)
  │  PreToolUse hook
  ├─ delegation.classify   작업 성격 판단 ──┐ 병렬
  ├─ delegation.skills     skill별 필요 확률 ┘
  ├─ delegation.profile    모델×effort 프로필 선택 또는 보류
  │  코드가 임계값과 검증을 적용
  ├─ shadow   : 기록만 함
  ├─ advisory : Main에게 조언으로 보여 줌
  └─ active   : 위임 호출에 프로필과 <jev-skills> 블록을 반영
subagent 실행 (호스트가 실행·권한·승인 담당)
  │  PostToolUse / SubagentHandback hook
  └─ supervisor.outcome    보고 텍스트 분류 → Main에게 조언
```

judge는 `jev`(TypeSafe Jev), `openai`(OpenAI Decisions API), `local`(네트워크 없는 어휘 규칙, skill 전용) 중 1~3개를 순서대로 묶을 수 있습니다. 앞의 judge가 실패하거나 확신이 낮으면 다음으로 넘어갑니다. 자세한 설계는 [Decision kernel 문서](docs/KERNEL.ko.md)에 있습니다.

## 빠른 시작: Jev Orchestration 설치와 해제

**필요한 것**: Node 22.13 이상, Git, 로그인된 Claude Code 또는 Codex, TypeSafe API 키(Claude·Codex 로그인과 별개). Python 3.11 이상은 검증기를 돌릴 때만 필요합니다.

저장소를 clone한 뒤 루트에서 실행합니다.

```bash
# 1) 로컬 검사. 유료 API와 실제 모델을 호출하지 않습니다.
bash scripts/test-all.sh

# 2) 모델 registry와 env 파일을 저장소 밖에 준비
cp orchestration/config/registry.example.json /tmp/jev-models.local.json
mkdir -p "$HOME/.config"
cp orchestration/.env.example "$HOME/.config/jev-setup.env"
chmod 600 "$HOME/.config/jev-setup.env"   # 600이 아니면 설치기가 거부합니다
# registry에서 실제로 쓸 수 있는 모델만 availability를 confirmed로 바꾸고,
# env 파일에 TYPESAFE_API_KEY를 적습니다.

# 3) 설치 계획 보기 (아무것도 쓰지 않음)
node orchestration/scripts/install.mjs \
  --project /absolute/path/to/your-project --runtime both \
  --registry /tmp/jev-models.local.json \
  --env-file "$HOME/.config/jev-setup.env" --mode shadow

# 4) 계획을 확인했으면 같은 명령 끝에 --yes 를 붙여 적용
```

설치 후 Claude Code 또는 Codex 세션을 다시 시작하고 `/hooks`에서 등록된 hook을 확인·신뢰합니다. 설치기는 Main 모델과 기존 로그인을 바꾸지 않습니다.

```bash
node orchestration/scripts/doctor.mjs                    # 설치 상태 점검 (읽기 전용)
node orchestration/scripts/skills.mjs --project /absolute/path/to/your-project --list   # skill 카탈로그 보기 (오프라인)
node orchestration/scripts/uninstall.mjs                 # 해제 계획. --yes 를 붙이면 적용
```

당장 멈추려면 `~/.config/jev-hooks/.env`에서 `JEV_MODE=off`로 바꿉니다. 해제해도 설정, 키, 백업, 상태는 남습니다. 키·모델·이전 절차는 [설치 문서](docs/SETUP.ko.md)를 보세요.

## 사용법: 모드와 자주 바꾸는 설정

Jev Orchestration을 쓰는 방법은 평소처럼 `claude`나 `codex`를 그 프로젝트에서 실행하는 것입니다. Main이 subagent 위임을 호출할 때 hook이 실행됩니다. 전체 동작은 `JEV_MODE` 하나로 정합니다.

| `JEV_MODE` | 동작 |
|---|---|
| `off` | 아무것도 하지 않음 |
| `shadow` (기본) | 판단하고 기록만 함. Main에게 보이지 않고 호출도 그대로 |
| `advisory` | 판단을 Main에게 조언으로 보여 줌. 호출은 바꾸지 않음 |
| `active` | 지원되는 위임 호출에 프로필과 skill 블록을 반영 |
| `controller` | Claude 전용 실험 모드. [별도 문서](docs/CONTROLLER.ko.md) 참고 |

권장 순서는 `shadow`로 설치 → `JEV_ALLOW_EGRESS=true` → `advisory` → `active`입니다. 설정은 설치된 `~/.config/jev-hooks/.env`에서 바꿉니다.

| 설정 | 뜻 | 기본값 |
|---|---|---|
| `JEV_ALLOW_EGRESS` | judge에게 요청을 보내도 되는지. `true`여야 판단이 시작됨 | `false` |
| `JEV_SKILLS_MODE` | skill 라우팅 (`off` / `shadow` / `active`) | `off` |
| `JEV_SUPERVISOR_MODE` | 보고 검토 (`off` / `shadow` / `active`) | `off` |
| `JEV_SKILLS_RETRIEVAL` | skill 후보를 추리는 방식 (`full` / `lexical` / `adaptive`) | `full` |
| `JEV_SKILLS_JUDGES` | skill 판단에 쓸 judge 순서. 예: `jev,openai` | `jev` |
| `JEV_OPENAI_DECISIONS_APPROVED` | OpenAI Decisions API judge 사용 승인 (`OPENAI_API_KEY`도 필요) | `false` |
| `JEV_SKILL_DIRS` | 프로젝트 `.claude/skills` 외에 추가로 읽을 skill 폴더 | 비어 있음 |

skill 라우팅이 `active`이면 worker brief 끝에 이런 블록이 붙습니다. skill의 설명이나 본문은 넣지 않고 이름, 경로, 확률만 넣습니다(최대 900자).

```text
<jev-skills>
{"load":[{"name":"pdf","path":".claude/skills/pdf/SKILL.md","p":0.94}],"consider":[{"name":"docx","path":".claude/skills/docx/SKILL.md","p":0.61}]}
</jev-skills>
```

## 효과: 지금까지 측정한 것

Jev Orchestration에서 측정한 것은 **판단이 정답 라벨과 얼마나 일치하는가**입니다. 아래 수치는 모두 2026-11-25, 버전 3.2.0, 실제 TypeSafe Jev, 1회 실행 결과입니다. 작업과 라벨은 모델이 만든 합성 데이터이고 사람이 검토하지 않았습니다.

| 측정 | 결과 | 읽는 법 | 근거 |
|---|---|---|---|
| skill 라우팅, 처음 보는 세트 (skill 72개, 작업 180건) | load precision 0.967, recall 0.881, F1 0.922 | 고른 skill은 대부분 맞고, 필요한 skill 약 12%를 놓침 | [held-out 요약](qa/kernel/results/holdout-1-score-1/summary.txt) |
| skill 라우팅, 개발 세트 (skill 40개, 작업 160건) | load F1 0.970 | 기본값을 정하는 데 쓴 세트라 더 높게 나옴 | [개발 세트 요약](qa/kernel/results/dev-retrieval-decision-1/summary.txt) |
| skill이 필요 없는 작업에 잘못 넣은 비율 (held-out 63건) | 1.6% (1건) | 불필요한 skill 주입은 드묾 | [held-out 요약](qa/kernel/results/holdout-1-score-1/summary.txt) |
| 한국어 작업 recall (held-out 72건) | 0.796 (영어 81건은 0.951) | 한국어 작업에서 더 많이 놓침 | [QA 요약](qa/kernel/SUMMARY.ko.md) |
| skill 판단 지연 (held-out, 작업 1건당) | p50 808 ms, p95 924 ms, 요청 2건, 입력 약 10,341 토큰 | 위임마다 1초 가까운 지연과 judge 비용이 생김 | [QA 요약](qa/kernel/SUMMARY.ko.md) |
| 보고 분류 (합성 보고 120건) | 정확도 93.3%, Main에게 보인 조언의 정확도 98.0% | `retry`를 `complete`로 본 경우가 30건 중 6건 | [전체 실행 요약](qa/kernel/results/20261125-full/summary.txt) |
| 설치된 hook 직접 호출 100회 | 기대 214개 중 212 통과, 실패 0 | hook 배선이 기대대로 동작 | [hook 종단 결과](qa/kernel/results/20261125-e2e/hooks.txt) |
| 실제 Claude Code 데스크톱 세션 4회 (`advisory`) | hook 실행, skill 선택, 조언 전달 확인 | 실제 세션에서 경로가 이어짐 | [실제 세션 요약](qa/kernel/results/real-session-20261125/summary.json) |

### 아직 모르는 것

- **실제 작업의 품질·시간·비용이 좋아지는지는 측정하지 않았습니다.** skill 주입 있음/없음을 짝지어 비교한 적이 없습니다.
- 실제 세션에서 `active` 모드(subagent brief 재작성)와 Codex 런타임은 확인하지 않았습니다.
- judge 호출에 드는 금액은 계산하지 않았고, 반복 실행의 편차도 재지 않았습니다.
- skill이 64개를 넘는 카탈로그에서 한국어 recall이 떨어지는 원인은 확인하지 못했습니다.

전체 수치와 남은 일은 [QA 요약](qa/kernel/SUMMARY.ko.md)에 있습니다.

## 지원 범위: 런타임, judge, 운영체제

| 구분 | 지원 | 비고 |
|---|---|---|
| 런타임 | Claude Code, Codex | 이 둘만 설치 가능. `--runtime both\|claude\|codex` |
| Claude Code | `shadow` / `advisory` / `active` / `controller` | 실제 세션 확인은 데스크톱 앱 `advisory`까지 |
| Codex | `shadow` / `advisory`, 별도 승인 후 `active` | `JEV_CODEX_REWRITE_APPROVED=true` 전에는 `active`에서도 조언만 함. 실제 세션 미확인 |
| judge | TypeSafe Jev, OpenAI Decisions API, `local` | 기본은 Jev 하나. OpenAI는 별도 승인과 키 필요. `local`은 skill 전용이며 보정되지 않음 |
| 운영체제 | macOS, Linux, WSL 대상 | 검사는 macOS에서 실행. Windows native shell 설치는 확인하지 않음 |

지원하지 않는 것:

- Claude Code와 Codex 외의 에이전트 도구(예: opencode).
- Claude `Workflow` 스크립트 안의 `agent()` 호출. worker별 hook 지점이 없어 모델·effort를 바꿀 수 없습니다.
- Main이 위임하지 않은 작업. `active`도 위임을 강제하지 않습니다.
- 재시도, 재실행, 차단. supervisor는 조언만 합니다.

## 안전과 동의

- **기본값은 아무것도 보내지 않습니다.** `JEV_MODE=shadow`, `JEV_ALLOW_EGRESS=false`로 설치되고, 모델 registry도 사용자가 `confirmed`로 표시하기 전에는 후보를 만들지 않습니다.
- **`JEV_ALLOW_EGRESS=true`부터 전송이 시작됩니다.** 위임 텍스트와 제한된 문서 메타데이터가 TypeSafe로 갑니다. 소스 전체나 대화 전체를 자동으로 올리지 않습니다. 위임문에 직접 넣은 코드는 위임 텍스트의 일부입니다.
- **OpenAI judge는 따로 승인합니다.** `JEV_OPENAI_DECISIONS_APPROVED=true`와 `OPENAI_API_KEY`가 모두 있어야 합니다.
- **기록에는 원문이 없습니다.** decision log는 해시, 숫자, 선택지 이름만 로컬에 남깁니다(파일 권한 0600).
- **권한을 넓히지 않습니다.** 설치기는 trust bypass를 등록하지 않고 Main 모델과 로그인을 바꾸지 않습니다. hook은 OS 수준 보안 경계가 아닙니다.

자세한 경계는 [보안·한계 문서](docs/SECURITY.ko.md)에 있습니다.

## 자주 묻는 질문

**Jev Orchestration은 Claude Code나 Codex를 대체하나요?**
아니요. Claude Code와 Codex 위에 얹는 hook 확장입니다. Main 에이전트, worker 실행, 권한, 승인은 원래 호스트가 그대로 맡습니다.

**opencode 같은 다른 에이전트 도구에서도 되나요?**
아니요. 지원 런타임은 Claude Code와 Codex 두 가지뿐이고, 설치기도 이 둘만 받습니다.

**Jev가 무엇인가요?**
Jev는 TypeSafe가 제공하는 decision model로, 글을 쓰는 대신 예/아니오 확률·선택지 분포·점수 같은 정해진 형태의 답을 냅니다. Jev Orchestration은 이 답을 기본 judge로 쓰며, TypeSafe API 키가 따로 필요합니다.

**내 코드가 외부로 전송되나요?**
기본 설정에서는 전송되지 않습니다. `JEV_ALLOW_EGRESS=true`로 바꾸면 위임 텍스트와 제한된 문서 메타데이터가 judge에게 가고, 소스 전체나 대화 전체는 자동으로 보내지 않습니다.

**토큰이나 비용을 아껴 주나요?**
알 수 없습니다. 비용 절감은 측정하지 않았고, judge 호출 자체가 요청과 토큰을 씁니다(held-out 세트에서 skill 판단 1건당 입력 약 10,341 토큰).

**skill은 어떻게 고르나요?**
프로젝트 `.claude/skills`의 카탈로그를 judge에게 보내 skill별 필요 확률을 받고, 코드가 임계값으로 자릅니다. 확률 0.9 이상은 "load", 0.5 이상은 "consider"로 각각 최대 3개까지 넣습니다.

**실제 업무에 바로 써도 되나요?**
`shadow`나 `advisory`로 먼저 지켜보기를 권합니다. 판단 일치도는 측정했지만 실제 작업 개선 효과는 아직 측정하지 않았습니다.

## 더 읽을거리

- [Decision kernel](docs/KERNEL.ko.md): 결정 지점, judge 체인, skill 라우팅, supervisor, decision log의 설계와 검증 상태.
- [설치·환경·인증](docs/SETUP.ko.md): 키, 모델 registry, 활성화 순서, 이전과 해제, 문제 해결.
- [보안·한계](docs/SECURITY.ko.md): 신뢰 경계, 저장되는 상태, 네트워크.
- [검증 방법](docs/VERIFICATION.ko.md): 독립 검증기 사용법과 판정 범위. 과거 결과는 [오프라인 검증 기록](reports/VERIFICATION.md).
- [QA 요약](qa/kernel/SUMMARY.ko.md)과 [평가 보고서](qa/kernel/REPORT.ko.md): 측정 수치 전체와 평가 방법.
- [Claude controller 모드](docs/CONTROLLER.ko.md): 실험적인 Claude 전용 모드의 규약과 schema.
- [ultracode 계획 보조](docs/ULTRACODE.ko.md): hook 없이 계획 단계에서만 Jev 자문을 받는 별도 경로.
- [비교 검토와 통합 결정](docs/COMPARISON.ko.md): 이전 버전에서 무엇을 가져왔고 무엇을 뺐는지.
- [게시 범위](docs/PUBLISH.ko.md)와 [변경 기록](orchestration/CHANGELOG.md).

## 라이선스

[MIT](LICENSE)
