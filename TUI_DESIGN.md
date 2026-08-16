# Agent Mesh TUI 설계

> 상태: v0.1 구현 기준 / line-oriented ANSI TUI
>
> 최종 갱신: 2026-08-15
>
> 상위 문서: [`REQUIREMENTS_AND_ARCHITECTURE.md`](./REQUIREMENTS_AND_ARCHITECTURE.md)
>
> Antigravity runtime 상세: [`ANTIGRAVITY_RUNTIME_ADAPTER_DESIGN.md`](./ANTIGRAVITY_RUNTIME_ADAPTER_DESIGN.md)

## 1. 목적

이 문서는 `agent-mesh`의 설치 후 온보딩과 운영 TUI 계약을 정의한다. v0.1은 외부 widget framework 없이 line-oriented ANSI TUI로 구현하며, 화면 계약은 후속 full-screen UI에서도 유지한다.

TUI는 사용자가 YAML, MCP 설정, Unix domain socket, 내부 포트, tmux 명령을 직접 다루지 않고 다음 작업을 수행하게 한다.

- Hub 설정과 연결 검사
- identity 등록, Ed25519 fingerprint 확인, 승인 대기와 key rotation/revocation 상태 관리
- OS 사용자 서비스로 동작하는 호스트당 단일 `agent-meshd` 상태와 복구 확인
- lane 생성, 수정, 시작, 종료, 재시작
- Claude/Codex/Antigravity runtime 연결
- channel-driver의 운영 중 추가, 비활성화, 활성화, 수정, 삭제
- tmux agent session attach
- 상태, 로그, outbox, 장애 확인과 복구

## 2. 설계 원칙

- 삭제보다 비활성화를 먼저 제안한다.
- config 삭제와 secret 삭제를 분리하고 secret 삭제는 별도로 확인한다.
- channel 또는 lane 삭제가 outbox와 Hub 감사 기록을 삭제하지 않는다.
- 실행 중인 lane 변경은 가능한 경우 Runtime과 Agent CLI를 재시작하지 않고 적용한다.
- 재시작이 필요한 변경은 적용 전에 영향 범위를 표시한다.
- 일반 화면은 lane, runtime, channel, Hub 상태에 집중하고 내부 endpoint와 PID는 상세 화면에서 제공한다.
- TUI와 CLI가 같은 config/service 계층을 사용한다.
- 장시간 작업은 현재 단계, 경과 시간, 취소 가능 여부와 마지막 오류를 표시한다.

## 3. 공통 조작

| 키 | 동작 |
|---|---|
| `Enter` | 열기, 선택 또는 계속 |
| `Esc` | 취소 또는 이전 화면 |
| `↑/↓`, `j/k` | 항목 이동 |
| `Tab`, `Shift+Tab` | 영역 이동 |
| `?` | 현재 화면 도움말 |
| `q` | 최상위 화면에서 TUI 종료 |

위험 작업은 단일 키 입력만으로 완료하지 않는다. Footer에는 현재 화면에서 실제 사용할 수 있는 키만 표시한다.

## 4. 실행 진입점

설정이 없을 때 `agent-mesh`를 실행하면 온보딩으로 들어간다.

```bash
agent-mesh
```

설정이 있으면 운영 대시보드로 들어간다. 특정 화면 직접 진입은 선택 기능으로 둔다.

```bash
agent-mesh tui
agent-mesh tui --lane agent-a
agent-mesh tui --view outbox
```

TTY가 없으면 TUI를 강제로 열지 않고 비대화형 subcommand 사용법을 출력한다.

## 5. 정보 구조

```text
Agent Mesh TUI
├── Overview
│   ├── Hub 상태
│   ├── 전체 lane 요약
│   └── 전체 경고
├── Lane Detail
│   ├── Runtime
│   ├── Channels
│   ├── Outbox
│   ├── Logs
│   └── Settings
├── Hub
│   ├── Endpoint와 discovery
│   ├── Identity 상태
│   ├── Key fingerprint와 승인 상태
│   └── Connection test
├── Diagnostics
│   ├── Dependencies
│   ├── Filesystem, user service와 tmux
│   └── Network
└── Global Settings
```

1차 버전은 복잡한 tab 구조보다 `Overview → Agent Detail` 계층을 우선한다.

## 6. 공통 화면

```text
╭─ Agent Mesh ──────────────────────── Hub ● Connected ────────╮
│                                                              │
│  Main content                                                │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ↑↓←→ Navigate                    Enter Select   Ctrl+C Exit   │
╰──────────────────────────────────────────────────────────────╯
```

- Header: 제품명, 현재 문맥, Hub 상태
- Main: 목록, 상세, wizard 또는 로그
- Footer: 현재 동작 키
- Overlay: 확인, secret 입력, 오류 상세, 도움말
- Esc는 이전 화면으로 이동한다. Overview에서는 무시하며, 종료는 Quit 항목으로만 한다. Backspace는 문자 삭제 전용이다 — 빈 입력에서 뒤로 가게 하면 오타를 지우던 손이 화면을 닫는다. 대상이 없는 action은 disabled로 남기지 않고 숨긴다.

