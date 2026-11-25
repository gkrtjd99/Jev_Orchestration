# 모델·effort 라우팅 3-arm 실험

실제 Claude Code 데스크톱 세션 세 개(라우팅 없음 / 라우팅 / 낮은 모델만)에서 같은 합성 과제 12개를 돌려, 서브에이전트 위임을 프로필로
라우팅하는 것이 과제 품질과 비용 측정값을 어떻게 바꾸는지 보는 실험입니다. 설계와 미리 정한 규칙은 [PROTOCOL.md](PROTOCOL.md)에
있습니다. **세션을 시작하기 전에 먼저 읽고, 3절의 "실행 세션이 기입" 칸을 채워 커밋하세요.**

**과제, 프로젝트 템플릿, 채점기, 참조·결함 해법은 모두 모델이 만든 합성 자료입니다.**

이 폴더의 스크립트는 네트워크를 쓰지 않고, 세션을 시작하지 않고, API 키를 필요로 하지 않으며, 실제 홈 디렉터리를 건드리지 않습니다.
세션은 저장소 소유자 쪽 세션이 직접 실행합니다.

## 구성

| 경로 | 내용 |
|---|---|
| `PROTOCOL.md` | 사전 등록 프로토콜(arm, 고정 설정 표, 결과 정의, 규칙, 알려진 차이, 천장) |
| `template/` | 합성 프로젝트 `studiobook`(Node ESM, 의존성 없음, 모듈 19개, 자체 테스트 29개). `.claude/skills`와 `CLAUDE.md` 없음 |
| `tasks.json` | 과제 12개, 고정 순서: `id`, `lang`, `difficulty`, `text`, `allowedPaths` |
| `main-prompt.txt` | 각 arm의 Main 세션에 넣을 단 하나의 prompt. `build-main-prompt.mjs`가 `tasks.json`에서 생성(`--check`) |
| `checkers/check.mjs` | 채점기. `--project <dir>` → `{tasks:[{id, done, passed, details:[{name, ok}]}], unattributedChanges}` |
| `checkers/probes.mjs`, `probe.mjs`, `tree.mjs` | 과제별 동작 검사, 자식 프로세스 진입점, 템플릿과의 차이 계산 |
| `checkers/selftest.mjs` | 채점기 self-test |
| `fixtures/reference/<id>/` | 과제마다 올바른 해법(템플릿 위에 덮어쓸 파일) |
| `fixtures/flawed/<id>/<variant>/`, `fixtures/flawed/manifest.json` | 그럴듯하지만 틀린 해법 30개와, 각각이 왜 틀리고 어느 검사에서 걸리는지 |
| `make-arm-config.mjs` | arm R / L의 registry 파일과 env 줄을 만들고(`--verify`로 설치 결과 확인) |
| `project-hooks.mjs` | 일회용 설치의 hooks를 arm의 프로젝트 사본에 프로젝트 수준 hooks로 넣음 |
| `verify-arm-install.mjs` | 위 순서를 실제 설치기로 임시 폴더에서 돌려 보는 오프라인 확인 |
| `make-verification.mjs` | 채점 결과를 결과 수집기가 받는 검증 파일로 만듦 |
| `analyze.mjs` | arm 하나의 오프라인 분석(채점 + transcript + hook 상태) |
| `compare.mjs` | 세 arm의 과제별 표와 arm별·등급별·모델별 합계 |
| `tools.test.mjs`, `analyze-fixtures.mjs` | 도구 테스트와, 실제 파일 모양을 흉내 낸 합성 세션 자료 생성기 |
| `freeze.mjs`, `FROZEN.json` | 세션 전에 고정된 파일들의 해시(`--check`) |

`checkers/`, `fixtures/`, `tasks.json`, `PROTOCOL.md`, 그 밖의 스크립트는 **세션에 복사하지 않습니다.** 세션이 볼 수 있는 것은
`template/`의 사본뿐이어야 합니다.

## 실행 전 확인

```bash
cd qa/kernel/routing-exp
node checkers/selftest.mjs          # SELFTEST PASSED
node --test tools.test.mjs          # 15 pass (실제 설치기를 임시 홈에서 실행하는 테스트 포함)
node build-main-prompt.mjs --check  # main-prompt.txt matches tasks.json
node freeze.mjs --check             # as frozen
git rev-parse HEAD                  # PROTOCOL.md 3절에 적습니다
```

## 세 arm 준비

