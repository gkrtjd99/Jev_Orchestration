# Jev Orchestration — 얇은 ultracode 계획 보조 + 기존 native hook

**ultracode용 새 경로는 훅 없이 작동합니다.** [얇은 지침](.claude/skills/jev-ultracode/SKILL.md)이 계획 작성 전에 제한된 Jev 자문을 요청하고, Astra가 판단을 검토해 원래 `Workflow`의 작업 분할·조사 범위·모델/effort에 반영합니다. 별도 controller·worker 실행 엔진·도구 가로채기로 전환하지 않습니다. 미동의·미지원·실패이면 기본 ultracode를 보존합니다. 정적 지침만 사용한 `GUIDANCE_ONLY`는 실제 Jev 판단을 쓴 상태가 아닙니다. **기본 ultracode 대비 품질·효율 우위는 아직 측정하지 않았습니다.** [사용 계약·입력·비교 방법](docs/ULTRACODE.ko.md)을 보세요.

기존 **Claude Code / Codex Main**을 유지하는 native hook 확장(3.1.0)도 보존합니다. 기본 `shadow`와 기존 `active`/`advisory` 모드는 Main이 **이미 요청한** 위임에 Jev 분류와 모델×effort 프로필 선택을 적용합니다. 새 **`controller` 모드(Claude 전용, 명시적 opt-in)**는 반대로 Astra 계획→Main의 native worker 배정→Main의 근거 확인을 중심에 두고, Jev를 선택적·비구속적 누락 검사자로 제한합니다. 독립 검증기 **1.1.0**은 별도 폴더에 있습니다.

새 대화형 CLI, 독립 worker 실행 엔진, MCP 서버, 재귀 `claude -p`/`codex exec` 실행은 없습니다. ultracode 경로의 작은 `jev-plan.mjs`는 자문 JSON만 반환하고 원래 Workflow가 실행을 맡습니다. 기존 hook 경로에서는 Main이 **native Agent/Task**에 직접 위임합니다. Reporivet과 AgentOTelStack의 코드를 복제하거나 설치하지 않습니다.

**상태:** 2026-09-26의 Node 395/395·검증기 자기 테스트 72/72·구문 검사 46개 모듈·기존 라우팅의 독립 offline 검사는 통과했습니다. 새 자문 CLI의 dry-run·미동의 fallback·합성 loopback 응답/캐시/요청 cap도 검사했지만, 실제 TypeSafe 계획 자문과 ultracode 성능 비교는 **NOT_RUN**입니다. [두 유지보수 과제의 실모델 native/controller 비교](reports/REPOSITORY_PILOT_20260926.md)에서는 native 후보 두 건이 독립 채점 통과, controller 후보 두 건이 무수정·채점 실패였습니다. `active`는 별도 TypeSafe 전송 동의가 없어 미실행이므로 세 조건 우위·실제 청구 비용은 알 수 없습니다. 실제 AgentOTelStack 저장·조회도 검증하지 않았습니다. 제한적인 과거 실제 TypeSafe·native 위임 시험은 별도로 있습니다. 새 Workflow 차단 정책에 이전 검증 결과를 소급하지 않습니다. 초기 `Agent` 위임 네 건에서는 Jev 선택과 child 모델을 연결했지만 effort 관측을 보고하지 못했습니다. 후속 유지보수 3쌍·웹 1쌍의 보관된 child 이벤트를 다시 읽으면 **2/4쌍에서 CLI typed effort `high → xhigh`**가 확인됩니다. 그러나 `Workflow` 내부 worker 라우팅, Codex 재작성 적용, Jev 판단의 정확도·작업 품질·총비용 우위는 **입증되지 않았습니다**. [실제 반복 비교](reports/PLAN_ROUTING_COMPARISON_20260925.md), [판단 경계 감사](reports/DECISION_AUDIT_20260925.md), [기존 검증 범위](reports/VERIFICATION.md)를 구분해 보세요. 파일이나 mock의 성공을 실제 모델 성공으로 간주하지 않습니다.

## 무엇을 통합했나

