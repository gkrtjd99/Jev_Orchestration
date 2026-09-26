# GitHub 연결과 게시 경계

대상: `https://github.com/gkrtjd99/Jev_Orchestration.git`, 로컬 브랜치 `main`.

2026-09-26 프로젝트 루트의 단일 Git 저장소에 `origin`을 위 주소로 연결했습니다. `orchestration/`과 `verification/`은 같은 저장소의 형제 디렉터리이며, 독립된 Git 저장소 두 개가 아닙니다. **원격 push 성공은 별도로 확인해야 합니다.** 이전 integration으로 `LICENSE` 생성을 시도했을 때 403 `Resource not accessible by integration`이었고, 이번 로컬 Git 연결만으로 쓰기 권한이 생긴 것은 아닙니다.

## 첫 커밋의 공개 자료 범위

`reports/`의 원본 로그, 모델 transcript, 프롬프트, 브라우저 캡처, 검증기 artifact 및 raw JSON은 로컬 보관 대상입니다. 일부에는 개인 경로·프롬프트가 있으므로 일괄 추가하지 않습니다. `.gitignore`는 검토된 Markdown 요약만 허용합니다. `orchestration/.env`, 개인용 `.jev/`, `*.local.json`은 절대 강제 추가하지 않습니다. 공개 요약의 수치와 링크는 원본 artifact를 함께 공개했다는 의미가 아닙니다.

게시할 정확한 파일을 확인할 때에는 `git status --short`, `git diff --cached --name-only`, `git diff --cached --check`로 목록과 변경 사항을 검토하고, 필요하면 `git check-ignore -v <path>`로 제외 여부를 확인하세요. `git add .`나 `git add -f reports/`로 원자료를 일괄 포함하지 않습니다. 게시 직전에는 staged 자료에서 자격증명과 개인정보를 별도로 점검하세요.

## 원격 게시

로컬 커밋은 외부 게시가 아닙니다. 공개 저장소로 push하려면 별도로 승인된 게시 범위와 GitHub 인증을 확인한 뒤 `git push -u origin main`을 실행합니다. 원격에 다른 커밋이 생겼다면 먼저 fetch 후 차이를 검토하고, force push하지 않습니다. 토큰을 URL이나 채팅에 붙이지 마세요. 설치된 CI workflow를 게시할 때에는 사용하는 인증 방식의 Contents/workflow 쓰기 권한도 필요할 수 있습니다.

로컬 기능 검사: `bash scripts/test-all.sh`. 합성 HTTP와 오프라인 검사 통과는 실제 controller 모델 품질·총비용이나 GitHub 업로드 성공의 증거가 아닙니다.
