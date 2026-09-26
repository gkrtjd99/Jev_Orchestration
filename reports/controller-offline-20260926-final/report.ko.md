# Jev 독립 검증 결과

**판정: PASS**

이 보고서는 2026-09-26의 보존된 오프라인 검사 스냅샷입니다. 이후 수정된 동기 Agent 수용 순서와 검증기 observer는 별도 임시 출력에서 전체 회귀를 다시 통과했으며, 아래 원본 검사 목록을 소급 수정하지 않습니다.

PASS는 요청한 검사 범위의 결과입니다. 미실행·미관측·표본 부족을 성공으로 간주하지 않습니다. 이 공개 요약에 대응하는 기계 판독용 `report.json`과 `artifacts/`는 로컬 전용이며 공개 저장소에 포함되지 않습니다.

| 단계 | 검사 | 판정 |
|---|---|---|
| preflight | node22 | PASS |
| preflight | git | PASS |
| offline | public_installer_in_disposable_home | PASS |
| offline | contract_route_claude | PASS |
| offline | idempotent_claude | PASS |
| offline | custom_agent_preserved_claude | PASS |
| offline | project_boundary_claude | PASS |
| offline | contract_route_codex | PASS |
| offline | idempotent_codex | PASS |
| offline | custom_agent_preserved_codex | PASS |
| offline | project_boundary_codex | PASS |
| offline | explicit_model_preserved_claude | PASS |
| offline | explicit_model_preserved_codex | PASS |
| offline | egress_consent_is_separate | PASS |
| offline | codex_approval_consent_is_separate | PASS |
| offline | dirty_source_invalidates_pending_route | PASS |
| offline | substantive_work_uses_quality_effort_floor | PASS |
| offline | off_does_not_rewrite | PASS |
| offline | shadow_does_not_rewrite | PASS |
| offline | http_failure_native | PASS |
| offline | http_failure_block | PASS |
| offline | scope | PASS |
| offline | grader_rejects_interval-union | PASS |
| offline | grader_rejects_json-pointer | PASS |
| offline | grader_rejects_dependency-order | PASS |
| offline | grader_rejects_async-pool | PASS |
| offline | grader_rejects_csv-state-machine | PASS |
| offline | grader_rejects_retry-delays | PASS |
| offline | grader_rejects_cache-expiry | PASS |
| offline | grader_rejects_stable-pagination | PASS |
| scope | live_stages | NOT_RUN |
| integrity | sut_source_unchanged | PASS |

## 세부 결과

### preflight / node22: PASS

```json
"v24.19.0"
```

### preflight / git: PASS

```json
"git version 2.54.0 (Apple Git-157)"
```

### offline / public_installer_in_disposable_home: PASS

```json
{
  "schema": 4,
  "version": "3.1.0",
  "profiles": {
    "claude": 27,
    "codex": 27
  },
  "installation_scope": "disposable HOME only"
}
```

### offline / contract_route_claude: PASS

```json
{
  "profile": "jev4_implement_light_xhigh_ff7d173a5a",
  "requested_model": "claude-sonnet-5",
  "requested_effort": "xhigh",
  "runtime": "claude",
  "proof": "REQUEST_ONLY_NOT_EFFECTIVE"
}
```

### offline / idempotent_claude: PASS

```json
{
  "extra_http_calls": 0
}
```

### offline / custom_agent_preserved_claude: PASS

```json
"Custom agent unchanged; no Jev call"
```

### offline / project_boundary_claude: PASS

```json
null
```

### offline / contract_route_codex: PASS

```json
{
  "profile": "jev4_implement_light_xhigh_76eec45aeb",
  "requested_model": "gpt-6-luna",
  "requested_effort": "xhigh",
  "runtime": "codex",
  "proof": "REQUEST_ONLY_NOT_EFFECTIVE"
}
```

### offline / idempotent_codex: PASS

```json
{
  "extra_http_calls": 0
}
```

### offline / custom_agent_preserved_codex: PASS

```json
"Custom agent unchanged; no Jev call"
```

### offline / project_boundary_codex: PASS

```json
null
```

### offline / explicit_model_preserved_claude: PASS

```json
null
```

### offline / explicit_model_preserved_codex: PASS

```json
null
```

### offline / egress_consent_is_separate: PASS

```json
null
```

### offline / codex_approval_consent_is_separate: PASS

```json
null
```

### offline / dirty_source_invalidates_pending_route: PASS

```json
null
```

### offline / substantive_work_uses_quality_effort_floor: PASS

```json
{
  "scope": "Literal policy/application contract, NOT model performance"
}
```

### offline / off_does_not_rewrite: PASS

```json
null
```

### offline / shadow_does_not_rewrite: PASS

```json
null
```

### offline / http_failure_native: PASS

```json
{
  "synthetic_status": 401,
  "fallback_policy": "native"
}
```

### offline / http_failure_block: PASS

```json
{
  "synthetic_status": 401,
  "fallback_policy": "block"
}
```

### offline / scope: PASS

```json
{
  "means": "Black-box protocol behavior with a synthetic server only. No Jev judgment or native application is claimed."
}
```

### offline / grader_rejects_interval-union: PASS

```json
{
  "rejects_unfixed_stub": true
}
```

### offline / grader_rejects_json-pointer: PASS

```json
{
  "rejects_unfixed_stub": true
}
```

### offline / grader_rejects_dependency-order: PASS

```json
{
  "rejects_unfixed_stub": true
}
```

### offline / grader_rejects_async-pool: PASS

```json
{
  "rejects_unfixed_stub": true
}
```

### offline / grader_rejects_csv-state-machine: PASS

```json
{
  "rejects_unfixed_stub": true
}
```

### offline / grader_rejects_retry-delays: PASS

```json
{
  "rejects_unfixed_stub": true
}
```

### offline / grader_rejects_cache-expiry: PASS

```json
{
  "rejects_unfixed_stub": true
}
```

### offline / grader_rejects_stable-pagination: PASS

```json
{
  "rejects_unfixed_stub": true
}
```

### scope / live_stages: NOT_RUN

```json
"Explicit offline selection; no real API/native claim."
```

### integrity / sut_source_unchanged: PASS

```json
{
  "changed": []
}
```

## 비교 결과

```json
[]
```

세부 명령·출력·관측 자료는 로컬 전용 `artifacts/`에 있습니다. 로컬 전용 `report.json`은 기계 판독용 원본입니다.