## 7. 상태 표현

색상만으로 상태를 구분하지 않고 기호와 텍스트를 함께 사용한다.

| 표시 | 의미 |
|---|---|
| `● Running` | 정상 실행 중 |
| `● Connected` | 외부 연결 정상 |
| `◐ Starting` | 전이 중 |
| `◐ Approval` | identity key 등록 후 관리자 승인 대기 |
| `◐ Draining` | 신규 작업 중단 후 기존 작업 완료 대기 |
| `○ Stopped` | 정상 종료 |
| `○ Idle` | runtime은 준비됐고 현재 실행 중인 one-shot child가 없음 |
| `○ Disabled` | 구성은 있으나 의도적으로 비활성화 |
| `! Degraded` | 일부 기능 실패, 기본 기능은 동작 |
| `× Failed` | 작업 실패 또는 사용 불가 |
| `? Unknown` | 상태를 확인할 수 없음 |

`NO_COLOR`와 monochrome terminal에서도 의미가 유지되어야 한다.

## 8. 최초 온보딩

### 8.1. 환경 검사

```text
 Environment check

 ✓ tmux 3.5
 ✓ Claude CLI detected
 ○ Codex CLI not detected        Not required yet
 ✓ Antigravity CLI detected      Not selected
 ✓ Runtime directory writable
 ✓ Secret directory permissions

 [Enter] Continue                  [r] Recheck   [d] Details
```

- 선택한 runtime CLI를 필수로 판정한다. tmux는 Claude/Codex 등 대화형 runtime을 선택했을 때만 필수이며 Antigravity one-shot lane에는 필수가 아니다.
- Bun, Node.js, npm은 최종 사용자 필수 항목이 아니다.
- 누락된 제3자 도구는 동의 없이 자동 설치하지 않는다.
- 기본은 설치 방법 안내이며 명시적인 동의가 있을 때만 자동 설치 후보로 다룬다.

### 8.2. Hub 설정

```text
 Hub connection

 Hub URL
 ┌──────────────────────────────────────────────────────────┐
 │ https://mesh.example.com                                 │
 └──────────────────────────────────────────────────────────┘

 Discovery   ✓ Found
 RPC         wss://mesh.example.com/ws
 API         https://mesh.example.com/api/v1
 Protocol    1.2
 Audit       protocol 1

 [t] Test connection   [Enter] Continue   [a] Advanced
```

기본 흐름은 Hub URL 하나만 요구한다. Advanced에서 `rpc_ws`, `api_http` override를 제공한다.

### 8.3. Runtime과 첫 lane 생성

```text
 CLI Runtime: [Claude] [Codex] [AntiGravity]

 Security Profile: [Sandboxed] [Workspace] [Unrestricted]

 [←/→ or Tab] Move   [Enter] Select
```

선택 항목은 강조 표시한다. 좌우 방향키 또는 Tab으로 이동하고 Enter로 확정한다. CLI Runtime은 Claude, Security Profile은 Workspace를 최초 강조 항목으로 표시한다. Runtime을 선택하면 해당 CLI, 인증과 transport capability를 검사한다. Unrestricted 선택 시에는 별도 위험 확인을 거쳐야 한다.

```text
 Create first lane

 Agent Identity
Runtime       Claude
Workspace     /home/user/work/agent-a

 ✓ Local lane ID generated: agent-a
✓ Workspace exists
✓ Claude authentication detected

 [Enter] Continue
```

Agent Identity는 기본값 없이 필수로 입력받는다. 로컬 config 중복과 Hub 전체 registry를 모두 조회하고, 이미 등록됐거나 soft-delete로 예약된 Identity는 거부한다. Hub에 연결할 수 없거나 조회 응답이 불명확하면 저장하지 않는 fail-closed 동작을 사용한다. Identity는 Hub에서 영구적이고 대소문자를 구분하며 soft delete 후 재사용되지 않는다. 로컬 lane ID는 Identity를 lowercase kebab-case로 정규화해 자동 생성하고, 충돌 시 숫자 suffix를 붙인다. tmux session 이름, UDS와 state 경로는 이 내부 lane ID로부터 자동 파생한다.

Antigravity를 선택하면 one-shot capability, MCP와 인증 상태를 추가로 검사한다.

```text
 Antigravity runtime

 CLI               ✓ agy 1.1.13 detected
 One-shot JSON     ✓ Supported
 Conversation      ✓ Supported
 Print timeout     ✓ Supported
 Authentication    ✓ Google OAuth detected
 Agent Mesh MCP    ✓ Workspace config ready
 Permission profile ! Not validated

 [t] Test runtime   [a] Authentication   [p] Permissions
 [Enter] Continue
```

`agy 1.1.13`은 검증 baseline으로 표시하되 영구 고정 version으로 강제하지 않는다. `--print`, JSON output, conversation, timeout과 선택된 security policy의 capability probe를 통과해야 ready로 판정한다. 모델 목록과 quota는 동적이므로 하드코딩하지 않는다.

OAuth가 필요하면 일반 form 안에서 credential을 받지 않고 임시 PTY/tmux 인증 단계로 이동한다.

