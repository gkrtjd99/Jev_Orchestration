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

## 권한 모드 `auto`: 거부된 뒤 다시 발행되는 위임

Claude Code의 권한 모드 `auto`에서는 host가 hook이 고친 호출을 한 번 거부합니다. host의 안전 분류기는 Main이 낸 입력을 검토하는데, 그 뒤에 hook이 입력을 바꾸면 실제로 실행될 내용은 검토받지 않은 것이 되기 때문입니다. host는 실행 전에 그 호출을 오류로 돌려주면서 hook이 만든 입력을 Main에게 보여 주고, 같은 입력으로 한 번 더 호출하라고 알립니다. Main은 다음 응답에서 **새 `tool_use_id`** 로 그 입력을 그대로 다시 발행하고, 이번에는 검토를 거쳐 실행됩니다.

이 거부는 host의 안전 장치입니다. 이 확장은 우회하지 않습니다. Claude 호출에 `permissionDecision: allow`를 돌려주지 않고, 재작성을 숨기지도 않습니다.

실제 데스크톱 세션 2개(전역 `active`)에서 본 것은 이렇습니다.

- 위임 16건 중 15건이 거부된 뒤 다시 발행됐습니다. 나머지 1건은 라우팅이 보류되어 재작성이 없었습니다.
- 다시 발행된 입력은 hook이 돌려준 `updatedInput`과 해시가 같았습니다(15/15). 추가되거나 빠진 필드는 없고 키 순서만 달랐습니다.
- 거부된 호출에는 `PostToolUse`도 `PostToolUseFailure`도 오지 않았습니다(0/15). 실패로 분류된 적도 없습니다. 그래서 "Post hook이 한 번도 오지 않은 호출"만 거부된 것으로 봅니다.
- 첫 호출의 결정 기록과 다시 발행된 호출의 결정 기록 사이는 5.6~10.8초였습니다(Main 대화 기록의 호출 시각으로는 최대 12.6초).

