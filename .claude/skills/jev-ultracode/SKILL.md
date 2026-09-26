---
name: jev-ultracode
description: 명시적 ultracode 실작업의 일회성 Jev 계획 보조. 기본 비교군/지침 제외는 건너뛴다.
---
# 얇은 ultracode 계획 보조

Astra가 계획 작성자·최종 판단자다. Jev는 typed 선택/보류만 제공한다. 기존 권한·동의와 hook 차단을 우회하지 않는다. 실제 Workflow가 없으면 `NOT_RUN`, 기본 native로 진행한다. `--effort ultracode`는 만들지 않는다.

1. 원래 goal·acceptance를 고정한다. 기존 근거로 provisional task 1~8개를 요약한다. 권고용 scout/critic fleet은 추가하지 않는다.
2. 작업 실행 전에 Jev 권고를 한 번만 구한다. 승인된 외부 registry/env가 없으면 키 탐색·동의 활성화를 하지 않는다. `GUIDANCE_ONLY`, Jev=`NOT_RUN`으로 기록하고 보통 ultracode를 계속한다. 설치나 키 존재는 전송 동의가 아니다.
3. 비공개 디렉터리(0700)의 JSON 파일(0600)에 `schema:1`, `goal`, `acceptance`(문자열 배열), `tasks`를 쓴다. task는 `id/summary/role/risk/dependsOn/readPaths/writePaths`; role=`research|plan|implement|review|integration`, risk=`normal|sensitive|unknown`. 소스·키·원문 대화 없이 짧은 요약만 담는다.

```sh
node orchestration/bin/jev-plan.mjs --project <project> --input <private-plan.json> --registry <confirmed-registry-outside-project> --env-file <private-env-outside-project> --run-id <fixed-task-id>
```

명시 env의 `TYPESAFE_API_KEY`, `JEV_ALLOW_EGRESS=true`, `JEV_SHARE_PLAN_CONTEXT=true`가 모두 있어야 전송한다. 사전 확인은 `--dry-run`. 같은 작업의 run-id를 유지한다(cap 1); draft 변경·실패로 ID를 바꿔 재호출하지 않는다. 비밀 패턴 검사는 완전한 DLP가 아니다.

4. 출력은 `advisory_only`, `applied=false`다. `ADVICE`와 실제 채택을 구분한다. Astra가 후보 model/effort와 strategy/reading enum을 검토한다. 의존 작업은 pipeline, 독립 read-only는 parallel, 작은 작업은 합친다. 같은 파일의 concurrent writers는 금지한다. registry confirmed **및 현재 Workflow 호출 측 지원**의 교집합만 명시적 agent opts에 반영한다. 불확실·민감 작업은 cheap 강등하지 않고, 정보 부족이면 근거부터 확보한다. 비용을 위해 acceptance·테스트를 줄이지 않는다.
5. timeout·낮은 확신·미동의·후보 부재이면 기본 plan을 유지한다. 권고 실패로 작업을 막거나 fleet을 재생성하지 않는다. 강제 controller/Workflow block과 병용하지 않으며 승인된 off/clean session이 필요하다.
6. 실행 뒤 권고별 채택/기각·이유, requested/observed model·effort, 실제 acceptance 검사·결과, 전체 시간·토큰·비용·재시도를 기록한다. 지침·계획·Jev(usage/latency/cache)를 포함하며 미관측은 `null`이다. stop/CLI 성공/권고 채택은 품질 PASS가 아니다. 성능 향상은 미검증이다.

예시·동의·비교가 필요할 때만 [상세 문서](../../../docs/ULTRACODE.ko.md)를 읽는다.