```text
 Antigravity authentication                         00:31

 Open the URL shown in the secure auth terminal,
 approve access, then paste the authorization code there.

 ! The observed approval window may be short.
   URL, code and token will not be saved in Agent Mesh logs.

 [o] Open auth terminal   [r] Retry   [Esc] Cancel
```

파일럿에서 관측된 약 60초 승인 창은 UI countdown의 고정 protocol 값으로 간주하지 않는다. TUI는 CLI가 실제로 제공하는 상태를 우선하며 auth URL/code/token을 일반 화면, 진단 export와 감사 이벤트에 남기지 않는다.

### 8.4. Identity key 등록과 승인

최초 적용 시 Lane Controller는 lane identity용 Ed25519 key를 생성하고 공개키를 등록한다. Private key는 lane secret에 저장하고 화면에 표시하지 않는다.

```text
 Identity registered — approval required

 Identity      agent-a
 Agent type    ai-cli-adapter
 Key policy    Signature required
 Key status    ◐ Pending approval
 Fingerprint   SHA256:7b:2e:...:91

 Compare this fingerprint with the Hub admin approval screen.
 Mesh messaging and audit upload will start after approval.
 Runtime, channels and local outbox can start now.

 [c] Copy fingerprint   [o] Open admin page   [r] Check approval
 [Enter] Continue in pending state
```

- `pending`은 setup 실패가 아니라 정상 대기 상태다.
- pending 중에도 Runtime과 channel-driver를 시작할 수 있고 감사 event는 local outbox에 쌓인다.
- mesh messaging과 Hub 감사 송신은 승인 전까지 사용할 수 없다고 명확히 표시한다.
- fingerprint 전체값은 명시적인 상세/copy 동작에서만 표시하고, 일반 로그에는 identity와 함께 표시한다.
- 승인되면 polling 또는 다음 reconnect에서 자동으로 `approved`로 전환한다.
- `missing`, `denied`와 `revoked`는 pending과 구분해 이유, 영향과 새 key 생성·제안 절차를 표시한다.
- Agent type은 client enum이 아니라 Hub 운영자 registry다. Antigravity의 `ai-cli-adapter`가 미등록이면 client가 type을 만들거나 다른 AI type으로 fallback하지 않고 Hub 운영자에게 `requires_key=1` provision을 요청하도록 안내한다.
- `requires_key=1` type은 key 없이 등록하지 않는다. `requires_key=0` type도 approved key가 존재하면 이후 요청에 서명을 사용한다.

### 8.5. 선택 channel

```text
 Connect a channel now?

 ● Skip for now
 ○ Discord
 ○ Slack                         Not installed
 ○ Telegram                      Not installed

 You can add or remove channels later without restarting the lane.

 [Enter] Continue
```

### 8.6. 최종 검토와 적용

```text
 Ready to configure

 Hub          https://mesh.example.com
 Daemon       launchd/systemd --user (single host daemon)
 Lane         agent-a
 Identity     agent-a
 Runtime      Claude
 Workspace    /home/user/work/agent-a
 Channel      None
 tmux         mesh-agent-a

 Files to create or update:
   ~/.config/agent-mesh/config.yaml
   ~/.local/state/agent-mesh/...
   /home/user/work/agent-a/.mcp.json

 [Enter] Apply and start   [b] Back   [q] Cancel
```

적용 진행은 단계별로 표시한다.

```text
✓ Saved configuration
✓ Started host daemon
✓ Generated lane identity key
✓ Registered public key
◐ Waiting for Hub approval — local services may continue
✓ Generated MCP configuration
✓ Created runtime tmux session
◐ Starting Claude CLI
· Waiting for Runtime Adapter
· Health check
```

실패하면 완료된 단계, 실패 단계, 되돌린 항목과 남은 항목을 구분한다.

## 9. 운영 대시보드

```text
 ◆ AGENT MESH · Overview
 Local control plane · live status

 ╭─ Host ───────────────────────────────────────────────────────╮
 │ ● Daemon running   PID 12031 · Agents 3 · Drivers 2          │
 ╰──────────────────────────────────────────────────────────────╯

 ╭─ Agents · 3 ─────────────────────────────────────────────────╮
 │ › ● agent-a  CLAUDE · Hub connected · Runtime running        │
 │     Key approved · Channels 1 · Outbox 0/0/0                 │
 │   ● agent-b  CODEX · Hub approval · Runtime idle             │
 │                                                              │
 │   + Add Agent                                                │
 │   ↻ Refresh                                                  │
 │   × Quit                                                     │
 ╰──────────────────────────────────────────────────────────────╯

 ↑ ↓ Select agent or command    Enter Open    Ctrl+C Exit
```

Overview는 로컬에 등록된 모든 Agent와 상태를 최상위 선택 목록으로 보여준다. 방향키로 Agent를 선택하고 Enter를 누르면 해당 Agent의 key, channel, runtime attach, 활성화와 삭제 작업으로 들어간다. `+ Add Agent`, Refresh와 Quit만 Agent 목록 아래에 둔다. 수동 send/inbox는 Runtime Adapter의 책임과 겹치므로 운영 TUI에 노출하지 않고 진단용 CLI에만 유지한다. 사람에게 보이는 화면에서는 내부 구현 용어인 Lane을 사용하지 않는다. 목록이 화면보다 길면 선택 위치를 따라 viewport가 이동한다.

