# 설치·환경·인증·이전

**ultracode에서 훅 없이 계획부터 Jev를 사용하는 새 경로는 [ULTRACODE.ko.md](ULTRACODE.ko.md)를 따르세요.** 아래 설치기는 기존 native hook용이며, 새 지침을 쓰기 위해 실행할 필요가 없습니다. 저장소의 `CLAUDE.md`·project skill은 다른 프로젝트나 사용자 HOME에 자동 배포되지 않습니다. 지침을 읽는 것과 실제 TypeSafe 전송 동의는 별개입니다.

## 1. 세 종류의 확인은 별개입니다

Claude/Codex의 기존 로그인은 native Main/worker 실행용입니다. **Jev는 TypeSafe API 키가 별도**입니다. API 키 존재, 모델 registry의 선언, 실제 native child 실행 확인도 서로 다릅니다. OAuth 토큰이나 `auth.json`을 오케스트레이션 env로 복사하지 마세요. production runtime은 native 인증 저장소를 읽거나 인증 자료를 수집하지 않습니다.

기존 Claude/Codex는 평소처럼 로그인하고 native 모델 접근을 확인합니다. 이 확장은 생성모델 API를 직접 호출하지 않습니다. 설치 후에도 Main 모델은 호스트에서 직접 선택합니다.

## 2. 모델 registry 준비

`orchestration/config/registry.example.json`을 개인 설정 파일로 복사하세요. JSON의 `models` 배열에서 각 항목을 편집합니다.

