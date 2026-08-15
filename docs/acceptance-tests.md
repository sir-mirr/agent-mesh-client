# v0.1 수용 테스트

> 상태: v0.1 release-candidate verification

각 시나리오는 [`requirements.md`](./requirements.md)의 requirement ID를 추적한다.

| ID | 추적 | 수용 시나리오 |
|---|---|---|
| `AT-001` | `ARCH-001`, `OPS-001` | 여러 lane을 시작해도 daemon process는 하나이며 systemd user/launchd가 재시작한다. |
| `AT-002` | `OPS-002` | TUI 종료와 tmux detach 후 daemon, Driver와 outbox worker가 계속 동작한다. |
| `AT-003` | `CHAN-001` | 여러 Driver가 lane UDS에 등록하고 한 연결에서 양방향 JSON-RPC를 처리한다. |
| `AT-004` | `CHAN-002` | 정확히 10 MiB payload는 처리하고 초과 payload는 거부·연결 종료한다. attachment bytes/base64 frame은 거부한다. |
| `AT-005` | `CHAN-003`, `AUD-003` | fsync/DB commit 전 process kill에서는 ACK가 없고, commit 뒤 ACK된 event는 restart 후 복구된다. |
| `AT-006` | `CHAN-004` | provider 성공 뒤 response 유실/driver reconnect가 발생해도 같은 action ID가 중복 메시지를 만들지 않는다. |
| `AT-007` | `AUD-001`, `AUD-002` | Hub를 중단한 동안 channel round-trip은 계속되고 본문/첨부가 outbox에 남아 복구 후 적재된다. |
| `AT-008` | `AUD-004` | Blob 성공 후 append/ACK 유실 상황에서 같은 event ID를 재전송하고 local payload를 조기 삭제하지 않는다. |
| `AT-009` | `BLOB-001` | 같은 bytes/extension은 한 Blob으로 dedup하고 같은 bytes라도 정규화 extension이 다르면 별도 key를 허용한다. |
| `AT-010` | `BLOB-002`, `BLOB-003` | 100 MiB/file, 32 files, 256 MiB/event와 180초 timeout 경계를 검증하고 실패 시 전체 재업로드한다. |
| `AT-011` | `OPS-003` | 실행 중 channel add/disable/enable/remove가 runtime과 다른 Driver를 재시작하지 않는다. |
| `AT-012` | `OPS-003`, `AUD-002` | Driver remove와 secret remove가 기존 outbox/dead-letter/Hub audit를 삭제하지 않는다. |
| `AT-013` | `RUN-002` | 모델 출력이 target을 위조해도 원 immutable source/reply_to로만 응답한다. |
| `AT-014` | `AGY-001`, `AGY-002` | Antigravity turn마다 child 하나만 실행되고 30분 timeout 뒤 process group과 late output이 정리된다. |
| `AT-015` | `AGY-003` | 50턴을 넘겨도 turn-count만으로 conversation을 reset하지 않는다. |
| `AT-016` | `AGY-004` | 설치 사용자가 선택한 Antigravity policy가 argv에 반영되고 완화 policy 경고가 유지된다. |
| `AT-017` | `RUN-001` | Claude/Codex/Antigravity가 같은 Channel envelope, outbox와 Hub contract fixture를 통과한다. |
| `AT-018` | `SEC-001` | log, audit, diagnostics와 observer에서 provider token, private key, auth code와 reasoning이 검출되지 않는다. |
| `AT-019` | `SEC-002`, `CON-001` | key pending/approved/revoked, freshness, nonce replay와 upload signature fixture를 통과한다. |
| `AT-020` | `UX-001`, `UX-002` | YAML/UDS/port 수동 편집 없이 TUI와 동등 CLI로 첫 lane을 생성·기동한다. |
| `AT-021` | `DIST-001` | Bun/Node/npm이 없는 지원 OS에서 release binary와 installer로 설치·doctor를 완료한다. |
| `AT-022` | `SEC-003` | 등록된 Identity takeover를 `IDENTITY_EXISTS`로 거부하고 원 key set이 불변이며, 동일 persisted key를 가진 daemon restart만 재연결한다. |

## 실행된 검증

2026-08-15 기준 다음 검증을 통과했습니다.

- `bun run check`: TypeScript 7 strict/exact optional 검사
- `bun test`: framing, config, outbox/Blob, Driver RPC, daemon UDS, reply-loop guard, Codex/Antigravity transport fixture
- `bun run test:e2e:live`: 실제 platform harness에서 key pending/approve, atomic Identity takeover 거부와 restart key reuse, signed 한글 params, `client_message_id` duplicate, mesh reply guard, channel attachment, Blob PUT, 3종 audit final ACK와 admin query
- Claude Code 2.1.116 + tmux 3.6a live smoke: development channel inbound → 모델 turn → MCP `reply` → immutable provider correlation
- Codex CLI App Server live smoke: signed mesh inbound → authoritative final agent message → Hub reply
- Antigravity CLI 1.1.13 live smoke: `--print <prompt> --output-format json` → `SUCCESS` envelope/conversation ID/final response
- `bun run build`와 standalone `bun run compile`, compiled `doctor/--help`

Live Hub 시나리오는 [`../e2e/scenarios/live-hub.json`](../e2e/scenarios/live-hub.json), 실행 코드는 [`../scripts/e2e-live.ts`](../scripts/e2e-live.ts)에 있습니다. Discord REST/Gateway는 credential을 CI에 저장하지 않으므로 protocol/supervision은 자동 검사하고 실제 bot credential smoke는 설치 운영자의 staging gate로 둡니다.