Agent가 0개인 첫 실행도 같은 Overview를 사용한다. `No agents registered.`를 표시하고 `+ Add Agent`를 기본 선택하며, 자동으로 등록 wizard에 진입하지 않는다.

## 10. Agent 상세

```text
 ◆ AGENT MESH · Agent · agent-a

 ╭─ Agent status ────────────────────────────────────────────────╮
 │ Status     Enabled                                           │
 │ Hub        Connected                                         │
 │ Key        Approved                                          │
 │ Runtime    Running                                           │
 │ Channels   discord-main:running                              │
 │ Outbox     0/0/0                                             │
 ╰──────────────────────────────────────────────────────────────╯

 ╭─ Manage agent ────────────────────────────────────────────────╮
 │ › ◆ Identity Key               # Channels                    │
 │   ⌁ Attach Runtime              ○ Disable Agent               │
 │   − Remove Agent                ← Back                        │
 ╰──────────────────────────────────────────────────────────────╯
```

Hub가 끊기거나 key 승인을 기다려도 channel과 runtime이 정상일 수 있으므로 상태를 각각 표시한다.

## 11. Channel 추가 wizard

### 11.1. Provider와 ID

```text
 Add channel to agent-a — 1/4

 ● Discord
 ○ Slack          Not installed
 ○ Telegram       Not installed

 [Enter] Continue   [Esc] Cancel
```

```text
 Add channel to agent-a — 2/4

 Driver ID
 ┌──────────────────────────────────────────────────────────┐
 │ discord-main                                             │
 └──────────────────────────────────────────────────────────┘

 ✓ ID is unique in lane agent-a
```

Driver ID는 자동 제안하며 한 lane 안에서 고유해야 한다. 감사와 라우팅의 안정성을 위해 생성 후 rename보다 remove/add를 우선한다.

### 11.2. Credential

```text
 Add channel to agent-a — 3/4

 Discord bot token
 ┌──────────────────────────────────────────────────────────┐
 │ •••••••••••••••••••••••••••••••••••••••••••••••••• │
 └──────────────────────────────────────────────────────────┘

 Store as
 ● Agent Mesh secret file
 ○ Environment variable reference

 [t] Test credentials   [Enter] Continue   [Esc] Cancel
```

- secret은 화면, 로그, audit payload에 노출하지 않는다.
- 현재 secret 수정 시 기존 값을 다시 표시하지 않는다.
- 테스트 결과는 표시 가능한 account ID와 name까지만 노출한다.

### 11.3. 검토와 기동

```text
 Add channel to agent-a — 4/4

 Provider       Discord
 Driver ID      discord-main
 Account        mesh-bot
 Capabilities   message, reply, reaction, typing, attachment

 ✓ Credentials valid
 ✓ Runtime Adapter ready
 ✓ Lane socket available

 [Enter] Add and start   [b] Back   [Esc] Cancel
```

적용은 transaction처럼 동작한다.

```text
Validate candidate config
→ Prepare secret
→ Start driver candidate
→ Connect lane UDS
→ channel.register
→ Provider health check
→ Commit config and secret reference
→ Healthy
```

등록 또는 health check 실패 시 candidate process를 종료하고 기존 config는 유지한다.

## 12. Channel 상세와 수정

```text
 Channel: discord-main                       Discord ● Connected

 Lane            agent-a
 Account         mesh-bot
 Driver PID      12102
 Connected       2h 14m
 Last inbound    18s ago
 Last outbound   42s ago
 Capabilities    message, reply, reaction, typing, attachment

 [e] Edit   [Space] Disable   [t] Test   [l] Logs
 [x] Remove [Esc] Back
```

| 변경 | 적용 방식 |
|---|---|
| 표시명 등 metadata | 즉시 반영 |
| token, provider 옵션 | 해당 driver만 재연결 |
| driver ID | 직접 수정하지 않고 remove/add 우선 |

해당 driver 재연결이 필요해도 lane과 Agent Runtime은 재시작하지 않는다.

## 13. Channel 비활성화와 활성화

`Space` 입력 후 영향 확인 overlay를 표시한다.

```text
 Disable discord-main?

 The driver will stop receiving and sending new messages.
 Configuration and credentials will be retained.
 The lane and Runtime Adapter will remain running.

 [Enter] Disable   [Esc] Cancel
```

비활성화 순서는 다음과 같다.

```text
Stop new outbound
→ Drain in-flight operations
→ Disconnect provider
→ channel.unregister
→ Stop driver
→ Mark Disabled
```

활성화는 저장된 config와 secret을 검사하고 driver만 재기동한다.

## 14. Channel 삭제

```text
 Remove channel: discord-main

 ● Remove configuration, keep credential
 ○ Remove configuration and credential
 ○ Disable only

 Pending audit outbox records will NOT be deleted.

 [Enter] Continue   [Esc] Cancel
```

