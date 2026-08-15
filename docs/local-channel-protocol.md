# Local Channel RPC v0.1

> 상태: v0.1 implemented
>
> 소유 저장소: `agent-mesh-client`

## 1. Transport와 framing

- lane별 Unix Domain Socket의 지속 duplex byte stream을 사용한다.
- encoding은 UTF-8, protocol은 JSON-RPC 2.0, framing은 NDJSON이다.
- 각 JSON document 뒤에 LF(`0x0A`) 하나를 붙인다. JSON string 내부 newline은 JSON escape를 사용한다.
- 직렬화된 JSON document는 LF를 제외하고 최대 `10485760 bytes`다.
- 양 끝은 buffer 단계에서 상한을 강제한다. 상한을 넘은 frame은 처리하지 않고 연결을 종료하며 진단 가능한 local error를 기록한다.
- binary/base64 attachment payload는 frame에 넣지 않는다.
- JSON-RPC request ID는 string을 사용한다. Driver는 `drv_<UUIDv7>`, daemon은 `mesh_<UUIDv7>` prefix를 권장한다.

## 2. Socket 보호

- runtime directory는 `0700`, socket은 `0600`이어야 한다.
- daemon은 가능한 OS에서 peer credential이 현재 사용자와 같은지 확인해야 한다.
- lane ID를 socket filename에 그대로 넣지 않고 안정된 짧은 hash를 사용한다.
- stale socket은 listener 부재를 확인한 뒤에만 제거한다.
- v0.1에서 별도 local bearer token을 추가할지는 [`open-questions.md`](./open-questions.md)에 남아 있다.

## 3. 등록 handshake

Driver가 연결한 뒤 보내는 첫 request는 반드시 `channel.register`여야 한다.

```json
{
  "jsonrpc": "2.0",
  "id": "drv_0198...",
  "method": "channel.register",
  "params": {
    "protocol_version": "0.1",
    "lane_id": "agent-a",
    "driver_instance_id": "discord-main-0198...",
    "provider": "discord",
    "account_ref": "opaque-account-ref",
    "staging_root": "/user-private-runtime/agent-mesh/staging/discord-main",
    "capabilities": [
      "message.receive",
      "message.send",
      "reaction.receive",
      "typing.send"
    ]
  }
}
```

성공 응답은 협상된 version과 제한을 반환한다.

```json
{
  "jsonrpc": "2.0",
  "id": "drv_0198...",
  "result": {
    "protocol_version": "0.1",
    "max_frame_bytes": 10485760,
    "max_attachment_bytes": 104857600,
    "max_attachments_per_event": 32,
    "max_attachment_total_bytes": 268435456,
    "capabilities": ["message.receive", "message.send"]
  }
}
```

- 등록 전 다른 method를 보내면 `CHANNEL_NOT_REGISTERED`로 거부하고 연결을 종료한다.
- `driver_instance_id`는 전역적으로 안정된 opaque ID이며 삭제 뒤 재사용하지 않는다.
- 연결 교체 시 같은 instance가 새 connection으로 재등록할 수 있지만 daemon은 이전 connection을 drain 또는 종료하고 하나만 active로 둔다.
- provider token은 handshake나 이후 payload에 넣지 않는다.

## 4. 공통 참조

Conversation은 provider 고유 ID를 opaque string으로 보존한다.

```json
{
  "account_ref": "opaque-account-ref",
  "conversation_ref": "opaque-channel-or-dm-ref",
  "thread_ref": "optional-opaque-thread-ref"
}
```

Inbound attachment는 Driver staging file을 참조한다.

```json
{
  "attachment_id": "provider-attachment-id",
  "filename": "report.pdf",
  "media_type": "application/pdf",
  "size": 42013,
  "sha256": "lowercase-hex",
  "local_path": "/registered-staging-root/0198.../report.pdf"
}
```

- `local_path`는 등록한 `staging_root` 아래의 absolute path여야 한다.
- daemon은 symlink가 아닌 regular file인지 확인하고 open한 동일 file descriptor에서 크기와 SHA-256을 다시 계산해야 한다.
- daemon은 검증한 bytes를 lane Blob spool로 복사·fsync한 뒤에만 inbound ACK할 수 있다.
- Driver는 성공 ACK 전 staging file을 삭제하면 안 된다.
- outbound attachment는 daemon이 만든 turn/action별 read-only view의 path와 동일 metadata를 Driver에 전달한다.

## 5. Driver → Lane Controller methods

### `channel.message.received`

notification이 아니라 request로 보내 durable ACK를 받아야 한다.

```json
{
  "jsonrpc": "2.0",
  "id": "drv_0198...",
  "method": "channel.message.received",
  "params": {
    "driver_instance_id": "discord-main-0198...",
    "provider_event_id": "opaque-event-id",
    "provider_message_id": "opaque-message-id",
    "occurred_at": "2026-08-15T09:00:00.000Z",
    "conversation": {
      "account_ref": "opaque-account-ref",
      "conversation_ref": "opaque-conversation-ref",
      "thread_ref": null
    },
    "sender": {
      "sender_ref": "opaque-user-ref",
      "display_name": "untrusted display name"
    },
    "text": "hello",
    "attachments": [],
    "reply_to_provider_message_id": null
  }
}
```