| 구성 | 채택한 부분 |
|---|---|
| 업로드된 optimized-router 0.4.0-router.1 | 위임 직전 native hook, 2단계 Jev 판단, 명시적 모델 registry, profile hash, 세션 상태, 캐시·중복 방지·회로 차단, 관측 자료 기반 선택 |
| 이전 native v2.3 | 전송 동의, 기본 비활성/권고 경계, 고-effort 정책, 사용자 설정 보존, 민감정보·관측값 구분 |
| 업로드된 independent verifier 1.0.0 | SUT 내부 로직을 사용하지 않는 외부 계약 검사, 별도 acceptance tests, 실제/합성 분리, requested/observed 구분, paired comparison |
| 이번 수정 | 검증기 조기 성공 위조 차단, 완전한 대응 표본 요구, stale revision 방지, max와 큰 모델 동시 후보, Codex allow 별도 동의, 목표 해시에 묶은 계획 요약 opt-in, `Workflow` 경계 관측, Codex 협업 spawn의 추가 승인 경계 |

비교·버그 재현·제외한 기능: [docs/COMPARISON.ko.md](docs/COMPARISON.ko.md).

## 실행 구조

### ultracode 계획 보조 (훅 없음)

```text
원래 목표·수용 기준 + 최소한의 작업 초안
  → 명시적인 전송 동의가 있을 때만 Jev에 한 번의 batch 자문
  → 짧은 typed 권고; 정보 부족·낮은 확신은 보류
  → Astra가 원래 Workflow 계획과 agent(model, effort) 옵션을 작성
  → 의존 작업은 pipeline, 독립 작업만 parallel; 실제 산출물·검사로 종료
```

이 저장소의 `CLAUDE.md`는 해당 skill로만 연결하는 얇은 진입점입니다. 다른 저장소·사용자 HOME에 자동 설치하지 않습니다. 기본 ultracode 비교군은 이 지침을 제외해야 합니다. `controller`나 `JEV_WORKFLOW_POLICY=block`으로 Workflow가 거부되는 세션에서는 이 지침으로 우회하지 말고 기존 설정을 보존한 채 충돌을 보고하세요. 새 경로가 자동으로 훅을 해제하거나 권한을 넓히지는 않습니다.

아래는 **기존 `active`/`advisory` 경로**입니다. 새 `controller`에서는 이 Jev 선택 경로를 호출하지 않습니다.

```text
기존 Main이 목표를 이해하고 native 위임 호출을 제안
  → PreToolUse: 동의·capability·기존 설정·문서·revision 확인
  → Jev: 역할/범위/위험/추론/정보 충분성/문서 판단
  → 로컬 코드: 허용된 실제 모델×effort 후보 구성
  → Jev: 구체적인 선택/제외 기준으로 프로필 선택 또는 보류
  → 재검사: 작업 revision과 profile 파일 일치
  → active: 검토된 native 호출 변경 / advisory: 변경 없이 권고
  → 원래 호스트가 worker 실행·권한·승인을 담당
  → 기존 Main이 실제 근거를 확인하고 통합
```

### Claude `controller` (별도 opt-in)

```text
첫 부모 목표 → Main이 native Agent를 JEV:bootstrap:plan으로 위임 (Astra xhigh)
  → Astra가 목표·수용 기준·계약·작업 DAG를 제안; Main이 비공개 계획 파일로 기록
  → Main이 JEV:<task-id>로 위임 → 로컬 정책/confirmed 프로필/선행 수용 기록 검사
  → Luna high 연구, Sol high/xhigh/max 범위 확정 작업, Astra xhigh 경계·통합
  → native worker가 작업 → Main이 산출물과 실제 검사 근거를 확인하고 수용 기록
  → 계획 경계 변경이면 Astra에게 새 계획을 요청; Jev 의견은 선택적·비구속적
```

설치 시 `--runtime claude --mode controller`와 확인된 native 프로필이 필요합니다. 이 모드는 `Workflow`를 거부하고 Main의 직접 파일·shell·검색/MCP 도구를 거부하며, 메인에 열어 둔 예외는 스케줄링과 프로젝트의 **개인용** `.jev/controller-plan.json`·`controller-status.json` 접근뿐입니다. Worker에게 전달하는 `readPaths`/`writePaths`는 계획 **지시문이지 OS 수준 파일 sandbox가 아닙니다**. `controller-status.json`은 실제 native spawn·stop에 연결된 **Main의 수용 주장**을 확인하며, 테스트 성공이나 독립 채점의 증명이 아닙니다. 설치되지 않거나 신뢰되지 않은 hook, native 이벤트에 `agent_id`가 없는 worker, timeout/설정 오류는 정책 적용을 보장하지 않습니다. [사용법·schema·보안 경계](docs/CONTROLLER.ko.md)를 먼저 읽으세요.