두 번째 확인에서 lane과 driver ID를 다시 보여준다. 삭제 진행은 단계별로 표시한다.

```text
 Removing discord-main

 ✓ Stopped new requests
 ◐ Draining in-flight messages                 2 remaining
 · Disconnect provider
 · Stop driver
 · Remove configuration

 12s elapsed
 [w] Wait longer   [f] Force stop   [Esc] Keep waiting
```

- 기본은 graceful drain이다.
- drain timeout 후 자동 강제 종료하지 않고 사용자가 선택한다.
- force stop된 outbound 요청은 실패 감사 이벤트로 남길 수 있어야 한다.
- 삭제가 outbox, Hub 감사 기록 또는 Blob을 삭제하지 않는다.
- 삭제한 `driver_instance_id`의 즉시 재사용은 기본적으로 금지한다.

## 15. Lane 추가, 수정과 수명주기

운영 중 lane 추가는 최초 온보딩 wizard를 재사용한다.

```text
Runtime 선택 → Workspace → CLI/auth 검사 → Optional channels
→ Review → Save → Start now / Keep stopped
```

Lane 수정 전에 영향도를 보여준다.

```text
Workspace        unchanged             No restart
Hub              global setting        Reconnect all lanes
Lane ID          immutable             Create a new lane instead
```

Lane ID는 로컬 outbox, tmux와 socket 경로에 연결되므로 일반 edit를 지원하지 않는 방향을 우선한다. Hub identity도 별도 영구 식별자이므로 일반 rename을 지원하지 않고 새 identity 등록과 명시적인 lane 재연결 절차로 취급한다.

Runtime별 attach 동작은 다를 수 있다.

- Claude: 대화형 Agent CLI window에 `Attach`
- Codex: 최종 app-server 수명주기에 따라 `Attach` 또는 `Observe`
- Antigravity: 상주 대화형 process 대신 queue, one-shot turn과 conversation mapping을 보여주는 `Observe`

Antigravity lane 상세에는 평상시 `Idle`, 처리 중 `Running`, queue depth, active turn 경과/30분 deadline, model, conversation mapping 수와 마지막 결과를 표시한다. `agy` 상주 process나 ACP session 상태는 없다. Prompt/response 본문, thought/reasoning, tool parameter/output과 auth 정보는 observer에 표시하지 않는다.

```text
 Runtime: antigravity-a

 CLI              agy 1.1.13
 State            ○ Idle
 Transport        one-shot JSON
 Queue            2 pending · 0 active
 Context          7 mappings
 Model            account default
 Permissions      ! Sandbox behavior unverified
 MCP              ✓ agent-mesh configured
 Last result      SUCCESS · 2.46s

 [c] Contexts   [p] Permissions   [a] Authentication
 [l] Logs       [Esc] Back
```

`Contexts` 화면에서는 source/provider/thread를 비밀정보가 아닌 opaque reference로 표시하고 개별 mapping reset을 제공한다. Reset은 Hub identity, audit 기록 또는 outbox를 삭제하지 않는다.

시작은 다음 순서다.

```text
Validate → Prepare identity/key → Register public key → Create tmux → Start services
→ Start runtime → Wait for adapter → Start channels → Health check
```

종료 시 Hub 미연결로 outbox가 남아 있어도 종료를 허용한다. 미전송 수와 다음 시작 때 재개됨을 확인 화면에 표시한다.

## 16. Hub 화면

```text
 Hub

 Configured URL   https://mesh.example.com
 Discovery        ● Available
 RPC              wss://mesh.example.com/ws
 API              https://mesh.example.com/api/v1
 Protocol         1.2
 Audit protocol   1
 Contract         @agent-mesh/contracts v0.6.0
 Audit limits     100 MiB/file · 32 files · 256 MiB/event
 In-flight        append 4 · upload 2
 Audit storage    ● Available
 Latency          24 ms

 Connected lanes  2/3
 Pending approval 1

 [Enter] Identities   [e] Edit   [t] Test   [d] Discovery
 [Esc] Back
```

Hub 변경 시 연결된 모든 lane이 재연결된다는 점과 그동안 channel 처리는 계속되고 감사 이벤트는 outbox에 남는다는 점을 적용 전에 표시한다.

Identity 목록은 상태와 fingerprint를 표시하고 다음 동작으로 연결한다.

```text
 agent-a   ● Approved   SHA256:7b:2e:...:91
 agent-b   ◐ Pending    SHA256:4a:11:...:d8   [Open approval]
 agent-c   × Revoked    SHA256:9c:70:...:32   [Propose new key]
```

일상적인 rotation은 기존 승인 key를 유지한 채 새 key를 제안한다. Compromise revocation은 대체 key 승인보다 먼저 수행할 수 있다는 강한 경고와 확인 절차를 둔다. TUI가 Hub 관리자 권한을 갖지 않으면 승인·폐기를 가장하지 않고 관리자 URL과 정확한 CLI/API 안내만 제공한다.

## 17. Outbox 화면

