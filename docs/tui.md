# TUI v0.1 요약 계약

> 상태: v0.1 implemented

화면별 상세는 [`../TUI_DESIGN.md`](../TUI_DESIGN.md)에 있다. 이 문서는 v0.1에서 반드시 유지할 운영 계약만 요약한다.

## 온보딩

1. 지원 OS와 user service 환경 검사
2. Hub base URL 입력, discovery와 protocol 검사
3. 기본값 없는 Agent Identity 입력, Mesh 전체 중복 조회, 내부 lane ID 자동 생성, 키보드 선택형 CLI Runtime·Security Profile과 workspace 선택
4. 선택 Runtime CLI, 인증과 capability 검사
5. lane별 보안 정책 선택 및 영향 확인
6. 선택 Channel Driver와 credential 설정
7. 생성·변경될 config, secret, service, tmux와 MCP 파일 검토
8. daemon user service 설치/기동 후 Agent가 없으면 빈 Overview와 `+ Add Agent` 표시
9. 사용자가 `+ Add Agent`를 선택하면 identity/key 등록, driver/runtime 준비와 health check 수행

Antigravity one-shot lane은 tmux를 필수 dependency로 판정하지 않는다. Claude/Codex 대화형 session을 선택한 경우에만 tmux를 요구한다.

## 운영 화면 필수 상태

Overview는 색상·카드 기반 전체 화면으로 렌더링하고 등록된 Agent 전체와 상태를 선택 목록으로 보여준다. `↑↓`로 Agent를 골라 Enter를 누르면 해당 Agent의 Identity Key, Channels, Attach Runtime, 활성화와 삭제 작업으로 들어간다. `+ Add Agent`, Refresh, Quit는 목록 아래에 둔다. 사람에게 보이는 TUI에는 내부 구현 용어인 Lane을 표시하지 않으며, 수동 send/inbox는 진단용 CLI에만 둔다.

등록된 Agent가 없어도 등록 wizard를 강제로 열지 않는다. `Agents · 0`, `No agents registered.`와 선택 가능한 `+ Add Agent`를 먼저 보여주고, 사용자가 Enter를 눌렀을 때만 wizard를 시작한다.

모든 하위 화면과 wizard는 Esc로 이전 화면에 돌아간다. Overview는 예외로 Esc를 무시한다 — 돌아갈 상위 화면이 없어 종료가 되고, 다른 화면에서 "이 화면 나가기"인 키가 유일하게 되돌릴 수 없는 자리에서만 "프로그램 나가기"가 된다. 종료는 Quit 항목이 담당한다. Backspace는 문자 삭제에만 쓰며 화면을 벗어나지 않는다. Channel Driver가 없으면 Add와 Back만 표시하며, enable/disable/remove는 적용 가능한 Driver가 있을 때만 표시하고 대상을 키보드로 선택한다.

- daemon user service와 restart 상태
- Hub endpoint/connection/protocol
- agent identity와 key approval/fingerprint
- runtime kind, Idle/Running/Stopped/Failed, queue와 deadline
- channel driver instance, capability와 drain 상태
- outbox pending/retry/dead-letter 수, bytes와 마지막 ACK/error
- 선택된 security policy, 실제 적용 상태와 위험 경고

## Channel lifecycle

- `add`: config/secret validation 뒤 child 시작 및 registration 확인
- `disable`: 신규 수락 중지, in-flight drain, config 유지
- `enable`: credential/capability 재검사 뒤 재연결
- `remove`: drain 뒤 config 제거; secret 삭제는 별도 명시 선택
- 어떤 작업도 pending/dead-letter outbox나 Hub audit record를 삭제하지 않는다.

## CLI 대응

모든 필수 TUI 작업은 non-interactive CLI로 제공해야 한다. 최소 namespace는 다음과 같다.

```text
agent-mesh daemon ...
agent-mesh config hub ...
agent-mesh lane ...
agent-mesh identity ...
agent-mesh channel ...
agent-mesh outbox ...
agent-mesh doctor
agent-mesh up|down|restart|attach|status|logs
```

## 위험 UX

