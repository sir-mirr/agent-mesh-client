# v0.1 추적 가능 요건

> 상태: Frozen

이 문서는 수용 테스트와 설계 문서가 참조할 안정적인 requirement ID를 정의한다. 구체적인 수치와 우선순위는 [`../SPEC.md`](../SPEC.md)가 우선한다.

| ID | 등급 | 요건 |
|---|---|---|
| `ARCH-001` | MUST | 호스트당 `agent-meshd` process는 하나여야 한다. |
| `ARCH-002` | MUST | lane별 identity, connection, UDS, outbox, Blob과 runtime state를 논리적으로 격리해야 한다. |
| `ARCH-003` | MUST | Channel 실시간 경로는 Hub를 우회하고 감사와 mesh 경로만 Hub를 사용해야 한다. |
| `OPS-001` | MUST | Linux는 systemd user, macOS는 launchd user service로 daemon을 관리해야 한다. |
| `OPS-002` | MUST | TUI/terminal/tmux 종료가 daemon을 종료하면 안 된다. |
| `OPS-003` | MUST | channel driver instance를 lane 재시작 없이 hot add/disable/enable/remove할 수 있어야 한다. |
| `OPS-004` | MUST | user service는 user-local, Homebrew/Linuxbrew와 설치 시 발견한 Runtime CLI 경로를 포함하는 명시적 PATH로 기동해야 한다. |
| `CHAN-001` | MUST | Channel RPC는 lane UDS의 JSON-RPC 2.0 over NDJSON이어야 한다. |
| `CHAN-002` | MUST | JSON payload frame은 최대 10 MiB이며 첨부 bytes를 포함하면 안 된다. |
| `CHAN-003` | MUST | inbound 성공 ACK는 메시지와 첨부가 durable local storage에 기록된 뒤에만 반환해야 한다. |
| `CHAN-004` | MUST | outbound action은 안정된 action ID로 재시도 중 중복 전송을 방지해야 한다. |
| `AUD-001` | MUST | 모든 channel inbound/outbound 메시지 본문과 첨부 원본을 감사해야 한다. |
| `AUD-002` | MUST | Hub 장애 중 미ACK event/Blob을 무기한 보관하고 복구 후 재시도해야 한다. |
| `AUD-003` | MUST | local outbox 기록 실패 시 신규 channel 처리를 fail-closed해야 한다. |
| `AUD-004` | MUST | Hub 최종 ACK 전 event와 참조 Blob을 삭제하면 안 된다. |
| `BLOB-001` | MUST | Blob은 lowercase SHA-256과 정규화 extension으로 식별·dedup해야 한다. |
| `BLOB-002` | MUST | 파일 100 MiB, event 32개/256 MiB, upload attempt 180초를 적용해야 한다. |
| `BLOB-003` | MUST | chunk/resume 없이 실패 시 전체 파일을 다시 업로드해야 한다. |
| `RUN-001` | MUST | Claude/Codex/Antigravity가 공통 channel, Hub, audit 계층을 재사용해야 한다. |
| `RUN-002` | MUST | reply target은 모델 출력이 아닌 immutable correlation으로 결정해야 한다. |
| `AGY-001` | MUST | Antigravity는 one-shot JSON child를 사용하고 상주 child를 두면 안 된다. |
| `AGY-002` | MUST | Antigravity turn timeout은 1800초이며 audit upload와 독립적이어야 한다. |
| `AGY-003` | MUST | Antigravity는 고정 turn 수로 conversation을 reset하면 안 된다. |
| `AGY-004` | MUST | Antigravity 보안 정책은 설치 사용자가 lane별로 선택하고 적용 상태를 확인할 수 있어야 한다. |
| `SEC-001` | MUST | provider token과 identity private key를 감사 payload·일반 로그·진단 export에서 제거해야 한다. |
| `SEC-002` | MUST | lane identity는 Ed25519 key와 Hub 승인 상태를 사용해야 한다. |
| `SEC-003` | MUST | 신규 lane은 Mesh 전체 identity 중복을 사전 조회하고 원자적 create-only 등록을 사용해 기존·삭제 identity와 key를 변경하면 안 된다. |
| `UX-001` | MUST | YAML, UDS와 내부 port를 직접 편집하지 않고 첫 lane을 실행할 수 있어야 한다. |
| `UX-002` | MUST | 모든 필수 TUI 작업에 non-interactive CLI가 있어야 한다. |
| `UX-003` | MUST | 사람에게 보이는 TUI는 Agent를 최상위 관리 대상으로 사용하고 내부 Lane 용어를 노출하지 않아야 한다. |
| `UX-004` | MUST | TUI 하위 화면과 wizard는 Esc로 상위 화면에 돌아가야 한다. Backspace는 문자 삭제 전용이며 화면을 벗어나면 안 된다 — 마지막 글자를 지운 뒤의 Backspace가 화면을 닫는 사고가 반복됐다. |
| `UX-005` | MUST | TUI는 존재하는 Agent/Channel만 선택하게 하고 대상이 없으면 enable/disable/remove 같은 적용 불가능한 action을 숨겨야 한다. |
| `DIST-001` | MUST | 최종 사용자는 Bun/Node/npm 없이 standalone binary를 설치할 수 있어야 한다. |
| `CON-001` | MUST | Hub contract를 immutable public Git tag로 고정해야 한다. |
