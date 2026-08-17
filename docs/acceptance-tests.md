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
| `AT-023` | `UX-003`, `UX-004`, `UX-005` | Agent 0개에서도 빈 Overview와 `+ Add Agent`부터 표시하고, Agent 목록을 직접 탐색하며, Esc로 복귀하고, Channel이 없을 때 적용 불가능한 action을 표시하지 않는다. |
| `AT-024` | `OPS-004` | 축소된 launchd/systemd 환경에서도 명시적 service PATH로 tmux와 선택 Runtime CLI를 발견한다. |
| `AT-025` | `RUN-001`, `RUN-002`, `RUN-003` | 신뢰·승인 상태가 없는 workspace에서 lane을 기동하면 프롬프트가 화면에 남지 않고, MCP 서버가 뜨며, 첫 회신이 권한 대화상자에 막히지 않는다. |
| `AT-026` | `RUN-004` | 상대 lane이 보낸 mesh 메시지가 Claude 세션 화면에 자동으로 나타나고, 세션에 조회를 요청하지 않아도 회신이 나간다. |
| `AT-027` | `RUN-005` | `/exit` 후 disable·enable을 거쳐도 재기동된 세션이 이전 대화를 잇는다. |
| `AT-028` | `RUN-006` | 게이트가 하나만 나타나는 workspace에서도 기동이 고정 대기 없이 끝난다. |
| `AT-029` | `RUN-007` | 세션이 없는 Claude lane에서 attach가 이어가기/새로 시작을 묻고, 고른 대로 세션을 세운 뒤 붙는다. |
| `AT-030` | `RUN-008` | 승인 대기 중인 runtime이 `awaiting-input`과 화면의 질문을 보고하고, 응답 후 `running`으로 돌아온다. |
| `AT-031` | `OBS-001` | Antigravity lane의 관찰 화면이 turn 상태와 글자 수만 보이고 본문을 보이지 않는다. |
| `AT-032` | `OBS-002` | Codex lane에 attach하면 데몬이 돌리는 thread가 열리고, 그 뒤 도착한 mesh turn과 응답이 관찰 화면에 나타난다. |
| `AT-033` | `UX-006`, `UX-007` | 비활성 lane이 Hub·Key를 미설정/불명으로 표시하지 않고, enable·disable·remove가 진행 표시와 함께 끝난다. |
| `AT-034` | `UX-008`, `SEC-003` | lane 제거 확인 화면이 identity 잔존과 재추가 조건을 알리고, 같은 키를 가진 호스트에서 재추가가 승인 없이 복구된다. |
| `AT-042` | `AUD-005` | mesh 대역 안의 미할당 코드는 dead-letter로, 대역 밖 코드는 재시도로 처리한다. |
| `AT-043` | `CON-002` | `E2E_SCENARIOS` 전체가 재생되고, `expectStored`는 verb 단위 skip으로 보고된다. 러너가 구현하지 않은 verb는 통과가 아니라 실패로 보고된다. |
| `AT-044` | `CON-003` | `receiveLeaseSeconds`를 요구하는 시나리오는 그 lease의 별도 mesh에서 돌아 lease 만료 후 재전달과 ack 이후 소멸을 모두 보인다. |
| `AT-045` | `CON-004` | 불일치가 나온 시나리오는 실패로 남고, 통과시키기 위한 요청 변형이 러너에 들어가지 않는다. |
| `AT-041` | `SEC-005` | 등록 응답이 승인된 key를 돌려주더라도 그 지문이 `/keys`에 없으면 lane이 연결로 진행하지 않고 conflict로 멈춘다. |
| `AT-040` | `SEC-004` | 등록된 identity를 다른 runtime으로 되찾으려 하면 두 type을 밝히며 멈추고, 맞는 runtime으로는 되찾아진다. Hub 쪽 type은 어느 경우에도 덮어쓰지 않는다. |
| `AT-039` | `OBS-004` | Antigravity lane에 attach하면 lane이 쓰던 대화가 이력과 함께 열리고, 열린 채로 도착한 turn도 저장돼 다시 열었을 때 보인다. |
| `AT-038` | `RUN-009` | Codex/Antigravity lane이 turn 대기 중 `queued`, 처리 중 `running`, 없을 때 `idle`을 보고한다. |
| `AT-037` | `OBS-003`, `RUN-005` | Codex lane을 disable 후 enable하면 mesh 트래픽 없이도 attach되고, 열린 대화가 이전 대화이며, 이후 도착한 turn이 같은 화면에 나타난다. |
| `AT-036` | `UX-009`, `UX-010` | 세 runtime 모두 TUI와 CLI에서 같은 방식으로 attach되고, 세션 이름이 `mesh-lane-<identity>`이며, 점유된 이름에는 붙지 않고 오류를 보인다. |
| `AT-035` | `AUD-002` | dead-letter된 event를 `outbox replay`로 다시 큐에 넣으면 첨부 확인 여부에 따라 blob 단계부터 또는 append부터 재개하고, ACKED가 아닌 event만 대상이 된다. |

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