worktree와 저장소 **밖**의 폴더를 하나 정해 그 아래에 모두 둡니다. 저장소 안에 두면 상위 폴더의 `CLAUDE.md`나 `.claude/`가 세션에
섞입니다. 아래에서 `REPO`는 이 저장소(worktree)의 절대 경로, `WORK`는 그 작업 폴더입니다. `WORK`는 홈 디렉터리 자체이면 안 됩니다.

```bash
REPO=<이 worktree의 절대 경로>
EXP=$REPO/qa/kernel/routing-exp
WORK=<저장소 밖의 새 폴더의 절대 경로>          # 예: $HOME/routing-exp-runs
mkdir -p "$WORK"
cp -R "$EXP/template/" "$WORK/arm-n"
cp -R "$EXP/template/" "$WORK/arm-r"
cp -R "$EXP/template/" "$WORK/arm-l"
mkdir -p "$WORK/home-r" "$WORK/home-l"
```

### arm N

할 일이 없습니다. `$WORK/arm-n`에는 `.claude/` 폴더가 없어야 합니다.

### arm R과 arm L (X = r, R / l, L 각각)

설치는 **두 번** 합니다. `resolvesTo` 선언은 프로필 fingerprint의 일부이고 설치된 config는 프로필마다 fingerprint를 기록하므로,
config.json의 registry만 고치면 재작성이 `PROFILE_NOT_INSTALLED_OR_STALE`로 거부됩니다(`verify-arm-install.mjs`가 보여 줍니다).
L은 설치되는 프로필 집합 자체도 달라집니다.

```bash
# 1) 일회용 홈에 기본 설치. <개인 env>는 저장소 밖의 chmod 600 파일(TypeSafe 키, JEV_ALLOW_EGRESS=true 등).
#    이전 실제 세션과 같은 registry를 쓰려면 그 파일을 --registry로 줍니다(주지 않으면 설치기의 기본 registry).
node "$REPO/orchestration/scripts/install.mjs" --home "$WORK/home-r" --project "$WORK/arm-r" --runtime claude \
  --env-file <개인 env의 절대 경로> [--registry <쓰던 registry 파일의 절대 경로>] --yes

# 2) arm 설정: registry 파일을 만들고, 설치된 .env의 네 줄을 맞춥니다
#    (JEV_MODE=active, JEV_SKILLS_MODE=off, JEV_SUPERVISOR_MODE=off, JEV_EVALUATION_CONTEXT=desktop-auto-v1).
node "$EXP/make-arm-config.mjs" --arm R --work "$WORK" \
  --config "$WORK/home-r/.config/jev-hooks/config.json" --env "$WORK/home-r/.config/jev-hooks/.env"

# 3) 그 registry로 다시 설치
node "$REPO/orchestration/scripts/install.mjs" --home "$WORK/home-r" --project "$WORK/arm-r" --runtime claude \
  --registry "$WORK/routing-exp-arm-R/registry.json" --yes

# 4) 확인: ok가 true여야 합니다. profileFiles, judges, egressAllowed를 PROTOCOL.md 3절에 옮겨 적습니다.
node "$EXP/make-arm-config.mjs" --verify --arm R --work "$WORK" --config "$WORK/home-r/.config/jev-hooks/config.json"

# 5) 프로젝트 수준 hooks. 반드시 마지막 설치 **뒤에** 합니다(설치기는 이 hooks가 있는 프로젝트를 거부합니다).
node "$EXP/project-hooks.mjs" --work "$WORK" --home "$WORK/home-r" --project "$WORK/arm-r"
```

arm L은 같은 다섯 줄을 `home-l`, `arm-l`, `--arm L`, `routing-exp-arm-L`로 바꿔 실행합니다.

- `make-arm-config.mjs`는 `--work` 아래에만 씁니다. `--config`와 `--env`가 `--work` 밖이거나 실제 `~/.config`, `~/.claude`를 가리키면
  거부합니다. `.env`는 해석하지 않고, 네 줄만 바꾸거나 덧붙이며, 다른 줄은 그대로 통과시키고 아무것도 출력하지 않습니다.
- 선언은 backend `sonnet` → `claude-sonnet-5-5`, backend `opus` → `claude-opus-5-5` 둘뿐입니다. 설치된 registry의 backend가 이 둘이
  아니면(`summary.json`의 `notDeclared`) 그 항목의 실행은 host가 backend와 **같은 문자열**을 기록할 때만 평가 행이 됩니다. 다른 선언이
  필요하면 `--declare <backend>=<모델 id>`로 직접 적고 PROTOCOL.md 8절에 기록합니다.