Reporivet에서 가져온 원칙은 [AGENTS.md](AGENTS.md)의 짧은 정본 포인터와 기존 파일 보존·기계적 링크 확인뿐입니다. AgentOTelStack으로 보내는 OTLP protobuf trace는 `JEV_OTEL_ENABLED=true`와 실제 ingest 인증을 갖춘 경우에만 로컬 Gateway로 전송합니다. 여기에는 프롬프트·소스·경로 원문을 넣지 않습니다. **Gateway 수락은 저장·조회 성공이나 라우팅 품질 증거가 아닙니다.**

**기본값:** `shadow`, `JEV_ALLOW_EGRESS=false`, `JEV_SHARE_PLAN_CONTEXT=false`, `JEV_WORKFLOW_POLICY=warn`, `JEV_CODEX_REWRITE_APPROVED=false`, `JEV_CODEX_COLLABORATION_REWRITE_APPROVED=false`. 모델 registry의 가용성도 `declared`입니다. 설치만으로 외부 호출이나 강제 라우팅이 켜지지 않습니다.

**active도 모든 요청의 위임을 강제하지 않습니다.** Main이 native 위임을 선택했을 때 해당 경계에서 적용합니다. 사소한 직접 작업은 기존 Main이 처리합니다. `Workflow` 스크립트 안의 `agent()`에는 개별 native hook 경계가 없어 Jev가 모델·effort를 강제하지 못합니다. 명시적인 `JEV_WORKFLOW_POLICY=block`은 Claude active 세션의 모든 `Workflow`를 거부하여 native `Agent`/`Task` 위임을 요청할 뿐, 내부 worker를 직접 제어하거나 Main의 재위임을 보장하지 않습니다. Codex는 현재 `updatedInput`에 `allow`를 동반해야 하므로 별도 동의를 받기 전에는 active에서도 권고만 하며, `collaborationspawn_agent`에는 한 단계 추가 승인이 필요합니다.

## 품질 우선 모델×effort (기존 Jev 선택 경로)

아래 후보표는 `controller`의 고정 정책표가 아닙니다. 새 모드의 정확한 대응과 보류 규칙은 [controller 문서](docs/CONTROLLER.ko.md)에 있습니다.

| 작업 | 정상 후보 |
|---|---|
| 기계적 조회·정형 변환 | Sonnet/Luna high; 원래 Main 직접 처리 가능 |
| 실질적인 읽기·문서·범위 제한 구현 | **Sonnet/Luna xhigh와 max**, 필요하면 Opus/Sol high·xhigh |
| 여러 모듈의 계약·복합 구현 | Opus/Sol high·xhigh·max |
| 깊은 원인 추적·민감한 변경 검토 | Opus/Sol xhigh·max 또는 승인된 frontier |
| 계획·새로운 구조 | Fable/Astra high·xhigh |

실제 모델명과 지원 effort는 **사용자가 확인한 registry**를 따릅니다. 동일 effort 이름을 모델 간 동일 성능으로 간주하지 않습니다. `max`를 고르기 위해 이전 설정으로 먼저 실패할 의무가 없고, max로 실패해야 상위 모델을 고를 수 있는 것도 아닙니다. 가격·성공률을 만들어 넣지 않았습니다.

## 시작

Node **22.13+**, Python **3.11+**(검증기), Git, 기존 native 호스트가 필요합니다. 런타임 외부 패키지 의존성은 없습니다. macOS/Linux/WSL 대상이며 Windows native shell 설치는 검증하지 않았습니다.

