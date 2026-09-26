# Claude controller 운영 규약 (실험적·명시적 opt-in)

## 권한과 실제 제어 경계

- **Astra** (`strategic`, `xhigh`)는 목표 해석, 수용 기준, 공유 계약, 작업 DAG와 경계 변경의 재계획을 맡습니다. Main이 `JEV:bootstrap:plan` native 위임을 먼저 만들어야 합니다. hook은 파일 내용을 검사하지만 **작성자가 실제 Astra였다는 인증을 하지 못합니다**.
- **Main**은 native `Agent`/`Task` 위임 생성·동적 재배정·상태 확인·수용 근거 판단만 담당합니다. 현재 Claude `PreToolUse` matcher는 모든 도구를 관찰해, Main으로 보고된 호출의 파일·셸·검색·MCP 도구를 거부하고 스케줄링 도구 및 아래의 사설 계획·상태 파일만 허용합니다. `Workflow`는 내부 worker의 개별 라우팅 경계가 없어서 거부합니다. Main은 시작한 작업을 완료·검증했다고 추측하면 안 됩니다.
- **Native worker**가 실제 파일 읽기·구현·실행·검토를 합니다. 로컬 정책은 confirmed 모델·설치된 프로필 해시를 재검사하고 native 요청을 변경하되, **`permissionDecision: allow`를 반환하지 않습니다**. 프로젝트 내 `writePaths`는 worker에게 전달되는 계약이지 OS 권한이나 파일 접근 차단 목록이 아닙니다. native profile과 호스트 권한·사용자 승인·테스트가 별도로 필요합니다.
- **Jev**는 기본값에서 호출되지 않습니다. `JEV_CONTROLLER_CRITIQUE=true`, `JEV_ALLOW_EGRESS=true`, `JEV_SHARE_PLAN_CONTEXT=true`를 모두 명시하면 task·plan 요약·경로를 TypeSafe API로 보내 누락 가능성 점수를 받습니다. 점수는 기록·경고만 하며 모델·effort·실행 허가·성공 판정에 사용되지 않습니다. 네트워크 오류도 라우팅 근거로 삼지 않습니다.
- 기존 `active`/`advisory`/`shadow`는 별도 경로입니다. `controller`를 켜면 기존 Jev 자동 분류·모델 선택은 **실행되지 않습니다**. Codex hook은 이 모드에서 라우팅하지 않습니다.

## 설정과 첫 위임

1. 사용자의 Claude 모델 계정/effort 지원을 확인한 **개인용** registry를 프로젝트 밖에 준비합니다. 예시는 `orchestration/config/registry.example.json`입니다. 모델 ID는 설치된 호스트가 받는 실제 값이고 `light=Luna`, `standard=Sol`, `strategic=Astra` 대응은 사용자가 확인한 registry에 따라야 합니다. 미확인(`declared`) 프로필은 거부합니다.
2. 프로젝트에 비공개 디렉터리를 준비합니다: `mkdir -m 700 .jev` (이미 있다면 소유권·symlink 여부·권한을 확인). hook은 이것을 대신 생성하거나 기존 사용자 파일을 덮어쓰지 않습니다. `.jev/`는 저장소의 `.gitignore` 대상입니다. 호스트에 설치 전 명령을 직접 수행할 때에는 사용자가 해당 파일 변경을 확인해야 합니다.
3. 설치 계획을 먼저 출력한 뒤 내용을 확인하고 실제 설치를 선택합니다:

```bash
node orchestration/scripts/install.mjs --project /absolute/project --runtime claude \
  --registry /absolute/models.local.json --env-file /absolute/private-setup.env \
  --mode controller
# 백업·hook 설정·native 프로필 파일을 확인한 경우에만 위 명령 끝에 --yes 추가
```

설치 위치와 사용자 파일 보존은 [SETUP.ko.md](SETUP.ko.md)에 있습니다. `JEV_MODE`만 수동으로 바꾸면 이미 설치된 `PreToolUse` matcher가 새 도구를 관찰하지 못할 수 있으므로 **모드 전환 시 설치기를 재실행**하고 `/hooks`에서 신뢰·범위를 확인하세요. 명시적으로 `off`로 중지한 뒤 재설치할 수 있습니다. 설치나 trust 오류에서 훅 강제는 보장되지 않습니다.

