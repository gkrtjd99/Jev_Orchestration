# Skill 주입 paired pilot 결과 파일 (2026-11-25)

실제 Claude Code 데스크톱 세션 두 개(arm A = 주입 없음, arm B = 주입 있음)를 오프라인으로 분석한 결과입니다. 요약과 읽는 법은
[`../../SUMMARY.ko.md`](../../SUMMARY.ko.md)의 "Skill 주입 paired pilot", 사전 등록 프로토콜은 [`../../pilot/PROTOCOL.md`](../../pilot/PROTOCOL.md)에 있습니다.

| 파일 | 내용 |
|---|---|
| `armA.json`, `armB.json` | `analyze.mjs`의 arm별 출력(`--sanitized-out`). 과제별 채점, hook 판단, subagent 측정, 경고 |
| `checks-armA.json`, `checks-armB.json` | 채점기(`checkers/check.mjs`)의 과제별 판정과 검사 이름별 통과 여부 |
| `compare.txt`, `compare.json` | `compare.mjs`가 두 arm 파일로 만든 짝 표, 합계, 짝 차이. 먼저 읽을 것은 `compare.txt`의 첫 문단(arm 사이의 다른 차이) |
| `notes.txt` | arm 사이의 다른 차이, 파일을 만든 명령, 세션 뒤 분석기 수정 두 번의 내용, 측정하지 못한 값 |

**원자료는 저장소에 넣지 않았습니다.** Main과 subagent transcript, hook 상태 폴더, 두 프로젝트 사본에는 로컬 경로, 세션 메타데이터,
prompt와 보고 원문이 들어 있습니다. 이 폴더의 파일에는 prompt·보고 원문, 로컬 절대 경로, 세션·agent·tool-use id가 없습니다(id는
`t01-call2`, `t01-subagent`, `session-1` 같은 과제 단위 이름으로 바꿨습니다). 소유자 환경의 사용자 수준·plugin skill은 개수(41)와
skill 검색용 두 개의 이름(`find-skills`, `using-skill-rag`)만 남겼습니다.

읽을 때 주의할 것:

- 1차 결과(`check.convention`)만 사전 등록된 결과입니다. 나머지는 2차·참고 측정이고, 세션 뒤에 정한 연결 규칙("실행 전에 거부되지 않은
  첫 Agent 호출")으로 읽은 값입니다.
- `null`은 "측정 못 함"입니다. 0이나 실패가 아닙니다. arm A의 `injected`는 skills 이벤트가 없어서 `null`입니다.
- 과제별 `hook`은 채점에 쓴 호출의 이벤트이고, `hookApplied`는 subagent에게 실제로 전달된 판단입니다. 16건 중 15건에서 둘은 다른
  hook 실행입니다(`notes.txt`의 Disclosure 2).
- arm당 1회 실행, 짝 6개입니다. 기술 통계일 뿐이고 유의성 주장을 하지 않습니다.
