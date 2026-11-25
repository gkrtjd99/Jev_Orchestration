---
name: settings-load-debugging
description: "src/config가 읽은 값이 실행 중에 기대와 다를 때, 어떤 환경 변수가 실제로 적용됐는지 단계별로 확인할 때 사용."
---

# Settings Load Debugging

src/config가 읽은 값이 실행 중에 기대와 다를 때, 어떤 환경 변수가 실제로 적용됐는지 단계별로 확인할 때 사용.

## Steps

1. 프로세스를 띄운 셸에서 해당 환경 변수가 실제로 export되어 있는지 확인한다.
2. loadSettings가 돌려준 객체를 시작 직후 한 번 출력해 본다.
3. 값이 숫자로 해석되지 않으면 기본값이 쓰인다는 점을 기억한다.
