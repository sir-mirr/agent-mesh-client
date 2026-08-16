# Agent Mesh Client

여러 Agent CLI와 외부 채널을 하나의 로컬 데몬으로 Agent Mesh Hub에 연결합니다. 최종 사용자는 Bun·Node.js·npm 없이 standalone `agent-mesh` 바이너리 하나를 설치하고, TUI에서 Hub·Agent·runtime·channel을 설정할 수 있습니다.

현재 `v0.1.0-dev` 구현에는 다음이 포함됩니다.

- 호스트당 하나의 `agent-meshd`, 내부의 여러 독립 lane
- Claude Code MCP development channel, Codex App Server, Antigravity one-shot runtime
- Discord Driver와 Slack/Telegram 확장을 위한 공통 Channel RPC
- lane별 Ed25519 identity, Hub 승인·서명, 멱등 mesh 전송
- SQLite `WAL + synchronous=FULL` outbox와 SHA-256 Blob spool
- Hub 장애 중 무기한 보관·재시도, final ACK와 dead-letter
- launchd/systemd 사용자 서비스, 설치·운영 TUI, 동등한 CLI
- macOS/Linux standalone GitHub Release 패키징

## 설치

공개 릴리스가 생성된 뒤 저장소의 installer를 사용합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/sir-mirr/agent-mesh-client/main/install.sh | sh
agent-mesh
```

`install.sh`는 OS/CPU에 맞는 GitHub Release archive와 `SHA256SUMS`를 내려받아 검증한 뒤 기본적으로 `~/.local/bin/agent-mesh`에 설치하고, launchd 또는 systemd 사용자 서비스를 즉시 등록·기동합니다. 서비스 PATH에는 user-local, Homebrew/Linuxbrew와 설치 시 발견한 Runtime CLI 위치가 명시적으로 기록됩니다. 서비스 등록을 생략해야 하는 컨테이너 환경에서는 `AGENT_MESH_INSTALL_SERVICE=0`을 지정할 수 있습니다. Agent CLI는 사용할 runtime만 별도로 준비합니다.

| Runtime | 필요한 외부 도구 | 연결 방식 |
|---|---|---|
| Claude | `claude`, `tmux` | stdio MCP development channel + tmux |
| Codex | `codex` (공식 installer) | 공식 `codex app-server --listen stdio://` |
| Antigravity | `agy` | turn마다 `agy --print --output-format json` |

### Codex 세션 관찰

Codex lane의 app-server는 lane마다 unix socket에 붙습니다.

```
codex app-server --listen unix://<runtime-dir>/codex-<lane>.sock
```

`agent-mesh attach <lane-id>`는 그 socket에 `codex --remote unix://<path> --no-alt-screen` TUI를 tmux로 띄웁니다. 데몬과 관찰자가 **같은 app-server**를 공유하므로 계정·설정·MCP 서버가 하나입니다. 세션이 없으면 attach가 만들고, 있으면 붙습니다.

이 경로는 Homebrew cask와 공식 installer 어느 쪽에서도 동작합니다 — `--listen unix://`와 `--remote`는 두 설치 모두에 있습니다. 공식 installer의 standalone 경로(`~/.codex/packages/standalone/current/`)가 필요한 것은 `codex app-server daemon` 계열뿐이고, 이 클라이언트는 그것을 쓰지 않습니다. 두 설치가 공존하면 PATH 순서가 어느 바이너리를 쓸지 결정하므로 `agent-mesh doctor`로 확인하십시오.

관찰자 TUI는 자기 thread를 엽니다. 데몬이 돌리는 turn은 같은 서버의 다른 thread라, 관찰자 화면에 그 turn이 자동으로 나타나지는 않습니다.

app-server의 unix transport는 stdio와 프로토콜이 다릅니다 — `/rpc`의 WebSocket이고 NDJSON이 아닙니다. 직접 붙을 일이 있다면 [`src/runtime/ws-unix-client.ts`](./src/runtime/ws-unix-client.ts)를 보십시오.

### Antigravity 세션 관찰

Antigravity는 turn마다 `agy --print` child를 한 번 실행하고 상주 프로세스를 두지 않습니다. 붙을 CLI가 없으므로 `agent-mesh attach <lane-id>`는 **redacted observer**를 tmux에 띄웁니다.

```
agent-mesh runtime observe --lane ID     # attach가 내부적으로 쓰는 것과 같은 화면
```

