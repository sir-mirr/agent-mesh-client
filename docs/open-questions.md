# v0.1 결정 기록과 후속 항목

> 상태: **v0.1 BLOCKING 없음**
>
> 최종 갱신: 2026-08-15

## 확정된 결정

| 영역 | v0.1 결정 |
|---|---|
| Outbox | lane별 SQLite WAL, `synchronous=FULL`, quota 20 GiB, 80% 경고, 95% 또는 여유 5 GiB 미만 fail-closed |
| Local RPC | 사용자 전용 directory `0700`, UDS `0600`, lane별 hash 경로, JSON-RPC 2.0 over NDJSON 10 MiB |
| Discord | receive/send, normalized payload, local durable ACK, stable action ID SQLite dedup |
| Driver lifecycle | hot add/disable/enable/remove, 예기치 않은 종료 exponential restart, 삭제 ID 영구 tombstone |
| Claude | Claude Code 2.1.116에서 stdio MCP development channel과 실제 inbound/reply 확인 |
| Codex | Codex CLI 0.147.0-alpha.6.5 공식 App Server stdio에서 start/resume/final output 확인 |
| Antigravity | `agy` 1.1.13 live one-shot JSON 확인, 30분 timeout, 고정 turn reset 없음 |
| 보안 profile | sandboxed/workspace/unrestricted; unrestricted는 명시적 risk acknowledgment 필수 |
| Contract | 공개 `sir-mirr/agent-mesh-contracts#v0.8.1`, TypeBox subpath와 byte fixtures 사용 |
| 배포 | macOS arm64/x64, Linux x64/arm64 standalone binary; GitHub Release+SHA256; 기본 `~/.local/bin` |
| Daemon | 호스트당 하나, macOS launchd/Linux systemd user service |
| Blob | SHA-256+정규 extension, 100 MiB/file, 32개/256 MiB/event, 180초 whole-file retry |

## v0.1 이후 후속 가능

- Slack/Telegram 실제 provider
- OS keychain integration
- third-party Driver package 서명·신뢰 정책
- Windows Named Pipe와 Windows user service
- lane별 bounded runtime 병렬화
- full-screen widget TUI, 검색/group과 고급 navigation
- Hub-confirmed ACK event/Blob의 운영자 선택 retention/cleanup
- Discord edit/delete/reaction/typing capability
- provider가 자체 idempotency key를 제공하지 않을 때 장기 reconcile API
- Hub mailbox dedup table의 advertised window pruning
- `mesh.receive`를 사용하는 socketless 보조 클라이언트 UX

후속 항목은 현재 v0.1의 데이터 보존·서명·wire 호환성을 약화하지 않는 범위에서 추가합니다.