```text
 Outbox: agent-b                                  ! Retrying

 Pending events     14
 Pending blobs       3
 Dead-letter         1
 Oldest event       12m ago
 Disk usage         8.3 GiB
 Last attempt       18s ago
 Next retry         12s
 Last error         HUB_UNAVAILABLE

 [r] Retry now   [Enter] Event detail   [d] Dead-letter
 [l] Logs        [Esc] Back
```

- ACK되지 않은 항목을 일반 TUI에서 삭제할 수 없게 한다.
- Hub 최종 ACK 뒤 다른 pending/dead-letter event가 참조하지 않는 payload만 cleanup 후보로 표시한다. v0.1은 보존을 우선해 자동 삭제하지 않는다.
- Retry now는 기존 schedule을 앞당길 뿐 중복 worker를 만들지 않는다.
- Event detail에는 secret을 제거한 metadata, attachment hash/size, retry 횟수와 오류를 표시한다.
- Dead-letter는 malformed params, limit 위반, event conflict 같은 영구 오류의 원문과 Blob을 보존한다. 일반 TUI에서 삭제할 수 없으며 active retry 대상으로도 넣지 않는다.
- `AUDIT_BUSY`이면 `retry_after_ms`, 현재 in-flight와 다음 시도를 표시한다.
- `AUDIT_STORAGE_EXHAUSTED`이면 자동 해소되는 busy가 아니라 Hub 운영자의 volume 증설이 필요하다고 표시한다. Channel과 mesh routing 상태는 감사 storage와 별도로 보여준다.
- protocol/schema 비호환과 key 승인 대기는 일반 네트워크 retry와 구분한다.
- 메시지 본문 열람 여부는 민감정보 정책과 함께 후속 결정한다.

## 18. 로그와 Diagnostics

```text
 Logs: agent-a / discord-main                   ● Following

 14:02:11 connected to provider
 14:02:13 registered with runtime adapter
 14:04:28 inbound message accepted
 14:04:28 audit event queued id=aud_0198b1f8-...

 [f] Follow   [/] Filter   [c] Component   [p] Pause
 [e] Export   [Esc] Back
```

로그는 기본적으로 secret과 message body를 redaction한다. Export에도 동일한 redaction을 적용한다.

```text
 Diagnostics

 Host
   ✓ tmux 3.5
   ✓ agent-meshd single instance
   ✓ daemon control socket
   ✓ Runtime directory permissions 0700
   ✓ Secret directory permissions 0700
   ✓ Disk free 72 GiB

 Runtime: agent-a
   ✓ Claude CLI detected
   ✓ Authentication detected
   ✓ tmux session
   ✓ Runtime Adapter socket

 Network
   ✓ Hub discovery
   ✓ Hub WebSocket
   ✓ Hub HTTP API
   ✓ Clock offset within signature window (±120s)

 Identity: agent-a
   ✓ Agent type ai-cli-adapter · requires key
   ✓ Ed25519 private key permissions 0600
   ✓ Fingerprint SHA256:7b:2e:...:91
   ✓ Hub key status approved
   ✓ Audit protocol 1 and limits supported

 Contract
   ✓ @agent-mesh/contracts v0.6.0 locked
   ✓ agentMeshSpec 0.2 compatible
   ✓ TypeBox runtime schemas and byte fixtures

 [r] Run all   [Enter] Details   [e] Export report   [Esc] Back
```

진단 보고서에서 token, credential, Authorization header, message body와 attachment 원본을 제거한다.

Antigravity 진단은 CLI version, one-shot JSON/capability, 인증 유형, workspace MCP config, child environment 필수값, conversation scope와 sandbox/permission probe를 추가로 검사한다. 실제 secret, auth URL/code, prompt/response 본문과 thought/tool detail은 보고서에 포함하지 않는다. Exit code 0이어도 headless permission soft-denial이 있으면 성공과 별도의 operational warning으로 표시한다.

기본 headless 정책도 활성 workspace 내부 파일 읽기/쓰기를 자동 허용한다. 설치 사용자가 lane별 security policy를 선택하고, TUI는 실제 적용 여부와 위험을 검증·표시한다. 완화된 정책을 선택해도 실행을 임의 차단하지 않지만 외부 channel 연결 전 확인을 받고 경고 상태를 유지한다.

## 19. 오류 UX

오류는 요약, 영향, 복구 행동, 상세 코드 순으로 표시한다.

```text
 Could not start discord-main

 The Discord token was rejected.
 agent-a and its other channels are still running.
 No configuration change was committed.

 [e] Edit token   [r] Retry   [l] View logs   [Esc] Close

 Details: PROVIDER_AUTH_FAILED
```