**ultracode 계획 보조만 사용한다면 아래 hook 설치를 하지 않습니다.** 이 저장소의 얇은 진입점과 [별도 준비·dry-run 절차](docs/ULTRACODE.ko.md#입력과-명시적-동의)를 사용하세요. `node orchestration/bin/jev-plan.mjs --help`로 자문 CLI 계약을 확인할 수 있습니다.

다음은 로컬 검사와 **기존 native hook 설치** 예시입니다.

```bash
# 먼저 로컬 검증: 유료 API/실제 native 모델을 호출하지 않습니다.
bash scripts/test-all.sh

# 기존 hook 설치 입력 예시. 키는 프로젝트 밖에서 관리합니다.
cp orchestration/config/registry.example.json /tmp/jev-models.local.json
mkdir -p "$HOME/.config"
cp orchestration/.env.example "$HOME/.config/jev-setup.env"
chmod 600 "$HOME/.config/jev-setup.env"
# 모델 목록을 실제 접근/effort 지원 기준으로 편집하고, 확인한 항목만 availability=confirmed.
# env 파일에 TYPESAFE_API_KEY를 입력. 이 단계에서는 전송 동의는 false 유지.
node orchestration/scripts/install.mjs \
  --project /absolute/path/to/your-project --runtime both \
  --registry /tmp/jev-models.local.json \
  --env-file "$HOME/.config/jev-setup.env" --mode shadow --yes
```

자세한 키·모델·활성화·재설치·해제 순서는 [docs/SETUP.ko.md](docs/SETUP.ko.md)를 보세요. 프로젝트 `.jev/.claude/.codex` 폴더만 만드는 방식이 아닙니다. 이 버전은 사용자 HOME에 작은 runtime과 native hooks를 설치하고, 허용한 프로젝트에만 적용합니다.

**v2.3에서 이전할 때:** 기존 v2.3 설치 폴더의 `scripts/uninstall.py`로 프로젝트-local hooks를 먼저 분리하세요. 백업·키는 보존합니다. 이 설치기는 기존 project Jev hook이 남으면 중복 라우팅을 막기 위해 중단합니다.

## 독립 검증

```bash
python3 verification/verify.py --suite offline --sut ./orchestration \
  --out /tmp/jev-independent-offline
```

실계정 테스트는 별도 opt-in입니다. 기존 작은 함수 과제는 `--suite native`/`benchmark`, `--accept-costs`, 확인한 registry와 모델/effort 관측이 필요합니다. 동일한 실제 저장소 유지보수 작업의 `native / active / controller` pilot은 별도 [`verification/repo_compare.py`](verification/repo_compare.py)로 준비했습니다. 오프라인 결함 주입·참조 복구 canary와 실제 `native / controller` 두 과제의 품질·시간·CLI 토큰·표시 비용을 [기록](reports/REPOSITORY_PILOT_20260926.md)했으나, `active` 미실행 및 실제 청구액 부재로 세 조건·총비용 우위는 판정할 수 없습니다. [범위·실행 조건](docs/VERIFICATION.ko.md#같은-저장소-유지보수-작업의-3조건-pilot)을 보세요. verifier는 SUT를 import하지 않고 설치·stdin hook·native transcript·외부 테스트를 검사합니다. **이는 코드 경로의 분리이지 외부 기관의 인증이나 악성 코드 격리 보증이 아닙니다.**

[검증 방법](docs/VERIFICATION.ko.md) · [보안·한계](docs/SECURITY.ko.md) · [오프라인 결과](reports/VERIFICATION.md) · [실제 위임 반복 비교](reports/PLAN_ROUTING_COMPARISON_20260925.md) · [동일 데이터 웹 대시보드 1쌍·토큰/시간/브라우저 비교](reports/dashboard-benchmark-20260925/README.md) · [실제 판단 경계 감사](reports/DECISION_AUDIT_20260925.md) · [원본 출처](docs/source-inputs.json)

## 게시 상태

프로젝트 루트의 단일 Git 저장소에 `origin=https://github.com/gkrtjd99/Jev_Orchestration.git`을 연결했습니다. `orchestration/`과 `verification/`은 별개의 디렉터리이지만 독립 Git 저장소는 아닙니다. 원본 transcript·로그·개인 경로가 포함된 보고서 artifact는 공개 대상에서 제외합니다. 이전 integration의 GitHub 쓰기는 403으로 차단됐으며, **로컬 연결이나 커밋만으로 원격 업로드가 완료된 것은 아닙니다**. controller 실계정 pilot은 native와의 두 조건만 수행했고, 기존 `active`를 포함한 세 조건 비교는 남아 있습니다. [게시 범위와 현재 연결](docs/PUBLISH.ko.md)을 확인하세요.
