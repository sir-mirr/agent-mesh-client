# v0.1 추적 가능 요건

> 상태: Frozen

이 문서는 수용 테스트와 설계 문서가 참조할 안정적인 requirement ID를 정의한다. 구체적인 수치와 우선순위는 [`../CLIENT_NOTES.md`](../CLIENT_NOTES.md)가 우선하며, 그 위의 규범 계약은 platform 저장소의 `SPEC.md`다.

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
| `RUN-001` | MUST | Claude lane은 사람 입력 없이 기동해야 한다. CLI가 요구하는 첫 실행 게이트 — workspace 신뢰, development channel 경고, channel tool 권한 — 를 데몬이 처리해야 하며, 그 셋 외의 질문에는 응답하면 안 된다. |
| `RUN-002` | MUST | 데몬은 development channel 경고와 workspace 신뢰 프롬프트에만 tmux 키 입력으로 응답해야 한다. 판정은 선택 커서가 화면에 있을 때만 하며, 경과 시간으로 추측하면 안 된다. |
| `RUN-003` | MUST | channel tool 권한은 기동 인자로 미리 허용해야 한다. lane이 첫 회신에서 권한 대화상자에 막히면 안 된다. |
| `RUN-004` | MUST | inbound mesh 메시지는 runtime 세션에 자동으로 전달되어야 한다. 세션이 조회해야만 보이는 상태를 전달로 취급하면 안 된다. |
| `RUN-005` | MUST | 데몬이 Claude runtime을 재기동할 때(부팅, config reload, 재활성) 이전 대화를 이어야 한다. 운영자가 명시적으로 새 세션을 고른 경우에만 비워야 한다. |
| `RUN-006` | MUST | runtime 기동 대기는 세션이 더 이상 입력을 요구하지 않는 시점에 끝나야 한다. 고정 시간 대기로 대체하면 안 된다. |
| `UX-009` | MUST | tmux 세션 이름은 `mesh-lane-<identity>`여야 한다. 이름이 이미 점유돼 있으면 그 세션에 붙지 말고 오류를 보여야 한다. |
| `UX-010` | MUST | attach의 runtime별 동작은 TUI와 CLI가 같아야 한다. |
| `RUN-007` | SHOULD | runtime 세션이 종료된 lane에서 attach는 세션을 다시 세울 수 있어야 하며, 이전 대화 이어가기와 새로 시작하기를 키보드로 고르게 해야 한다. |
| `AUD-005` | MUST | 분류되지 않은 Hub 에러코드는 계약의 `errorClassOf`로 판정해야 한다. 호출 지점이 임의로 재시도 쪽 기본값을 고르면 안 된다 — 아무도 풀 수 없는 거부를 무한 재시도하는 동안 모든 구성요소가 정상으로 보고한다. |
| `RUN-009` | MUST | 상주 프로세스가 없는 runtime의 상태는 turn 상태에서 파생해야 한다. turn을 처리 중인 lane과 할 일이 없는 lane이 같은 상태로 표시되면 안 된다. |
| `RUN-008` | MUST | 사람 입력을 기다리는 runtime은 `awaiting-input`으로 구분되고 화면의 질문을 함께 보고해야 한다. 진행 중인 turn과 같은 상태로 표시하면 안 된다. |
| `OBS-004` | SHOULD | 상주 프로세스가 없는 runtime이라도 대화가 남으면 attach는 그 대화를 열어야 한다. |
| `OBS-001` | SHOULD | 본문을 노출하면 안 되는 경우를 위해 redacted 관찰 화면을 제공해야 한다. 본문·reasoning·auth code는 데몬 밖으로 내보내면 안 되고 크기만 보고해야 한다. |
| `OBS-002` | SHOULD | 데몬이 구동하는 Codex app-server에 운영자가 같은 세션으로 붙을 수 있어야 한다. 뷰어는 데몬이 실제로 돌리는 thread를 열어야 하며, 붙을 thread가 없으면 빈 뷰어를 열지 말고 그 사실을 알려야 한다. |
| `OBS-003` | MUST | 세션을 갖는 runtime은 lane 기동과 함께 세션과 대화를 세워야 한다. 이전 대화가 있으면 이어야 하고, 붙을 대화의 존재가 트래픽 도착에 의존하면 안 된다. |
| `UX-006` | MUST | 비활성 lane의 Hub·Key 상태를 미설정이나 불명으로 표시하면 안 된다. 연결하지 않은 상태와 잘못 설정된 상태는 구분되어야 한다. |
| `UX-007` | MUST | 데몬 reload를 수반하는 TUI 동작은 진행 표시를 보여야 한다. 화면이 멈춘 채로 두면 안 된다. |
| `SEC-005` | MUST | provisioning 응답의 `key` 객체를 자기 키가 기록됐다는 증거로 삼으면 안 된다. 등록 후 `/keys`로 자기 지문이 그 identity에 실제로 올라왔는지 확인해야 한다. |
| `SEC-004` | MUST | 되찾는 identity의 등록 type과 요청한 runtime이 다르면 멈추고 사람에게 물어야 한다. 로컬 값을 조용히 쓰거나 Hub의 type을 덮어써서 맞추면 안 된다 — 후자는 그 identity의 과거 감사 기록을 소급해 다른 runtime으로 표시한다. |
| `UX-008` | MUST | lane 제거는 Mesh identity가 Hub에 남는다는 것과, 이 호스트의 키가 있는 한 다시 추가할 수 있다는 것을 결정 전에 알려야 한다. |
| `SEC-001` | MUST | provider token과 identity private key를 감사 payload·일반 로그·진단 export에서 제거해야 한다. |
| `SEC-002` | MUST | lane identity는 Ed25519 key와 Hub 승인 상태를 사용해야 한다. |
| `SEC-003` | MUST | 신규 lane은 Mesh 전체 identity 중복을 사전 조회하고 원자적 create-only 등록을 사용해 기존·삭제 identity와 key를 변경하면 안 된다. |
| `UX-001` | MUST | YAML, UDS와 내부 port를 직접 편집하지 않고 첫 lane을 실행할 수 있어야 한다. |
| `UX-002` | MUST | 모든 필수 TUI 작업에 non-interactive CLI가 있어야 한다. |
| `UX-003` | MUST | 사람에게 보이는 TUI는 Agent를 최상위 관리 대상으로 사용하고 내부 Lane 용어를 노출하지 않아야 한다. |
| `UX-004` | MUST | TUI 하위 화면과 wizard는 Esc로 상위 화면에 돌아가야 한다. Overview에서는 Esc가 아무 동작도 하지 않아야 하며 종료는 Quit 항목으로만 이뤄져야 한다. Backspace는 문자 삭제 전용이며 화면을 벗어나면 안 된다 — 마지막 글자를 지운 뒤의 Backspace가 화면을 닫는 사고가 반복됐다. |
| `UX-005` | MUST | TUI는 존재하는 Agent/Channel만 선택하게 하고 대상이 없으면 enable/disable/remove 같은 적용 불가능한 action을 숨겨야 한다. |
| `DIST-001` | MUST | 최종 사용자는 Bun/Node/npm 없이 standalone binary를 설치할 수 있어야 한다. |
| `CON-001` | MUST | Hub contract를 immutable public Git tag로 고정해야 한다. |
| `CON-002` | MUST | 계약의 `E2E_SCENARIOS`를 그대로 재생할 수 있어야 한다. 러너는 자체 expectation을 두면 안 되고, 시나리오가 요구하지 않은 필드를 요청에 넣어서도 안 된다 — 그 순간 이쪽의 green과 저쪽의 green이 다른 뜻이 된다. 수행할 수 없는 verb는 verb 단위로 건너뛰고 보고해야 하며, 시나리오 전체를 건너뛰면 안 된다. |
| `CON-003` | MUST | 시나리오 재생은 clean mesh에서 순서대로 이뤄져야 하고, `mesh` 요구가 있는 시나리오는 그 조건의 mesh를 따로 세워야 한다. 시나리오끼리 identity를 공유하므로 개별 실행을 전제하면 안 되고, 기본 조건으로 대신 돌리면 정상 동작에서 실패한다. |
| `CON-004` | MUST | 재생 결과의 불일치는 계약 결함으로 플랫폼에 보고해야 한다. 클라이언트가 기대값을 맞추거나 플랫폼 코드를 고쳐서 통과시키면 안 된다. |
| `CON-005` | MUST | 재생 결과는 무엇에 대고 돌렸는지(플랫폼 worktree·commit·branch·dirty)를 함께 보고해야 한다. 출처를 말할 수 없는 결과로 불일치를 제기하면 안 된다 — 40커밋 뒤진 feature worktree를 상대로 이미 고쳐진 결함을 확신 있게 보고한 적이 있다. |
| `CON-006` | MUST | 시나리오의 `mesh` 요구는 하니스 인자로 요청하고, 하니스가 실제로 적용했다고 보고한 값과 대조해야 한다. 환경변수로 우회하거나 요청만 하고 확인하지 않으면, 조건에 도달하지 못한 시나리오가 통과로 남는다. |
| `CON-007` | MUST | step의 기대값 검사는 동사마다 복제하지 말고 한 지점에서 해야 한다. 계약에 검사 항목이 늘었을 때 일부 동사만 배우면, 검사되지 않는 단언이 green으로 남는다 — 플랫폼 러너에서 실제로 일어난 실패다. |
| `CON-008` | MUST | `{{name}}` 치환은 평가가 아니어야 하고, 바인딩이 없는 이름은 원문을 남기지 말고 실패해야 한다. `DELETE /api/v1/outbox/{{taken}}`가 그대로 전송되면 404가 나는데, 그건 뒤 step이 정당하게 기대하는 상태라서 누락이 통과로 읽힌다. |