- arm L은 활성 claude 항목 중 가장 낮은 slot의 backend만 남깁니다. 무엇이 꺼졌는지는 `summary.json`의 `disabled`에 나옵니다.

### 사용자 수준 agent 파일 (실행 세션이 하는 일)

`active` 모드의 재작성은 `jev4_*` 프로필이 host에 보여야 실행됩니다. 이전 실제 세션들과 같이, 실행하는 동안만 사용자 수준 agents
폴더에 두고 끝난 뒤 지웁니다. arm L의 파일은 arm R의 부분집합이고 내용이 같으므로(테스트가 확인) **arm R의 집합만** 복사하면 됩니다.

```bash
ls "$WORK/home-r/.claude/agents"/jev4_*.md | wc -l          # PROTOCOL.md 3절의 프로필 파일 수
cp "$WORK/home-r/.claude/agents"/jev4_*.md ~/.claude/agents/   # 세션을 돌리는 쪽이 직접 실행. 이 폴더의 스크립트는 하지 않습니다
# 세 세션이 모두 끝난 뒤, 복사한 이름만 지웁니다:
for f in "$WORK/home-r/.claude/agents"/jev4_*.md; do rm -f ~/.claude/agents/"$(basename "$f")"; done
```

## 세션 실행

1. PROTOCOL.md 3절을 실제 값으로 채워 커밋합니다.
2. 세 폴더(`arm-n`, `arm-r`, `arm-l`)에서 각각 새 데스크톱 세션을 엽니다. 권한 모드 `auto`, 세 세션 모두 같은 Main 모델과 effort.
3. 세 세션에 `main-prompt.txt`의 내용을 **그대로 한 번** 붙여 넣고 같은 시각에 시작합니다. 중간에 개입하지 않습니다.
4. Main이 마지막 요약을 내고 멈추면 세션을 닫습니다. 프로젝트 폴더는 그대로 둡니다(채점 대상).
5. arm마다 그 세션의 transcript를 한 폴더에 **복사**합니다(원본은 그대로 둠): Main transcript `.jsonl` 하나를 폴더 바로 아래에,
   서브에이전트 파일은 `subagents/` 아래에 셋씩(`agent-<id>.jsonl`, `agent-<id>.meta.json`, `agent-<id>.prefix.json`).
   아래에서는 `$WORK/transcripts-n`, `$WORK/transcripts-r`, `$WORK/transcripts-l`이라고 부릅니다.
6. 인프라 문제로 arm을 다시 돌릴지는 그 arm에 아래 명령을 돌리기 **전에** 정합니다(PROTOCOL 규칙 2). 분석은 세 세션이 모두 끝난 뒤에
   합니다(규칙 10).

## 분석

```bash
cd "$EXP"
node analyze.mjs --arm N --project "$WORK/arm-n" --transcripts "$WORK/transcripts-n" --out "$WORK/arm-n.json"
node analyze.mjs --arm R --project "$WORK/arm-r" --transcripts "$WORK/transcripts-r" \
  --state-dir "$WORK/home-r/.local/state/jev-hooks" --out "$WORK/arm-r.json"
node analyze.mjs --arm L --project "$WORK/arm-l" --transcripts "$WORK/transcripts-l" \
  --state-dir "$WORK/home-l/.local/state/jev-hooks" --out "$WORK/arm-l.json"
node compare.mjs --n "$WORK/arm-n.json" --r "$WORK/arm-r.json" --l "$WORK/arm-l.json"            # 표
node compare.mjs --n "$WORK/arm-n.json" --r "$WORK/arm-r.json" --l "$WORK/arm-l.json" --json     # 같은 내용의 JSON
```

- `--state-dir`은 설치된 config의 `stateDir`입니다(`make-arm-config.mjs --verify`가 출력). `sessions/<세션>/events/*.json`과
  `decisions-log/*.jsonl`이 있는 폴더입니다.