수정 뒤 실제 세션 1개(전역 `active`, 위임 3건)에서 다시 확인했습니다. 3건 모두 거부된 뒤 다시 발행됐고, hook은 5.1~15.6초 뒤의 재발행을 인식했으며 그 호출에 judge 요청은 0건이었습니다(`qa/kernel/results/real-session-reissue-20261125/summary.json`, [검증 상태](#재발행-수정-뒤-실제-세션-재확인)).

다시 발행된 호출에 이 확장이 하는 일은 다음과 같습니다.

| 상황 | 동작 |
|---|---|
| 입력 해시가 이 세션에서 이 확장이 돌려준 재작성의 해시와 같고, 그 재작성이 120초 이내이며, 원래 호출에 Post hook(`PostToolUse`·`PostToolUseFailure`)이 한 번도 오지 않았고, 다른 호출이 아직 그 결정을 가져가지 않음 | **재발행**으로 봅니다. judge를 부르지 않고, 다시 고치지 않고, 보존된 호출과 같은 빈 출력을 돌려줍니다. 새 `tool_use_id`를 원래 결정(route, skill 블록, skill 이벤트, 결정 id)에 연결하고 세션 이벤트 `delegation_reissued`를 한 건 남깁니다(두 `tool_use_id`, 결정 id, 프로필, 입력 해시, 경과 시간. 텍스트 없음) |
| 재발행은 아니지만(결정을 이미 다른 호출이 가져감, 원래 호출에 Post hook이 이미 옴, 120초 경과, 색인 잠금 실패) 입력 해시가 이 세션에서 **현재 정책으로** 돌려준 재작성의 해시와 같음 | **반복**으로 봅니다. 입력 전체(과제 글, 프로필, packet, skill 블록)가 이 확장이 만든 것과 byte 단위로 같으므로 다시 판단하지 않고 그대로 둡니다. 새 id를 그 저장된 route에 연결하고 `delegation_repeated`를 남깁니다. 실행 접수 매핑, supervisor, 실패 귀속(`taskSignature`·`profileId`)이 이 호출에도 동작합니다. 다시 라우팅하지 않았으므로 **재시도 단계 상승은 적용되지 않습니다.** 그 과제에 실패 기록이 있으면 Main에게 그 사실과 "원래 과제 글로 다시 위임하면 재시도 라우팅을 받는다"는 안내를 `additionalContext`로 보여 줍니다(전역 `shadow`에서는 기록만) |
| 위 둘에 해당하지 않는데(상태 유실, 다른 세션, 정책 변경, Main이 직접 적은 packet) 호출이 관리 프로필(`jev4_*`)을 지정하고 prompt가 이 확장이 붙이는 꼬리 그대로 **끝남**(빈 줄, routing packet, 고정 문장, 선택적으로 빈 줄과 `<jev-skills>` 블록 하나) | 아무것도 건너뛰지 않습니다. 꼬리를 뗀 **앞부분의 과제 글**로 다른 호출과 똑같이 라우팅합니다(분류, 프로필 선택, skill, `minimumConfidence`, 재시도 단계, `failureMode`). 재작성에는 packet이 하나만 붙습니다. 새 결정이 들어온 입력과 byte 단위로 같으면 고칠 것이 없으므로 빈 출력을 돌려주고 route는 저장합니다. `routing_packet_unverified`를 남깁니다 |
| 그 밖의 호출(관리 프로필이지만 꼬리가 없거나 packet이 prompt 중간에 있음, 관리 프로필이 아닌 호출이 packet 모양 텍스트를 담음) | 이전과 같이 prompt 전체를 과제로 라우팅합니다 |

- 재발행으로 연결된 뒤에는 실행 접수(`spawn_observed`), agent id → 위임 매핑, hand-back, supervisor가 모두 **실제로 실행된 호출의 id** 로 동작합니다. 세션 요약에는 위임이 한 건으로 보입니다. 반복은 원래 호출 옆에 자기 id로 따로 보입니다.
- 결정 하나는 재발행으로 한 번만 넘겨줍니다. 같은 과제를 일부러 두 번 위임하면 결정도 두 개이고, 각 결정이 자기 재발행 하나와 연결됩니다(먼저 만든 결정부터). 그 뒤에 같은 입력이 또 오면 재발행이 아니라 반복입니다.
- 120초는 pilot에서 관찰된 최대 간격(12.6초)의 약 10배, 재확인 세션에서 관찰된 최대 간격(15.6초)의 약 7.7배입니다. 120초보다 늦은 재발행은 실제 세션에서 본 적이 없습니다. 같은 입력에 대해 기억하는 재작성은 최근 8건입니다. 재작성 색인(`sessions/<세션>/rewrites/`)에는 해시와 `tool_use_id`만 있습니다. 색인 파일이 깨져 있으면 빈 색인으로 읽고, 잠금이 남아 있어 재발행 연결을 못 하면 `reissue_lookup_failed`를 남긴 뒤 잠금 없이 읽는 반복 확인으로 넘어갑니다. 어느 경우에도 hook 오류나 `failureMode: block`의 거부가 되지 않습니다.
- 거부는 과제 실패가 아닙니다. `failure.classify`를 부르지 않고, `failure` 이벤트를 남기지 않고, 요청 한도·circuit·재시도 단계에 들어가지 않습니다. 실행된 서브에이전트의 실제 실패는 이전과 같이 처리하며, 원래 route에 귀속됩니다.
- **host가 알린 실패는 지우지 않습니다.** Post hook이 실패를 알린 호출은 "거부된 호출"로 보지 않으므로 그 뒤의 같은 입력은 재발행이 아니라 반복이고, 실패 기록은 재시도 단계에 그대로 남습니다. 거부를 도구 실패로 알리는 host와, 서브에이전트가 실제로 시작해 오류로 끝난 경우를 구별할 수 없기 때문입니다. 재발행이 연결된 **뒤에** 거부된 id로 실패가 오는 순서도 같은 결과입니다(실패가 세어지고, 그 id가 세션 요약에 `spawn_failed`로 보임). 두 순서 모두 관찰된 적은 없습니다(0/15).
- 실패한 뒤 Main이 재시도할 때 **고쳐진 입력을 그대로 다시 내면** 반복으로 처리되어 같은 프로필로 실행됩니다(위 안내가 뜹니다). 재시도 단계 상승은 **원래 과제 글**로 다시 위임할 때 적용됩니다. 실제 세션에서 실패가 없었으므로(양쪽 `spawn_observed` 실패 0건) Main이 재시도를 어떤 입력으로 내는지는 관찰하지 못했습니다.
- prompt 안의 routing packet 모양은 출처 증명이 아니며 **어떤 판단도 건너뛰게 하지 않습니다.** 다시 판단하지 않는 근거는 packet이 아니라 "입력 전체의 해시가 이 세션이 저장한 재작성과 같다"는 것뿐입니다. Main이 등록된 `jev4_*` 프로필을 직접 고르고 packet을 적어 넣어도 과제는 분류되고 프로필은 라우팅 결과로 바뀝니다. 꼬리를 떼는 것은 packet을 과제 글로 판단하거나 packet이 두 번 붙는 것을 막기 위한 것이고, prompt 끝의 정확한 꼬리에만 적용합니다. 그 결과 Main이 꼬리 형태를 직접 적어 넣었다면 그 꼬리(직접 적은 `<jev-skills>` 블록 포함)는 이 확장의 것으로 바뀝니다.
- 같은 `tool_use_id`가 **다른 입력**으로 다시 오면 재발행·반복으로 연결된 id도 다른 id와 똑같이 `TOOL_ID_REUSED_WITH_DIFFERENT_INPUT`(또는 정책·작업공간 변경 경고)를 받습니다. 같은 입력의 재전송만 조용히 같은 답을 받습니다.
- 전역 `shadow`·`advisory`에서는 재작성이 없으므로 색인도 없고, 재발행·반복 연결은 일어나지 않습니다. 꼬리로 끝나는 관리 프로필 호출은 그 모드에서도 앞부분의 과제 글로 판단합니다.

**비용.** `auto` 모드에서 재작성된 위임은 Main 왕복이 한 번 더 듭니다(거부 응답을 읽고 다시 호출). 이 확장은 이 왕복을 없앨 수 없습니다. 없애려면 `auto` 모드를 쓰지 않거나, 전역 모드를 `advisory`로 두어 재작성 자체를 하지 않아야 합니다. 이 확장이 없앤 것은 그 두 번째 호출에서 하던 중복 판단입니다. 수정 전 pilot에서는 다시 발행된 호출마다 라우팅 judge 2건을, skill 지점이 켜진 arm B에서는 skill judge 2건도 한 번 더 썼고(arm A 재발행 7건 × 2 = 14건, arm B 재발행 8건 × 4 = 32건, 합쳐 두 세션의 judge 요청 94건 중 46건. `qa/kernel/results/pilot-20261125/compare.txt`), 이미 packet이 붙은 prompt를 과제로 판단해서 15건 중 2건은 실제로 실행된 것과 다른 프로필을 기록했습니다. 수정 뒤 실제 세션에서는 재발행 3건에 judge 요청이 0건이었습니다.

Codex는 실제 세션에서 실행한 적이 없어 이 거부가 생기는지 알 수 없습니다. 인식 규칙은 runtime과 무관하게 "돌려준 입력의 해시"만 보므로 설계상 Codex spawn에도 같은 방식으로 적용되지만, 실제 Codex 세션에서 확인한 것은 아닙니다.

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
4. **대기 중 기록.** 판정 결과(outcome, 확신, 근거 수준, 표시 여부, `decisionId`, agent id, 보고 전체의 해시, 보고 줄 수와 줄 해시 최대 128개, 시각)는 세션 디렉터리의 `handbacks/`(0700, 파일 0600)에 **hand-back마다** 작은 기록으로 남습니다. judge를 부르기 **전에** `in_flight` 표시를 먼저 씁니다. 보고 텍스트, prompt 텍스트, **조언 문구는 저장하지 않습니다.** agent 하나당 최근 4개의 기록만 두고, 새 hand-back을 기록할 때 그보다 오래된 기록과 그 표시 파일을 지웁니다. 위임당 판정 횟수를 세는 표시 파일(최대 4개)은 남습니다.
5. **전달.** Main의 `UserPromptSubmit`이 hand-back 머리말로 시작하면 agent id를 엄격한 패턴(`[A-Za-z0-9_-]{1,128}`)으로 읽습니다. 나머지 prompt는 신뢰하지 않는 텍스트이고 의미를 읽지 않으며, 본문은 **줄 단위 해시로만** 씁니다. 조언은 아래를 모두 만족할 때 `additionalContext`로 **한 번** 돌려줍니다.
   - prompt 전체가 agent-message 요소 하나입니다(닫는 태그 뒤에 글이 붙은 prompt는 조언을 받지 않고, 전달 기회도 쓰지 않습니다).
   - 그 세션에 **같은 agent, 같은 보고**의 hand-back 기록이 있습니다. 보고가 같은지는 아래 [보고와 prompt의 결합 규칙](#보고와-prompt의-결합-규칙)으로 정합니다. 그 agent의 다른 hand-back(이전 것, 다른 prompt를 이미 보증한 것)은 이 prompt의 기록이 아닙니다. 그런 기록만 있으면 기록이 없을 때와 똑같이 유예(250ms) 동안 이 prompt의 기록을 기다립니다. 그래서 이전 hand-back의 조언이 다음 보고에 붙거나, 한 agent가 연달아 보낸 두 보고의 조언이 서로 바뀌지 않습니다.
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

#### 보고와 prompt의 결합 규칙

hand-back 기록과 prompt는 텍스트를 저장하지 않고 해시로만 묶습니다(`handbackReportBinding()`, `handbackPromptMatches()`).

**실제 세션에서 본 prompt 형태 두 가지.** 둘 다 첫 줄은 `<agent-message from="<agent id>">`, 둘째 줄은 `[Subagent hand-back] `로 시작하는 긴 한 줄, 마지막 줄은 `</agent-message>`입니다.

| | 셋째 줄부터 |
|---|---|
| 알림 없음 (첫 번째 실제 세션) | 곧바로 보고. 모든 줄이 두 칸 들여쓰기 |
| 알림 있음 (두 번째 실제 세션, commit `d82c345`) | 두 칸 들여쓴 `[harness: subagent output matched instruction-shaped pattern(s): ...` 한 줄, 들여쓴 빈 줄, 그다음 보고. 이 알림은 harness가 보고 안의 control tag를 `<` → `<\` 로 바꿀 수 있다고 말함 |

이전 규칙(셋째 줄부터 닫는 태그 전까지를 통째로 해시)은 알림이 있는 형태에서 **절대 일치할 수 없었습니다.** 두 번째 실제 세션에서 `SubagentHandback`은 정상 판정됐지만(274ms) 70ms 뒤의 prompt는 `unverified_prompt`로 기록됐고, 그런 hand-back에서는 조언 전달도 `handback_prompt` 보증도 일어날 수 없었습니다.

**기록에 남는 것.** `SubagentHandback`의 `tool_input.message`를 "앞뒤 공백을 뗀 비어 있지 않은 줄"의 목록으로 만든 뒤:

- `reportHash`: 그 목록 전체의 해시. 각 줄에서 `<` 뒤에 붙은 `\`들을 뗀 형태로 계산합니다.
- `lines.total`: 줄 수.
- `lines.head`, `lines.tail`: 앞 64줄과 뒤 64줄의 **줄 해시**(줄마다 16진수 16자, 즉 64비트. agent id와 hand-back id를 함께 넣어 계산하므로 다른 agent·다른 hand-back의 줄 해시와 비교되지 않음). 128줄 이하의 보고는 모든 줄의 해시가 있고, 그보다 긴 보고는 가운데 줄의 줄 해시가 없습니다. 기록 파일은 보고 길이와 무관하게 4KiB 미만입니다.

**prompt가 그 기록의 것인 조건.** prompt 본문은 둘째 줄 다음부터 닫는 태그 전까지의 비어 있지 않은 줄입니다. 본문이 순서대로 아래와 **정확히** 같아야 합니다.

1. harness 알림 **최대 1줄**: 들여쓰기로 시작하고 그다음이 `[harness:`이며 4096자 이하이고, 그 줄의 해시가 기록의 줄 해시 어느 것과도 같지 않은 줄. 본문 맨 앞에서만 허용합니다.
2. 보고의 줄 전부, 같은 순서로, 그 밖의 줄 없이. 본문 줄은 앞뒤 공백을 뗀 것이 보고 줄과 같거나, 거기서 `<\`를 `<`로 되돌린 것이 보고 줄과 같으면 같은 줄입니다. 줄 해시가 없는 가운데 줄은 `reportHash`로 확인합니다(`reportHash`는 모든 길이에서 함께 확인).

그 밖은 모두 불일치이고, 불일치는 이 기능이 없을 때와 똑같이 처리됩니다(조언 없음, `unverified_prompt`): 줄 추가·누락·순서 변경, harness가 다른 방식으로 고친 줄(예: `<`를 `&lt;`로), 맨 앞이 아닌 곳의 알림, 들여쓰지 않은 알림, 알림 2줄 이상, 빈 보고 앞의 알림, 헤더의 agent id가 기록의 agent id와 다른 경우.

**worker가 악용할 수 있는가.** worker가 정할 수 있는 것은 보고의 줄뿐입니다.

- **보고 줄을 `[harness:`로 시작하게 쓰는 경우.** 그 줄은 기록에 든 보고 줄이므로 prompt에서도 제자리에 있어야 하고, 허용 범위를 넓히지 않습니다. 허용되는 알림은 "이 보고의 줄이 **아닌**" 맨 앞 한 줄뿐이어서, 보고의 `[harness:` 줄을 맨 앞에 한 번 더 넣거나 옮기거나 뺀 prompt는 일치하지 않습니다(테스트로 확인). 보고의 첫 줄이 harness의 실제 알림과 글자까지 같으면, 알림이 붙은 prompt는 일치하지 않습니다(보수적 불일치).
- **보고에 `<\`를 미리 써 두는 경우.** 줄 해시는 그 줄 그대로 계산합니다. prompt 줄은 그 줄과 같거나 `<` 뒤에 `\`가 하나씩 더 붙은 것이어야 합니다. 반대 방향(prompt 쪽 `\`가 더 적음, 즉 worker가 무력화된 것처럼 써 둔 태그가 prompt에서 살아난 형태)은 줄 해시가 있는 줄에서는 일치하지 않습니다.
- **다른 agent의 prompt와 맞추는 경우.** 기록은 헤더의 agent id로만 찾고, 줄 해시에 agent id와 hand-back id가 들어가므로, 같은 보고를 낸 다른 agent의 기록이나 그 기록을 다른 agent 이름으로 복사한 파일은 일치하지 않습니다(테스트로 확인).
- **같은 agent의 다른 hand-back 기록과 맞추는 경우.** 위 두 허용(알림 한 줄, `<\` 되돌리기) 때문에 **prompt 하나가 같은 agent의 서로 다른 보고 두 개의 기록과 동시에 일치할 수 있습니다.** 예: 첫 보고 `A`, 둘째 보고 `[harness: 아무 글]` + `A`(둘째의 prompt는 "알림 + 첫 보고"로도 읽힘). 또는 첫 보고 `see <x>`, 둘째 보고 `see <\x>`. 그래서 기록 하나와의 일치만으로 고르지 않고, prompt가 일치한 기록 **전부**(이미 쓰인 것 포함)를 놓고 아래 순서로 정합니다(`handbackPromptRecords()`).
  1. 허용 없이 **그대로 일치**(알림 없음, 되돌린 줄 없음)한 기록이 있으면 그 기록들만 후보입니다. 이들은 줄 단위로 같은 보고이므로 그 안에서는 종전대로 아직 쓰이지 않은 가장 오래된 것부터 씁니다.
  2. 그대로 일치한 기록이 없으면, 허용을 거쳐 일치한 기록들의 **일치 형태**(알림 줄 수와 되돌린 줄 번호)가 모두 같을 때만 후보입니다(같은 보고를 두 번 낸 경우). 형태가 다르면 서로 다른 보고를 prompt 하나로 구분할 수 없는 것이므로 **어느 기록에도 묶지 않습니다**(기록 없는 prompt와 같은 처리: 조언 없음, `unverified_prompt`).

  위 두 예에서 둘째 hand-back의 prompt는 둘째 기록에만 묶이고 첫 기록의 `.prompt`·`.delivered`는 건드리지 않습니다(테스트로 확인). 이 규칙 이전(줄 해시 결합을 넣은 직후)에는 "가장 오래된 미사용 기록 우선"만 있어서, 첫 hand-back의 prompt가 오지 않았거나 불일치였을 때 둘째의 prompt가 첫 기록의 조언을 받아 가고 둘째의 판정은 전달되지 않았습니다.

**이 규칙의 한계.**

- **알림 한 줄의 내용은 확인하지 않습니다.** "보고 + 맨 앞의 들여쓴 `[harness:` 한 줄(내용 임의)"인 prompt는 그 hand-back의 prompt로 인정됩니다. 그런 prompt를 만들 수 있는 것은 Main에게 prompt를 보낼 수 있는 주체이고(worker의 보고로는 만들 수 없음), 인정되더라도 시간 창·hand-back당 prompt 하나·`.claim` 조건은 그대로이며 prompt는 저장되지도 목표가 되지도 않습니다. 알림 문구를 고정 문자열로 비교하지 않은 이유는 실제 문구를 한 번, 그것도 잘린 형태로만 봤기 때문입니다.
- harness가 알림을 두 줄 이상 넣거나 보고 중간·뒤에 넣는 경우, `<` → `<\` 외의 방식으로 줄을 고치는 경우, 긴 보고를 잘라 넣는 경우는 본 적이 없고, 모두 불일치로 처리됩니다.
- 한 줄 안에 worker가 쓴 `<\`와 harness가 바꾼 `<\`가 섞이면 "모든 `<\`를 되돌린" 줄이 보고 줄과 달라 불일치입니다.
- 128줄을 넘는 보고의 가운데 줄은 줄 해시 없이 `reportHash`로만 묶입니다. 그 구간에서는 `<` 뒤 `\`의 개수 차이를 구분하지 못하고, 알림 줄이 가운데 줄과 같은 글인지도 확인하지 못합니다. 줄의 추가·누락·순서 변경·다른 내용은 그 구간에서도 불일치입니다.
- 줄 해시는 64비트이고 비밀 키가 없습니다. 세션 상태 디렉터리(0700)를 읽을 수 있는 프로세스는 기록의 agent id·hand-back id로 **짧고 추측 가능한 줄**이 보고에 있었는지 대조해 볼 수 있습니다. 텍스트는 저장하지 않지만, 보고 전체 해시 하나만 두던 때보다 줄 단위로 추측을 확인할 수 있게 된 점은 이 변경으로 생긴 차이입니다.
- **글자까지 같은 prompt 두 개는 구분할 수 없습니다.** 첫 보고가 "harness의 실제 알림 줄 + 빈 줄 + `A`"와 글자까지 같고 둘째 보고가 `A`이며 둘째의 prompt에 harness가 정확히 그 알림을 붙이면, 두 hand-back의 prompt는 같은 문자열입니다. 이때 그 prompt는 그대로 일치하는 첫 기록에 묶입니다. 첫 기록이 이미 쓰였으면 둘째의 조언은 전달되지 않고(반복된 prompt로 처리), 첫 기록이 아직 안 쓰였으면 첫 hand-back의 조언이 전달됩니다. 어느 쪽이든 조언 문장은 판정 결과에서 다시 만든 고정 문장이고 "Main이 실제 증거를 확인해야 한다"는 내용입니다.
- 이전 형식의 기록(`schema: 1`)은 기록으로 읽지 않습니다. 업그레이드 순간에 대기 중이던 hand-back의 prompt는 이 기능이 없을 때처럼 처리됩니다. 다만 "이미 끝난 hand-back인가"는 형식과 무관하게 파일의 상태(`judged`·`skipped`·`unavailable`)로 판단하므로(`HandbackLedger.settled()`), 이전 형식으로 끝난 hand-back의 `SubagentHandback` 이벤트가 업그레이드 뒤에 다시 와도 **다시 판정하지 않습니다**(테스트로 확인). 이전 형식으로 `in_flight`인 채 남은 것은 기록이 없는 경우와 같이 7초 뒤 한 번 이어받습니다.

**hand-back prompt와 prompt 출처 표시.** 첫 목표 이후에 오는 다른 prompt는 `unverified_prompt`로 기록되고, 그 뒤 route에는 plan과 목표 텍스트를 보내지 않습니다(Main의 것인지 worker의 것인지 증명할 수 없기 때문). 비동기 runtime에서는 hand-back prompt가 위임마다 오므로, 이대로면 첫 위임이 끝나는 순간 세션이 항상 unverified가 됩니다. 그래서 **지점이 `active`일 때에 한해**, 아래를 모두 만족하는 hand-back prompt는 `handback_prompt`로 기록하고 unverified로 만들지 않습니다.

- 같은 세션에서 같은 agent id의 `SubagentHandback` `PostToolUse`(성공, runtime이 보낸 hook 이벤트)를 그 prompt보다 최대 10초 전에 관측함(그 이벤트의 처리 표시 `.claim`이 있어야 함)
- prompt 본문이 그 이벤트가 전한 보고와 [결합 규칙](#보고와-prompt의-결합-규칙)으로 일치함(보고의 줄 전부, 같은 순서, 맨 앞의 harness 알림 최대 1줄만 추가 허용). 같은 agent의 다른 보고를 담은 prompt는 보증되지 않음
- 그 hand-back이 아직 다른 prompt를 보증하지 않음(hand-back 하나가 prompt 하나만 보증. 같은 prompt의 재전송은 같은 것으로 봄)
- prompt 전체가 agent-message 요소 하나임: 첫 줄이 머리말, 마지막 줄이 `</agent-message>`, 그 사이에 열 0에서 agent-message를 열거나 닫는 줄이 없음(harness가 보고의 모든 줄을 들여쓰므로 보고가 요소를 일찍 닫고 뒤에 글을 붙일 수 없음)

이것이 목표를 바꾸거나 세탁하지 못하는 이유: `handback_prompt`는 목표를 기록하지 않습니다. `goal`과 `goalHash`는 첫 prompt에서만 정해지고 이 경로는 그 값을 읽지도 쓰지도 않습니다. 보증된 hand-back prompt는 목표가 아직 없는 세션에서도 목표가 되지 않습니다(이 기능이 꺼져 있으면 그런 prompt가 첫 prompt로서 목표가 됩니다). worker가 정할 수 있는 것은 보고 본문뿐이고, 그것은 inline 경로에서도 Main에게 그대로 전달되던 내용입니다. 바뀌는 것은 "사용자의 원래 목표와 plan을 이후 route에서 계속 Jev에 보내는가" 하나이며, 보내는 내용은 worker가 아니라 사용자와 Main이 쓴 것입니다. 보증되지 않은 hand-back prompt(창 밖, 다른 agent id, 다른 보고, 닫는 태그 뒤에 글이 더 있음, 두 번째 다른 prompt, `/clear` 이전의 hand-back)와 그 밖의 모든 나중 prompt는 이전과 같이 `unverified_prompt`입니다.

**알아둘 한계.**

- 이 완화는 지점이 `active`일 때만 적용됩니다. 기본 설정과 지점 `shadow`에서는 hand-back prompt가 계속 세션을 unverified로 만듭니다(기본 동작을 바꾸지 않기 위한 선택).
- 10초 창은 관측된 70ms 간격에 여유를 둔 값입니다. Main이 다른 turn을 처리하는 동안 hand-back prompt가 얼마나 늦게 전달될 수 있는지는 재지 않았습니다. 창을 넘겨 도착하면 조언은 전달되지만(10분까지) prompt는 `unverified_prompt`가 됩니다.
- prompt와 기록은 보고의 줄 해시로 묶습니다([결합 규칙](#보고와-prompt의-결합-규칙)). harness가 prompt에 넣는 보고가 `SubagentHandback`의 `tool_input.message`와 그 규칙이 허용하는 것 이상으로 다르면(예: 긴 보고를 잘라서 넣는 경우) 그 prompt는 조언을 받지 못하고 이 기능이 없을 때처럼 `unverified_prompt`가 됩니다. 실제 세션 2회에서 본 두 형태(알림 없음, 알림 있음)는 일치합니다. 잘린 보고는 확인하지 못했습니다.
- 3000ms보다 느리게 끝난 판정의 조언은 그 prompt가 다시 오지 않는 한 전달되지 않습니다. 다음 hand-back의 prompt에 붙지 않습니다.
- 내용이 같은 보고를 한 agent가 두 번 보내면 두 prompt는 구분되지 않습니다. 각 prompt가 아직 쓰이지 않은 기록을 오래된 것부터 하나씩 씁니다.
- `agent_id` 없이 부모의 `session_id`를 쓰는 자식 prompt가 방금 hand-back한 agent의 hand-back prompt와 본문까지 같으면 조언이 그 컨텍스트로 갈 수 있습니다. 전달되는 것은 코드가 만든 조언 한 문장뿐이고 다시 전달되지 않습니다.
- agent id와 위임의 연결은 세션 projection에 남은 최근 64개 위임 안에서만 찾습니다.
- 이벤트의 형태와 순서는 실제 Claude Code 데스크톱 세션 한 번(hook 이벤트 29개)에서 가져왔고, 검증은 그 형태를 재현한 mock judge·loopback 서버·실제 hook 프로세스 두 개로 했습니다. 그 뒤 실제 세션에서 조언 전달을 확인했습니다: 세션 4에서 1건(QA용 임계값 0.3), 재발행 수정 뒤 재확인 세션에서 기본 임계값으로 3건 중 3건([검증 상태](#검증-상태)). 알림 줄이 있는 prompt 형태는 수정 뒤 실제 세션에서 확인하지 못했습니다. Codex runtime에는 이 경로가 없습니다.

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
| `usage` (선택) | judge가 응답에 실어 보낸 토큰 수 `{input_tokens, output_tokens}`. 각 값은 0 이상의 정수이거나 `null`(judge가 그 값을 주지 않았거나 정수가 아님). 응답에 usage가 없을 때, 캐시 적중(요청을 보내지 않음), 실패한 결정에는 이 필드가 없습니다. **채택된 judge의 요청 하나**만 담습니다: 체인에서 확신이 낮아 다음 judge로 넘어간 요청과 실패한 요청이 쓴 토큰은 들어가지 않습니다. 이 필드가 생기기 전의 기록도 그대로 유효합니다 |

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
| 공통(운영) | 캐시 비율, 지연 p50/p95, 평균 확신, 토큰 합계(`usage`) |

`points`는 **지점별** 요약입니다. 실패한 결정은 `provider`가 `none`으로 기록되므로, 실패 비율은 제공자 묶음이 아니라 지점 단위로 봐야 합니다.

| 필드 | 내용 |
|---|---|
| `decisions`, `failed`, `failureRate` | 그 지점의 전체 결정 수, 유효한 답 없이 끝난 수, 그 비율 |
| `escalated`, `escalationRate` | judge를 둘 이상 거친 결정 수와 비율 |
| `judges` | `trail` 기준 judge별 시도 수(`attempts`), 실패 수(`failures`), 낮은 확신으로 넘긴 수(`lowConfidence`), 실패 비율 |
| `usage` | 그 지점의 토큰 합계 `reported`(usage가 있는 기록 수), `input_tokens`, `output_tokens`와 제공자별 내역 `providers` |

토큰 합계는 세 곳에 있습니다. 보고서 최상위 `usage`(전체와 제공자별), `points[].usage`(지점별과 그 안의 제공자별), `groups[].operational.usage`(묶음별)입니다. 답 형태가 두 가지인 결정은 묶음 두 곳에 들어가므로 묶음별 합계를 더하면 안 됩니다. 전체나 지점 단위 합계는 기록 하나를 한 번만 셉니다. 넓은 skill 판정은 요청마다 기록이 하나씩이므로 요청 수만큼 더해집니다. usage가 있는 기록이 없으면 합계는 `0`이 아니라 `null`입니다. **합계는 실제 사용량의 하한입니다.** 기록 하나는 채택된 judge의 요청만 세므로, judge를 둘 이상 둔 체인에서 확신이 낮아 넘어간 요청(`trail`의 `KERNEL_LOW_CONFIDENCE`)과 실패한 요청의 토큰은 어디에도 더해지지 않습니다(예: `jev` 110토큰이 낮은 확신으로 넘어가고 `openai` 8토큰이 채택되면 합계는 8). 그런 요청의 수는 `points[].judges[]`의 `lowConfidence`·`failures`로 볼 수 있습니다. 기본 체인(judge 하나)에는 해당하지 않습니다. `--action show`도 보여 준 기록들의 `usage` 합계를 함께 출력합니다.

- 라벨이 없거나 분모가 0인 지표는 `0`이 아니라 `null`입니다.
- 묶음마다 `sufficient`와 `sufficientReason`이 있습니다. 세는 단위는 질문 라벨이 아니라 **라벨이 붙은 결정**(`counts.labeledDecisions`)입니다. 넓은 skill 결정 하나에는 서로 의존하는 질문이 수십 개 붙으므로 라벨 수(`counts.labeled`)는 표본 크기가 아닙니다. 라벨이 붙은 결정이 30건 미만이면 `false`(`too_few_labeled_decisions`)이고, **약한 출처의 라벨이 섞여 있으면 몇 건이든 `false`**(`weak_labels`)입니다. 약한 라벨은 행동의 기록이라 많아져도 정답이 되지 않습니다. `false`인 수치는 참고용으로만 보세요.
- 답 형태와 맞지 않는 라벨은 `invalidLabels`로 세고 지표에서 뺍니다.

보고서는 라벨의 **출처(`source`)** 를 섞지 않고 보여 줍니다. 최상위 `labels`에 출처별 라벨 수와 강도(`bySource`), 약한 출처 목록(`weakSources`), 한쪽 결과만 쓰는 출처 목록(`oneSidedSources`), 손으로 붙인 출처 목록(`unclassifiedSources`), **판정 자체가 결과에 영향을 준 출처 목록**(`decisionInfluencedSources`), 철회된 라벨 수(`retracted`, `retractionMarkers`)가 있습니다. 묶음마다 `labelSources`(출처별 라벨 수와 **그 출처의 라벨만으로 계산한 지표**)와 `metricsLabelStrength`(묶음의 `metrics`가 기댄 라벨의 강도: `weak`/`verified`/`unclassified`/`mixed`, 라벨이 없으면 `null`)가 있습니다. 묶음의 `metrics`는 출처와 무관하게 질문마다 가장 최근 라벨을 쓰므로, 출처가 둘 이상이면 `mixed`로 표시됩니다. 출처를 골라서 보려면 `--source a,b`(이 출처만)와 `--exclude-source a,b`(이 출처 제외)를 씁니다. 거른 라벨 수는 `labels.excludedByFilter`에 나옵니다. 출처의 뜻과 강도는 아래 [결과 수집기](#결과-수집기)에 있습니다.

권장 순서는 `shadow`로 켜서 log를 쌓고 → 라벨을 붙이고(손으로, 또는 결과 수집기로) → 보고서로 임계값을 확인한 뒤 → `active`로 올리는 것입니다.

## 결과 수집기

kernel은 판단마다 확률을 log에 남기고, 라벨이 있으면 calibration을 계산합니다. 라우터는 평가 자료가 들어오면 프로필별 실측을 씁니다. 그런데 둘을 "세션에서 실제로 일어난 일"에 잇는 것이 없어서 라벨은 손으로 하나씩 붙여야 했고 평가 저장소는 0행이었습니다. **결과 수집기**(`src/collector.mjs`, `scripts/collect.mjs`)는 세션이 끝난 뒤 hook 상태와 그 세션의 대화 기록을 읽어 세 가지를 씁니다. 아무것도 전송하지 않고, 세션을 시작하지 않으며, 그 자체로는 라우팅을 바꾸지 않습니다.

```bash
C="node orchestration/scripts/collect.mjs"
# 수집 (--dry-run이면 아무것도 쓰지 않고 요약만 출력)
$C --config /절대/config.json --transcripts /절대/세션-기록-폴더 [--verification 결과.json] [--evaluation-context 이름] [--out /절대/폴더] [--project /절대/프로젝트] [--dry-run]
$C --state-dir /절대/state --transcripts /절대/세션-기록-폴더      # config 없이 state 디렉터리를 직접 지정
$C --state-dir /절대/state                                      # 대화 기록 없이 hook 상태만 요약
$C --state-dir /절대/state --report                             # 관찰 기록 보고서
$C --config /절대/config.json --report                          # 위와 같고, 평가 저장소의 행 수(일치 종류별)도 함께
$C --task-hash 과제글.txt                                       # 검증 파일에 쓸 taskHash 계산
```

`--transcripts`는 세션의 Main 기록(`*.jsonl`)과 `subagents/`(`agent-<id>.jsonl`, `agent-<id>.meta.json`)가 든 폴더입니다. 수집기는 그 폴더를 찾아 주지 않습니다. 홈 디렉터리를 뒤지지 않도록 경로를 직접 줘야 합니다.

### 무엇을 읽고 어떻게 잇나

라우팅된 위임 하나를 세 군데에서 이어 붙입니다.

1. **hook 상태**(`sessions/<scope>/events`, `decisions/`): `route`, `skills`, `supervisor`, `delegation_reissued`, `delegation_repeated`, `spawn_observed`. `tool_use_id`가 키입니다. `spawn_observed`에는 host가 실행 접수 결과에 적어 준 모델 id(`resolvedModel`)가 함께 남습니다(이 변경 이후의 hook부터, 모델 id 형식일 때만). 수집기가 서브에이전트 기록과 대조하는 데만 쓰고, hook 출력에는 영향이 없습니다.
2. **Main 기록**: 같은 `tool_use_id`의 `Agent` 호출과 그 결과(거부 여부, 실행 접수의 `agentId`). 기록에 적힌 입력의 해시가 hook이 본 입력 해시와 다르면 경고(`transcript_input_differs_from_hook_input`)를 셉니다.
3. **서브에이전트 기록**: `agent-<agentId>.jsonl`과 `.meta.json`.

권한 모드 `auto`에서는 위임 하나가 호출 두 개입니다(거부된 호출과 다시 발행된 호출). 수집기는 둘을 한 위임으로 묶습니다.

| 연결 | 근거 | 어느 결정이 그 서브에이전트에 적용됐나 |
|---|---|---|
| `reissue` | hook이 남긴 `delegation_reissued` | 거부된 첫 호출의 결정 (판단은 한 번뿐) |
| `repeat` | hook이 남긴 `delegation_repeated` | 원래 호출의 결정을 공유. 별도의 위임으로 셈 |
| `refused-call` | 재발행 수정 **이전** 상태: 두 호출이 모두 라우팅됨. 실행된 호출의 입력 해시가 다른 호출의 `outputHash`와 같고 그 호출에 `spawn_observed`가 없음 | 첫 호출의 결정. host는 발행된 입력(첫 재작성)을 그대로 실행했고 두 번째 route는 적용되지 않았습니다. host 기록의 agent type이 두 번째 route의 프로필만 가리킬 때에만 두 번째를 씁니다 |
| 없음(`own`) | 재작성이 그 호출에 바로 적용됨 | 그 호출의 결정 |

잇지 못한 위임은 이유와 함께 셉니다(`no_transcripts`, `agent_call_not_in_transcript`, `refused_and_not_reissued`, `never_launched`, `spawn_failed`, `subagent_transcript_missing`, `subagent_transcript_unreadable`, `subagent_transcript_without_assistant_rows`, `subagent_meta_names_another_call`, `subagent_not_finished`, `subagent_end_unconfirmed`, `runtime_transcripts_unsupported`). **끝났다는 확인이 없는 서브에이전트 기록은 전체 실행으로 읽지 않습니다.** host의 `.meta.json`이 `finished: false`이면 `subagent_not_finished`, host가 끝을 기록하지 않았고(`finished` 없음) hook도 그 agent의 종료(`agent_stopped`)나 hand-back(`handback_observed`)을 보지 못했으면 `subagent_end_unconfirmed`입니다. 실행 중이거나 잘린 사본에서 "load하지 않음" 라벨과 토큰 합계를 만들면 그것은 관찰이 아니라 추측이기 때문입니다. 잇지 못한 위임의 결정은 `labels.unlabelled.delegation_not_joined`로 셉니다. 라우팅되지 않은 위임(`route_deferred`, `no_route_recorded`)도 실행됐으면 관찰 기록은 남기되 요청 프로필은 `null`입니다.

### 쓰는 것 1: 관찰 기록

위임 하나에 한 줄, `<stateDir>/observations-log/observations-YYYY-MM.jsonl`(decision log 옆, 디렉터리 0700 / 파일 0600, 추가 전용, symlink 거부). 형식 검사는 decision log처럼 엄격합니다(`src/kernel/observations.mjs`의 `isObservationRecord`): 모든 키가 필수이고 모르는 키는 거부하며, 문자열은 64자리 hex 해시, 식별자 패턴(공백 없음), 검증된 skill 이름, 정해진 enum만 통과합니다. 과제 글, 보고 글, 경로, session id, agent id, `tool_use_id`는 들어가지 않습니다. **측정하지 못한 값은 `0`이 아니라 `null`입니다.**

| 필드 | 내용 |
|---|---|
| `delegationId`, `sessionScope`, `taskHash` | 해시. `delegationId`는 세션 scope와 실행된 호출 id의 해시, `taskHash`는 아래 정의 |
| `host` | host가 기록한 `version`, `entrypoint`, `permissionMode` |
| `calls` | 호출 수, 거부된 수, 연결 종류(`reissued`/`repeated`/`reroutedAfterRefusal`) |
| `requested` | route가 요청한 프로필·모델·backend·effort·역할·tier·taskClass, 그리고 어느 결정에서 왔는지(`routeSource`) |
| `effective` | **host가 기록한** agent type(`.meta.json`), 모델(서브에이전트 assistant 행의 `message.model`), effort(같은 행의 `effort`), 요청과의 일치(`profileMatch`, `effortMatch`, `modelMatch`). agent type은 **이 세션의 route가 가리킨 프로필 id일 때만 이름 그대로** 적고, 그 밖(내장·사용자·plugin agent)은 `other`로 적습니다. 사용자 환경의 agent 목록이 저장소에 남지 않게 하기 위해서입니다. `profileMatch`는 실제 값으로 계산합니다 |
| `skills` | skill 지점의 모드·상태·`need`, hook이 블록을 넣었다고 기록했는지(`injectedByHook`), **서브에이전트의 첫 prompt에 실제로 블록이 있었는지**(`blockInPrompt`)와 그 이름들, 서브에이전트가 load한 프로젝트 skill과 경로(`Skill`/`Read`/`Shell`)·첫 쓰기 이전 여부, 판정 불가 접근 여부. 블록은 **hook이 붙이는 자리**(prompt 맨 끝, 라우팅 packet 뒤: `splitRoutingTail`)에 있을 때만 블록으로 봅니다. 과제 글 안에 적힌 `<jev-skills>`는 과제 글입니다. 블록의 이름은 그 세션이 아는 프로젝트 skill일 때만 적고, 나머지는 수만 셉니다(경고 `skills_block_name_not_a_known_project_skill`) |
| `usage` | API turn 수(메시지 id 기준), tool 호출 수, 토큰 4종(입력·출력·cache read·cache creation, **메시지 id마다 한 번**), 서브에이전트 wall time, 첫 호출부터 서브에이전트 마지막 행까지의 `endToEndMs` |
| `judge` | 라우팅 judge 단계 수, skill 요청 수, supervisor 판정 수, 라우팅 hook 시간 합, decision log의 `usage`에서 읽은 judge 토큰(`usage`가 없는 log면 `null`) |
| `supervisor` | 마지막 판정(상태·outcome·확신·evidence·경로) 또는 `null` |
| `verification` | 사용자가 준 외부 검증 결과 또는 `null` |
| `decisions` | 관련된 decision log id와 역할(`governing`/`not-applied`) |

`modelMatch`는 다섯 값입니다.

| 값 | 뜻 | 평가 행 |
|---|---|---|
| `exact` | host가 기록한 모델 id가 route의 `backend`와 **문자열이 같음** | 만듦 |
| `declared` | 문자열은 다르지만, 그 프로필의 registry 항목에 사용자가 **선언해 둔 id**(`resolvesTo`) 중 하나와 문자열이 같음 | 만듦 |
| `declared-not-in-force` | 기록된 id가 **지금은** 선언돼 있지만, 그 세션의 route가 가진 프로필 fingerprint는 지금 registry의 것과 다름. 즉 세션이 돌 때는 그 선언이 프로필 정의에 없었음(선언하기 전의 세션, 또는 그 뒤 항목이 달라짐) | 만들지 않음 |
| `alias-undeclared` | registry가 별칭(`opus`)을 쓰고 host가 그것을 구체 id(`claude-opus-5-5`)로 풀었는데, 그 id가 선언돼 있지 않음 | 만들지 않음 |
| `mismatch` | 그 밖 | 만들지 않음 |

`alias-undeclared`와 `mismatch`를 가르는 기준은 "별칭이 기록된 id의 한 토막(`-`, `.`, `:`, `/`, `@`로 나눈 조각)인가"입니다. 이 기준은 **표시와 안내에만** 쓰입니다. 어떤 경우에도 행을 받아들이는 근거가 되지 않습니다. 받아들이는 근거는 `backend` 문자열 일치와 선언된 id 문자열 일치, 둘뿐입니다. 선언은 **그 세션이 돌 때의 프로필 정의에 들어 있던 것**만 봅니다. route에 기록된 fingerprint가 지금 registry의 그 프로필 fingerprint와 같을 때만 지금의 목록을 쓰고, 다르면 빈 목록으로 비교합니다. 그래서 선언하기 전에 돈 세션은 관찰 기록에 `declared`로 남지 않고(`declared-not-in-force`), 보고서의 `acceptedRate`에도 들어가지 않습니다. 가져오기가 그런 행을 `STALE_EVIDENCE_PROFILE`로 거부하는 것과 같은 기준입니다. 이전 수집기가 쓴 기록의 `alias`는 지금의 `alias-undeclared`와 같은 뜻이고 그대로 읽습니다.

**skill load 판정**(`src/collector-access.mjs`). tool 호출은 셋 중 하나로 분류됩니다.

- **load**: 아는 프로젝트 skill 하나를 읽는 호출이고 **그 호출의 tool 결과가 오류 없이 돌아온 경우**입니다. (1) `Skill` tool이 아는 skill 이름을 부름, (2) 프로젝트 안 `.claude/skills/<폴더>/SKILL.md`를 `Read`, (3) shell에서 읽는 명령(`cat`, `head`, `tail`, `less`, `more`, `nl`, `bat`)의 인자가 그 `SKILL.md`. 프로젝트 안인지는 host가 그 행에 기록한 `cwd`로 봅니다(읽기만 하고 저장하지 않음). `cat … | head -40`처럼 일부만 읽은 것도 load입니다.
- **판정 불가**: load도 아니고 "load하지 않음"도 아닙니다. 그 기록에서는 라벨을 쓰지 않습니다. load 호출인데 결과가 오류이거나 없음, 읽는 명령이 아닌 shell 명령이 `SKILL.md`를 가리킴(`grep`, `wc`, `git status` 등), skills 폴더·와일드카드·모르는 폴더를 읽는 명령, 아는 skill 폴더 안의 다른 파일을 `Read`, 프로젝트 밖의 같은 이름 `SKILL.md`, `cd`로 다른 곳에 간 뒤의 상대 경로, 그리고 **skills 폴더에 닿는 재귀 내용 검색**입니다: 프로젝트 루트(`.`, 절대 경로 루트, 상위 폴더, 풀 수 없는 변수)에 대한 `grep -r/-R`, `git grep`, 숨김 폴더를 보게 한 `rg`(`--hidden`, `-uu`)나 `.claude`를 직접 준 `rg`, `-exec`가 있거나 `xargs`로 이어지는 `find`, 경로 없는 `Grep` tool. skill 글을 이름 없이 읽을 수 있기 때문입니다. 다만 skills 폴더를 **통째로** 뺐거나(`--exclude-dir=.claude`, `-g '!.claude/**'`, `-not -path './.claude/*'`, 바로 뒤의 `grep -v '^./.claude/skills/'`) 검색이 `SKILL.md`에 맞을 수 없으면(`--include=*.mjs`, `-name '*.mjs'`, `Grep`의 `glob`/`type`) 판정 불가가 아닙니다. 일부 skill만 빼는 필터(`grep -v '^./.claude/skills/periodic'`)는 통째로 뺀 것이 아닙니다.
- **해당 없음**: 그 밖. 파일 내용을 내지 않는 명령(`ls`, `test`, `stat`, `echo`, `-exec` 없는 `find`, `Glob` tool)은 skills 폴더를 가리켜도 읽은 것이 아닙니다. 오류로 끝난 `Grep`은 아무것도 돌려주지 않았습니다.

판정 불가의 이유는 요약의 `labels.indeterminateAccess`에 종류별로 나옵니다. shell 명령은 작은 토크나이저(따옴표, 역슬래시, here-document 본문 제거)로 단순 명령과 단어로 나눌 뿐 shell을 해석하지 않습니다. **잡지 못하는 것**: 변수·명령 치환·alias·함수·스크립트 파일 안에서 읽은 것, `sed`/`awk`/`python` 등으로 읽은 것(가리키면 판정 불가, 가리키지 않으면 못 봄), 복사·압축한 뒤 읽은 것, `--include`로 걸러진 재귀 검색이 skill 폴더 안의 다른 파일(`.mjs` 등)을 읽은 것, 프로젝트 skill이 아닌 경로(사용자 skill, plugin)로 같은 내용을 읽은 것, MCP나 다른 tool로 읽은 것. 그리고 **load는 서브에이전트가 한 번의 호출로 만들 수 있는 사실**입니다. 읽고 따랐는지는 보지 않습니다.

"아는 skill"은 그 세션의 `skills` 이벤트에 나온 이름입니다. skill 지점이 꺼져 있던 세션은 이름을 모르므로 `--project <프로젝트>`로 `.claude/skills`를 알려 줘야 load를 읽을 수 있습니다(읽기 전용). "첫 쓰기"는 `Write`/`Edit`/`MultiEdit`/`NotebookEdit` 호출만 봅니다. shell로 쓴 파일은 보지 않고, 쓰기 호출이 없으면 `null`입니다.

같은 세션에 두 번 돌려도 같은 기록을 또 쓰지 않습니다. 위임마다 **현재 유효한 줄**이 하나 있고(`latestObservations`), 새 내용이 그것과 같으면(`observationId`) 쓰지 않습니다. 검증 결과를 나중에 주거나 고치면 새 줄이 추가되고 그 줄이 유효해집니다. **검증 결과가 없는 줄은 검증 결과가 있는 줄을 대신하지 못합니다.** 검증 파일 없이 다시 돌리면 아무것도 쓰지 않고(`observations.keptVerified`), 예전 저장소에 그런 줄이 이미 있어도 보고서는 검증된 줄을 씁니다. 검증된 기록을 새로 고치려면 검증 파일과 함께 돌리세요.

### 쓰는 것 2: 라벨과 그 강도

라벨은 기존 `DecisionLog.label`로 씁니다. **출처가 라벨의 강도입니다.** 서브에이전트가 한 일은 관찰이지 정답이 아니고, 서브에이전트의 보고 글은 성공의 증거가 아닙니다. 수집기는 통과/실패를 지어내지 않습니다. 과제의 성공 라벨은 사용자가 준 외부 검증 결과가 있을 때만 생깁니다. 서브에이전트의 보고 글에서는 어떤 라벨도 만들지 않습니다.

| 출처 | 지점·질문 | 결과 | 강도 | 뜻과 한계 |
|---|---|---|---|---|
| `observed-load` | `delegation.skills`의 `skill_<i>` | 서브에이전트가 그 skill을 load했는가 | **약함** | 서브에이전트의 prompt에 **블록이 없던** 위임(shadow 모드, 또는 아무것도 선택되지 않음)에서만. 서브에이전트가 **한 일**입니다. 필요 없는 skill을 load할 수 있고 필요한 skill을 건너뛸 수 있으며, 한 번의 호출로 만들 수 있습니다 |
| `observed-load` | `delegation.skills`의 `need` | **그 요청이 물어본 skill** 중 하나라도 load했는가 | **약함** | 같음. 넓은 판정은 요청 여러 개이고 요청마다 `need`는 자기 구간의 skill만 묻습니다. 그래서 라벨도 그 구간의 이름만 봅니다. 다른 구간의 skill이 load됐다고 이 요청의 `need`가 참이 되지 않습니다 |
| `observed-load-after-injection` | 위 두 질문 | 같음 | **약함**, **판정의 영향을 받음** | prompt에 **그 판정이 만든 블록이 있던** 위임. 블록이 "이 skill을 load하라"고 하므로 load는 일부 판정이 만든 결과입니다. 이 라벨로 임계값을 맞추면 judge가 이미 고르는 것을 보상하게 됩니다 |
| `external-verification-with-load` | `skill_<i>`, `need` | `true`만 | **약함**, 한쪽 | 블록 없는 위임에서, 그 skill이 load됐고 **그리고** 사용자의 외부 규칙 검사(`conventionPassed`)가 통과. 통과가 그 skill 덕분이라는 뜻이 아니며(귀속 없음), load되지 않았거나 검사가 실패한 경우에는 라벨을 쓰지 않습니다 |
| `external-verification-with-load-after-injection` | 같음 | `true`만 | **약함**, 한쪽, **판정의 영향을 받음** | 같은 조건, 블록이 있던 위임 |
| `external-verification` | `supervisor.outcome`의 `outcome` | `complete`만 | **검증됨**, 한쪽 | 외부 검증이 통과한 과제. **실패한 검증은 라벨을 쓰지 않습니다.** 실패는 `retry`·`replan`·`escalate` 중 무엇인지 알려 주지 않기 때문입니다. 그래서 이 출처의 라벨은 전부 `complete`이고, 그 위의 정확도는 "`complete`에 대한 재현율"이지 정확도가 아닙니다 |
| 그 밖(손으로 붙인 라벨) | 임의 | 임의 | **미분류** | 이 코드가 보증하지 않습니다 |

**임계값을 볼 때 쓸 수 있는 라벨은 `observed-load`뿐입니다**(그것도 약한 라벨입니다). `-after-injection` 출처는 판정이 서브에이전트에게 할 일을 알려 준 뒤의 행동이라, 보고서에서 `--exclude-source observed-load-after-injection,external-verification-with-load-after-injection`으로 빼거나 `--source observed-load`로 따로 봐야 합니다. 블록 없는 라벨을 모으는 방법은 skill 지점을 `shadow`로 두는 것입니다. 블록이 있었는지 알 수 없는 기록(첫 prompt를 찾지 못함)에서는 라벨을 쓰지 않습니다(`skills_block_presence_unknown`).

라벨을 쓰지 않는 경우는 이유별로 셉니다(`labels.unlabelled`): 위임을 대화 기록에 잇지 못함(`delegation_not_joined`), 질문→skill 대응을 증명할 수 없음(`skills_question_mapping_unproven`), 그 결정이 실행된 호출에 적용되지 않음(`skills_decision_not_applied_to_launched_call`), 반복 호출과 결정을 공유(`skills_decision_shared_with_repeated_call`), skill 접근이 판정 불가(`skills_access_indeterminate`), 블록 유무를 모름(`skills_block_presence_unknown`), 외부 검증 없음·실패(`supervisor_no_external_verification`, `supervisor_verification_failed_no_outcome_class`), 같은 과제의 이전 시도(`supervisor_earlier_attempt_of_task`), 이어진 agent의 이전 hand-back(`supervisor_earlier_handback`), log에 결정이 없음(`supervisor_decision_not_in_log`).

**같은 라벨을 두 번 쓰지 않고, 근거가 사라진 라벨은 철회합니다.** (결정, 질문, 출처)마다 현재 유효한 라벨이 하나 있습니다(가장 최근 것). 새로 계산한 결과가 그것과 같으면 쓰지 않습니다(`labels.alreadyPresent`). log는 추가 전용이라 지울 수 없으므로, 수집기가 썼던 라벨을 이번 실행이 더는 도출하지 못하면 **철회 표시**를 씁니다: 같은 결정·질문에 출처가 `<출처>:retracted`인 라벨 한 줄입니다(`labels.retracted`). calibration은 표시보다 먼저 쓰인 그 출처의 라벨을 버리고(`applyRetractions`), 표시 뒤에 다시 쓰인 라벨은 유효합니다. 철회되는 경우: 검증 결과가 통과에서 실패로 고쳐짐(`external-verification`, `…-with-load…`), 기록이 이제 판정 불가로 읽힘, 블록 유무가 달라짐. 검증 파일 없이 돌린 실행은 검증에 기댄 라벨을 철회하지 **않습니다**(없다는 것은 반박이 아닙니다). 대화 기록에 잇지 못한 위임의 라벨도 건드리지 않습니다. 손으로 `decisions.mjs --action label --source <출처>:retracted`를 붙여도 같은 효과입니다.

**라벨이 붙는 결정은 무작위 표본이 아닙니다(선택 편향).** 라벨을 받을 수 있는 것은 (1) 라우팅됐고 (2) 실행됐고 (3) 끝난 것이 확인된, 읽을 수 있는 서브에이전트 기록에 이어졌고 (4) skill 접근이 판정 가능하고 (5) 블록 유무를 알고 (6) 질문 대응이 증명된, **실행된 호출에 적용된 결정**뿐입니다. judge가 실패한 요청, 미뤄진 라우팅, 거부된 뒤 다시 발행되지 않은 호출, 판정 불가 기록, 적용되지 않은 두 번째 판단은 아무것도 내지 않습니다. 재귀 검색을 많이 하는 과제일수록 판정 불가가 되기 쉬우므로 빠지는 쪽이 과제 종류와 무관하지도 않습니다. 따라서 모든 지표는 **그 부분집합에 대한 조건부 값**이고 "모든 결정"의 calibration이 아닙니다. 보고서의 `counts.decisions`(그 지점의 전체 결정)와 `counts.labeledDecisions`(라벨이 붙은 결정)를 함께 보세요.

**질문 id → skill 이름 대응.** 넓은 판정은 요청 여러 개로 나뉘고 요청마다 `skill_0`부터 번호가 다시 시작합니다. 규칙은 `selectSkills`에 있습니다: 판정 대상은 BM25 순위의 앞 `candidates`개이고, `requests`개의 연속 구간(크기 `ceil(candidates / requests)`)으로 나뉘며, 요청 r의 `skill_i`는 순위 `r × 크기 + i`의 skill입니다. `decisionIds`에는 **답한 요청만** 요청 순서대로 들어갑니다.

1. 이 변경부터 `skills` 이벤트는 결정 id마다 물어본 이름을 순서대로 적습니다(`asked: [{ decisionId, names }]`, 검증된 이름만). 수집기는 이것을 씁니다.
2. 그 이전 이벤트는 `trace`에서 유도합니다. `trace`는 판정하지 않은 항목을 뺀 순위 그대로이므로, 잘리지 않았을 때(`trace.length === candidates`, 이벤트는 64개까지만 보관) 항목 `r × 크기 + i`가 요청 r의 `skill_i`입니다. 실패한 요청은 그 구간이 `judge_unavailable`이라 건너뜁니다.
3. 어느 쪽이든 log의 결정과 맞춰 봅니다. 답 개수가 `이름 수 + 1`이어야 하고, 유도한 경우 `skill_i`의 확률이 `trace`의 확률과 모두 같아야 합니다. 하나라도 어긋나면 그 결정은 라벨 없이 이유를 셉니다(`trace_incomplete`, `probability_mismatch`, `answer_count_mismatch`, `decision_count_mismatch`, `decision_not_in_log`, `event_shape_unknown`).

skill 지점이 꺼진 기본 설정에서는 `skills` 이벤트가 없으므로 `asked`도 기록되지 않습니다(`npm run compare:default` 차이 0). `route` 이벤트에는 분류·프로필 판단의 decision log id(`judgeDecisionIds`)가 추가됐습니다. 위임별 judge 토큰을 세는 데만 씁니다.

### 검증 파일

`--verification`은 사용자가 **외부에서 검증한** 과제 결과입니다. JSON 배열이거나 `{ "schema": 1, "results": [...] }`입니다. 모르는 키는 거부합니다.

```json
[{ "taskHash": "<64hex>", "passed": true, "conventionPassed": true,
   "validator": { "name": "my-checker", "version": "1.4.0" }, "artifactSha256": "<64hex>", "costUsd": 0.42 }]
```

| 키 | 내용 |
|---|---|
| `taskHash` 또는 `toolUseId` | 둘 중 정확히 하나. `toolUseId`는 그 위임의 `Agent` 호출 id 아무거나 |
| `passed` | 과제가 검증을 통과했는가 |
| `conventionPassed` | 선택. 프로젝트 규칙(skill이 담은 규칙) 검사를 통과했는가. `external-verification-with-load` 라벨에만 쓰임 |
| `validator` | 검증기 `name`, `version`(공백 없는 식별자, 각 64자 이하). 평가 행의 `validatorVersion`은 `name@version` |
| `artifactSha256` | 검증기 보고서의 SHA-256 |
| `costUsd` | 선택. 그 과제의 실제 비용. 없으면 평가 행의 `costUsd`는 `null` |

**`taskHash`의 정의**: Main이 그 위임을 **처음 발행한** `Agent` 호출의 `prompt` 문자열(어떤 hook 재작성보다 앞선 원래 과제 글)의 UTF-8 바이트에 대한 SHA-256(소문자 hex)입니다. 다듬기나 정규화는 없습니다. 그 문자열이 이 확장이 붙이는 꼬리(빈 줄, `<jev-routing>` packet, 고정 문장, 선택적 `<jev-skills>` 블록: `splitRoutingTail`)로 끝나면 꼬리 앞부분이 과제 글입니다. `collect.mjs --task-hash <파일>`이 파일 바이트 그대로의 해시를 내고(줄 끝 개행이 있으면 해시가 달라짐), `src/collector.mjs`의 `taskHash(text)`가 같은 함수입니다. 수집 요약의 `delegationIndex`에 위임마다 `taskHash`가 나오므로, `--dry-run`으로 먼저 돌려 값을 얻을 수 있습니다. 같은 과제 글을 한 세션에서 두 번 위임했으면 `taskHash` 항목은 그 과제의 것이지만, **관찰 기록과 라벨에는 마지막으로 실행된 위임에만** 붙습니다(검증은 작업의 최종 상태를 본 것이므로). 앞선 시도의 관찰 기록은 `verification: null`이고 요약의 `delegationIndex`에 `supersededAttempt: true`로 나옵니다. 평가 행은 과제 단위라 두 시도를 모두 `attempts`로 셉니다. `toolUseId`로 준 항목은 그 위임을 직접 가리킵니다. 한 위임에 서로 다른 결과 두 개가 걸리면 `CONFLICTING_VERIFICATION`으로 멈춥니다.

**`taskHash`는 키 없는 해시입니다.** 과제 글 자체는 파일에 들어가지 않지만, 과제 글을 **추측할 수 있는 사람은 해시를 계산해 맞는지 확인할 수 있습니다.** 짧거나 정형화된 위임("테스트 돌려 줘")은 추측이 쉽습니다. `taskHash`는 관찰 기록, 요약의 `delegationIndex`, 검증 파일, 평가 행 후보의 `taskId`, 평가 저장소에 들어가므로, **실제 프로젝트에서는 이 파일들을 밖에 공유하지 마세요.** 세션 scope와 `delegationId`는 엔트로피가 높은 id의 해시라 해당하지 않습니다.

### 쓰는 것 3: 평가 행 후보

외부 검증 결과가 있는 과제마다 `src/feedback.mjs`의 `validateEvaluation`이 요구하는 형식 그대로의 행을 **파일로** 씁니다(`--out`, 기본 `<stateDir>/collector/evaluations-<scope 앞 16자>.candidate.jsonl`, 0600). **가져오기는 하지 않습니다.** 사용자가 파일을 검토한 뒤 기존 명령으로 가져옵니다.

```bash
node orchestration/scripts/feedback.mjs --file <후보 파일> --accept-evidence --config /절대/config.json
```

가져오기 쪽 검증은 바꾸지 않았습니다. 수집기는 **정직하게 채울 수 없는 필드가 하나라도 있으면 행을 만들지 않고** 이유를 셉니다(`evaluations.withheld`).

| 이유 | 뜻 |
|---|---|
| `evaluation_context_not_configured` | 평가 context가 없거나 `native-default-unvalidated`. `--evaluation-context`나 config의 `optimization.evaluationContext`가 필요 |
| `session_ran_under_default_evaluation_context` | 지금은 context 이름을 줬지만 **그 세션은 기본 context(`native-default-unvalidated`)로 실행됐음**(route에 기록된 값). 나중에 이름을 붙여도 행이 되지 않습니다 |
| `session_ran_under_another_evaluation_context`, `route_evaluation_context_unknown` | 세션이 다른 이름의 context로 실행됐거나, route에 context 기록이 없음 |
| `effective_setting_not_recorded_by_host` | host 기록에 모델이나 effort가 없음 |
| `effective_model_alias_undeclared` | `modelMatch`가 `alias-undeclared`. host가 별칭을 구체 id로 풀었고 그 id가 registry에 선언돼 있지 않음. 요약의 `modelMatch.undeclared`가 어느 항목(`registryEntry`, `backend`)에서 어떤 id(`observedModel`)가 기록됐는지 알려 줍니다. 이것은 **관찰이지 선언이 아니고, 그대로 붙여 넣을 registry 조각도 아닙니다**(host가 별칭을 다른 모델로 돌려도 똑같이 나옵니다). 수집기는 선언을 대신 넣지 않습니다. `declarable: false`는 그 id가 `resolvesTo`가 받는 형식이 아니라는 뜻입니다(아래 "형식") |
| `effective_model_declared_after_session` | `modelMatch`가 `declared-not-in-force`. 그 id는 지금 선언돼 있지만 세션은 그 선언이 없는 프로필 정의로 돌았음. `importer_refuses:STALE_EVIDENCE_PROFILE`과 함께 나옵니다. 새 세션이 필요합니다 |
| `effective_model_mismatch` | `modelMatch`가 `mismatch`(또는 비교 불가) |
| `resolved_model_disagrees_with_transcript` | host가 실행 접수 때 알려 준 모델 id(hook이 남긴 `spawn_observed.resolvedModel`, 또는 Main 기록의 같은 값)가 서브에이전트 기록의 모델과 다름 |
| `task_ran_on_several_models` | 같은 과제의 시도들이 서로 다른 모델 id로 실행됨(행 하나에 모델 하나만 적을 수 있음) |
| `effective_effort_differs_from_profile` | effort가 다름 |
| `duration_not_measured` | 기록에 timestamp가 없어 시간을 잴 수 없음 |
| `supervisor_judge_time_unknown` | 판정된 hand-back의 decision log 기록이 없음 |
| `attempt_not_joined_to_transcripts` | 그 과제의 시도 중 대화 기록에 잇지 못한 것이 있음(전체 집계 불가) |
| `route_not_applied`, `route_mode_unknown` | 그 위임의 route가 **적용되지 않았음**. 전역 모드가 `active`가 아니면(`shadow` 등) route는 기록만 되고 호출은 Main이 발행한 그대로 실행됩니다. 그런 실행을 route의 프로필 실적으로 적지 않습니다. route 이벤트에 모드가 없으면 `route_mode_unknown` |
| `agent_type_differs_from_profile`, `agent_type_unknown` | host가 기록한 agent type이 route의 프로필이 아니거나 기록이 없음. 모델과 effort가 우연히 같아도 그 프로필의 agent 정의가 실행된 것이 아닙니다 |
| `delegation_not_routed`, `route_fields_missing`, `task_ran_under_several_profiles`, `task_hash_unknown` | 프로필이 없거나, 필드가 빠졌거나, 같은 과제가 여러 프로필로 실행됐거나, 원래 과제 글을 알 수 없음 |
| `importer_refuses:<코드>` | `--config`가 있을 때 가져오기 검증을 미리 돌려 본 결과. `STALE_EVIDENCE_PROFILE`은 지금 registry가 정의하는 프로필의 fingerprint가 세션 때의 것과 다르다는 뜻입니다(모델·effort·`resolvesTo` 선언 등 registry 항목이 바뀜). 이 이유는 다른 이유가 있어도 함께 셉니다 |

행의 각 필드: `taskId`는 `taskHash`(과제 글이 같으면 같은 단위), `taskClass`·`projectHash`·`profileId`·`profileFingerprint`는 route에서, `effective`는 host 기록에서(`source: native-transcript`), `verification`은 검증 파일에서(`source: independent-validator`), `createdAt`은 서브에이전트 마지막 행의 시각입니다. `accounting: all-attempts-including-failures-and-router`는 다음을 뜻합니다. `attempts`는 그 과제의 **모든 `Agent` 호출 수**(거부된 호출 포함)이고, `durationMs`는 Main이 첫 호출을 발행한 시각부터 서브에이전트의 마지막 행까지(라우팅 hook, 거부, 재발행 왕복이 모두 안에 들어감)를 그 과제의 위임들에 대해 더하고, 서브에이전트가 끝난 뒤의 보고 판정 시간(decision log의 `latencyMs`)을 더한 값입니다. 이 중 하나라도 잴 수 없으면 행을 만들지 않습니다. 포함하지 **않는** 것: hand-back 뒤 Main이 보고를 읽는 turn, Post hook의 파일 입출력.

**평가 행이 라우터에 닿는 길**(기존 관문, 코드 그대로): (1) `feedback.mjs --accept-evidence`로 명시적으로 가져와야 합니다. 형식·출처·프로필 fingerprint·effective 일치·context 일치를 검사하고, 같은 (context, 프로젝트, 과제, 프로필, 프로필 fingerprint) 단위가 다른 내용으로 이미 있으면 거부합니다(`CONFLICTING_EVALUATION_UNIT`). fingerprint가 단위에 들어 있으므로, 프로필 정의가 바뀐 뒤(예: `resolvesTo` 변경)에는 같은 과제를 새 정의로 다시 가져올 수 있습니다. 옛 정의의 행은 저장소에 `stale`로 남고 세지 않습니다. (2) 라우팅 때 `optimization.evaluationContext`가 `native-default-unvalidated`(기본)이면 평가 자료를 **읽지도 않습니다**. (3) 읽은 행 중 context·`projectHash`·`taskClass`·프로필 fingerprint가 현재 위임과 같고 `evidenceTtlDays`(기본 30일) 이내인 것만 프로필별로 요약합니다. 한 프로필의 행들이 **서로 다른 `effective.model`** 을 적고 있으면(한 항목에 id를 둘 이상 선언했고 둘 다 기록된 경우, 또는 `backend`와 선언된 id가 함께 기록된 경우) 그 프로필은 그 묶음에서 **요약하지 않습니다**(측정 없음으로 둠). 서로 다른 모델의 실행을 한 표본으로 합치지 않기 위해서입니다. 요약에는 그 표본의 모델(`effectiveModel`)이 적힙니다. (4) 실측 기준(`observed_quality_gated`)이 되려면 기준 프로필과 후보 프로필이 **같은 과제 집합**(`cohortHash`)에서 각각 `minimumSamples`(기본 30, 최소 5)건 이상이고, 성공률의 Wilson 하한이 `qualityFloor`(기본 0.85) 이상이며, 기준 대비 `nonInferiorityTolerance`(0.02) 안이고, **평균 비용과 평균 시간이 모두 있어야** 합니다. `costUsd`가 `null`인 행이 하나라도 있으면 평균 비용이 `null`이라 실측 기준이 되지 않습니다. (5) 그 관문에 못 미쳐도 요약 통계는 프로필 선택 judge의 입력(`statistics`)과 route의 `evidence`에 들어갑니다. 즉 가져온 순간부터 judge가 볼 수 있는 정보가 됩니다. 수집기가 만든 행은 `costUsd`가 검증 파일에 없으면 `null`이므로, 비용을 주지 않는 한 (4)는 통과하지 못합니다.

### registry의 `resolvesTo`: host가 풀어 준 모델 id 선언

Claude의 native 서브에이전트 프로필은 모델을 별칭(`opus`, `sonnet`)으로 받을 수 있고, registry도 그 별칭을 `model`/`backend`에 적을 수 있습니다. 그런데 host는 대화 기록에 **자기가 풀어 낸 구체 id**(`claude-opus-5-5` 같은 값)를 적습니다. 가져오기 검증은 "실제로 돈 모델 = 프로필의 `backend`"를 문자열로 비교하므로, 별칭 registry에서는 어떤 행도 통과할 수 없었습니다.

`resolvesTo`는 이 간극을 **사용자의 선언**으로 메웁니다. registry의 모델 항목에 "이 항목은 host에서 이 id들로 기록된다"를 적어 둡니다.

```json
{ "id": "claude-standard", "runtime": "claude", "model": "opus", "backend": "opus", "resolvesTo": ["<host가 기록한 id>"], "...": "..." }
```

- **선언만 인정합니다.** 접두어 비교, "별칭이 들어 있으면 인정", 대화 기록에서 id를 자동으로 배우기는 어디에도 없습니다. 목록에 적힌 문자열과 **완전히 같은** id만 받습니다.
- **형식.** 1~8개의 서로 다른 문자열. 각 id는 영문·숫자로 시작하고 영문·숫자와 `.`, `_`, `:`, `@`, `-`만 쓰며 80자 이하입니다(`*`, `?`, `[`, `/`, 공백 불가 → `INVALID_RESOLVES_TO`, 중복은 `DUPLICATE_RESOLVED_MODEL_ID`). hook과 수집기는 host가 준 id를 이보다 넓은 형식(`[`, `]`, `/` 포함, 160자)으로 기록합니다. 그런 id(예: 대괄호 접미어가 붙은 id, 제공자 경로가 붙은 id)는 관찰 기록과 `modelMatch.undeclared`에 나오지만 **선언할 수 없습니다**(`declarable: false`). 와일드카드처럼 읽힐 수 있는 문자를 선언에 허용하지 않기로 한 결과이고, 그런 id로 기록되는 실행은 지금은 평가 자료가 되지 못합니다. 실제 pilot 자료에는 그런 id가 없었습니다. 대소문자도 구분합니다(`X1`과 `x1`은 다른 id). 선언하지 않으려면 필드를 **빼야** 합니다. `null`이나 빈 배열은 거부됩니다.
- **한 id는 한 `backend`의 것입니다.** 같은 runtime에서 `backend`가 **다른** 두 항목이 같은 id를 선언하면 거부합니다(`RESOLVED_MODEL_ID_DECLARED_FOR_ANOTHER_BACKEND`). **다른 항목의 `backend`나 `model` 그 자체인 id를 선언하는 것도 같은 코드로 거부합니다**(예: `opus` 항목에 `sonnet`, 또는 `claude-opus-5-5` 항목에 다른 항목의 backend인 `claude-sonnet-5`). 꺼 둔(`enabled: false`) 항목도 포함하고, 항목 순서와 무관합니다. 한 모델이 두 모델이라는 뜻이 되고, 한 모델의 실행이 다른 모델 프로필의 실적으로 들어갈 수 있기 때문입니다. `backend`가 같은 두 항목(같은 모델을 두 slot에 쓰는 경우. pilot의 registry가 `standard`와 `strategic` 모두 `opus`였습니다)은 같은 id를 선언할 수 있습니다. 항목 자신의 `backend`와 같은 id는 쓸모는 없지만 허용합니다.
- **없으면 이전과 똑같습니다.** 필드가 없는 항목은 `backend` 문자열 일치만 받습니다. 프로필 fingerprint, 프로필 이름(설치되는 agent 파일 이름), hook 출력이 바뀌지 않습니다(테스트가 이전 commit의 값과 대조합니다).
- **선언은 프로필 fingerprint의 일부입니다.** fingerprint는 registry 모델 항목 전체의 해시이므로 `resolvesTo`를 추가·변경·삭제하면 그 항목의 프로필 fingerprint가 바뀝니다(목록의 순서는 영향 없음). 그 결과: (1) 이전 선언 아래에서 가져온 평가 행은 **더 이상 세지 않습니다**(라우터의 요약이 fingerprint가 다른 행을 건너뜁니다). (2) 선언하기 **전에** 돌린 세션의 route는 옛 fingerprint를 갖고 있어 행이 되지 않습니다(`STALE_EVIDENCE_PROFILE`). (3) registry를 고친 뒤에는 다시 설치해야 합니다(설치된 프로필의 fingerprint 기록이 달라져, 재설치 전에는 그 프로필로의 재작성이 `PROFILE_NOT_INSTALLED_OR_STALE`로 적용되지 않습니다). 프로필 **파일 이름과 내용은 그대로**입니다.
- **요청하는 모델은 바뀌지 않습니다.** `resolvesTo`는 평가 행을 받아들일 때만 쓰입니다. host에 보내는 값은 여전히 `model`입니다.
- env로 그 slot의 모델을 바꾸면(`JEV_<RUNTIME>_<SLOT>_MODEL`/`_BACKEND`가 registry와 다름) 그 항목의 선언은 버립니다. 다른 모델에 대한 선언이었기 때문입니다.

저장되는 평가 행에는 어떻게 일치했는지가 남습니다(`effective.modelMatch`: `exact` 또는 `declared`). 수집기의 후보 행에도 같은 값이 들어 있고, 가져오기는 그 값이 지금 registry로 계산한 것과 다르면 거부합니다(`EFFECTIVE_MODEL_MATCH_MISSTATED`). 이 필드가 생기기 전에 저장된 행은 보고서에서 `unrecorded`로 셉니다(당시에는 `exact`만 가능했습니다). 저장소 보고서(`feedback.mjs --report`)는 프로필마다 현재 행의 모델별 수(`currentEffectiveModels`)와, 현재 행이 둘 이상의 모델을 적고 있는 프로필 목록(`mixedModelProfiles`)을 보여 줍니다.

**선언이 맞는지는 아무도 대신 확인해 주지 않습니다.** 별칭이 가리키는 모델은 host 쪽에서 바뀔 수 있습니다. 바뀌면 host는 새 id를 기록하고, 그 실행은 다시 `alias-undeclared`로 보류됩니다. 그때 할 일은 다음과 같습니다.

- **옛 id를 새 id로 바꿉니다(추가가 아니라 교체).** 선언을 고치면 fingerprint가 바뀌어 옛 선언 아래의 행은 세지 않게 됩니다(저장소에는 `stale`로 남습니다). 다시 설치하고 새 세션을 돌립니다.
- **같은 과제를 같은 context 이름으로 다시 가져올 수 있습니다.** 저장 단위에 프로필 fingerprint가 들어 있어, 옛 정의의 행이 새 행을 막지 않습니다. 같은 정의 안에서 같은 과제의 다른 내용은 여전히 `CONFLICTING_EVALUATION_UNIT`입니다. host 버전처럼 **다른 조건도 함께** 달라졌다면 평가 context 이름도 바꾸세요(context는 "이 조건끼리만 비교한다"는 약속입니다).
- **한 항목에 id를 둘 이상 적으면 그 id들은 한 fingerprint를 공유합니다.** 그 상태에서 두 id가 모두 기록되면 fingerprint만으로는 둘이 갈리지 않습니다. 라우터는 이때 둘을 합쳐 세지 **않고** 그 프로필을 측정 없음으로 둡니다(위 "평가 행이 라우터에 닿는 길"의 (3)). 15건 + 15건으로 `minimumSamples` 30을 채울 수 없습니다. 여러 id를 적는 것은 host가 **같은 모델**을 두 이름으로 기록할 때를 위한 것이지만, 그 경우에도 통계는 id 하나의 행만으로 이루어져야 합니다. 섞인 프로필은 `feedback.mjs --report`의 `mixedModelProfiles`에 나옵니다. 풀려면 쓰지 않는 id를 선언에서 빼거나(fingerprint가 바뀌므로 새로 모아야 함), 오래된 쪽 행이 `evidenceTtlDays`를 넘길 때까지 기다립니다.

### 평가 행이 만들어지려면

평가 저장소 0행에서 "라우팅에 영향을 주는 자료"까지, 사용자가 하는 일을 순서대로 적습니다. 하나라도 빠지면 행이 만들어지지 않거나 쓰이지 않습니다.

1. **평가 context에 이름을 붙입니다.** env의 `JEV_EVALUATION_CONTEXT`(또는 config의 `optimization.evaluationContext`)를 기본값 `native-default-unvalidated`가 아닌 이름으로 정합니다(예: `desktop-2.1.330-auto-v1`). 이름은 "이 조건에서 얻은 자료끼리만 비교한다"는 약속입니다. host 버전이나 권한 모드처럼 결과를 바꾸는 조건이 달라지면 이름도 바꾸세요. **이 설정은 세션을 돌리기 전에 해야 합니다.** route에 그때의 context가 기록되고, 수집기는 기록된 context와 같은 이름으로만 행을 만듭니다.
2. **host가 기록하는 모델 id를 확인하고 선언합니다.** registry의 `backend`가 host가 기록하는 id와 같으면(구체 id를 적은 registry) 할 일이 없습니다. 별칭을 쓰면: 세션을 한 번 돌린 뒤 수집기를 `--dry-run`으로 돌려 요약의 `modelMatch.undeclared`를 봅니다. 항목마다 `registryEntry`(registry 항목 id), `backend`(별칭), `observedModel`(host가 기록한 id), `declarable`(선언할 수 있는 형식인가), 위임 수가 나옵니다. 이 목록은 관찰이지 붙여 넣을 선언이 아닙니다. **그 id가 그 항목이 뜻하는 모델이 맞는지 직접 확인한 뒤** registry 파일의 그 항목에 `resolvesTo`로 적습니다. 수집기는 적어 주지 않습니다. `node orchestration/scripts/doctor.mjs`의 `evidence`가 활성 항목마다 선언된 id와 가져오기 가능 여부(`blocked:evaluation_context_not_configured` / `possible:exact_backend_only` / `possible:exact_backend_or_declared_id`)를 보여 줍니다.
3. **다시 설치합니다**(`install.mjs --registry …`, [SETUP](SETUP.ko.md)). 선언이 fingerprint를 바꿨기 때문입니다.
4. **`active` 모드로 세션을 돌립니다.** `shadow`나 `advisory`에서는 route가 기록만 되고 적용되지 않으므로 그 실행은 프로필의 실적이 아닙니다(`route_not_applied`). 1~3 **이후에** 돌린 세션만 자료가 됩니다.
5. **외부 검증 결과를 준비합니다.** 과제마다 통과/실패를, 서브에이전트의 보고가 아닌 **별도의 검사**로 판정해 [검증 파일](#검증-파일)로 만듭니다. 수집기는 통과 여부를 만들어 내지 않습니다. 비용을 최적화 기준에 넣으려면 `costUsd`도 줘야 합니다.
6. **수집기를 돌립니다.** `collect.mjs --config … --transcripts … --verification …`. 요약의 `evaluations.produced`, `producedByModelMatch`(`exact`/`declared`), `withheld`(보류 이유)를 확인합니다.
7. **후보 파일을 검토합니다.** `<stateDir>/collector/evaluations-….candidate.jsonl`. 과제 수, 통과 여부, `effective.model`과 `modelMatch`, 시간, 시도 수가 아는 사실과 맞는지 봅니다.
8. **명시적으로 가져옵니다.** `feedback.mjs --file <후보 파일> --accept-evidence --config …`. `--accept-evidence` 없이는 거부됩니다. 저장소에 무엇이 들어 있는지는 `feedback.mjs --report --config …`(프로필별·일치 종류별 행 수, 현재/낡음)로 봅니다.

가져온 뒤에 적용되는 기준(기본값은 `src/config.mjs`의 `optimization`):

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `minimumSamples` | 30 (허용 5~10000) | 기준 프로필과 후보 프로필이 **같은 과제 집합**에서 각각 이만큼의 행을 가져야 실측 기준이 됨 |
| `qualityFloor` | 0.85 | 성공률의 Wilson 95% 하한이 이 값 이상이어야 함. 30건이 전부 통과해도 하한은 약 0.886입니다 |
| `nonInferiorityTolerance` | 0.02 | 후보의 하한이 기준 프로필의 하한보다 이 값 넘게 낮으면 제외 |
| `objectiveSlack` | 0.08 | 측정된 비용·시간 목적값이 가장 좋은 프로필에서 이 범위 안인 것만 후보 pool에 남김 |
| `evidenceTtlDays` | 30 | 이보다 오래된 행은 세지 않음 |

이 기준에 못 미치는 동안에는 선택이 바뀌지 않습니다(`policy_prior_not_measured`). 요약 통계는 프로필 선택 judge의 참고 입력으로만 들어갑니다(위 "평가 행이 라우터에 닿는 길"의 (5)). 평균 비용이 없으면(`costUsd`가 `null`인 행이 하나라도 있으면) 행이 아무리 많아도 실측 기준이 되지 않습니다.

**기록된 pilot 세션 두 개는 어떤 설정으로도 가져올 수 없습니다.** 기본 context(`native-default-unvalidated`)로 실행됐기 때문입니다. 지금 config를 그대로 쓰면 `evaluation_context_not_configured`, 나중에 context 이름을 붙여도 route에 기록된 context가 기본값이라 `session_ran_under_default_evaluation_context`입니다. 여기에 더해, 그 세션들은 `resolvesTo` 선언 이전에 돌았으므로 선언을 추가한 registry로는 프로필 fingerprint도 맞지 않습니다(`STALE_EVIDENCE_PROFILE`). 자료를 얻으려면 위 1~4를 한 뒤 **새 세션**을 돌려야 합니다.

**선언을 나중에 고쳤다면**(host가 별칭을 다른 id로 풀기 시작함): 2의 선언을 새 id로 **교체**하고 3~8을 다시 합니다. 같은 과제를 같은 context 이름으로 다시 가져와도 됩니다(옛 행은 `stale`로 남고 세지 않음). 옛 id와 새 id를 한 목록에 함께 두고 둘 다 기록되면 그 프로필은 측정 없음이 됩니다(위 "registry의 `resolvesTo`").

### 요약과 관찰 보고서

수집 명령은 JSON 요약을 출력합니다: 본 위임·이은 위임·못 이은 이유, 지점·출처별로 쓴 라벨 수(`labels.written`)·철회한 수(`labels.retracted`)·쓰지 않은 이유(`labels.unlabelled`)·판정 불가 접근의 종류(`labels.indeterminateAccess`), 질문 대응 결과(`skillQuestionMapping`), 관찰 기록 수, 평가 행 수(`evaluations.produced`, 일치 종류별 `producedByModelMatch`)와 보류 이유, 모델 일치 요약(`modelMatch`: 라우팅되고 이어진 위임의 종류별 수, 선언되지 않은 채 기록된 id의 목록 `undeclared`, host가 알려 준 모델 id와 서브에이전트 기록의 대조 결과 `resolvedModelCheck`), 검증 항목의 일치 수, 종류별 경고 수, 본 host 형태(`host.versions` 등), 위임 색인(`delegationIndex`: 해시만).

`--report`는 관찰 기록(위임마다 최신 줄)을 요약합니다. **서술만 하고 아무것도 판정하지 않습니다.** 요청 대 실제 일치율(프로필, 모델 `exact`/`declared`/`declaredNotInForce`/`aliasUndeclared`/`mismatch`와 `acceptedRate`, effort. `acceptedRate`는 `exact`+`declared`의 비율로, **모델 id 비교만의 결과**입니다. 세션 때 유효했던 선언으로 비교하므로 선언 전 세션은 들어가지 않지만, 행이 되려면 검증 결과·context 등 나머지 조건도 필요하므로 "가져올 수 있는 행의 비율"은 아닙니다), 프로필별 위임 수와 검증 통과율(검증이 없으면 `null`), 위임당 평균 토큰·turn·tool 호출·시간(값이 있는 기록 수 `measured`와 함께), judge 요청 수, judge 토큰 비중(decision log에 `usage`가 없으면 `null`), 라우팅 hook 시간이 end-to-end 시간에서 차지하는 비중, 그리고 "블록이 있었나 × skill을 load했나" 교차표(판정 불가는 `loadUnknown`)입니다. `--config`로 부르면 평가 저장소의 행 수도 함께 나옵니다(`evidenceStore`: 전체, 현재/낡음, 일치 종류별 `exact`/`declared`/`unrecorded`, 프로필별, `mixedModelProfiles`).

### 실제 세션 자료에 돌린 결과 (2026-11-25)

오프라인으로, hook 상태의 **사본**에 돌렸습니다(`qa/kernel/collector/run-pilot-evidence.sh`, 결과 `qa/kernel/results/collector-20261125-r2/`). 검증 파일은 pilot의 scripted checker(`qa/kernel/pilot/checkers/check.mjs`, 변경 없음)를 두 프로젝트에 돌려 만들었습니다. 앞서 저장한 `qa/kernel/results/collector-20261125/`는 검토 이전 수집기(`outcome-collector-1`)의 결과이고 **이 절의 수치로 대체됩니다**. 그 폴더의 `need` 수치(FN 7)는 라벨 규칙의 오류였습니다(요청마다 자기 구간만 묻는 `need`에 "위임 전체에서 무엇이든 load"를 붙임).

| | arm A (skill 지점 off) | arm B (skill 지점 active) | 재확인 세션 (상태만) |
|---|---|---|---|
| `Agent` 호출 / 위임 | 15 / 8 | 16 / 8 | 6 / 3 |
| 라우팅됨 / 대화 기록에 이음 | 7 / 8 (1건은 `route_deferred`) | 8 / 8 | 3 / 0 (`no_transcripts`) |
| 연결 종류 | 수정 이전 형태 7 | 수정 이전 형태 8 | `reissue` 3 |
| 질문 대응(유도, log 대조) | 해당 없음 | 결정 32개 전부, 답 960개 일치 | 결정 6개 전부, 답 180개 일치 |
| skill 접근 판정 불가인 위임 | 4 (루트 재귀 `grep` 3, skill 폴더를 준 `grep` 1) | 2 (루트 재귀 `grep`) | 해당 없음 |
| 쓴 라벨 | 0 | `observed-load` 124, `observed-load-after-injection` 248, `external-verification-with-load` 3, `external-verification-with-load-after-injection` 9 | 0 |
| 라벨이 붙은 결정 / 그 지점의 결정 | 해당 없음 | 12 / 32 (블록 없음 4, 블록 있음 8) | 0 / 6 |
| 라벨 없이 둔 결정 | 해당 없음 | 20: 실행된 호출에 적용되지 않은 두 번째 판단 16, 판정 불가 4 | 9 (`delegation_not_joined`: skill 결정 6, 보고 판정 3) |
| 관찰 기록 | 8 | 8 | 0 |
| 검증 항목 일치 | 8/8 (통과 8) | 8/8 (통과 8) | 없음 |
| 평가 행 | 0 (보류 8) | 0 (보류 8) | 0 |
| 경고 | 0 | 0 | 0 |

- **평가 행이 0인 이유.** 두 세션의 config는 평가 context가 기본값(`native-default-unvalidated`)이었습니다(16건). context를 준 dry-run에서도 0행입니다: 라우팅된 15건 모두 host가 기록한 모델(`claude-opus-5-5`, `claude-sonnet-5-5`)이 registry의 `backend`(`opus`, `sonnet`)와 문자열이 달랐고(`effective_model_differs_from_profile_backend`), 나머지 1건은 라우팅되지 않았습니다. 가져오기 검증이 문자열 일치를 요구하므로 수집기는 별칭을 풀어 적지 않습니다. 평가 행을 얻으려면 registry의 `backend`를 host가 기록하는 구체 id로 적거나, 그 id를 `resolvesTo`로 선언해야 합니다([위](#registry의-resolvesto-host가-풀어-준-모델-id-선언)). 이 결과는 `outcome-collector-2`의 것이고, 같은 자료를 선언 기능이 들어간 수집기로 다시 돌린 결과는 [아래](#선언된-모델-id로-다시-돌린-결과-2026-11-25)에 있습니다. 그때의 보류 이유 이름 `effective_model_differs_from_profile_backend`는 지금 `effective_model_alias_undeclared`와 `effective_model_mismatch`로 나뉘었습니다. route 모드는 15건 모두 `active`, agent type은 15건 모두 프로필과 일치했으므로 새 보류 이유(`route_not_applied`, `agent_type_differs_from_profile`)는 여기서 0건입니다.
- **요청 대 실제.** 프로필 15/15, effort 15/15 일치. 모델은 `exact` 0, `alias` 15, `mismatch` 0.
- **calibration(arm B, `delegation.skills`).** 실제 세션에서 나온 첫 수치입니다. **전부 약한 라벨이고, 합성 pilot 세션 1개(실행 1회)에서 나왔으며, 보고서의 `sufficient`는 모든 묶음에서 `false`(`weak_labels`)입니다.** 라벨은 그 지점 결정 32개 중 12개에만 붙었습니다(조건부 값, 위 선택 편향 참고).

  | 출처 | 질문 | 결정 n (위임) | 라벨 n | Brier | ECE | 기저율 | 임계값 0.5에서 TP / FP / TN / FN |
  |---|---|---|---|---|---|---|---|
  | `observed-load` (블록 없음) | 전체 | 4 (2) | 124 | 0.0117 | 0.0249 | 0.0242 | 1 / 0 / 121 / 2 |
  | | `need` | 4 (2) | 4 | 0.1189 | 0.2200 | 0.25 | 0 / 0 / 3 / 1 |
  | | `skill_<i>` | 4 (2) | 120 | 0.0081 | 0.0184 | 0.0167 | 1 / 0 / 118 / 1 |
  | `observed-load-after-injection` (블록 있음, 판정의 영향) | 전체 | 8 (4) | 248 | 0.0060 | 0.0419 | 0.0363 | 9 / 0 / 239 / 0 |
  | | `need` | 8 (4) | 8 | 0.0653 | 0.2300 | 0.5 | 4 / 0 / 4 / 0 |
  | | `skill_<i>` | 8 (4) | 240 | 0.0040 | 0.0356 | 0.0208 | 5 / 0 / 235 / 0 |

  임계값에 참고할 수 있는 것은 첫 묶음뿐이고 그것은 **결정 4개(위임 2건)** 입니다. 무엇도 결론 내릴 수 없는 크기입니다. 블록 있는 묶음의 TP 9 / FN 0은 "블록이 load하라고 한 skill을 서브에이전트가 load했다"는 뜻이지 judge가 맞았다는 뜻이 아닙니다. 두 묶음 모두 라벨의 97% 이상이 "load하지 않음"이라 Brier와 ECE는 대부분 그 쉬운 음성에서 나옵니다.
- **관찰 보고서.** 검증 통과율은 두 arm 모두 8/8, 규칙 검사 6/6. 위임당 평균 토큰 합 A 423,554 / B 532,570(대부분 cache read), 평균 wall time A 50.5초 / B 62.5초. judge 요청은 A 28건(위임당 3.5), B 64건(위임당 8): 수정 이전 형태라 호출 두 개가 각각 판단됐습니다. judge 토큰 비중은 `null`(두 decision log에 `usage` 필드가 없음). 라우팅 hook 시간 비중은 A 2.0%(7건), B 1.9%(8건). 교차표: A는 블록 없음에서 load 4 / 없음 0 / 판정 불가 4, B는 블록 있음에서 load 4(블록의 load skill을 4/4 load), 블록 없음에서 load 1 / 없음 1, 판정 불가 2(블록 있음 1, 없음 1).
- 위임 16건의 토큰 합·wall time·API turn·tool 호출·load한 skill·블록 유무는 검토 이전 실행과 16/16 같고(바뀐 것은 판정 불가 표시와 agent type 표기), 그 값들은 pilot 분석기(`qa/kernel/pilot/analyze.mjs`, 서로 다른 코드)의 결과와 16/16 일치했습니다. load로 센 15건(A 6, B 9)은 모두 오류 없는 tool 결과가 있었습니다.
- 같은 상태에 두 번째로 돌리면 라벨 0개, 관찰 0개를 씁니다(이미 있음 384 / 8), 철회 0.
- 사본으로 따로 확인한 것(저장하지 않음): 검증 파일 없이 다시 돌리면 관찰 0개를 쓰고 8건을 유지(`keptVerified` 8, 보고서 통과율 8/8 그대로). 검증을 전부 실패로 고쳐 돌리면 `…-with-load…` 라벨 12개를 철회하고 보고서의 출처별 수에서 빠짐. 서브에이전트 기록 하나를 20행에서 자르고 `finished: false`로 두면 그 위임은 `subagent_not_finished`로 빠지고 라벨·관찰이 없음(나머지 7건은 그대로).

### 선언된 모델 id로 다시 돌린 결과 (2026-11-25)

같은 pilot 자료의 **사본**에 `outcome-collector-4`를 오프라인으로 돌렸습니다(`qa/kernel/collector/run-alias-demo.sh`, 결과 `qa/kernel/results/collector-alias-20261125-r2/`). 검토 전 결과(`outcome-collector-3`, `qa/kernel/results/collector-alias-20261125/`)는 대체됐고 추적용으로만 남겼습니다. 달라진 것은 (다)의 모델 일치 분류와 요약의 `wouldNeed` 제거뿐이고, 평가 행 수(0)와 (가)·(나)의 수는 같습니다. 세 경우입니다. **(나)와 (다)는 동작을 보이기 위한 dry-run이고 가져올 수 있는 자료가 아닙니다.**

| 경우 | arm A (위임 8, 라우팅 7) | arm B (위임 8, 라우팅 8) |
|---|---|---|
| (가) 기록된 config(사본을 가리키도록 `stateDir`만 바꾸고 registry `revision`에 데모 표시), 실제 실행 | 0행. `evaluation_context_not_configured` 8, `effective_model_alias_undeclared` 7, `delegation_not_routed` 1 | 0행. `evaluation_context_not_configured` 8, `effective_model_alias_undeclared` 8 |
| (나) context 이름을 주고 선언 없이, dry-run | 0행. `session_ran_under_default_evaluation_context` 7, `effective_model_alias_undeclared` 7, `delegation_not_routed` 1 | 0행. `session_ran_under_default_evaluation_context` 8, `effective_model_alias_undeclared` 8 |
| (다) context 이름 + 스크립트에 손으로 적은 id 두 개를 선언한 임시 config, dry-run | 0행. `session_ran_under_default_evaluation_context` 7, `importer_refuses:STALE_EVIDENCE_PROFILE` 7, `effective_model_declared_after_session` 7, `delegation_not_routed` 1 | 0행. `session_ran_under_default_evaluation_context` 8, `importer_refuses:STALE_EVIDENCE_PROFILE` 8, `effective_model_declared_after_session` 8 |
| 모델 일치, (가)·(나) | `alias-undeclared` 7 | `alias-undeclared` 8 |
| 모델 일치, (다) | `declared` 0, `declared-not-in-force` 7 | `declared` 0, `declared-not-in-force` 8 |
| (다)를 사본에 실제로 쓴 뒤의 보고서 | 비교 7, `declaredNotInForce` 7, `acceptedRate` 0 | 비교 8, `declaredNotInForce` 8, `acceptedRate` 0 |

- (가)·(나)의 요약이 알려 준 것(`modelMatch.undeclared`): 항목 `claude-light`(별칭 `sonnet`)에서 `claude-sonnet-5-5`(A 1건, B 1건), 항목 `claude-standard`(별칭 `opus`)에서 `claude-opus-5-5`(A 6건, B 7건). 넷 다 `declarable: true`. 수집기는 어느 registry에도 쓰지 않았습니다(자료의 config 두 개의 SHA-256, 상태 파일 수 116/169, 상태 파일 전체의 해시가 실행 전후 같음. 자료 config의 `resolvesTo` 0건).
- (다)의 선언은 요약에서 기계적으로 옮긴 것이 **아닙니다**. `run-alias-demo.sh`에 사람이 적은 두 줄(`claude-light=claude-sonnet-5-5`, `claude-standard=claude-opus-5-5`)이고, 데모 도우미(`make-alias-demo-config.mjs`)는 수집기 요약을 읽지 않으며 작업 폴더 밖에는 쓰지 않고 registry `revision`을 `DEMO-NOT-FOR-INSTALL`로 바꿉니다.
- (다)에서 `alias-undeclared`는 사라지지만 그 15건은 `declared`가 **아닙니다**. 세션이 그 선언 없이 돌았기 때문입니다(`declared-not-in-force` 15). 이전 결과는 이 15건을 `declared`로 적었고, 실제로 썼다면 관찰 보고서의 `acceptedRate`가 1로 나왔을 것입니다. 지금은 0입니다. 남는 이유는 세션이 기본 context로 실행됐다는 것(15건)과 프로필 fingerprint가 다르다는 것(15건)이고, **둘 다 설정을 고쳐서 없앨 수 없습니다.** 선언된 id로 행이 실제로 만들어지고 가져와지는 경로는 합성 세션 테스트로만 확인했습니다(`test/collector.test.mjs`의 end to end).
- **host가 알려 준 모델 id 대조.** Main 기록의 실행 접수 결과에 있는 `resolvedModel`은 서브에이전트 기록의 모델과 16건 중 16건 같았습니다(`hostResult.agreed` A 8, B 8). hook 상태 쪽 값은 16건 모두 없습니다(`hookEvent.absent`): 이 세션들의 hook은 그 값을 남기기 전 버전입니다. 저장소 밖에 남아 있는 실제 세션의 hook 입력(`PostToolUse`의 `Agent` 이벤트) 3건에는 `tool_response.resolvedModel`이 3건 모두 있었습니다. **hook이 남긴 값과 대화 기록의 대조는 실제 세션으로는 아직 해 보지 못했습니다**(테스트만).

### 한계

- **`resolvesTo`는 사용자의 말입니다.** 선언된 id가 그 항목이 뜻하는 모델이 맞는지 이 확장은 확인하지 않습니다. `alias-undeclared`와 `mismatch`의 구분도 이름의 토막 비교일 뿐이라, 수집기의 안내(`undeclared`)는 "확인해 볼 것"이지 "넣어도 되는 것"이 아닙니다. registry 검증이 막는 것은 형식과, 한 id가 두 `backend`에 걸리는 경우(다른 항목의 `backend`/`model`을 선언하는 경우 포함)뿐입니다. registry에 없는 다른 모델의 id를 잘못 적는 것은 막지 못합니다.
- **대화 기록 형식은 계약이 아닙니다.** 실제로 본 형태는 Claude Code 데스크톱 `2.1.330`(`entrypoint: claude-desktop`, 권한 모드 `auto`)의 세션 2개뿐입니다. 다른 버전·CLI·다른 권한 모드의 기록은 본 적이 없습니다. 모르는 형태는 `null`과 경고 수로 나오고 추측하지 않습니다. 끝났다는 확인(`.meta.json`의 `finished`)과 tool 결과의 오류 표시(`is_error`)도 이 버전에서 본 형태입니다.
- **Codex는 지원하지 않습니다.** Codex 대화 기록을 본 적이 없어 파서를 만들지 않았습니다. codex 세션의 위임은 `runtime_transcripts_unsupported`로 셉니다.
- **약한 라벨, 그리고 판정이 만든 라벨.** `observed-load`는 서브에이전트의 행동이고 서브에이전트가 값싸게 만들 수 있습니다. 블록이 주입된 위임의 라벨(`-after-injection`)은 판정이 행동을 유도한 결과입니다. 약한 라벨만으로 임계값을 정하면 "서브에이전트가 무엇을 하는가"에 맞추는 것이지 "무엇이 필요했는가"에 맞추는 것이 아닙니다. **"그 skill이 필요했는가"의 검증된 라벨을 만드는 방법은 이 수집기에 없습니다.**
- **선택 편향.** 라벨은 잇고, 끝난 것을 확인하고, 판정 가능하고, 적용된 결정에만 붙습니다([위](#쓰는-것-2-라벨과-그-강도)). 지표는 그 부분집합의 값입니다.
- **skill load 판정은 휴리스틱입니다.** 잡지 못하는 접근은 [위 목록](#쓰는-것-1-관찰-기록)에 있습니다. 판정 불가 쪽으로 기울게 만들었으므로 루트 재귀 검색을 하는 위임은 라벨을 잃습니다(실제 자료에서 16건 중 6건).
- **잘린 사본은 host 기록이 그렇게 말할 때만 압니다.** `.meta.json`이 `finished: true`인데 `.jsonl`만 잘린 사본은 구별하지 못합니다. 답이 없는 tool 호출이 있으면 경고(`subagent_tool_call_without_result`)를 셀 뿐입니다.
- **`taskHash`는 추측한 과제 글을 확인하는 데 쓸 수 있습니다**(키 없는 해시). 실제 프로젝트의 관찰 기록·요약·검증 파일·평가 행을 공유하지 마세요.
- **철회는 수집기가 다시 돌았을 때만 일어납니다.** 검증 결과를 고친 뒤 수집기를 그 세션에 다시 돌리지 않으면 옛 라벨이 남습니다. 대화 기록을 더는 구할 수 없으면 손으로 철회 표시를 붙여야 합니다.
- **재발행 수정 이후 형태(`reissue`)의 end-to-end 수집은 실제 자료로 해 보지 못했습니다.** 재확인 세션은 대화 기록을 보관하지 않아 상태만 요약했습니다(테스트는 합성 기록으로 함). 그 세션의 supervisor 판정 3건도 외부 검증이 없어 라벨이 없습니다. `shadow` 모드 세션도 실제 자료가 없습니다(테스트만).
- `supervisor.outcome`은 실제 자료에서 라벨이 한 건도 없습니다. `external-verification` 라벨은 통과한 과제만 생기므로, 실패 사례가 쌓이기 전에는 supervisor의 오판을 잴 수 없습니다.
- judge 토큰은 decision log에 `usage`가 있을 때만 셉니다. 분류·프로필 판단의 id는 이 변경 이후의 `route` 이벤트에만 있습니다.

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

2026-11-25 기준, branch `qa/kernel-eval`(제품 트리 `c09cd2e`). **이 브랜치는 저장소 소유자의 결정으로 `main`에 병합됩니다(2026-11-25).** 아래 항목의 상태는 병합으로 바뀌지 않습니다. 근거 파일 경로는 저장소 루트 기준입니다. 한 장 요약은 `qa/kernel/SUMMARY.ko.md`입니다.

### 이전에 열려 있던 6개 항목

상태는 `해결` / `부분 해결` / `미해결` 중 하나입니다. 올림하지 않았습니다.

| # | 항목 | 상태 | 확인한 것과 근거 파일 | 남은 것 |
|---|---|---|---|---|
| 1 | 실제 효과 측정 (작업 품질·시간·비용) | **미해결** | 측정한 것은 합성 데이터에 대한 **판정 일치도**뿐입니다. skill 라우팅은 개발 세트(실제 Jev 719건, `qa/kernel/results/dev-retrieval-decision-1/`)와 held-out 세트 1개(540건, `qa/kernel/results/holdout-1-score-1/`), supervisor는 합성 보고 120건(`qa/kernel/results/20261125-full/`)입니다. 수치는 아래 [결정 기록](#결정-기록) | 실제 작업에서 skill 주입·supervisor 조언이 결과를 개선하는지는 여전히 모릅니다. 주입 있음/없음을 짝지은 pilot을 한 번 했습니다(아래 [Skill 주입 paired pilot](#skill-주입-paired-pilot)): 규칙 검사 통과가 두 arm 모두 6/6이었고, 주입이 없는 arm에서도 서브에이전트가 skill 60개짜리 프로젝트에서 맞는 skill을 스스로 load했습니다. baseline이 만점이라 이 pilot은 이득을 잴 수도 배제할 수도 없습니다. supervisor 조언의 효과는 한 건도 재지 않았습니다. 재발행 수정 뒤의 재확인 세션은 hook 동작만 확인했고 작업 결과를 채점하지 않았습니다. 라벨은 모델이 만들었고 사람이 검토하지 않았습니다 |
| 2 | 실제 hook / 실제 Claude Code 세션 경유 종단 실행 | **부분 해결** | (가) 실제 설치기로 일회용 HOME에 설치한 뒤 등록된 entrypoint를 직접 호출: 100회(그중 실제 Jev/OpenAI judge 시나리오 88회, 나머지 12회는 judge가 아닌 loopback 소켓에 대한 장애 주입), 기대 214개 중 212 PASS·0 FAIL·soft miss 2(제품 `e8333f9`). `qa/kernel/results/20261125-e2e/hooks.txt`, `hooks.json`. (나) 실제 Claude Code 데스크톱 세션 4회, 프로젝트 수준 hook, 전역 `advisory` 모드: 실제 Agent 호출에서 hook 실행, 실제 Jev로 라우팅과 skill 선택, hand-back 경로에서 supervisor 판정, 세션 4에서 조언이 Main에 전달. `qa/kernel/results/real-session-20261125/summary.json`, 아래 [실제 데스크톱 세션](#실제-데스크톱-세션-4회) (다) pilot의 실제 세션 2개, 전역 `active` 모드: 위임 16건 중 15건에서 재작성된 호출이 실행됨(`qa/kernel/results/pilot-20261125/`). (라) 재발행 수정 뒤 실제 세션 1개, 전역 `active` 모드, 기본 임계값, 위임 3건: 3건 모두 재작성, host 거부, 재발행 인식(judge 요청 0건), 실행, supervisor 판정, Main으로 조언 전달(확신 0.88, 1.00, 0.99). `hook_error`·`failure`·`unverified_prompt` 이벤트 없음. `qa/kernel/results/real-session-reissue-20261125/summary.json`, 아래 [재확인](#재발행-수정-뒤-실제-세션-재확인) | 실제 세션에서 확인하지 않은 것: Codex runtime(실행 없음), 결합 수정 뒤 harness 알림 줄이 있는 hand-back prompt 형태(fixture로만 확인. 재확인 세션에서 나왔는지 알 수 없음), 120초보다 늦은 재발행, `auto`가 아닌 권한 모드의 `active`. Codex와 알림 줄 형태가 남아 있어 "해결"로 올리지 않았습니다. 권한 모드 `auto`에서는 재작성된 위임마다 Main 왕복이 한 번 더 들고, 이 확장은 host의 거부를 우회하지 않습니다. 이전의 `20261125-e2e/real-session.json`(BLOCKED)은 그 시점의 기록입니다 |
| 3 | OpenAI 첫 호출 timeout | **부분 해결** | 제공자별 timeout(`kernel.providers.openai.timeoutMs`, 기본 2500ms)을 추가했고 loopback 테스트로 계약을 확인했습니다(`orchestration/test/kernel-judges.test.mjs`, `kernel-hooks.test.mjs`). 실제 API: 매번 새 프로세스로 OpenAI만 쓴 위임 5건에서 요청 14건, 최대 778ms, timeout 0건(`20261125-e2e/hooks.json` → `s17-openai-only-cold-latency`). 평가 러너에서 280건, 최대 928ms(`20261125-full/summary.txt`) | 2500ms는 분포에서 정한 값이 아닌 초기값입니다. cold 호출 표본은 14건뿐입니다. e2e 단계가 보고한 cold 1336ms·1396ms 관측은 저장된 파일에 없습니다. 위 실제 호출은 잠금 대기 수정(`e6fb770`) 이전 트리에서 했고, 그 뒤 OpenAI를 실제로 다시 부르지 않았습니다 |
| 4 | 검토 수정 뒤 기본 동작 바이트 비교 | **해결** | 저장소에 남긴 반복 가능한 검사로, 기본 검색 방식 변경과 supervisor hand-back 경로까지 포함한 트리에서 다시 실행(마지막 실행은 이 문서 갱신 때, HEAD `2d987ae`): hook 출력 168개(이벤트 14개로 확장)·judge 호출 21건 일치, 차이 0, 종료 코드 0. `orchestration/scripts/compare-default-behavior.mjs`(`npm run compare:default`), `orchestration/test/default-behavior.test.mjs`. 아래 [기본 동작 비교](#기본-동작-비교) | 없음. 단, 이 검사가 다루지 않는 범위(기본값이 아닌 kernel 설정, 실제 호출, 프로세스 entrypoint 등)는 아래 목록 그대로이며 그 범위에 대한 주장은 아닙니다 |
| 5 | macOS 기본 `TMPDIR`에서 `npm test` 단독 실행 | **해결** | `TMPDIR=/var/folders/...`(심볼릭 링크 경로) 그대로 `cd orchestration && npm test`: 608/608 통과, 실패 0(이 문서 갱신 때 HEAD `2d987ae`에서 다시 실행). fixture가 임시 디렉터리를 `realpath`로 정규화(`orchestration/test/helpers.mjs`), 재현 테스트 `orchestration/test/fixture-paths.test.mjs` | 없음 |
| 6 | 심볼릭 링크된 skill 폴더 | **부분 해결** | `.claude` 또는 `.claude/skills`가 **프로젝트 안**을 가리키는 링크이면 따라가서 읽고, 주입 경로는 논리 경로로 고정합니다(commit `95e30f1`). `orchestration/test/kernel-skills.test.mjs`, `kernel-hooks.test.mjs` "a symlinked skills root inside the project routes…" | 링크가 **프로젝트 밖**(예: 홈의 공유 skill 폴더)을 가리키면 여전히 프로젝트 skill 전체를 읽지 않습니다(`root_outside_project`, 의도된 제한이며 `JEV_SKILL_DIRS`로 그 경로를 직접 지정해야 함). 개별 skill 폴더나 `SKILL.md`가 링크인 경우도 계속 건너뜁니다. 링크된 skill 폴더는 실제 프로젝트나 실제 세션에서 확인하지 않았습니다 |

**실제 API 호출에 대한 주의:** 위 근거 중 `20261125-full`(683건)과 `20261125-e2e`(75건)는 실제 TypeSafe·OpenAI API를 호출한 결과이고, `dev-retrieval-decision-1`(719건)과 `holdout-1-score-1`(540건)은 실제 TypeSafe API를 호출한 결과입니다. 보낸 것은 `qa/kernel/data`와 `qa/kernel/holdout-1`의 합성 데이터뿐입니다. 실제 세션 4회도 실제 Jev를 불렀고 요청 수는 요약 파일에 없습니다. pilot의 세션 2개(judge 요청 94건)와 재확인 세션 1개(judge 기록 15건)도 실제 Jev를 불렀습니다. `20261125-full`과 `20261125-e2e`를 누가 어떤 승인으로 실행했는지는 저장소 안에서 확인되지 않습니다. 이 문서를 갱신한 단계에서는 실제 API를 호출하지 않았습니다.

### 실제 데스크톱 세션 4회

근거는 `qa/kernel/results/real-session-20261125/summary.json`입니다. 로그인된 Claude Code 데스크톱 앱에서 일회용 합성 프로젝트를 열고, 그 프로젝트의 `.claude/settings.json`에만 hook을 등록했습니다. 실제 `~/.claude`는 건드리지 않았습니다. 전역 모드 `advisory`, `delegation.skills`와 `supervisor.outcome`은 `active`, judge는 실제 Jev이고 세션마다 위임 1건입니다. 원자료는 로컬 경로와 세션 메타데이터가 들어 있어 저장소에 넣지 않았습니다.

| 세션 | 제품 | 확인된 것 | 확인되지 않았거나 드러난 문제 |
|---|---|---|---|
| 1 | `2a162d8` | 실제 Agent 호출에서 PreToolUse 실행, 실제 Jev로 라우팅과 skill 선택(`changelog-hollowbrook`, p 0.98), skill 블록이 Main에 표시됨, 결과물이 규칙을 따름 | 서브에이전트 prompt는 재작성되지 않음. 서브에이전트가 skill을 스스로 load함. supervisor 미실행(보고가 `SubagentHandback`으로 오는데 그 빌드는 해시만 함) |
| 2 | `2a162d8` | hook 이벤트 29개의 실제 형태 수집 | 판정 목적이 아님 |
| 3 | `8f7c976` (제품 코드는 `d82c345`와 같음) | hand-back 경로에서 supervisor 판정(274ms, `complete`, 확신 0.44). 0.65 미만이라 조언 미전달(의도된 동작) | harness 알림 줄 때문에 prompt 결합 불일치(`unverified_prompt`). `7fb4ff2`, `31e1c26`에서 수정 |
| 4 | `31e1c26` | supervisor 판정(`complete`, 확신 0.75), prompt가 `handback_prompt`로 기록, 조언이 `UserPromptSubmit`에서 Main에 전달되고 Main 기록에서 확인됨(hand-back→prompt 60ms, prompt→전달 238ms). 상태 파일 0600, 보고 텍스트 저장 없음 | QA용 일회용 설정에서 확신 임계값을 0.3으로 낮춤(제품 기본 0.65는 그대로, 관측된 0.75는 기본값도 통과). harness 알림 줄이 없는 형태였음 |

이 세션들이 다루지 않은 것: 전역 `active` 모드(사용자 수준 `~/.claude/agents`의 `jev4_*` 프로필이 필요하고 프로젝트 수준 사본은 `PROJECT_AGENT_SHADOWS_PROFILE`로 거부됨), skill 주입이 결과에 주는 효과, 결합 수정 뒤 알림 줄이 있는 prompt 형태, Codex runtime. 앞의 둘은 아래 pilot에서 다뤘습니다.

### Skill 주입 paired pilot

근거는 `qa/kernel/results/pilot-20261125/`(`compare.txt`, `notes.txt`, arm별 JSON)이고 사전 등록 프로토콜은 `qa/kernel/pilot/PROTOCOL.md`입니다. 실제 데스크톱 세션 2개를 동시에 시작했습니다. arm A는 `delegation.skills` off, arm B는 active, 전역 모드는 둘 다 `active`, judge는 실제 Jev입니다. 합성 프로젝트(skill 60개: target 6, distractor 54)에서 세션마다 위임 8건(skill 과제 6, control 2)을 했고, `jev4_*` 프로필 27개는 실행 동안만 사용자 수준에 설치했다가 제거했습니다. arm당 1회 실행, 짝 6개이므로 기술 값입니다. 원자료는 저장소에 넣지 않았습니다.

- **1차 결과(사전 등록): 규칙 검사 통과는 arm A 6/6, arm B 6/6.** control은 두 arm 모두 2/2입니다.
- **주입이 없는 arm A에서도 서브에이전트 6개 전부가 target skill을 `Skill` 도구로 스스로 load했습니다**(5건은 첫 도구 호출). harness가 모든 서브에이전트에게 skill 목록(이름 101개, 프로젝트 skill 60개 전부 설명 포함)을 줬기 때문입니다. 이 설정에서 주입 블록은 겹쳤습니다.
- arm B는 skill 과제 6개 중 5개에 target이 든 블록을 주입했고 control 2개에는 주입하지 않았습니다. 나머지 1개(t01)는 need 점수 0.32가 임계값 0.5 아래였습니다.
- 주입이 더한 것: skill judge 요청 32건(Agent 호출당 2건), 지연 합 12,008 ms. judge 토큰은 미측정입니다. 관찰된 절감은 없습니다. 블록이 어느 쪽에도 없던 짝의 토큰 차이(−7.7%, +23.7%, +1.7%)가 블록이 간 짝의 차이와 같은 크기입니다.
- 조건이 달랐던 짝: t04는 arm A에서 라우팅이 보류되어 `general-purpose` / `claude-fable-5-2` / effort `medium`, arm B에서 `jev4_implement_standard_xhigh` / `claude-opus-5-5` / effort `xhigh`로 실행됐습니다. 이 짝의 2차 측정은 비교할 수 없습니다.
- 권한 모드 `auto`에서는 harness가 hook이 고친 Agent 호출을 실행 전에 거부하고 Main이 고친 입력으로 다시 호출합니다. 16건 중 15건이 그랬습니다. 서브에이전트는 첫 재작성을 받았고, 두 번째 호출 때의 hook 재작성(블록이 두 번 든 prompt)은 적용되지 않았습니다. 이 두 번째 판단은 pilot 뒤에 없앴습니다(`6ac6014`, `87a72a4`, [권한 모드 `auto`](#권한-모드-auto-거부된-뒤-다시-발행되는-위임)).
- 분석기는 세션 뒤에 두 번 고쳤고 2차 측정은 모두 사후에 정한 연결 규칙으로 읽은 값입니다. 1차 결과는 프로젝트 폴더에서 읽으므로 영향을 받지 않습니다.

**이 pilot이 보여 주지 못하는 것:** 주입이 도움이 되는지(두 arm이 만점인 천장 효과이고, 효과 없음의 증거도 아님), 비용이나 시간을 줄이는지(arm당 1회), 실제 프로젝트의 과제에서 어떤지(과제와 skill이 합성), harness 목록이 잘리는 크기의 카탈로그나 서브에이전트가 스스로 load하지 않는 과제에서 어떤지. 사용자 수준 skill 검색 도구는 켜 둔 채였고 아무 서브에이전트도 쓰지 않았습니다.

### 재발행 수정 뒤 실제 세션 재확인

근거는 `qa/kernel/results/real-session-reissue-20261125/summary.json`입니다. 로그인된 Claude Code 데스크톱 세션 1개, 권한 모드 `auto`, 제품 트리 `c09cd2e`입니다. pilot 프로젝트의 일회용 사본(skill 60개)에서 프로젝트 수준 hook을 썼습니다. 전역 모드 `active`, `delegation.skills`와 `supervisor.outcome`도 `active`, judge는 실제 Jev, 임계값은 기본값입니다. 위임 3건(skill 과제 2, control 1)을 하나씩 했습니다. `jev4_*` 프로필은 실행 동안만 사용자 수준에 복사했다가 제거했습니다. 원자료는 저장소 밖 임시 디렉터리에만 두었습니다.

- 3건 모두 라우팅됐습니다(`implement / standard / opus / high`). skill 과제 2건에는 skill 블록이 주입됐고(`domain-failure-types` p 0.98, `read-endpoints` p 0.99) control에는 주입되지 않았습니다.
- 3건 모두 host가 고쳐진 호출을 한 번 거부했고 Main이 다시 발행했습니다. hook은 5,126~15,625 ms 뒤의 재발행을 인식했고 그 호출에 judge 요청은 0건이었습니다. 3건 모두 실행됐습니다.
- supervisor는 3건 모두 hand-back에서 판정했습니다(`complete`, 확신 0.88, 1.00, 0.99). prompt는 `handback_prompt`로 기록됐고 조언은 기본 임계값 0.65에서 3건 모두 Main에 전달됐습니다.
- `hook_error`, `failure`, `unverified_prompt` 이벤트는 기록되지 않았습니다.
- judge 기록은 `delegation.classify` 3, `delegation.profile` 3, `delegation.skills` 6, `supervisor.outcome` 3건입니다.

Judge 토큰은 이 세션에서 처음 쟀습니다(decision log의 `usage` 합계). 위임 3건, 실행 1회, skill 60개 카탈로그의 값이므로 일반화할 수 없습니다.

| 지점 | 기록 수 | 입력 / 출력 토큰 (3건 합) | 위임 1건당 입력 / 출력 (합 ÷ 3) |
|---|---|---|---|
| `delegation.classify` | 3 | 5,220 / 1,065 | 1,740 / 355 |
| `delegation.profile` | 3 | 7,693 / 462 | 약 2,564.3 / 154 |
| `delegation.skills` | 6 | 26,099 / 3,480 | 약 8,699.7 / 1,160 |
| `supervisor.outcome` | 3 | 3,391 / 195 | 약 1,130.3 / 65 |
| 합계 | 15 | 42,403 / 5,202 | 약 14,134.3 / 1,734 |

**이 재확인이 다루지 않은 것:** 서브에이전트의 작업이 맞았는지(채점하지 않음. hook 동작만 확인), harness 알림 줄이 있는 hand-back prompt 형태(이 세션에서 나왔는지 알 수 없음), Codex runtime, 120초보다 늦은 재발행. 금액과 Main 쪽 추가 토큰도 재지 않았습니다.

### QA에서 찾아 고친 결함 (commit `e6fb770`)

- 프로필 선택이 보류되면 선택된 skill 블록이 버려지던 것 → 보류 안내문 뒤에 붙여 Main에게 표시
- timeout 최솟값 50ms에서 judge를 부르지 않던 것 → 첫 judge는 예산 자체가 50ms 미만일 때만 거부
- 연결 실패가 typed 코드 없이 남던 것 → `JEV_NETWORK_ERROR`, `DECISIONS_NETWORK_ERROR`
- OpenAI judge의 잠금 대기가 마감과 무관하던 것 → 요청 전 대기를 마감에서 끊고, 마감이 지난 호출은 요청 수·circuit에 세지 않음
- env만으로는 체인이 escalation되지 않던 것 → `JEV_*_ESCALATE_BELOW` 추가

각각 회귀 테스트가 있고, 수정 전 소스에서 실패하는 것을 확인했습니다. 평가가 드러낸 두 약점(한국어 작업의 BM25 후보 검색, `local` judge의 need 0이 확신 1로 계산되어 chain에서 escalation되지 않는 것)은 그 뒤에 다뤘습니다. 아래 [후보 검색의 오프라인 분석](#후보-검색의-오프라인-분석)을 보세요. 전자는 처음에 선택 기능으로 들어갔고, 그 뒤 실제 judge 비교를 거쳐 기본값이 `full`로 바뀌었습니다([결정 기록](#결정-기록)).

그 뒤에 찾아 고친 결함(후보 검색 리뷰 `1003f5b`, 규칙 고정 `b6e4ff6`, 비동기 runtime에서 supervisor 미실행 `134faf8`, hand-back 리뷰 `d82c345`, 1MB 초과 결과 파일 `bed1243`, harness 알림 줄 결합 `7fb4ff2`, 모호한 결합과 재판정 `31e1c26`, 재발행된 위임의 중복 판단 `6ac6014`와 그 리뷰 `87a72a4`)은 `qa/kernel/SUMMARY.ko.md`의 표와 `orchestration/CHANGELOG.md`에 있습니다.

### 후보 검색의 오프라인 분석

`node qa/kernel/dev-retrieval-analysis.mjs`가 개발용 데이터(`qa/kernel/data`, 작업 160건: 영어 96·한국어 64, skill 40개, 작성자 gold의 gold skill 120개)에서 제품의 `selectSkills`를 그대로 돌려, 방식별로 **어떤 skill이 judge에게 가는지**만 셉니다. judge는 항상 0을 답하는 stub이고 API 호출은 없습니다. 결과는 `qa/kernel/results/dev-retrieval-offline/analysis.json`입니다. 이 160건은 이제 개발용이고, 별도 held-out 세트(다른 skill 카탈로그, 72개)는 이 변경 뒤에 만들어 한 번 채점했습니다([결정 기록](#결정-기록)).

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
- 위 수치는 전부 개발 세트(작성자 gold와 두 번째 라벨의 일치 부분집합, 합성 작업, skill 40개 카탈로그, 실행 1회)의 값입니다. 기본값은 개발 세트에 맞춘 선택입니다. held-out 세트 결과는 아래 [held-out 세트 1 채점](#held-out-세트-1-채점)에 있습니다.
- 이 변경으로 달라지지 않는 것: `delegation.skills` 지점은 계속 기본 `off`입니다. `npm run compare:default`는 변경 뒤에도 차이 0입니다(아래 [기본 동작 비교](#기본-동작-비교)).
- 이 변경으로 달라지는 것: 지점을 켠 설치는 위임마다 judge 요청이 `ceil(카탈로그 크기와 maxJudged 중 작은 값 / chunk)`개(카탈로그 32개 이하면 1개, 33~64개면 2개) 나가고, 요청 하나에 든 skill 수와 입력 토큰이 늡니다. 요청은 선택 지점의 세션 요청 상한에 각각 세어집니다.

#### held-out 세트 1 채점

규칙대로 기본값을 정한 뒤 held-out 세트를 **한 번** 채점했습니다. 결과로는 아무것도 조정하지 않았습니다.

- 세트: `qa/kernel/holdout-1`, skill 72개, 작업 180건(영어 81, 한국어 72, 혼합 27), `HOLDOUT.json`으로 고정(commit `8f7c976`).
- 실행: run id `holdout-1-score-1`, `qa/kernel/results/holdout-1-score-1/metrics.json`과 `summary.txt`. 실제 Jev, 요청 540건(`lexical` 180 + `full` 360, 실패 0), 제품 commit `8f7c9763`, `dirty: false`. `HOLDOUT_LEDGER.jsonl`에 한 줄만 있습니다. 설계상 집계 수치만 저장하고 항목별 파일은 없습니다.

| 방식 | 세트 | need accuracy | load precision | load recall | load F1 | 오주입률 | 한국어 load P / R / F1 | 영어 load P / R / F1 |
|---|---|---|---|---|---|---|---|---|
| `lexical` | 개발 (n 159) | 83.6% | 1.000 | 0.669 | 0.802 | 0.0% | 1.000 / 0.388 / 0.559 | 1.000 / 0.870 / 0.930 |
| `lexical` | held-out (n 180) | 81.1% | 0.963 | 0.578 | 0.722 | 1.6% | 0.882 / 0.278 / 0.423 | 1.000 / 0.738 / 0.849 |
| `full` | 개발 (n 159) | 100.0% | 0.991 | 0.949 | 0.970 | 0.0% | 0.979 / 0.939 / 0.958 | 1.000 / 0.957 / 0.978 |
| `full` | held-out (n 180) | 97.2% | 0.967 | 0.881 | 0.922 | 1.6% | 0.935 / 0.796 / 0.860 | 1.000 / 0.951 / 0.975 |

held-out의 혼합 언어 작업 27건은 두 방식이 같습니다: load precision 0.947, recall 0.900, F1 0.923.

| 방식 | 세트 | 작업당 요청 수 | 판정 skill 수 | 입력 / 출력 토큰 | 작업당 지연 p50 / p95 / 최대 ms |
|---|---|---|---|---|---|
| `lexical` | 개발 | 1.00 | 8.0 | 1518.9 / 164.0 | 181 / 251 / 489 |
| `lexical` | held-out | 1.00 | 8.0 | 1612.8 / 164.0 | 181 / 256 / 534 |
| `full` | 개발 | 2.00 | 40.0 | 6551.2 / 780.0 | 220 / 540 / 666 |
| `full` | held-out | 2.00 | 64.0 | 10341.2 / 1236.0 | 808 / 924 / 1026 |

규칙이 함께 보고하라고 한 수치입니다(`qa/kernel/DECISION_RULE.md`의 "함께 보고하되 결정에 쓰지 않는 것". 각 실행의 `metrics.json` → `skills["jev-<방식>"]`. 결정에는 쓰지 않았습니다).

| 방식 | 세트 | `operations.retrieval.wideShareByLanguage` (넓게 간 작업 / 작업) | `gold.consensus.wideNoneTasksByLanguage` (load된 작업 / 넓게 간 skill 불필요 작업) | `operations.retrieval.tasksPartialNothingSelected` |
|---|---|---|---|---|
| `lexical` | 개발 | 영어 0 (0/96), 한국어 0 (0/64) | 넓게 간 작업 없음 (빈 객체) | 0 |
| `adaptive` | 개발 | 영어 0.15625 (15/96), 한국어 1 (64/64) | 영어 0/14, 한국어 0/22 | 0 |
| `full` | 개발 | 영어 1 (96/96), 한국어 1 (64/64) | 영어 0/34, 한국어 0/22 | 0 |
| `lexical` | held-out | 영어 0 (0/81), 한국어 0 (0/72), 혼합 0 (0/27) | 넓게 간 작업 없음 (빈 객체) | 0 |
| `full` | held-out | 영어 1 (81/81), 한국어 1 (72/72), 혼합 1 (27/27) | 영어 0/28, 한국어 0/25, 혼합 1/10 (오주입률 0.1) | 0 |

`adaptive`는 held-out에서 돌리지 않았으므로 held-out 값이 없습니다(미측정).

읽을 때 알아야 할 것:

- `full`은 held-out에서도 `lexical`보다 높지만(F1 0.922 대 0.722), 개발 세트의 0.970보다 낮습니다.
- 한국어 recall이 0.939에서 0.796으로 떨어졌습니다. 집계상 `full`이 놓친 한국어 gold 11개 중 6개는 judge에게 도달하지 못했고 5개는 제안에 그쳤습니다(`goldSkillNotLoadedByStage`). 카탈로그 72개가 `maxJudged` 64를 넘는 것이 원인으로 의심되지만, 항목별 출력이 없어 확인하지 못했습니다.
- skill이 필요 없는 작업 63건 중 1건에 오주입이 있었습니다(혼합 언어 작업 10건 중 1건, 두 방식 모두).
- `full`의 held-out 작업당 p95 924ms는 제품의 judge 예산 1200ms에 가깝습니다. 입력 토큰은 `lexical`의 약 6.4배입니다(개발 세트 약 4.3배, 위 표의 값으로 계산).
- 라벨: 작성자 gold, `labels/blind1`, `labels/blind2`가 180/180 정확히 일치합니다. 두 blind 라벨러는 카탈로그와 작업 파일만 읽었습니다. 이 일치는 작업이 라벨링 모델에게 모호하지 않다는 것을 보여 줄 뿐, gold가 독립적으로 검증됐다는 뜻이 아닙니다. 사람은 라벨을 검토하지 않았습니다. 항목별 결과를 남기지 않았으므로 held-out 수치를 독립적으로 다시 계산하지 못했습니다.
- OpenAI·`local`·`chain` arm과 `adaptive`는 held-out에서 돌리지 않았습니다.

**오프라인 테스트로 확인한 것** (2026-11-25, Node v24.19.0. 이 문서를 갱신하며 HEAD `2d987ae`에서 다시 실행: `cd orchestration && npm test` 608/608, 구문 68개 모듈, `qa/kernel/test` 25/25)

**`bash scripts/test-all.sh`는 HEAD `2d987ae`에서 종료 코드 0입니다**(Node 608/608, 구문 68개 모듈, Python 검증기 self-test 72건 통과, offline suite PASS 31·NOT_RUN 1: live 단계). 이전에는 종료 코드 1이었습니다: commit `4de2f6b`에 든 결과 파일 `qa/kernel/results/dev-retrieval-decision-1/decision-log/skills-jev-full/labels-2026-11.jsonl`(1,217,400바이트)이 검증기의 commit 파일 크기 한도 1,000,000바이트를 넘어 self-test 72건 중 5건이 `UNSAFE_ARCHIVE_ENTRY`로 끝났고, 그 파일은 commit `bed1243`에서 내용 변경 없이 줄 단위로 나뉘었습니다(이 변경에서 한 일이 아님).

모두 mock judge, 로컬 어휘 judge, loopback 서버, 주입된 fetch, 로컬 CLI의 자식 프로세스로 돌린 계약 검사입니다.

- kernel: 지점 모드, 체인 순서, 실패·낮은 확신 시 escalation, escalation 실패 시 보류한 답 채택, 체인 예산(명시·기본, 50ms 경계), 설정 병합·검증, env 덮어쓰기(`escalateBelow` 포함)
- judge: OpenAI wire 변환과 응답 검증(label 기준 score 분포 포함), 동의 관문, 크기 제한, 답 검증, 선택 지점의 별도 요청 상한·circuit, 제공자별 timeout(loopback 서버로 제공자 timeout 적용·체인 예산 우선·route deadline 우선·재시도 없음 확인), 잠금 대기의 마감 준수, 연결 실패의 typed 코드
- 후보 검색(`test/kernel-skills-retrieval.test.mjs`, 36건. `retrieval`이 없는 이전 config가 작은 요청 상한에서 `lexical`로 읽히고 설치기가 그렇게 저장하는 것, 직접 지정한 넓은 방식은 계속 거부되는 것 포함. 리뷰 뒤 추가한 8건: 낮은 어휘 신호에서도 답하는 `local`, 요청 수 제한과 직접 호출 시 잘림, 요청 상한 대비 검증, 최대 fan-out 뒤에도 남는 요청 예산, 실제 client로 공유 마감·circuit 실패 1회 계산, 마감 뒤 차례가 온 요청의 미전송·미계산, 일부 실패 표시, hook 이벤트의 일부 실패 표시): 어휘 신호의 정의(한국어·혼합 문자·전각 포함)와 BM25 0과의 동치, 방식 선택과 `minCoverage` 경계, 고른 분할·질문 문구 불변·동시 전송, 공유 마감, 일부 요청 실패와 전부 실패, `need` 최댓값, 요청을 넘나드는 상한, 추적 완전성, `maxJudged` 초과 시 `dropped`, loopback Jev로 요청별 상한 계산과 원문 없는 요청별 log record, 이전 config와 byte 단위로 같은 hook 출력, hook의 `skills` 이벤트와 재호출 재현, `local` 기권과 `local,jev` escalation, env·CLI
- skill: 카탈로그 읽기와 건너뛰기 규칙, 프로젝트 안 심볼릭 링크 root 허용과 프로젝트 밖 root 거부, 적대적 디렉터리 이름의 주입 차단, 경로 구간 검사, BM25, 임계값·상한, 주입 블록 형식, 예산 초과 시 생략, 재호출 재현, 실패 시 미선택, 보류된 route에서의 안내
- supervisor: 판정 조건, 조언 문구, 확신 미달 시 기존 문구 유지. hand-back 경로(`test/kernel-handback.test.mjs`, 45건. commit `31e1c26`에서 4건 추가: 모호한 prompt의 결합과 이전 형식 기록의 재판정 방지. 결합 규칙 변경으로 추가한 9건: 실제 prompt 형태 두 가지와 무력화된 `<`의 일치, 줄 추가·누락·순서 변경·다른 방식의 수정·잘못된 위치나 개수의 알림 불일치, `[harness:`로 시작하는 보고 줄과 미리 쓴 `<\`가 허용 범위를 넓히지 않음, 5000줄 보고의 기록 크기 상한과 일치, 알림이 있는 prompt의 조언 전달·`handback_prompt` 보증·재전송(`active`/`advisory`), 알림 없는 실제 형태와 낮은 확신, 불일치 prompt가 전달 기회를 쓰지 않음, 같은 보고를 낸 두 agent. 리뷰 뒤 추가한 7건: prompt hook이 먼저 처리된 두 번째 hand-back이 자기 기록을 기다리고 이전 hand-back의 조언을 받지 않음, 한 agent의 연속 hand-back 둘이 각자의 보고에 맞는 조언을 받음, 요소 하나가 아닌 prompt·다른 보고의 prompt는 조언을 받지 않고 전달 기회를 쓰지 않음, `/clear` 이전 기록과 10분 넘은 기록 미전달, 판정 중 죽은 hook의 hand-back을 재전송 때 한 번만 이어받음, hook 없이 쓰인 기록은 전달·보증하지 않고 저장된 글은 전달되지 않음, 위임당 판정 4번과 파일 수 상한): 실제 세션의 이벤트 형태와 순서 재현, 전역 `active`/`advisory` 전달과 `shadow` 무표시, 지점 `shadow`·`off`, 낮은 확신, egress 없음, custom·중첩·resume·모르는 agent, 비밀 유사 보고, judge 실패·timeout, 판정 중 도착한 prompt의 대기와 대기 한도(3000ms), 오래된 표시, hand-back 없이 온 prompt, hand-back 재전송, 두 위임의 교차 hand-back과 동시 처리, 두 번 전달되지 않음, 다른 세션 미전달, inline 경로와의 중복 방지, 보증된 prompt만 `handback_prompt`가 되고 목표가 바뀌지 않음, 손상된 기록 무시, 상태·log에 보고 텍스트 없음, 실제 hook 프로세스 두 개를 70ms 간격으로 실행
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

**실행 결과 (2026-11-25, Node v24.19.0, 기본 검색 방식 `full`과 supervisor hand-back 경로를 포함한 트리)**: hook 출력 168개(`judged` 84개 중 비어 있지 않은 것 40개, `untouched` 84개 중 42개)와 judge 호출 21건(`judged` 21, `untouched` 0)이 모두 일치했습니다. 차이 0건, 예외로 끝난 출력 0건. 이 문서를 갱신하며 HEAD `2d987ae`에서 다시 실행한 결과도 같습니다(`RESULT: IDENTICAL`, 출력 168개, judge 호출 21건, 종료 코드 0). 기본 검색 방식만 바꾼 트리(이벤트 9개, 출력 108개)에서도 차이 0건이었습니다. 변조 확인: hand-back 판정의 "지점 `off`이면 중단" 한 줄을 일부러 뺐을 때 `eventTypes` 차이 36건과 종료 코드 1이 나왔습니다(확인 후 원복). prompt 쪽의 "지점 `active`일 때만" 조건을 뺀 변조는 잡히지 않습니다. 기본 설정에서는 hand-back 기록이 만들어지지 않아 출력과 이벤트가 같고, 달라지는 것은 이 비교가 보지 않는 지연(유예 250ms)뿐이기 때문입니다. 이전 판에서 한 변조 확인(출력 문구 한 글자, 질문 문구 한 단어 → 각각 `output`, `judgeCalls` 차이)은 `bbb7452` 트리의 것입니다.

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
| end-to-end 효과 (작업 품질, 시간, 비용) | 미측정. 모델·effort 라우팅 3-arm 실험 1회(실제 세션 3개, 합성 과제 12개, `qa/kernel/results/routing-exp-20261126/`)는 세 arm 모두 채점기 12/12(사전 등록 집계 11/12, 천장에 가까움)여서 품질 차이를 재지 못했습니다. 그 조건(기본값 fable medium → opus high/xhigh)에서 라우팅한 arm은 서브에이전트 출력 토큰 약 3.5배·시간 약 3.2배였고, 낮은 모델 실행은 0건이었습니다(불확실한 분류는 최소 standard) |
| 실제 Claude Code 세션에서 skill이 주입된 서브에이전트 실행 | 배선은 확인. 전역 `active` 모드의 실제 세션 3개(pilot 2, 재확인 1), 권한 모드 `auto`에서만. pilot arm B는 skill 과제 6건 중 5건, 재확인은 skill 과제 2건 중 2건에 블록을 주입해 실행. 주입이 결과를 개선하는지는 미측정(위 항목). 재확인 세션의 작업 결과는 채점하지 않음 |
| skill 선택 정확도 | 합성 데이터 두 세트(개발 160건, held-out 180건)에서 각 1회 측정. 모델이 만든 라벨, 사람 검토 없음. 실제 skill 폴더 미측정 |
| `adaptive`/`full` 후보 검색에서의 judge 정확도·지연·토큰 | 개발 세트에서 실제 Jev로 1회(`dev-retrieval-decision-1`), held-out 세트에서 `lexical`과 `full`만 1회(`holdout-1-score-1`) 측정([결정 기록](#결정-기록)). `adaptive`의 held-out 수치, 72개보다 큰 카탈로그, 실제 skill 폴더, OpenAI judge는 미측정 |
| 실제 트래픽에서의 calibration (Brier, ECE) | 거의 미측정. 실제 세션의 라벨은 [결과 수집기](#결과-수집기)가 pilot arm B에서 만든 **약한 라벨**뿐이고(세션 1개. 블록 없는 `observed-load`는 결정 4개·위임 2건·질문 124개, 판정의 영향을 받은 `observed-load-after-injection`은 결정 8개·위임 4건·질문 248개, 모두 `sufficient: false`), 검증된 라벨은 없음. 합성 데이터의 값은 `qa/kernel/REPORT.ko.md` |
| supervisor 조언의 유용성 | 미측정. 합성 120건의 outcome 일치도만 있음 |
| supervisor hand-back 경로의 실제 세션 동작 | 일부 확인. 실제 세션 3에서 `SubagentHandback` 판정(274ms)은 됐고 prompt 결합은 harness 알림 줄 때문에 **실패**했습니다([결합 규칙](#보고와-prompt의-결합-규칙)). 결합 규칙을 고친 뒤 세션 4(`31e1c26`)에서 `handback_prompt` 기록과 Main으로의 조언 전달을 확인했습니다. 다만 세션 4에는 알림 줄이 없었으므로, 알림 줄이 있는 형태는 수정 뒤 fixture로만 확인했습니다. 전달 확인은 세션 4에서 1건(전역 `advisory`, QA용 임계값 0.3), 재확인 세션에서 3건 중 3건(전역 `active`, 기본 임계값 0.65)입니다. 재확인 세션에 알림 줄이 있었는지는 알 수 없습니다. 대기·유예 한도와 10초 창은 측정값이 아닌 초기값 |
| 실제 API 비용 | 미계산. 토큰 수만 기록. 실제 세션의 judge 토큰은 1회만 측정: 위임 3건 합 입력 42,403 / 출력 5,202, 위임 1건당 약 14,134.3 / 1,734(skill 60개 카탈로그, `qa/kernel/results/real-session-reissue-20261125/summary.json`) |
| 결함 수정(`e6fb770`) 뒤의 실제 Jev/OpenAI 호출 | Jev는 평가 러너(개발·held-out)와 실제 세션 7개(`advisory` 4, pilot 2, 재확인 1)에서 호출. 설치된 entrypoint e2e(`20261125-e2e`)의 실제 judge 시나리오와 OpenAI는 다시 돌리지 않음 |
| Codex runtime의 skill 주입·supervisor 경로 | 전용 테스트 없음. 기본 동작 비교에서만 다룸. 실제 세션 미실행 |

따라서 이 문서는 "어떻게 동작하는가"를 설명할 뿐이며, skill 라우팅이나 supervisor가 결과를 개선한다는 근거는 아직 없습니다. 임계값(0.9, 0.5, 0.65)은 측정으로 정한 값이 아닌 초기값입니다. 합성 데이터의 임계값 sweep은 같은 데이터에 대한 재생이라 선택 근거로 쓰면 과적합입니다.

`orchestration`에서 `npm test`를 직접 돌려도 통과합니다. 예전에는 macOS 기본 `TMPDIR`(`/var/folders/...`, `/private/var/...`의 심볼릭 링크) 아래에 만든 fixture 경로가 정규화되지 않아 31건이 실패했습니다. 제품 코드는 프로젝트 경로를 `realpath`로 비교하므로 fixture(`test/helpers.mjs`)가 임시 디렉터리를 `realpath`로 정규화하도록 고쳤고, 제품의 심볼릭 링크 검사는 바꾸지 않았습니다. `test/fixture-paths.test.mjs`가 심볼릭 링크 `TMPDIR`을 직접 만들어 이 경우를 모든 플랫폼에서 재현합니다.