| 오류 | 기본 행동 |
|---|---|
| 잘못된 URL, 중복 ID | 입력 위치로 복귀 |
| Hub/provider 인증 실패 | secret 재입력 또는 검사 |
| Hub agent type 미등록 | 운영자에게 type과 `requires_key` provision 안내, 다른 type으로 자동 fallback 금지 |
| Hub 503, 네트워크 단절 | 자동 retry와 degraded 상태 |
| key pending | 정상 approval 대기, local channel/outbox 계속, 관리자 승인 안내 |
| key denied/revoked | Hub 기능 중지, 이유와 새 key 제안 또는 복구 안내 |
| `AUDIT_BUSY` | 서버 지시 시간 이상 대기하고 현재 pacing 표시 |
| `AUDIT_STORAGE_EXHAUSTED` | Hub 감사 volume 증설 필요, outbox 보관과 라우팅 정상 여부를 별도 표시 |
| `SIGNATURE_INVALID` | 새 nonce/iat로 재서명하고 local clock, key와 serializer 진단 |
| 영구 감사 오류 | dead-letter 격리와 운영 경고, 자동 hot retry 금지 |
| user service 설치 실패, 필요한 tmux 없음, 권한 오류 | doctor와 설치 안내 |
| outbox 기록 실패, 디스크 부족 | fail-closed와 강한 경고 |
| protocol version 불일치 | 업그레이드 안내와 안전한 실행 제한 |

Hub만 끊겼거나 여러 channel 중 하나만 실패한 경우 lane 전체를 `Failed`로 표시하지 않는다.

## 20. Config 동시성과 transaction

- TUI는 config revision을 읽고 저장 직전에 다시 확인한다.
- 외부 CLI나 다른 TUI가 먼저 수정했으면 자동 overwrite하지 않는다.
- 충돌 시 reload, diff 확인, 취소를 제공한다.
- 설정은 validation 후 임시 파일과 atomic rename으로 갱신한다.
- Host Daemon은 확정된 config revision만 적용하고 lane별 controller에 변경을 전달한다.
- 같은 lane의 start, stop, add, remove 작업은 직렬화한다.
- 서로 다른 lane의 안전한 작업은 병렬 수행할 수 있다.

## 21. Secret 처리

- 입력 필드는 마스킹한다.
- 저장한 secret을 일반 화면에 다시 표시하지 않는다.
- secret 파일은 `0600`, 상위 directory는 `0700`으로 둔다.
- identity private key는 secret으로 취급하고 export, clipboard, 로그와 진단 보고서에서 제외한다.
- config 삭제와 secret 삭제를 별도 작업으로 취급한다.
- secret 변경 실패 시 기존 정상 secret과 연결을 가능한 한 유지한다.
- 환경 변수 reference를 선택하면 값이 아니라 변수명만 설정에 저장한다.

## 22. 터미널 호환성

- 권장 최소 크기는 `80x24`다.
- 작으면 필요한 크기와 resize 안내를 표시한다.
- 좁은 화면은 목록과 상세를 분리하고 넓은 화면은 split view를 허용한다.
- mouse 없이 모든 기능을 사용할 수 있어야 한다.
- true color와 Unicode를 필수로 요구하지 않는다.
- SSH와 tmux 안에서 정상 동작해야 한다.

## 23. TUI와 CLI 대응

| TUI 작업 | CLI 대응 |
|---|---|
| Hub 설정 | `agent-mesh config hub set <url>` |
| Hub 검사 | `agent-mesh config hub test` |
| Identity 상태 | `agent-mesh identity status <lane>` |
| Key rotation 제안 | `agent-mesh identity rotate <lane>` |
| Fingerprint 표시 | `agent-mesh identity fingerprint <lane>` |
| Lane 추가 | `agent-mesh lane add ...` |
| Lane 시작 | `agent-mesh up <lane>` |
| Lane 종료 | `agent-mesh down <lane>` |
| Lane attach | `agent-mesh attach <lane>` |
| Channel 추가 | `agent-mesh channel add <lane> ...` |
| Channel 비활성화 | `agent-mesh channel disable <lane> <id>` |
| Channel 활성화 | `agent-mesh channel enable <lane> <id>` |
| Channel 삭제 | `agent-mesh channel remove <lane> <id>` |
| 상태 | `agent-mesh status` |
| Host Daemon 상태 | `agent-mesh daemon status` |
| 로그 | `agent-mesh logs <lane> [component]` |
| Outbox retry | `agent-mesh outbox retry <lane>` |
| Dead-letter 조회 | `agent-mesh outbox dead-letter <lane>` |
| 진단 | `agent-mesh doctor` |

## 24. 수용 조건