- arm 파일에는 경로, 세션·agent·tool-use id, prompt 원문이 들어가지 않습니다.
- 값을 읽지 못하면 `null`이 되고 arm 파일의 `warnings`(arm 전체)나 과제의 `notes`에 이유가 남습니다. 표에서는 `-`로 보입니다.
- 과제 행의 `check`는 채점기가 본 프로젝트 상태이고 `counted`는 결과에 세는 값입니다. 위임되지 않은 과제는 `counted.passed`가 `false`입니다.
- 토큰은 **모델별로** 나옵니다. 서로 다른 모델의 토큰은 더하지 않습니다.
- 금액 추정은 가격 파일을 직접 만들어 줄 때만 나옵니다(이 저장소에는 가격이 없습니다):

  ```bash
  node compare.mjs --n ... --r ... --l ... --prices <prices.json>
  # { "currency": "USD", "source": "<출처>", "checkedAt": "<확인한 날짜>",
  #   "perMillionTokens": { "<host가 기록한 모델 id>": { "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0 } } }
  ```

- 채점만 따로 보려면 `node checkers/check.mjs --project "$WORK/arm-r"`.

## 결과 수집기 (arm R, arm L)

```bash
C="node $REPO/orchestration/scripts/collect.mjs"
# 1) 검증 파일: 채점기의 passed, validator = routing-exp-checker@<check.mjs의 SHA-256>, artifactSha256 = 채점기 출력의 SHA-256
node "$EXP/make-verification.mjs" --project "$WORK/arm-r" --transcripts "$WORK/transcripts-r" \
  --out "$WORK/verification-r.json" --artifact-out "$WORK/checker-r.json"

# 2) 먼저 dry run (아무것도 쓰지 않음)
$C --config "$WORK/home-r/.config/jev-hooks/config.json" --transcripts "$WORK/transcripts-r" \
  --verification "$WORK/verification-r.json" --evaluation-context desktop-auto-v1 --dry-run > "$WORK/collect-r.dry-run.json"

# 3) 실제 수집: 관찰 기록과 라벨은 그 arm의 일회용 hook 상태 폴더에, 평가 행 후보는 --out 폴더에 씁니다
$C --config "$WORK/home-r/.config/jev-hooks/config.json" --transcripts "$WORK/transcripts-r" \
  --verification "$WORK/verification-r.json" --evaluation-context desktop-auto-v1 --out "$WORK/candidates-r" > "$WORK/collect-r.json"
$C --config "$WORK/home-r/.config/jev-hooks/config.json" --report > "$WORK/collect-r.report.json"

# arm L도 같은 명령을 home-l, arm-l, transcripts-l, *-l 이름으로 실행한 뒤:
node "$EXP/compare.mjs" --n "$WORK/arm-n.json" --r "$WORK/arm-r.json" --l "$WORK/arm-l.json" \
  --collector-r "$WORK/collect-r.json" --collector-l "$WORK/collect-l.json"
```

- `make-verification.mjs`의 `taskHash`는 수집기의 `taskHash()`와 같은 함수로 계산합니다: Main이 처음 발행한 `Agent` 호출의 prompt
  (hook 재작성 이전의 과제 글)의 UTF-8 바이트에 대한 SHA-256, 다듬기 없음. `--transcripts`를 주면 Main 기록의 그 문자열을 쓰고(위임되지
  않은 과제는 항목이 없음), 주지 않으면 `tasks.json`의 글을 씁니다.
- 수집 요약의 `evaluations.produced`(만든 평가 행 수), `producedByModelMatch`, `withheldTasks`, `withheld`(보류 이유별 수)가
  PROTOCOL.md의 2차 결과입니다.
- **후보 파일을 가져오지 않습니다**(`feedback.mjs --accept-evidence`를 실행하지 않음, PROTOCOL 규칙 11). 가져오더라도 행 수가
  `minimumSamples`(프로필당 같은 과제 집합에서 30건)에 한참 못 미쳐 라우팅의 선택 기준은 바뀌지 않습니다.
- `collect.mjs --config`는 config 옆의 `.env`를 제품 코드로 읽습니다(일회용 홈의 사본). 값을 출력하지 않습니다.
- `taskHash`는 키 없는 해시입니다. 과제 글이 공개된 합성 자료이므로 이 실험에서는 문제가 아니지만, 수집기 출력에는 로컬 상태에서 나온
  해시가 들어 있으니 저장소에 넣기 전에 내용을 확인하세요.

## 결과를 읽을 때

1차 결과는 arm별 통과 과제 수(12개 중)와 등급별 통과 수입니다. arm당 한 번, 과제 12개이므로 **기술적인 숫자일 뿐**이고 유의성이나
일반화를 말할 수 없습니다. 세 arm이 모두 12개를 통과하면 천장이고, 그때 품질 질문은 열린 채로 남습니다. 무엇을 어떻게 보고할지는
PROTOCOL.md의 6절과 7절을 따릅니다.