성공 응답:

```json
{
  "jsonrpc": "2.0",
  "id": "drv_0198...",
  "result": {
    "accepted": true,
    "inbound_id": "in_0198...",
    "audit_event_id": "aud_0198...",
    "duplicate": false
  }
}
```

`accepted: true`는 본문, correlation과 모든 attachment가 local durable storage에 기록되었다는 뜻이다. Runtime 처리 또는 Hub ACK 완료를 뜻하지 않는다. 같은 provider identity와 event/message ID의 재전송은 같은 결과를 반환하고 중복 runtime turn을 만들면 안 된다.

### 그 밖의 inbound methods

v0.1 namespace는 다음을 예약한다.

```text
channel.reaction.received
channel.message.updated
channel.message.deleted
```

Discord v0.1에서 실제 지원할 최소 capability는 동결 전 확정한다. 지원하지 않는 method에는 `METHOD_NOT_SUPPORTED`를 반환한다.

## 6. Lane Controller → Driver methods

```text
channel.message.send
channel.message.edit
channel.message.delete
channel.reaction.add
channel.typing.set
```

`channel.message.send`의 개념 payload는 다음과 같다.

```json
{
  "jsonrpc": "2.0",
  "id": "mesh_0198...",
  "method": "channel.message.send",
  "params": {
    "driver_instance_id": "discord-main-0198...",
    "action_id": "act_0198...",
    "conversation": {
      "account_ref": "opaque-account-ref",
      "conversation_ref": "opaque-conversation-ref",
      "thread_ref": null
    },
    "reply_to_provider_message_id": "opaque-message-id",
    "text": "final response",
    "attachments": []
  }
}
```

- Lane Controller는 provider 호출 전 outbound intent와 attachment를 durable outbox에 기록해야 한다.
- Driver는 `action_id`를 idempotency key로 사용하고 같은 action 재수신 시 provider로 중복 전송하지 않아야 한다.
- 성공 result는 `provider_message_id`, provider timestamp와 `duplicate` 여부를 반환한다.
- Lane Controller는 provider result를 별도 delivery outcome으로 내구성 있게 기록한다.
- 실패 result는 retryable 여부와 provider secret을 제거한 오류를 반환한다.

## 7. 오류

JSON-RPC 표준 오류와 다음 local data를 사용한다.

| code | `data.code` | 의미 |
|---:|---|---|
| `-32050` | `CHANNEL_NOT_REGISTERED` | 첫 handshake 누락 |
| `-32051` | `CHANNEL_PROTOCOL_UNSUPPORTED` | version 협상 실패 |
| `-32052` | `CHANNEL_CAPABILITY_UNSUPPORTED` | method/capability 미지원 |
| `-32053` | `CHANNEL_ATTACHMENT_INVALID` | path, size, hash 또는 정책 오류 |
| `-32054` | `CHANNEL_DURABILITY_FAILED` | outbox/Blob durable write 실패 |
| `-32055` | `CHANNEL_BACKPRESSURE` | local storage 또는 queue 수락 불가 |
| `-32056` | `CHANNEL_PROVIDER_FAILED` | provider action 실패 |

오류 `data`에는 `code`, `retryable`, 선택 `retry_after_ms`와 redacted detail만 넣는다. token, Authorization header, 원본 secret path는 넣지 않는다.

이 코드들은 `-32040`부터 시작했고 mesh의 audit 코드 5개와 숫자가 겹쳤다. 두 어휘 모두 JSON-RPC이고 한 프로세스 안에서 만나므로 겹친 번호는 오류가 아니라 **재분류**를 일으킨다 — `-32043`은 여기선 "영구히 잘못된 첨부"였고 mesh에선 "Hub busy, 재시도"였다. `@agent-mesh/contracts` v0.7.5가 구간을 나눠 mesh는 `-32049 … -32000`만 할당하고 그 위는 비워 두기로 했으므로, 이 프로토콜은 `-32099 … -32050`을 쓴다. 공개 release 이전의 변경이라 protocol_version은 `0.1` 그대로 두었다.

## 8. 연결과 drain

- connection loss 뒤 Driver는 exponential backoff와 jitter로 같은 instance ID를 재등록한다.
- disable/remove는 신규 inbound 수락과 신규 outbound dispatch를 먼저 멈추고 in-flight request를 drain한다.
- graceful drain 기본 timeout 수치는 아직 확정되지 않았다.
- config 제거, Driver process 제거와 secret 삭제는 별도 transaction이다.
- 미ACK outbox와 Blob은 Driver 제거와 무관하게 보존한다.
