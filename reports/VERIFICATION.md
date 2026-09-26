# 실제 검증 결과 — Jev Orchestration 3.0.0 / Verifier 1.1.0

이 문서는 **초기 오프라인 배포 당시의 검증 스냅샷**을 보존합니다. 아래의 `NOT_RUN`, 212개 테스트, 33개 구문 검사 수는 당시 결과이며 현재 상태가 아닙니다. 2026-09-25 최종 소스의 검사는 orchestration **222/222**, 검증기 **54/54**, JS 구문 **35**, 독립 offline **31 PASS / 1 NOT_RUN**입니다. 실제 계정·native 비교와 그 한계는 [별도 실험 보고서](PLAN_ROUTING_COMPARISON_20260925.md)를 보세요.

검토 기준일: 2026-09-25 (KST). 초기 독립 검사 시작 시각: **2026-09-24T17:13:33Z**. UTC 전날 표시는 한국 시간과 모순되지 않습니다.

## 결과

| 검사 | 결과 | 실제로 입증한 범위 |
|---|---|---|
| 기존 optimized-router 원본 | 174 통과 | 해당 원본 unit/contract |
| 이전 native v2.3 원본 | 165 통과 | 해당 원본 Python contract |
| 독립 검증기 원본 | 44 통과 | 원본 verifier 자기 검사 |
| 통합 오케스트레이션 3.0.0 | **212 통과, 실패 0, skip 0** | 실제 함수·합성 HTTP·설치·stdin 계약 |
| 수정 검증기 1.1.0 자체 | **54 통과, 실패 0, skip 0** | grader/통계/증거/가짜 native process 경계 |
| JS 구문 검사 | **33 모듈 통과** | JavaScript syntax |
| 독립 오프라인 black box | **31 PASS, 1 NOT_RUN, exit 0** | public installer·hook I/O·외부 acceptance test |
| 실제 Jev API 키 인증 | **NOT_RUN** | 계정 키 미제공 |
| 실제 Claude/Codex native 실행·effort 관측 | **NOT_RUN** | 실제 모델 세션을 실행하지 않음 |
| 품질·속도·총비용 우위 | **NOT_ESTABLISHED** | 필요한 실제 paired 자료 없음 |

서로 다른 검사군을 더해 '전체 500개 품질 테스트'처럼 표현하지 않습니다. 정책 시뮬레이션의 합성 성공률·비용은 실제 성능 근거에서 제외했습니다.

## 재현

```bash
bash scripts/test-all.sh
python3 verification/verify.py --suite offline --sut ./orchestration --out /tmp/jev-independent-offline
```

Node v22.16.0, Python 3.13.5, Git 2.47.3에서 확인했습니다. 전체 스크립트는 임시 HOME과 최소 env를 사용하므로 사용자의 키를 상속하지 않습니다. 외부 패키지 설치 없이 실행했습니다. 합성 HTTP는 loopback만 사용합니다.

설치기·hook은 원본 SUT 소스 폴더를 수정하지 않았고 전후 fingerprint가 일치했습니다. `orchestration-files.sha256`은 해당 검사에 사용한 실행 소스 파일의 SHA-256 목록입니다. `verification-summary.json`에는 검사 ID와 상태를 보존했습니다. 비밀키·사용자 인증 저장소·원문 프롬프트는 보고서에 포함하지 않았습니다.

## 실패를 재현하고 고친 항목

원본 grader는 깨진 구현이 고정 성공 문자열을 출력하고 exit 0으로 종료하면 passed=true를 반환했습니다. 이번 버전은 nonce, 먼저 준비한 검사 함수, 제한된 Node 실행, seek 불가능한 pipe로 재현된 경로를 막았습니다. silent exit, 고정 marker, grader source 읽기, assertion 변경, stdin rewind, source symlink를 별도 회귀 검사했습니다. 이것을 악성 코드에 대한 완전한 sandbox라고 주장하지 않습니다.

불완전한 baseline/active 대응 표본, 실제로 관측되지 않은 active route·model·effort, 부정확한 시간·비용 값으로 성능 우위를 주장하지 못하도록 검사합니다. 같은 task의 반복은 독립 task 수로 계산하지 않습니다.

첫 release 통합 실행에서는 250ms 미만이라는 wall-clock 조건 하나가 병렬 실행 부하에서 실패했습니다. production timeout을 완화한 것이 아니라, **응답 body를 끝내지 않는 합성 서버에서 JEV_TIMEOUT이 실제 발생하는지** 검사하도록 oracle을 변경했습니다. 최종 전체 재실행은 통과했습니다.

## 한계

검증기의 독립성은 SUT 내부 scoring/함수를 import하지 않는다는 구조적 의미입니다. 제3자 기관의 독립 인증은 아닙니다. 사용자 제공 실제 host version, registry, native 적용 관측, 승인 의미, 프로젝트별 품질 기준의 확인은 아직 필요합니다. 기본값은 shadow·외부전송 비동의이며, Codex 인자 변경의 allow는 별도 동의 전에는 반환하지 않습니다.
