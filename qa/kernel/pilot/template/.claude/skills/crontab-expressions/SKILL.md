---
name: crontab-expressions
description: "운영 서버의 crontab 표현식을 새로 작성하거나, 이미 있는 표현식이 언제 실행되는지 해석해야 할 때 사용."
---

# Crontab Expressions

운영 서버의 crontab 표현식을 새로 작성하거나, 이미 있는 표현식이 언제 실행되는지 해석해야 할 때 사용.

## Steps

1. 다섯 필드(분 시 일 월 요일)의 순서를 먼저 확인한다.
2. 서버 시간대가 UTC인지 확인한다.
3. 수정 전에 crontab -l 출력을 백업해 둔다.