```
◆ AGENT MESH · observer · mesh-antigravity
antigravity runtime · ~/work/ai/mesh-agents/antigravity · 16:51:39
────────────────────────────────────────────────────────────────────────────
  TIME      STATE       FROM            IN    OUT   AGE    TURN
  16:51:14  COMPLETED   mesh-claude       31    46    17s  01a00655-b0c
  16:26:57  OBSERVED    mesh-codex        36     -  24m42s  01a0063f-761
```

**본문은 표시하지 않습니다.** `IN`/`OUT`은 프롬프트와 응답의 글자 수입니다. redaction은 렌더러가 아니라 데몬(`runtime.observe`)에서 일어나므로 본문·reasoning·auth code는 애초에 데몬 밖으로 나오지 않습니다 — 화면을 만드는 쪽에 버그가 있어도 샐 것이 없습니다.

`AGE`는 그 turn이 현재 상태에 머문 시간이라, 멈춘 turn이 눈에 띕니다.

인증 중 임시 PTY(`auth` window)는 아직 구현하지 않았습니다.

## 첫 실행

```sh
agent-mesh
```

TUI가 기본값 없는 Agent Identity, runtime, workspace와 보안 profile을 받습니다. Identity는 저장 전에 Hub 전체 registry에서 중복을 조회하며 Hub에 연결할 수 없거나 조회 응답이 불명확하면 fail-closed합니다. 내부 Lane ID는 Identity에서 자동 생성되지만 사람에게 보이는 TUI에서는 Agent로 일관되게 표시합니다. 설치 시 등록된 단일 데몬은 설정 변경을 감지하며, Claude Agent는 tmux 세션까지 생성합니다. Claude 최초 실행의 workspace 신뢰와 development channel 확인은 다음 명령으로 세션에 붙어 사용자가 직접 승인합니다.

```sh
agent-mesh attach <lane-id>
```

Claude lane은 **무인으로 기동합니다.** 새 workspace에서 CLI가 요구하던 세 번의 사람 답변을 데몬이 처리합니다.

| 게이트 | 처리 |
|---|---|
| workspace 신뢰 | 데몬이 tmux pane에 확인 키를 보냄 |
| development channel 경고 | 같음. 매 기동마다 다시 물으므로 저장으로는 해결 안 됨 |
| `reply` MCP tool 권한 | `--allowedTools`로 lane의 네 tool을 미리 허용 |

앞의 둘은 lane 설정의 결과지 나중에 붙는 사람이 내릴 결정이 아닙니다 — 경고는 데몬이 그 플래그를 넘겨서 뜨고, 신뢰 프롬프트는 운영자가 lane에 지정한 workspace를 묻습니다. **이 둘 외에는 아무것도 자동 응답하지 않습니다.** 다른 질문이 뜨면 화면에 남고 `awaiting-input` 상태로 사람을 부릅니다.

inbound mesh 메시지는 세션에 **자동으로 밀려 들어갑니다**. 그러려면 MCP 서버가 두 곳에 있어야 합니다 — `--mcp-config`가 서버를 실제로 띄우고(프로젝트 `.mcp.json` 단독은 승인 게이트에 걸려 무인 기동에서 안 뜹니다), workspace의 `.mcp.json`은 `--dangerously-load-development-channels server:agent-mesh`의 이름 해석에 쓰입니다. 채널 이름은 프로젝트 registry에서 찾지 `--mcp-config`가 넘긴 서버에서 찾지 않습니다. 파일이 없으면 tool 호출은 되는데 채널이 안 붙어서, 답장이 와도 화면에 안 뜨고 사람이 세션에 물어봐야 합니다.

CLI에서 `/exit`하면 tmux 세션이 사라집니다. 그 상태에서 `attach`는 붙을 것이 없다고 답하는 대신 **세션을 다시 세웁니다** — 이전 대화를 이어갈지(`--continue`) 새로 시작할지 좌/우 키로 고르고, 기동 동안 진행 표시가 나옵니다. mesh 상대는 identity로 부르므로 재시작 뒤 기본값은 같은 대화를 잇는 쪽입니다.

사람 개입이 필요한 대기는 상태로 구분됩니다. 해당 lane의 runtime 상태가 `running`이 아니라 **`awaiting-input`**이 되고 화면에 뜬 질문이 함께 표시되므로, 느린 turn과 헷갈리지 않습니다. 판정은 tmux pane에서 선택 커서(`❯ 1.`)를 읽어서 하며 — MCP 쪽으로는 대기 중 아무 신호도 오지 않기 때문에 — 시간으로 추측하지 않습니다.