- secret 삭제, identity rotation/revocation과 완화된 runtime permission 선택은 영향 범위를 표시하고 명시적으로 확인한다.
- config 삭제와 secret 삭제를 합치지 않는다.
- 위험한 runtime policy를 선택한 경우 실행을 몰래 차단하거나 설정을 바꾸지 않고 지속 경고한다.
- Hub 장애, provider 장애, runtime 장애와 local durability failure를 서로 다른 상태로 표시한다.

## Runtime 세션 조작

`attach`는 runtime 종류에 따라 다른 것을 연다.

| Runtime | attach가 여는 것 |
|---|---|
| Claude | tmux의 CLI 세션. 없으면 다시 세운다 |
| Codex | 데몬이 돌리는 thread에 붙는 `codex --remote` 뷰어 |
| Antigravity | lane의 대화를 연 `agy --conversation <id>`. 대화가 아직 없으면 redacted 관찰 화면 |

Antigravity는 turn 사이에 프로세스를 남기지 않지만 **대화는 남긴다.** `agy --conversation <id>`가 lane이 쓰던 대화를 이력째 열고, 운영자가 거기에 직접 입력할 수도 있다. 그 상태에서 데몬의 `--print` 실행은 계속 성공하고 그 turn도 보존된다 — 다만 **실시간으로 렌더되지는 않아** 새 turn은 세션을 다시 열 때 나타난다.

본문을 화면에 두면 안 되는 상황에서는 `agent-mesh runtime observe --lane ID`가 redacted 화면을 직접 연다(`OBS-001`).

세 경우의 판단은 TUI와 CLI가 같은 코드(`src/runtime/attach.ts`)를 쓴다. CLI에만 있던 동안 TUI의 attach는 셋 중 Claude 하나에만 동작했다.

tmux 세션 이름은 `mesh-lane-<identity>`다. `tmux ls`는 어느 창이 어느 agent인지 보려고 여는 곳이라 digest는 답이 되지 않는다. identity는 `[A-Za-z0-9-]`이고 호스트 안에서 유일하므로 읽히는 이름이 곧 유일한 이름이다. 같은 이름을 다른 것이 쥐고 있으면 붙지 않고 오류를 보인다 — 남의 세션에 붙는 것은 agent가 이상하게 동작하는 것처럼 보인다.

attach가 실패하는 이유는 그대로 보인다. app-server가 아직 안 떴다거나(첫 turn에 뜬다) 이름이 점유됐다거나 하는 것은 "붙을 수 없음"보다 훨씬 쓸모 있는 정보다.

Claude 세션이 없을 때 attach는 이어가기와 새로 시작하기를 좌/우 키로 묻는다(`RUN-007`). 기본은 이어가기다 — mesh 상대가 identity로 부르므로 빈 세션은 같은 이름의 낯선 상대가 된다.

비활성 lane은 Hub와 Key를 `not connected` / `not checked`로 표시한다(`UX-006`). `not-configured`와 `unknown`은 설정이 잘못됐을 때의 표현이라, 꺼둔 lane에 쓰면 연결 문제를 찾는 사람이 잘못된 곳을 보게 된다.

enable·disable·remove는 데몬 reload를 수반하므로 진행 표시와 함께 실행한다(`UX-007`). 멈춘 화면은 멈춘 프로그램과 같아 보이고, 그때 누른 키는 다음 화면으로 들어간다.

lane 제거 확인 화면은 Mesh identity가 Hub에 남는다는 것과, 이 호스트의 키가 있는 한 다시 추가할 수 있다는 것을 결정 전에 보인다(`UX-008`).

## Runtime 상태

| 상태 | 뜻 |
|---|---|
| `idle` | 처리할 turn이 없다 |
| `queued` | turn이 도착했고 아직 집어가지 않았다 |
| `running` | turn을 처리 중이다 |
| `awaiting-input` | 사람 답변을 기다린다(Claude). 화면의 질문을 함께 보고한다 |
| `stopped` | 세션을 갖는 runtime의 세션이 없다 |
| `disabled` | lane이 꺼져 있다 |

Claude는 tmux의 CLI가 상태를 갖고 있어 supervisor가 보고하고, 상주 프로세스가 없는 Codex·Antigravity는 turn 상태에서 파생한다. 후자를 `next()`(첫 PENDING turn)로 읽던 동안에는 worker가 turn을 집어가는 순간 `idle`로 돌아가, **처리 중인 lane과 할 일 없는 lane이 같은 표시**였다.
