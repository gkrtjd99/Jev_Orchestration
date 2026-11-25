---
name: crontab-expressions
description: "운영 서버의 crontab 표현식을 작성하거나 해석할 때 사용. 앱 안에서 도는 작업이 아니라 호스트 crontab 항목 전용."
---

# Crontab Expressions

운영 서버의 crontab 표현식을 작성하거나 해석할 때 사용. 앱 안에서 도는 작업이 아니라 호스트 crontab 항목 전용.

## Steps

1. 다섯 필드(분 시 일 월 요일)의 순서를 먼저 확인한다.
2. 서버 시간대가 UTC인지 확인한다.
3. 수정 전에 crontab -l 출력을 백업해 둔다.