- `model`: 호스트에 요청할 실제 모델 ID 또는 명시적인 alias.
- `backend`: 확인된 실제 backend 모델. alias 이름으로 추측하지 않습니다.
- `supportedEfforts`: 해당 모델과 **실제 실행 경로**가 지원하는 값만 유지.
- `effortByIntent`: brief/balanced/deep/exhaustive를 지원 effort에 명시적으로 대응.
- `availability`: 확인 전 `declared`; 계정 접근/지원 설정을 확인한 것만 `confirmed`. 사용 불가는 `unavailable`.
- `capabilitySource`: 누가 언제 무엇으로 확인했는지. 이것은 실제 worker 실행 증거와 다릅니다.
- `resolvesTo`(선택): 이 항목이 host에서 **어떤 구체 모델 id로 기록되는지** 사용자가 확인해 적는 목록입니다. `model`/`backend`에 별칭(`opus`, `sonnet`)을 쓰면 host는 대화 기록에 자기가 풀어 낸 id를 적기 때문에, 이 선언이 없으면 그 항목의 평가 자료는 가져올 수 없습니다. 항목의 다른 키와 같은 층에 적습니다.

  ```json
  { "id": "claude-standard", "runtime": "claude", "slot": "standard", "model": "opus", "backend": "opus",
    "resolvesTo": ["<host가 기록한 id를 확인해서 적기>"], "...": "나머지 키는 그대로" }
  ```

  예제 파일에는 비활성 항목 `claude-micro`에 자리 표시 값(`EXAMPLE-ONLY.replace-with-the-id-your-host-records`)만 들어 있습니다. **실제 id가 아니므로 그대로 쓰지 말고**, 필요 없으면 줄을 지우세요. 넣을 값은 세션을 한 번 돌린 뒤 결과 수집기의 `--dry-run` 요약(`modelMatch.undeclared`)에서 확인합니다. 1~8개, 와일드카드 불가, 완전히 같은 문자열만 인정됩니다. `backend`가 구체 id이고 host가 같은 id를 기록하면 필요 없습니다. 이 필드를 추가·변경·삭제하면 그 항목의 프로필 fingerprint가 바뀌므로 **다시 설치**해야 하고, 그 전에 가져온 평가 자료는 세지 않게 됩니다. 순서와 규칙 전체는 [KERNEL의 "평가 행이 만들어지려면"](KERNEL.ko.md#평가-행이-만들어지려면)에 있습니다.

초기 role 정책은 light=Sonnet/Luna, standard=Opus/Sol, strategic=Fable/Astra입니다. 선택적 Haiku/micro는 비활성이고 없는 Codex micro 모델은 만들지 않습니다. 실제로 xhigh를 지원하지 않으면 그 값을 제거하고 모든 intent mapping도 일치하게 수정하세요. 조용히 effort를 낮추는 보정은 하지 않습니다.

가용성 확인이 없으면 자동 후보가 생기지 않습니다. 이름을 공식 문서에서 보았다는 사실만으로 모든 항목을 confirmed로 바꾸지 마세요.

### 품질 우선 모델×effort 후보 (기존 Jev 선택 경로)

아래는 `delegation.profile`이 고르는 후보의 기본 방향입니다. `controller`의 고정 정책표가 아닙니다(그 대응과 보류 규칙은 [controller 문서](CONTROLLER.ko.md)에 있습니다).

| 작업 | 정상 후보 |
|---|---|
| 기계적 조회·정형 변환 | Sonnet/Luna high; 원래 Main 직접 처리 가능 |
| 실질적인 읽기·문서·범위 제한 구현 | Sonnet/Luna xhigh와 max, 필요하면 Opus/Sol high·xhigh |
| 여러 모듈의 계약·복합 구현 | Opus/Sol high·xhigh·max |
| 깊은 원인 추적·민감한 변경 검토 | Opus/Sol xhigh·max 또는 승인된 frontier |
| 계획·새로운 구조 | Fable/Astra high·xhigh |

실제 모델명과 지원 effort는 사용자가 확인한 registry를 따릅니다. 동일 effort 이름을 모델 간 동일 성능으로 간주하지 않습니다. `max`를 고르기 위해 이전 설정으로 먼저 실패할 의무가 없고, max로 실패해야 상위 모델을 고를 수 있는 것도 아닙니다. 가격·성공률을 만들어 넣지 않았습니다.

### 지원 운영체제

macOS/Linux/WSL 대상입니다. Windows native shell 설치는 검증하지 않았습니다. 런타임 외부 npm 패키지 의존성은 없습니다.

## 3. env 준비

저장소 밖의 파일에 아래 형태로 저장하고 `chmod 600`을 적용합니다. `export`, 중복 key, 셸 명령 치환은 지원하지 않습니다.

```dotenv
TYPESAFE_API_KEY=YOUR_ACTUAL_KEY
JEV_MODEL=jev-latest
JEV_MODE=shadow
JEV_ALLOW_EGRESS=false
JEV_CONTROLLER_CRITIQUE=false
JEV_OTEL_ENABLED=false
JEV_OTEL_ENDPOINT=http://127.0.0.1:4318
JEV_CODEX_REWRITE_APPROVED=false
JEV_CODEX_COLLABORATION_REWRITE_APPROVED=false
JEV_RETAIN_PROMPT_TEXT=false
JEV_SHARE_PLAN_CONTEXT=false
JEV_WORKFLOW_POLICY=warn
JEV_MAX_EFFORT_ALLOWED=true
JEV_ALLOW_ECONOMY_CANDIDATES=false
JEV_READ_ADVICE=false
JEV_OBJECTIVE=balanced
JEV_EVALUATION_CONTEXT=native-default-unvalidated
```

`TYPESAFE_API_KEY` 이외는 이 확장의 설정입니다. `JEV_OBJECTIVE`는 비교 가능한 실제 자료가 없으면 가격/속도 최적화를 증명하지 않습니다. `JEV_EVALUATION_CONTEXT`는 평가 환경 식별자이며 기본 상태에서는 학습 자료를 사용하지 않습니다. 평가 자료를 모으려면 **세션을 돌리기 전에** 기본값이 아닌 이름으로 바꿔야 합니다. 기본값으로 돌린 세션은 나중에 이름을 붙여도 자료가 되지 않습니다.

이 설치기는 입력 env를 **`~/.config/jev-hooks/.env`로 복사**합니다. v2.3처럼 원래 외부 파일을 계속 참조하는 방식이 아닙니다. 설치 후에는 설치된 env를 바꾸거나, 원본 env를 변경한 뒤 재설치하세요. 셸 환경 변수가 같은 이름으로 설정돼 있으면 설치된 파일보다 우선합니다. `source`는 불필요합니다.

기본 endpoint는 TypeSafe의 공식 HTTPS origin만 허용합니다. custom gateway는 신뢰된 config에서 allowlist를 명시적으로 수정해야 하며, 일반 OpenAI chat-completions 주소를 대체 입력으로 넣지 않습니다.

## 4. 설치

```bash
node orchestration/scripts/install.mjs \
  --project /absolute/project --runtime both \
  --registry /absolute/models.local.json \
  --env-file /absolute/private-setup.env --mode shadow
# 위 명령은 계획만 출력합니다. 확인 후 --yes 추가:
node orchestration/scripts/install.mjs \
  --project /absolute/project --runtime both \
  --registry /absolute/models.local.json \
  --env-file /absolute/private-setup.env --mode shadow --yes
```

`--runtime claude` 또는 `codex`로 한 호스트만 설치할 수 있습니다. 설치 위치는 다음과 같습니다.

```text
~/.config/jev-hooks/config.json        # 프로젝트 allowlist, registry, 검증 조건
~/.config/jev-hooks/.env               # 비밀키, 동작 모드: owner-only
~/.config/jev-hooks/installation.json  # 소유 파일·hash
~/.local/share/jev-hooks/3.2.0/        # 작고 단일한 JS hook runtime
~/.local/state/jev-hooks/             # 캐시·메타데이터·명시적 평가 자료
~/.claude/settings.json + agents/    # 선택한 호스트만
~/.codex/hooks.json + agents/        # 선택한 호스트만
```

기존 Main 모델, 권한, 로그인, CLAUDE.md/AGENTS.md, `.codex/config.toml`은 바꾸지 않습니다. 기존 hooks는 병합하고 소유 파일이 편집돼 있으면 덮어쓰지 않습니다. 이전 project-local Jev hooks는 자동 삭제하지 않고 이전 절차를 요구합니다.

호스트를 재시작하고 `/hooks`에서 등록된 command를 검토/신뢰하세요. hook을 신뢰하는 것과 프로젝트를 신뢰하는 것은 별개일 수 있습니다. 설치기는 trust bypass를 등록하지 않습니다. 새 agent 정의도 호스트가 읽었는지 확인하세요.

## 5. 활성화 순서

### Claude controller (기존 active와 다른 opt-in)

`--runtime claude --mode controller`로 **설치 계획을 검토한 뒤** `--yes`를 선택하면, 모든 Claude `PreToolUse`를 관찰하는 matcher와 confirmed native 프로필이 설치됩니다. Main은 직접 구현/탐색/테스트를 하지 않고 native worker만 배정합니다. 프로젝트의 `.jev`를 owner-only(0700)로 **직접 준비**하고 [controller 계획·수용 규약](CONTROLLER.ko.md)을 따르세요. 기존 설정의 `JEV_MODE` 값만 `controller`로 바꾸면 설치된 matcher가 Main의 도구를 관찰하지 못할 수 있습니다. **반드시 재설치**하고 `/hooks` 등록을 확인하세요. Codex에는 이 모드의 프로필 자동 선택이 적용되지 않습니다.

Jev 보조 검사는 기본 꺼짐입니다. `JEV_CONTROLLER_CRITIQUE=true`, `JEV_ALLOW_EGRESS=true`, `JEV_SHARE_PLAN_CONTEXT=true`를 동시에 명시하면 계획·task 요약이 TypeSafe로 전달됩니다. `JEV_OTEL_ENABLED=true`는 별도의 선택적 로컬 OTLP 전송이며 실제 UUIDv4·ingest 자격증명 또는 `obs run`의 OTEL 환경이 필요합니다. 두 연결은 native 모델 로그인과 무관합니다. 빈 키·가상의 프로젝트 ID로 수집 성공을 주장하지 마세요.

### 기존 Jev 라우팅

설치된 env에서 먼저 `JEV_ALLOW_EGRESS=true`, `JEV_MODE=shadow`로 판단 로그만 확인할 수 있습니다. **이때부터 사용자 위임 텍스트와 제한된 문서 메타데이터가 TypeSafe로 전송됩니다.** 소스 본문 전체나 전체 대화를 자동 업로드하지 않습니다. 위임에 직접 넣은 코드는 위임 텍스트의 일부입니다.

`advisory`로 바꾸면 Main에 권고가 전달되지만 pending call은 바뀌지 않습니다. 그 호출이 이미 실행되는 상황에서 같은 일을 중복 worker로 다시 시작하지 않도록 권고에 명시했습니다.

Claude에서 적용을 원하면 `JEV_MODE=active`로 전환합니다. 확인된 registry와 설치 profile hash, 현재 revision이 일치하는 지원 호출만 변경합니다.

Codex는 현재 구현에서 `updatedInput`에 `permissionDecision: allow`를 동반합니다. 따라서 **`JEV_CODEX_REWRITE_APPROVED=true`를 별도로 설정하기 전에는 active에서도 권고만** 합니다. 실제 0.156.1에서 관측된 `collaborationspawn_agent`는 별도 `JEV_CODEX_COLLABORATION_REWRITE_APPROVED=true`까지 요구합니다. 이름과 입력 필드 관측은 native 응답의 권한 의미를 증명하지 않으므로 격리된 실제 실행에서 검증하기 전에는 켜지 마세요. 두 값은 모델 접근 확인이나 일반적인 sandbox 권한을 대신하지 않습니다. 알려지지 않은 입력이 있으면 변경하지 않습니다.

실제로 쓰는 방법은 원래 `claude` 또는 `codex`를 해당 프로젝트에서 실행하는 것입니다. 매번 Jev 명령은 필요 없습니다. Main이 native Agent/Task 또는 Codex spawn 위임을 제안하면 hook이 실행됩니다. 모든 프롬프트를 반드시 위임하거나 모든 도구 호출마다 Jev를 부르지는 않습니다.

계획 문맥은 기본적으로 **전송하지 않습니다**. 원한다면 `JEV_SHARE_PLAN_CONTEXT=true`를 명시하고, Main이 해당 프로젝트에 다음 JSON을 `.jev/routing-plan.json`으로 **권한 600**으로 작성하게 하세요. `goalHash`는 해당 부모 `UserPromptSubmit` 문장의 SHA-256입니다. 동의한 모드에서 hook이 Main에게 현재 해시와 작성 힌트를 제공합니다. 예시는 형태만 보여 주며, 해시를 추측해서 채우면 안 됩니다.

```json
{"schema":1,"goalHash":"<현재 부모 목표의 SHA-256>","summary":"작업 분해 및 판단 근거 요약","acceptance":"검증 조건","delegations":["worker별 예상 역할"]}
```

파일은 4 KiB 이하, `summary` 1,200자 이하, `acceptance` 600자 이하, 위임 항목 8개·각 160자 이하이며 목표 해시가 일치해야 합니다. native 호스트는 후속 내부 worker 프롬프트에서 부모/child 구분자를 제공하지 않을 수 있습니다. 이 경우 첫 프롬프트만 부모 후보로 유지하고 후속 출처가 불명확해지면 **계획·부모 텍스트 전송을 중지**합니다. 같은 세션의 다음 사용자 턴을 자동으로 새 부모 목표로 채택하지 않으므로, 새 목표의 계획 판단이 필요하면 새 native 세션을 시작하세요. 원문 계획이나 비밀값을 그대로 붙이지 마세요. 계획 파일은 hook이 직접 작성하지 않으며 기본 세션 상태에는 원문이 기록되지 않습니다. 해당 파일은 프로젝트에 남으므로 필요 없을 때 직접 관리하세요. `JEV_RETAIN_PROMPT_TEXT=true`도 함께 **명시적으로** 선택하면 저장된 부모 프롬프트 중 가림 처리된 최대 700자를 Jev 판단에 추가합니다. 간단한 가림 처리는 완전한 비밀정보 차단이 아닙니다.

Claude `Workflow`의 내부 `agent()`에는 worker별 `PreToolUse`가 없어 Jev가 해당 모델·effort를 바꿀 수 없습니다. 기본 `JEV_WORKFLOW_POLICY=warn`은 `Workflow`를 변경 없이 관측하고 그 한계를 고지합니다. **Claude `active` 모드에서만** 설치된 개인 env에 `JEV_WORKFLOW_POLICY=block`을 명시하면 모든 `Workflow` 호출(이름 있는 저장된 workflow 포함)의 `PreToolUse`를 거부하고 Main에 native `Agent`/`Task` 위임을 요청합니다. Workflow 스크립트를 자동 변환하거나 내부 worker를 라우팅하는 기능은 아닙니다. 해당 workflow가 worker를 전혀 사용하지 않아도 거부합니다. 다른 모드와 Codex에는 이 차단 정책이 적용되지 않습니다.

`block` 사용 전: 신뢰한 hook 등록, 확인된 model registry, `JEV_ALLOW_EGRESS=true`, native profile 파일의 정상 설치를 각각 검증하세요. native 호출 자체는 Jev 분류/선택이 보류되거나 명시 모델·custom agent·resume·강제 모델 환경변수·nested 위임이 있으면 변경 없이 실행될 수 있습니다. `block`은 전체 worker가 Jev 통제 아래 있다는 보장이 아닙니다. `Workflow` 거부 후 Main이 재위임했는지도 실제 `Agent`/`Task` 이벤트로 확인해야 합니다. 해제하려면 `JEV_WORKFLOW_POLICY=warn`으로 되돌리거나 `JEV_MODE=off`로 중단하고 새 세션에서 확인하세요. 기본 차단 동작을 켜거나 사용자 권한을 우회하지 않습니다.

## 6. 연결과 실행을 따로 확인

```bash
node orchestration/scripts/doctor.mjs
# 고정된 작은 예문으로 실제 Jev 요청 1회. 유료 사용량 발생 가능:
node orchestration/scripts/doctor.mjs --live --yes
```

doctor의 HTTP 성공은 인증/응답 확인이며 native child 성공이 아닙니다. profile manifest도 실제 모델 적용의 증거가 아닙니다. 최종 확인은 `hook → Jev 응답 → native 요청 → child 관측 → 외부 검증` 순서입니다. `verification/verify.py`의 paid native suite는 이 구분을 검사합니다.

## 7. 이전·중단·해제

v2.3의 기존 패키지에서 `python3 scripts/uninstall.py`로 project hooks를 분리하고, 기존 `.jev`·env·사용자 파일을 백업/보존하세요. 새 설치기는 남은 `.claude/settings.local.json` 또는 `.codex/hooks.json`의 Jev command를 발견하면 중단합니다. `mkdir`나 여러 ZIP 덮어쓰기로 업데이트하지 않습니다.

optimized 0.4의 사용자-home 설치는 동일 installer manifest를 활용하되, 새 registry와 env를 명시적으로 검토하세요. 기존 설정을 그대로 가용성/동의 증거로 인정하지 않습니다. 이전 버전의 저-effort registry가 남으면 품질 후보가 줄어들 수 있습니다.

즉시 중단은 설치된 env의 `JEV_MODE=off`입니다. 해제 계획은 `node orchestration/scripts/uninstall.mjs`, 실제 해제는 같은 명령에 `--yes`입니다. 키·상태·백업은 지우지 않으며 사용자가 편집한 agent 파일도 보존합니다.

## 문제 해결

권고가 없으면 순서대로 확인하세요: 프로젝트 allowlist → hook trust/실행 경로 → mode/egress → confirmed 모델 → 지원 effort → profile hash → API 키/네트워크 → 실제 native 위임 여부. API 401을 native 로그인으로 해결하려 하지 마세요. hook이 무시되면 실제 설치 호스트 버전과 지원 이벤트를 확인하세요.

현재 revision scan은 알려진 build/cache/비밀 경로를 제외하고 2,500 entries/16 MiB 텍스트 범위를 로컬에서 해시합니다. 범위를 넘거나 symlink를 만나면 자동 라우팅을 보류하고 원래 native 경로를 유지합니다. 큰 저장소 지원은 task-scope 증거를 갖춰 별도로 검증해야 합니다. 훅은 OS 보안 경계가 아닙니다.
