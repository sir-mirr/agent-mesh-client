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
| Codex | `codex` | 공식 `codex app-server --listen stdio://` |
| Antigravity | `agy` | turn마다 `agy --print --output-format json` |

## 첫 실행

```sh
agent-mesh
```

TUI가 기본값 없는 Agent Identity, runtime, workspace와 보안 profile을 받습니다. Identity는 저장 전에 Hub 전체 registry에서 중복을 조회하며 Hub에 연결할 수 없거나 조회 응답이 불명확하면 fail-closed합니다. 내부 Lane ID는 Identity에서 자동 생성되지만 사람에게 보이는 TUI에서는 Agent로 일관되게 표시합니다. 설치 시 등록된 단일 데몬은 설정 변경을 감지하며, Claude Agent는 tmux 세션까지 생성합니다. Claude 최초 실행의 workspace 신뢰와 development channel 확인은 다음 명령으로 세션에 붙어 사용자가 직접 승인합니다.

```sh
agent-mesh attach <lane-id>
```

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

- [`SPEC.md`](./SPEC.md) — v0.1 규범 스펙
- [`docs/architecture.md`](./docs/architecture.md) — 프로세스와 데이터 경로
- [`docs/local-channel-protocol.md`](./docs/local-channel-protocol.md) — Driver RPC
- [`docs/outbox.md`](./docs/outbox.md) — 내구성·재시도·용량 정책
- [`docs/acceptance-tests.md`](./docs/acceptance-tests.md) — 수용 기준과 검증 상태
- [`TUI_DESIGN.md`](./TUI_DESIGN.md) — TUI 화면·운영 계약

Wire contract는 공개 저장소 `sir-mirr/agent-mesh-contracts`의 immutable Git tag를 사용합니다. npm registry publish는 필수가 아니며, 현재 client는 `v0.7.4`에 고정돼 있습니다. 계약의 소유자는 platform 쪽이며 client는 tag를 고정해 소비만 합니다.

Hub RPC 실패는 숫자 코드로 재시도 정책을, `error.data.code` 문자열로 어떤 조건이었는지를 판정합니다. 하나의 숫자를 여러 조건이 공유하므로 둘 다 필요합니다. 분류되지 않은 코드의 처리는 호출 지점이 정합니다 — outbox가 뒤에 있는 감사 경로는 `errorClass(code, "transient")`, 나중에 비울 것이 없는 connect·send 경로는 `"permanent"`입니다.