4. 새 native 세션의 첫 `UserPromptSubmit`에서 hook이 **첫 관측 목표 해시**를 Main에 돌려줍니다. Main은 원본 사용자 목표를 Astra `Agent`/`Task`에 `description: JEV:bootstrap:plan`으로 위임합니다. 추가 근거가 필요하면 한정된 `JEV:bootstrap:research`(보통 Luna high), 계약 독해에는 `JEV:bootstrap:contract`(Sol xhigh)를 요청할 수 있습니다. 초기 위임만으로 Astra 계획이 자동 파일에 저장되지는 않습니다. Main은 Astra의 계획 결과를 읽고 파일을 기록합니다.
5. Astra가 task별 결과·계약·선행 관계를 JSON schema 2로 제안하면, Main은 `.jev/controller-plan.json`을 **비공개 디렉터리**에 기록합니다. hook은 파일 owner, 일반 파일 여부, symlink, 32 KiB 제한, 목표 SHA-256 일치와 구조·경로·DAG·병렬 쓰기 충돌을 검사합니다. 디렉터리가 owner-only(0700)이면 일반 editor가 만든 0644 파일도 타인이 순회해 읽을 수 없으나 가능하면 파일 자체도 0600으로 유지하세요. 파일을 외부로 이동하거나 공유하는 경우에는 이 보호가 적용되지 않습니다.

```json
{
  "schema": 2,
  "goalHash": "<첫 UserPromptSubmit이 돌려준 정확한 64자리 SHA-256>",
  "version": 1,
  "summary": "목표와 공유 계약을 요약하되 비밀값을 쓰지 않음",
  "tasks": [
    {
      "id": "find-evidence",
      "phase": "research",
      "summary": "기존 구현과 API 근거를 찾음",
      "acceptance": "필요한 계약·파일 위치와 불명확한 부분을 보고함",
      "dependencies": [],
      "readPaths": ["src"],
      "writePaths": [],
      "risk": "normal",
      "complexity": "bounded",
      "reasoning": "routine",
      "uncertain": false,
      "interfacesChanging": false,
      "highLoss": false,
      "information": "sufficient"
    }
  ]
}
```

`phase`는 `research|contract|plan|implement|debug|test|tool|review|integration`, `risk`는 `normal|sensitive|destructive`, `complexity`는 `small|bounded|broad`, `reasoning`은 `routine|deep|novel`, `information`은 `sufficient|missing`입니다. `test`는 **독립 테스트 설계·검토(read-only)**, `tool`은 실제 실행입니다. 구현·통합용 task에만 필요한 쓰기 경로를 넣으세요. `.git`, `.claude`, `.codex`, `.jev`, 비밀 경로 등은 계획 경로가 될 수 없습니다. 경로 충돌은 디렉터리 선행 관계가 없는 작업 사이에서도 차단합니다.

6. Main은 **별개의 native 호출마다** `description: JEV:<task-id>`를 지정합니다. 계획 task의 실제 worker 프롬프트는 plan packet으로 **대체**되므로 Main의 임의 프롬프트가 계약에 추가되지 않습니다. 정보가 부족하면 보류하고, 계획 또는 프로필이 바뀌면 새 호출을 만들거나 Astra에게 재계획을 부탁합니다. `resume` 및 명시된 모델/effort 덮어쓰기는 controller 재라우팅이 아닙니다.

### 로컬 후보 정책

| 명시된 작업 상태 | 선택 프로필(설치·확인된 경우) |
|---|---|
| 일반 근거 탐색 | Luna/light `research/high` |
| 민감하거나 불확실한 근거 탐색 | Sol/standard `research/xhigh` |
| 계약 해석·독립 리뷰·테스트 설계 | Sol/standard `review/xhigh` |
| Astra 계획, 변경되는 인터페이스, 새로운 구조, 높은 손실 | Astra/strategic `xhigh` (단계별 `plan`/`implement`/`review` 역할) |
| 작고 확정된 일반 구현·실제 도구 실행 | Sol/standard `implement/high` |
| 그 밖의 구현·민감하거나 불확실한 구현 | Sol/standard `implement/xhigh` |
| 깊고 범위가 닫힌(`complexity=bounded`) 디버깅 | Sol/standard `implement/max` (`JEV_MAX_EFFORT_ALLOWED=false`이면 xhigh; 넓은 디버깅도 xhigh) |
| 교차 패치 통합 | Astra/strategic `implement/xhigh` |

`information=missing` 또는 confirmed 프로필 부재는 보류합니다. `risk=destructive`는 근거 수집을 제외하고 인간 승인 전의 작업을 보류합니다. 분류값은 **Astra 계획의 선언**이지 모델 품질 측정값이 아닙니다. 손실이 큰 작업은 `highLoss=true`로 조기에 전략 프로필을 선택하되 이 선택도 사용자 권한을 대체하지 않습니다.

## 선행 작업의 수용과 재계획

의존성이 있는 작업은 `.jev/controller-status.json`이 없거나 현재 계획 *내용 해시*와 일치하지 않거나 선행 작업의 native route→worker start→stop 및 같은 위임 ID에 대한 성공한 PostToolUse의 `agentId`를 연결할 수 없으면 **거부**됩니다. 동기 `Agent`에서 stop은 PostToolUse보다 먼저 올 수 있으므로 둘 사이의 고정 순서를 요구하지 않습니다. Main이 독립적으로 검사한 artifact의 SHA-256을 확인하고 직접 기록하는 **수용 주장** 형태입니다:

```json
{
  "schema": 1,
  "goalHash": "<계획과 동일한 목표 SHA-256>",
  "planRevision": "<controller-plan.json의 정확한 파일 바이트 SHA-256>",
  "accepted": [
    {"taskId":"find-evidence","toolUseId":"<실제 위임 호출 ID>","agentId":"<실제로 관측된 ID>","evidenceHash":"<수용 검사 자료의 SHA-256>"}
  ]
}
```

파일의 실제 바이트 hash를 사용하므로 개행을 바꿔도 다시 계산해야 합니다. Main은 `Bash`로 검증하지 않고 native tool worker에게 해시 및 검사 결과를 요청할 수 있습니다. 훅은 관련 worker가 **중지했다는 이벤트**와 Main 기록의 연결만 확인합니다. `evidenceHash`로 해시된 자료의 내용·테스트 성공·Astra 작성 여부를 독립적으로 인증하지 않습니다. worker 완료·Jev 점수·OTel span을 수용 성공으로 간주하지 마세요. 계획의 경계·계약이 변경되면 Astra 재계획→`version` 증가→새 내용 해시→필요한 수용 재검토 순서로 진행합니다. task 사이 원문 비교나 파일별 write 권한 강제는 구현되어 있지 않습니다.

## 선택적 AgentOTelStack 계측

`JEV_OTEL_ENABLED=true`를 개인 env에 명시해야 합니다. `obs run`은 실제 workspace UUIDv4를 `OTEL_RESOURCE_ATTRIBUTES`의 `agentotel.project.id`, **ingest 토큰**을 `OTEL_EXPORTER_OTLP_HEADERS`의 `Authorization=Bearer%20...`에 제공합니다. 또는 별도의 `JEV_OTEL_PROJECT_ID=<UUIDv4>`·`JEV_OTEL_INGEST_TOKEN=<ingest token>`을 프로젝트 밖 개인 env에 기록합니다. 두 경로가 동시에 설정되고 서로 다르면 송신하지 않습니다. query token은 사용하지 않습니다. 대상은 정확한 `http://127.0.0.1:4318` (또는 IPv6 loopback의 동일 포트)이며 Gateway의 `/v1/traces`로 인증된 **OTLP protobuf**를 보냅니다. 외부 호스트/다른 포트/redirect는 허용하지 않습니다. `obs run` 자체만으로는 Jev hook을 계측하지 않으므로 opt-in이 필요합니다.

세션 trace에 `session_started`, 라우팅 선택·보류, native 위임 결과, 보고된 worker 시작·중지와 정책 거부를 이벤트로 연결합니다. 허용된 enum과 불투명한 식별자 hash만 속성에 넣고 프롬프트·계획 내용·소스·파일 경로·토큰·원문 오류는 보내지 않습니다. 훅의 로컬 `telemetry_delivery`는 *Gateway 응답* 또는 실패 코드만 나타냅니다. 실제 Collector/저장/조회 확인이나 성능 인과 관계는 아닙니다. 연결 오류는 라우팅을 바꾸지 않지만 전송 기다림이 최대 약 400ms 추가될 수 있습니다. 실행하지 않은 실 Gateway 시험을 완료로 표기하지 마세요.

## 제한과 검증

native callback에 `agent_id`가 없으면 Main인지 worker인지 확실히 구별할 수 없어 worker 도구가 Main 직접 작업으로 거부되거나 알 수 없는 worker가 별도 경계를 우회할 수 있습니다. hook은 파일 접근 sandbox·인증된 planner·완전한 actor 판별기가 아닙니다. 모든 직접 도구 matcher 등록과 정상 hook 실행이 필요하며 callback 미전달·timeout·설정 로드 오류는 실패 차단을 보장하지 않습니다. 오프라인 unit·설치된 stdin hook·모의 OTLP 수신 검사는 [controller 테스트](../orchestration/test/controller.test.mjs)에 있지만, **실제 Astra/Sol/Luna worker 배정의 산출물 품질·총비용·AgentOTelStack 수집/조회는 별도 실계정 시험이 필요**합니다. 방법은 [검증 문서](VERIFICATION.ko.md)를 따릅니다.

참고 원칙: [Reporivet의 진입점 전용 ADR](https://github.com/gkrtjd99/Reporivet/blob/main/docs/decisions/ADR-0002-entrypoint-only-boundary.md) · [AgentOTelStack 연결](https://github.com/gkrtjd99/AgentOTelStack/blob/main/docs/CONNECT.md) · [Gateway ingest 계약](https://github.com/gkrtjd99/AgentOTelStack/blob/main/src/gateway/cmd/gateway/main.go). 외부 코드를 이 저장소에 복사하거나 외부 서버에 자료를 게시하지 않았습니다.
