# plan-dev-relay

Claude Code 세션 두 개를 **기획**과 **개발**로 짝지어 주는 mod입니다.

## 하는 일

- `/role plan`, `/role dev`로 역할을 정하면 같은 repo의 두 세션이 짝이 됩니다.
- 기획 세션의 모델이 SendMessage(`to: "dev-session"`)로 지시를 보내면, 개발 세션이 지시를 받아 바로 작업을 시작합니다.
- 개발 세션의 작업이 끝나면 결과(마지막 답변, 수정 파일, 실행 명령과 성공/실패)가 기획 세션에 자동으로 보고됩니다.
- 기획 세션은 보고를 받아도 스스로 작업을 시작하지 않습니다. 보고는 사용자의 다음 프롬프트와 함께 모델에 전달됩니다.
- 지시, 수신, 파일 수정, 명령, 보고를 날짜별 markdown 로그로 남깁니다.
- 프롬프트 위에 역할별 Claude 캐릭터 애니메이션을 보여 줍니다.

## 요구 사항

- Claude Code 2.1.287 이상. mod의 function hooks API는 초기 공개 단계라 Claude Code 버전이 바뀌면 동작이 달라질 수 있습니다.
- macOS 또는 Linux. 로그를 `/bin/sh`로 씁니다.
- 로그 시각은 KST(UTC+9) 기준입니다.

## 설치

```
/plugin marketplace add <이 저장소의 git 주소>
/plugin install plan-dev-relay@plan-dev-relay
```

- GitLab처럼 GitHub가 아닌 저장소는 전체 주소(`https://...git` 또는 `git@...:...git`)를 씁니다.
- 비공개 저장소는 그 주소로 `git clone`이 되어야 합니다(SSH 키 또는 HTTPS 토큰).
- 설치한 뒤 새로 띄운 세션부터 적용됩니다.

### 로그 폴더 바꾸기

기본값은 `~/Documents/claude/plan-dev-log`입니다. 바꾸려면 둘 중 하나를 씁니다.

- `/plugin` 설정 메뉴에서 plan-dev-relay의 `로그 폴더`(logRoot)를 바꿉니다.
- 설치할 때 지정합니다: `claude plugin install plan-dev-relay@plan-dev-relay --config logRoot=/원하는/경로`

## 사용법

1. 터미널 A: repo 폴더에서 `claude`를 실행하고 `/role plan`을 입력합니다.
2. 터미널 B: 같은 repo 폴더에서 `claude`를 실행하고 `/role dev`를 입력합니다.
3. A에 평소처럼 요청합니다. 예: "로그인 API에 입력 검증을 추가하도록 개발 세션에 지시해"
4. B가 지시를 받아 바로 작업합니다. 끝나면 A에 "개발 보고 도착" 알림이 뜹니다.
5. A에 다음 프롬프트(예: "보고 확인해 줘")를 보내면 기획 모델이 보고를 읽습니다.

| 명령 | 하는 일 |
| --- | --- |
| `/role plan`, `/role dev` | 역할을 정합니다. repo마다 기획 하나, 개발 하나입니다. 같은 역할을 다른 세션이 등록하면 그 세션으로 바뀝니다. |
| `/role` | 현재 역할과 상대 세션을 보여 줍니다. |
| `/role off` | 역할을 지웁니다. |

개발 세션에 사람이 직접 입력한 작업도 로그에 남습니다. 이 작업은 기획 세션에 보고하지 않습니다.

## 로그

- 로그: `<logRoot>/<repo 이름>/YYYY-MM-DD.md`
- 짝 정보: `<logRoot>/<repo 이름>/roles.json`

## 주의

- **두 세션의 권한 모드를 맞추세요.** Claude Code 기본 설정(`crossSessionInbound` 미지정)은 권한 모드 종류가 다른 세션에서 온 메시지를 승인 대기로 붙잡아 둡니다. 그러면 개발 세션이 자동으로 작업을 시작하지 않습니다.
- **역할은 세션마다 정합니다.** 세션을 새로 띄우면 `/role`을 다시 입력합니다.
- **신뢰하는 환경에서만 쓰세요.** 이 mod는 셸 명령(로그 쓰기)을 실행하고, 세션 간 메시지로 다른 세션이 작업을 시작하게 합니다.
- 보고의 "수정 파일"에는 Edit·Write·NotebookEdit 도구로 바꾼 파일만 나옵니다. 셸 명령으로 바꾼 파일은 "명령" 목록에 나옵니다.

## 개발

```
claude plugin test .
claude plugin validate --strict .claude-plugin/plugin.json
```

이 폴더를 직접 고치면서 쓰려면 `~/.claude/settings.json`의 `env.CLAUDE_CODE_PLUGIN_DIRS`에 이 폴더 경로를 넣습니다. 마켓플레이스로 설치한 것과 함께 쓰지 마세요. 같은 mod가 두 번 불려 hook이 두 번 실행됩니다.
