# Skill 주입 paired pilot

실제 Claude Code 데스크톱 세션 두 개(주입 없음 / 주입 있음)에서 같은 합성 과제 8개를 돌려, subagent prompt에 `<jev-skills>` 블록을
붙이는 것이 결과를 바꾸는지 보는 작은 pilot입니다. 설계와 미리 정한 규칙은 [PROTOCOL.md](PROTOCOL.md)에 있습니다. 세션을 시작하기
전에 먼저 읽으세요. **과제, skill, 채점기는 모두 모델이 만든 합성 자료입니다.**

이 폴더의 스크립트는 네트워크를 쓰지 않고 세션을 시작하지 않습니다. 세션은 저장소 소유자가 직접 실행합니다.

## 구성

| 경로 | 내용 |
|---|---|
| `template/` | 합성 프로젝트 `parceldesk` (Node ESM, 의존성 없음)와 `.claude/skills/` 60개 (target 6, distractor 54) |
| `tasks.json` | 과제 8개, 고정 순서 (`id`, `lang`, `kind`, `targetSkill`, `text`) |
| `main-prompt.txt` | Main 세션에 넣을 단 하나의 prompt. `node build-main-prompt.mjs`로 `tasks.json`에서 생성 (`--check`로 일치 확인) |
| `checkers/check.mjs` | 채점기. `--project <dir>` → `{tasks:[{id, done, convention, details}], unattributedChanges}` |
| `checkers/probes.mjs`, `probe.mjs`, `scopes.mjs`, `tree.mjs` | 과제별 검사, 자식 프로세스 진입점, 과제별 허용 경로, 템플릿과의 차이 계산 |
| `checkers/selftest.mjs` | 채점기 self-test (참조/naive/손대지 않은 템플릿/독립성/control) |
| `fixtures/reference/<id>/` | skill을 따른 subagent가 남겼을 파일 |
| `fixtures/naive/<id>/` | skill을 모르고 일반적으로 구현한 파일 |
| `analyze.mjs` | arm 하나의 오프라인 분석 (채점 + hook 이벤트 + transcript) |
| `compare.mjs` | 두 arm 결과의 과제별 짝 표와 합계 |
| `analyze.test.mjs`, `analyze-fixtures/` | 분석기 테스트와 합성 상태/transcript (`make-fixtures.mjs`로 재생성) |
| `leak-check.sh` | target 규칙의 고유 문자열이 `template/`에서 자기 `SKILL.md` 밖에 없는지 확인 |

`checkers/`, `fixtures/`, `tasks.json`, `PROTOCOL.md`는 **세션에 복사하지 않습니다.** 세션이 볼 수 있는 것은 `template/`의 사본뿐이어야
합니다.

## 실행 전 확인

```bash
cd qa/kernel/pilot
node checkers/selftest.mjs        # SELFTEST PASSED
node --test analyze.test.mjs      # 8 pass
sh leak-check.sh                  # 여섯 줄 모두 ok
node build-main-prompt.mjs --check
git rev-parse HEAD                # 고정된 버전. 보고서에 적어 둡니다
```

## 두 arm 준비

worktree와 저장소 **밖**의 서로 다른 폴더에 복사하세요. 저장소 안에 두면 상위 폴더의 `CLAUDE.md`나 `.claude/`가 세션에 섞일 수 있습니다.

```bash
PILOT=/Users/hakseong/Project/Jev_Orchestration/.claude/worktrees/qa-kernel/qa/kernel/pilot
mkdir -p ~/pilot-runs
cp -R "$PILOT/template/" ~/pilot-runs/arm-a      # baseline
cp -R "$PILOT/template/" ~/pilot-runs/arm-b      # assisted
ls ~/pilot-runs/arm-a/.claude/skills | wc -l     # 60
```

그다음 arm마다:

1. 프로젝트 수준 hooks를 설치합니다. 두 arm 모두 전역 모드 `active`. `delegation.skills` 지점은 **arm A는 off, arm B는 active**.
   그 밖의 설정(모델, 권한, judge 체인, 동의)은 두 arm이 같아야 합니다. hook 상태 폴더는 arm마다 따로 둡니다.
2. 그 폴더에서 새 데스크톱 세션을 열고 `main-prompt.txt`의 내용을 **그대로 한 번** 붙여 넣습니다. 중간에 개입하지 않습니다.
3. Main이 마지막 요약을 내고 멈추면 세션을 닫습니다. 프로젝트 폴더는 그대로 둡니다(채점 대상).
4. 그 세션의 transcript를 한 폴더에 모읍니다: Main transcript `.jsonl` 하나를 폴더 바로 아래에, subagent transcript들을
   `subagents/agent-<agentId>.jsonl`로. 원본은 지우지 말고 복사하세요.

프로젝트 사본에 hook 설정이나 상태가 `.claude/` 아래에 생겨도 채점에는 영향이 없습니다(`.claude/skills/` 밖은 비교에서 제외).
`.claude/skills/`가 바뀌면 `unattributedChanges`에 나옵니다.

## 분석

```bash
cd "$PILOT"
node analyze.mjs --arm baseline --project ~/pilot-runs/arm-a --state-dir <arm A의 hook 상태 폴더> \
  --transcripts <arm A의 transcript 폴더> --out ~/pilot-runs/arm-a.json
node analyze.mjs --arm assisted --project ~/pilot-runs/arm-b --state-dir <arm B의 hook 상태 폴더> \
  --transcripts <arm B의 transcript 폴더> --out ~/pilot-runs/arm-b.json
node compare.mjs --a ~/pilot-runs/arm-a.json --b ~/pilot-runs/arm-b.json          # 표
node compare.mjs --a ~/pilot-runs/arm-a.json --b ~/pilot-runs/arm-b.json --json   # 같은 내용의 JSON
```

- `--state-dir`은 `sessions/<세션>/events/*.json`이 들어 있는 폴더입니다.
- 채점만 따로 보려면 `node checkers/check.mjs --project ~/pilot-runs/arm-a`.
- 값을 읽지 못하면 `null`이 되고 `warnings`에 이유가 남습니다. 표에서는 `-` 또는 `measured n`으로 보입니다. 추측해서 채우지 않습니다.
- 분석기는 프로젝트의 모듈을 자식 프로세스에서 import해 실행합니다(쓰기 없음). 그 외에는 읽기만 합니다.

## 결과를 읽을 때

1차 결과는 arm별 "skill 과제 6개 중 `convention` 통과 수"입니다. arm당 한 번, 짝 6개이므로 **기술적인 숫자일 뿐**이고 유의성이나
일반화를 말할 수 없습니다. 무엇을 어떻게 보고할지는 PROTOCOL.md의 "미리 정한 규칙"을 따릅니다.
