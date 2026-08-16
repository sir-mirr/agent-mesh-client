# Daemon Control Plane v0.1

> 상태: v0.1 implemented

TUI와 CLI는 데몬을 직접 호출하지 않는다. 둘 다 control socket에 JSON-RPC 2.0 over NDJSON으로 요청하고, 데몬만이 lane state, Hub connection, runtime process를 소유한다.

```text
control socket: <runtime-dir>/control.sock   (0700 디렉터리, 사용자 전용)
```

lane별 channel socket과는 다른 소켓이다. channel socket은 driver가 붙는 곳이고, 이것은 운영 도구가 붙는 곳이다.

## 1. 메서드

| Method | Params | 용도 |
|---|---|---|
| `config.reload` | — | 저장된 config를 다시 읽고 lane을 생성·중지·재구성한다 |
| `config.get` | — | 현재 적용된 config |
| `daemon.shutdown` | — | 데몬 종료 |
| `lane.list` | — | lane별 hub·runtime·outbox·channel 상태 |
| `hub.status` | — | lane별 Hub 연결, fingerprint, key status |
| `outbox.summary` | `lane_id` | pending/retry/dead-letter/acked와 Blob 사용량 |
| `outbox.replay` | `lane_id`, `event_ids?` | dead-letter를 큐로 되돌린다 ([`outbox.md`](./outbox.md)) |
| `mesh.send` | `lane_id`, `to`, `content`, `reply_to?`, `client_message_id?` | mesh 전송 |
| `mesh.list_agents` | `lane_id` | Hub가 아는 참여자 |
| `mesh.inbox` | `lane_id`, `limit?` | runtime turn 원문 |
| `runtime.observe` | `lane_id`, `limit?` | **redacted** turn 상태. 본문 대신 글자 수 |
| `runtime.start` | `lane_id`, `resume?` | Claude 세션을 다시 세운다 |
| `runtime.claim` | `lane_id` | 다음 turn을 RUNNING으로 가져간다 |
| `runtime.reply` | `lane_id`, `turn_id`, `text` | turn 응답 |
| `runtime.fail` | `lane_id`, `turn_id`, `error_code` | turn 실패 기록 |

## 2. `runtime.observe`가 별도로 있는 이유

`mesh.inbox`는 본문을 돌려준다. 관찰 화면은 사람이 보는 터미널에 뜨고 그 터미널을 볼 수 있는 사람은 운영자만이 아니므로, prompt 본문·모델 출력·reasoning·auth code가 거기 있으면 안 된다(`OBS-001`).

redaction을 렌더러가 아니라 데몬에서 하는 것이 요점이다. 본문이 소켓을 건너간 뒤 화면에서 버려지는 구조라면, 그리는 쪽의 버그 하나로 새어나간다. `runtime.observe`는 애초에 글자 수만 돌려주므로 샐 것이 없다.

## 3. `runtime.start`

`/exit` 등으로 CLI가 끝나면 tmux 세션은 남지 않는다. 그 상태의 attach는 붙을 대상이 없으므로, 세션을 다시 세우는 것이 attach가 해야 하는 일이다(`RUN-007`).

```text
resume=true   (기본) CLI가 이전 대화를 이어간다
resume=false  운영자가 새 세션을 명시적으로 골랐을 때만
```

데몬 자신이 lane을 복원할 때 — 부팅, `config.reload`, 재활성 — 는 항상 이어간다(`RUN-005`). mesh 상대는 identity로 부르므로, 빈 세션으로 돌아온 lane은 상대가 말하던 그 이름의 낯선 상대다.

Claude lane 전용이다. Codex는 세션 본체가 app-server라 재기동 개념이 다르고, Antigravity는 상주 세션 자체가 없다.

## 3.1 Codex thread 공유

Codex lane의 attach는 `mesh.inbox`로 lane이 마지막으로 처리한 `conversationId`를 찾고, app-server의 `thread/loaded/list`에 그것이 살아 있는지 확인한 뒤 `codex --remote unix://<sock> resume <thread-id>`로 뷰어를 연다.

데몬은 lane 기동과 함께 대화를 하나 열어 둔다 — 이전 대화가 있으면 그것을 `thread/resume`하고, 없을 때만 새로 시작한다(`RUN-005`). 그래서 메시지가 한 번도 오간 적 없는 lane에도 붙을 대화가 있고, "turn을 먼저 흘려야 attach가 쓸모 있다"는 순서 규칙이 없다. 그 thread id는 `lane.list`의 `runtime_status.threadId`로 보고된다.

데몬이 뷰어의 thread를 대신 채택하지는 않는다. peer와의 대화는 history를 갖고 있고, 사람이 열어둔 thread를 그 대화로 삼으면 수동 작업 맥락이 peer 대화에 섞인다.

`thread/list`가 아니라 `thread/loaded/list`여야 한다 — 전자는 저장된 세션이고 실행 중인 thread는 안 보인다. 그리고 loaded 목록에는 뷰어가 종료된 thread도 남는데 그쪽은 rollout이 없어 resume이 `-32600`으로 실패하고 pane이 죽는다. 그래서 id는 데몬의 turn 기록에서 얻고, loaded 목록은 살아 있는지 확인하는 데만 쓴다.

## 4. 오류

메서드는 실패를 JSON-RPC error로 돌려준다. lane을 지정하는 메서드는 알 수 없는 `lane_id`를 거부하며, 없는 lane을 만들지 않는다.

Hub RPC 실패 코드의 분류와 재시도 정책은 이 소켓이 아니라 `@agent-mesh/contracts`가 정한다 — [`../README.md`](../README.md)의 에러 계약 절을 따른다.