- YAML 편집 없이 첫 lane을 실행할 수 있다.
- lane 수와 관계없이 Host Daemon 하나만 기동되고 TUI에서 해당 상태를 확인할 수 있다.
- Hub 주소 하나로 discovery와 연결 검사를 완료한다.
- 실행 중인 lane에 channel을 추가·삭제해도 Agent Runtime을 재시작하지 않는다.
- Antigravity lane을 생성할 때 one-shot/JSON capability, 인증과 permission 오류를 일반 Hub/channel 오류와 구분해 안내한다.
- Antigravity 보안 정책은 설치 사용자가 lane별로 선택하고 실제 적용 상태와 위험도를 확인할 수 있다.
- Antigravity `Observe` 화면에 Idle/Running, queue, turn deadline과 context mapping은 보이지만 prompt/response 본문, thought/tool detail과 auth 정보는 노출되지 않는다.
- Antigravity auth는 임시 PTY에서 처리하고 credential을 TUI state나 진단 report에 저장하지 않는다.
- Antigravity turn timeout 30분과 Hub Blob upload 시도 timeout 180초를 서로 다른 상태로 표시한다.
- `ai-cli-adapter` type이 Hub에 없으면 관리자 provision 필요 상태로 표시하고 임의 type 생성이나 vendor type fallback을 하지 않는다.
- 설치된 contract tag, SPEC compatibility와 runtime schema/fixture completeness를 Diagnostics에서 확인할 수 있다.
- channel 삭제 시 config, secret, outbox 처리 차이를 명확히 보여준다.
- Hub 장애와 channel 장애를 별도 상태로 표시한다.
- key pending을 실패가 아닌 정상 대기 상태로 표시하고 fingerprint 대조 절차를 제공한다.
- key denied/revoked, audit protocol/schema 비호환, `AUDIT_BUSY`와 영구 dead-letter를 서로 다른 상태로 표시한다.
- `AUDIT_STORAGE_EXHAUSTED`를 `AUDIT_BUSY`와 구분하고 Hub routing이 계속되는지를 별도 상태로 표시한다.
- signature clock offset이 `±120초`를 벗어나기 전에 진단할 수 있다.
- 장시간 작업의 단계와 경과 시간을 확인할 수 있다.
- 실패한 작업이 기존 정상 구성을 불필요하게 손상시키지 않는다.
- 위험 작업에 영향 범위와 확인 절차가 있다.
- keyboard만으로 모든 필수 기능을 수행할 수 있다.
- `80x24`, SSH, tmux, monochrome 환경에서 핵심 정보가 유지된다.
- 주요 TUI 작업에 대응하는 비대화형 CLI가 존재한다.
- 화면, 로그, 진단 보고서에 secret이 노출되지 않는다.

## 25. 피드백 필요 항목

### 25.1. 내비게이션과 온보딩

- Overview 중심 계층형 화면이면 충분한지, 좌측 navigation이나 tab이 필요한지
- lane 수가 수십 개일 때 검색과 group이 필요한지
- 실행 직후 Overview와 최근 사용 lane 중 어느 화면을 기본으로 할지
- tmux/runtime CLI 누락 시 안내만 할지 동의 후 설치까지 할지
- 온보딩 완료 후 자동으로 agent window에 attach할지

### 25.2. 운영

- channel graceful drain 기본 timeout
- channel 삭제 후 secret 기본 보존 기간
- 삭제한 `driver_instance_id` 재사용 금지 기간
- lane 종료 시 outbox 미전송 건에 대한 확인 강도
- Runtime 또는 driver crash 자동 재시작 정책
- systemd user/launchd의 Host Daemon crash 및 restart 상태를 TUI에서 어떻게 표시할지
- Antigravity queue, active turn deadline과 conversation mapping 상태를 Overview에 어느 수준까지 표시할지
- Antigravity observer용 tmux session을 항상 만들지 필요할 때만 만들지

### 25.3. 민감정보와 확장

- TUI에서 감사 메시지 본문을 열람할 수 있게 할지
- OS keychain integration을 1차 범위에 넣을지
- 공식 내장 driver만 관리할지 외부 executable driver 설치까지 포함할지
- 외부 driver의 서명, 권한, 호환성을 어떻게 표시할지

## 26. v0.1 이후로 미룬 항목

- TUI framework 선택
- rendering library와 event loop 구현
- standalone binary compile 도구 최종 선택
- 내부 module과 class 구조

## 27. 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-08-15 | 최초 피드백 초안. 온보딩, Overview, lane, channel hot add/remove, Hub, outbox, 로그, diagnostics, 오류와 config transaction UX 정의 |
| 2026-08-15 | Gemini runtime 선택, ACP/auth 검사, runtime별 Attach/Observe와 Gemini 진단·관측 요건 추가 |
| 2026-08-15 | Host Daemon을 OS 사용자 서비스로 변경하고 tmux를 대화형 runtime으로 한정. Antigravity security policy를 설치 사용자 선택으로 변경 |
| 2026-08-15 | 호스트당 단일 `agent-meshd` 상태, 온보딩 기동, diagnostics와 CLI 대응 요건 추가 |
| 2026-08-15 | Hub 회신 반영. Ed25519 identity 승인 UX, fingerprint 대조, key rotation/revocation, negotiated audit limit, busy pacing, UUIDv7 event ID와 dead-letter 화면 추가 |
| 2026-08-15 | Hub 2차 회신 반영. KEY_NOT_APPROVED 상태, ±120초 signature clock 진단, AUDIT_STORAGE_EXHAUSTED 운영자 안내와 ACK 후 local payload 정리 추가 |
| 2026-08-15 | Gemini ACP 화면을 Antigravity one-shot JSON runtime으로 교체. Idle/Running, context mapping, 임시 PTY OAuth, permission probe와 30분 turn 표시 추가 |
| 2026-08-15 | Hub 3차 회신 반영. Dynamic agent type/requires_key UX, contract v0.3.0과 schema/fixture readiness 진단 추가 |
