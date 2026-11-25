# orchestration

통합판 정본은 저장소 최상위 `README.md`와 `docs/`입니다.

Node 기반 native hooks입니다. `scripts/install.mjs`는 설치 도구이며 새 대화형 CLI가 아닙니다.

## Decision kernel (3.2.0)

hook의 모든 판단은 `src/kernel/`의 decision kernel을 지나갑니다. 설명은 [`docs/KERNEL.ko.md`](../docs/KERNEL.ko.md)에 있습니다.

| 경로 | 역할 |
|---|---|
| `src/kernel/kernel.mjs` | 지점별 모드, judge 체인, escalation |
| `src/kernel/judges.mjs`, `answers.mjs` | OpenAI Decisions·로컬 judge, 답 검증 |
| `src/kernel/skills.mjs` | skill 카탈로그, BM25, 선택, 주입 블록 |
| `src/kernel/supervisor.mjs` | worker 보고에 대한 조언 |
| `src/kernel/log.mjs`, `calibration.mjs` | decision log와 calibration 지표 |
| `scripts/skills.mjs` | skill 카탈로그·선택·why-not 조회 (worker를 시작하지 않음) |
| `scripts/decisions.mjs` | decision log 조회(`show`), 라벨(`label`), calibration 보고(`report`) |