Hub 관리자는 TUI의 전체 Ed25519 fingerprint와 Hub 승인 화면의 값을 대조해 key를 승인해야 합니다. 승인 전에도 로컬 channel 메시지와 첨부는 outbox에 보존되지만 mesh 송신과 Hub 감사 적재는 대기합니다.

## 주요 CLI

```text
agent-mesh                          TUI
agent-mesh up|down|restart|status|logs
agent-mesh config hub set URL|show
agent-mesh lane add|list|enable|disable|remove ...
agent-mesh channel add|list|enable|disable|remove ...
agent-mesh mesh send|agents|inbox ...
agent-mesh outbox status --lane ID
agent-mesh outbox replay --lane ID [--event-id ID ...]
agent-mesh attach LANE_ID
agent-mesh doctor
```

완화된 runtime 권한은 명시적으로 선택해야 합니다.

```sh
agent-mesh lane add local-codex \
  --runtime codex \
  --workspace "$PWD" \
  --security-profile workspace

agent-mesh lane add isolated-agy \
  --runtime antigravity \
  --workspace "$PWD" \
  --security-profile sandboxed
```

`unrestricted`는 `--acknowledge-risk` 없이는 저장되지 않습니다. channel 삭제와 provider secret 삭제는 분리되며, 삭제한 `driver_instance_id`는 provider 멱등성 상태 때문에 영구 재사용하지 않습니다.

## 데이터 경로

```text
Discord/future driver ← UDS JSON-RPC/NDJSON → Lane Controller ← runtime transport → Agent CLI
                                              │
                                              ├─ mesh routing → Hub
                                              └─ durable outbox/Blob → async Hub audit
```

Channel 실시간 왕복은 Hub를 우회해 latency를 줄입니다. inbound 메시지는 본문과 첨부가 로컬에 fsync된 뒤에만 Driver에 성공 ACK를 보냅니다. Hub 장애 중에도 로컬 runtime 응답은 계속되며, 미ACK event와 Blob은 복구 뒤 다시 전송됩니다.

첨부 제한은 파일당 100 MiB, event당 32개/합계 256 MiB입니다. chunk/resumable upload는 사용하지 않고 180초 안에 전체 PUT하며, 실패하면 다음 시도에서 전체 파일을 다시 보냅니다.

## 개발

개발 환경은 Bun 1.3과 TypeScript 7입니다.

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun run compile
```

실제 Hub harness 수용 테스트:

```sh
# agent-mesh-platform 저장소에서
bun run e2e:harness -- --ready-file /tmp/mesh-ready.json --keep-state

# 이 저장소에서
AGENT_MESH_E2E_READY_FILE=/tmp/mesh-ready.json bun run test:e2e:live
```

이 시나리오는 두 signed Codex lane 승인, 한글 mesh 왕복, reply-loop 차단, 직접 channel 응답, 첨부 Blob upload, 3종 audit final ACK와 관리자 audit 조회까지 검증합니다.

## 문서

- [`CLIENT_NOTES.md`](./CLIENT_NOTES.md) — 클라이언트 구현 노트 (규범 계약은 platform 저장소의 `SPEC.md`)
- [`docs/architecture.md`](./docs/architecture.md) — 프로세스와 데이터 경로
- [`docs/local-channel-protocol.md`](./docs/local-channel-protocol.md) — Driver RPC
- [`docs/outbox.md`](./docs/outbox.md) — 내구성·재시도·용량 정책
- [`docs/acceptance-tests.md`](./docs/acceptance-tests.md) — 수용 기준과 검증 상태
- [`TUI_DESIGN.md`](./TUI_DESIGN.md) — TUI 화면·운영 계약

Wire contract는 공개 저장소 `sir-mirr/agent-mesh-contracts`의 immutable Git tag를 사용합니다. npm registry publish는 필수가 아니며, 현재 client는 `v0.7.5`에 고정돼 있습니다. 계약의 소유자는 platform 쪽이며 client는 tag를 고정해 소비만 합니다.

Hub RPC 실패는 숫자 코드로 재시도 정책을, `error.data.code` 문자열로 어떤 조건이었는지를 판정합니다. 하나의 숫자를 여러 조건이 공유하므로 둘 다 필요합니다. 분류되지 않은 코드의 처리는 호출 지점이 정합니다 — outbox가 뒤에 있는 감사 경로는 `errorClass(code, "transient")`, 나중에 비울 것이 없는 connect·send 경로는 `"permanent"`입니다.
