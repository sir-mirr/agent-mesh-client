# Codex Runtime Transport v0.1

> 상태: v0.1 implemented · Codex App Server live transport verified

- Codex도 공통 Lane Controller, Channel RPC, Hub와 outbox 계층을 사용한다.
- Runtime Transport는 Codex app-server client 역할을 한다.
- `codex app-server --listen stdio://`를 child로 실행한다.
- `initialize`/`initialized`, `thread/start|resume`, `turn/start`, `item/completed`, `turn/completed`를 처리한다.
- 최종 외부 회신은 authoritative `agentMessage` item만 사용하며 reasoning과 중간 event를 노출하지 않는다.
- unattended server request에서 approval을 대신 승인하지 않는다. lane 보안 profile을 thread 시작 정책으로 전달한다.
- Codex/app-server process가 종료돼도 daemon과 outbox는 유지한다.

검증 기준 version은 Codex CLI `0.147.0-alpha.6.5`입니다. timeout 시 `turn/interrupt` 후 child를 정리하고, conversation mapping은 lane SQLite에 저장해 다음 turn에서 resume합니다.
