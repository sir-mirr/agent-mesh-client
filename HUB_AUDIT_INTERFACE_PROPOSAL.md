# Agent Mesh Hub 감사 적재 인터페이스 계약 개정안

> 상태: Hub 3차 회신 및 SPEC 0.2 반영 / contract `v0.3.0` 확인 / 구현 전
>
> 대상 저장소: [`sir-mirr/agent-mesh-platform`](https://github.com/sir-mirr/agent-mesh-platform)
>
> Hub 회신: [`docs/proposals/audit-ingestion-response.md`](https://github.com/sir-mirr/agent-mesh-platform/blob/main/docs/proposals/audit-ingestion-response.md)
>
> Hub 신원·인증 결정: [`docs/decisions/identity-and-authentication.md`](https://github.com/sir-mirr/agent-mesh-platform/blob/main/docs/decisions/identity-and-authentication.md)
>
> 반영 기준: Hub commit `ec74f30`, SPEC 0.2 / contract `v0.3.0`
>
> 상위 클라이언트 요건: [`REQUIREMENTS_AND_ARCHITECTURE.md`](./REQUIREMENTS_AND_ARCHITECTURE.md)

## 1. 문서 목적과 현재 결론

이 문서는 최초 제안서와 클라이언트 개정안에 대한 Hub 플랫폼의 1·2·3차 회신을 반영한 클라이언트 측 계약 기준이다. 코드 구현을 시작하는 문서가 아니며, 확정된 계약을 contract package의 schema와 fixture로 옮긴 뒤 양쪽 구현이 이를 소비한다.

3차 회신으로 unsigned identity, agent type 확장과 Blob upload wire 형식까지 해소됐다. 공개 contract `v0.3.0`도 생성됐다. 남은 항목은 protocol 결정이 아니라 runtime validation schema, 미커버 fixture, language-neutral artifact와 release 운영 정리다.

다음 방향은 수용한다.

- 채널 실시간 경로와 Hub 감사 경로를 분리한다.
- `hub-direct` 채널 전달 모드는 제거하고 Runtime Adapter 직접 전달만 지원한다.
- 채널 이벤트는 Runtime Adapter가 로컬 outbox를 거쳐 Hub에 자기 신고한다.
- mesh 메시지는 Hub가 라우팅 시점에 감사 이벤트를 직접 생산한다.
- 생산 identity는 payload가 아니라 인증된 연결에서 도출한다.
- lane별 Ed25519 키와 요청별 서명을 사용한다.
- 이벤트는 immutable하고 `event_id`로 멱등 처리한다.
- `sequence`, `mesh.audit.checkpoint`, `audit_producers`, `blobs` 테이블은 제거한다.
- Blob 저장 키는 `<sha256>[.<ext>]`이고 dedup 단위는 `(sha256, extension)`이다.
- 감사 이벤트와 첨부 참조는 `audit.db`에 한 transaction으로 저장하고 Blob bytes는 `uploads/`에 저장한다.
- 기존 데이터 마이그레이션은 범위 밖이며 빈 저장소에서 시작한다.
- Hub의 audit event와 참조 Blob은 무기한 보존한다.

## 2. 데이터 경로와 책임

### 2.1. 채널 실시간 경로

```text
Discord / Slack / Telegram Driver
                 ⇅ lane UDS
          Runtime Adapter
                 ⇅
       Claude / Codex / Antigravity
```

Hub는 채널의 실시간 전달 경로에 들어가지 않는다. Runtime Adapter가 inbound/outbound를 정규화하고, 로컬 outbox에 내구성 있게 기록한 뒤 런타임 또는 channel-driver로 전달한다.

### 2.2. 채널 감사 경로

```text
Runtime Adapter
  └─ lane별 durable outbox ──WS/HTTP──▶ Hub + agent-mesh-http
```

- 채널 이벤트의 생산자와 기록자는 인증된 Runtime Adapter다.
- Hub 장애나 감사 protocol 비호환 중에도 로컬 outbox 기록에 성공하면 채널 처리는 계속한다.
- 로컬 outbox 기록 자체가 실패하면 신규 채널 처리를 fail-closed한다.
- Hub 최종 ACK 전에는 outbox 이벤트와 첨부 원본을 삭제하지 않는다.

### 2.3. mesh 경로와 감사

```text
Runtime Adapter A ⇄ Hub ⇄ Runtime Adapter B
                       └─ audit.db에 mesh 이벤트 직접 기록
```

mesh 메시지는 Hub가 실제 데이터 경로이므로 Hub가 감사 이벤트를 한 번만 생산한다. 송신·수신 Adapter가 같은 mesh 메시지를 중복 감사하지 않는다.

초기 mesh event type은 다음과 같다.

```text
mesh.message.sent
mesh.message.delivered
mesh.message.pending
```

메시지 본문은 운영 저장소 `hub.db:messages`를 참조하지 않고 `audit_events`에 복제한다. 감사 보존기간과 운영 메시지 보존기간을 독립적으로 적용하기 위해서다. 첨부 bytes는 content-addressed `uploads/` 객체를 함께 참조하며 복제하지 않는다.

## 3. Identity와 키 수명주기

### 3.1. lane과 identity

- `lane`은 로컬 배포, 설정, tmux, 경로와 outbox의 단위다.
- `identity`는 mesh 위의 영구적인 에이전트 식별자다.
- 한 Host Daemon 안의 Lane Controller마다 독립된 identity, 키, Hub WebSocket을 가진다.
- 감사 레코드에는 `lane_id`가 아니라 Hub가 인증된 연결에서 도출한 `identity`를 기록한다.
- payload가 보낸 `identity` 값은 저자 판정에 사용하지 않는다.

### 3.2. 키 생성과 등록

- Lane Controller는 identity별 Ed25519 키쌍을 생성한다.
- 개인키는 lane secret 파일에 `0600` 권한으로 저장하고 Hub에 전송하지 않는다.
- 공개키는 identity 등록 시 제출한다.
- 공개키 raw 32 bytes는 base64url로 표현한다.
- fingerprint는 공개키에 대한 SHA-256으로 만들며 표시 형식은 contract fixture로 고정한다.
- 기동 시 identity와 fingerprint를 운영 로그와 TUI에 표시하되 개인키는 절대 노출하지 않는다.

단일 `agent-meshd` process를 사용하더라도 키는 daemon 공용이 아니라 lane identity별로 분리한다.

### 3.3. 승인 상태

```text
none → pending → approved
          └────→ denied

approved → rotation pending → approved(new) + revoked(old)
approved → revoked
```

- 등록 직후 `pending`은 오류가 아닌 정상 대기 상태다.
- `pending`, `denied`, `revoked` 상태에서는 Hub connect, mesh 송신과 감사 append를 성공한 것으로 취급하지 않는다.
- 채널 로컬 경로와 outbox 적재는 계속하고, 승인 후 자동 연결·배출한다.
- 운영자는 HTTP 관리자 화면의 fingerprint와 Adapter가 표시한 fingerprint를 대조한 뒤 승인한다.
- 같은 키 재등록은 현재 상태를 반환하는 멱등 동작이어야 한다.
- 키 교체는 기존 승인 키를 유지한 채 새 키를 `pending`으로 제안하고, 승인 시 기존 키를 폐기한다.
- 유출 키는 교체 키 승인을 기다리지 않고 즉시 폐기한다.
- identity 삭제는 과거 서명 검증과 identity 재사용 방지를 위해 soft delete로 처리한다.
- Hub는 승인 key를 connection lifetime cache에 두지 않고 요청마다 `agents.db`의 현재 key 상태를 읽는다.
- pending, denied 또는 revoked key 요청은 `-32014 KEY_NOT_APPROVED`와 `data.key_status`로 거부하고 Hub가 해당 연결을 종료한다.
- rotation 승인 후 이전 key는 다음 요청부터 실패하며 클라이언트는 새 key로만 reconnect한다. 폐기 key로 fallback하지 않는다.

## 4. 요청 서명, 원문 보존과 digest

### 4.1. JSON-RPC 서명 위치

클라이언트가 보내는 모든 JSON-RPC request는 `params`의 형제를 이루는 `sig`를 가진다.

```json
{
  "jsonrpc": "2.0",
  "id": 102,
  "method": "mesh.audit.append",
  "params": {},
  "sig": {
    "alg": "ed25519",
    "kid": "<fingerprint>",
    "nonce": "<opaque>",
    "iat": 1786780800,
    "value": "<base64url>"
  }
}
```

서명 preimage는 SPEC 0.2에서 다음으로 확정됐다.

```text
LP(x)    = uint32be(byteLength(x)) || x

preimage = "agent-mesh/sig/v1" || 0x00
         || LP(UTF8(method))
         || LP(UTF8(kid))
         || LP(UTF8(nonce))
         || LP(UTF8(decimal(iat)))
         || LP(raw params bytes)
```

- `iat`는 앞자리 0이 없는 Unix seconds 정수의 10진 문자열이다.
- `id`는 재시도마다 바뀔 수 있으므로 제외한다.
- `sig`는 결과를 담으므로 제외한다.
- domain separator와 각 `uint32be` length prefix를 정확히 fixture로 고정한다.
- Hub는 자기 시각 기준 `iat`가 `±120초`를 벗어나면 `SIGNATURE_INVALID`로 거부한다.
- Hub는 identity별로 freshness window 동안 사용한 nonce를 기억하고 재사용을 거부한다.
- 재시도는 같은 raw params에 새 nonce, 현재 `iat`와 새 signature를 붙인다.

`sig` 객체의 필드 순서나 JSON 재직렬화 결과에 의존해서는 안 된다. 서명과 `payload_digest`는 raw params를 공통 입력으로 사용할 뿐 서로 다른 계산이다.

### 4.2. 감사 params 원문

- Runtime Adapter는 `mesh.audit.append.params`를 한 번 직렬화한다.
- outbox는 파싱된 객체만이 아니라 직렬화된 UTF-8 문자열 `raw_params`를 보관한다.
- 재시도에서는 JSON-RPC `id`와 `sig`가 바뀔 수 있지만 `raw_params` bytes는 그대로 재전송한다.
- Hub는 수신한 `params`의 원문 bytes를 보존하고 그 bytes로 동일성 검증을 수행한다.
- JSON canonicalization이나 RFC 8785 JCS는 사용하지 않는다.

`payload_digest`는 요청 필드로 넣지 않고 Hub가 다음과 같이 계산해 저장한다. 따라서 digest의 자기참조가 없다.

```text
payload_digest = lowercase_hex(SHA-256(received raw params UTF-8 bytes))
```

같은 `event_id`와 동일한 `payload_digest` 재전송은 duplicate success다. 같은 `event_id`와 다른 digest는 `AUDIT_EVENT_CONFLICT`다.

### 4.3. 첨부 무결성

파일 bytes 자체를 Ed25519로 직접 서명하지 않는다.

```text
file bytes → SHA-256 → attachments[].sha256 → raw params를 포함한 request preimage 서명
```

HTTP upload 과정에서 서버가 실제 bytes의 SHA-256과 크기를 다시 검증한다.

## 5. 버전과 capability 협상

세 가지 버전은 서로 다르다.

| 버전 | 의미 | 수명 |
|---|---|---|
| `agentMeshSpec` | 전체 Agent Mesh SPEC 문서 버전 | 배포·문서 |
| `capabilities.audit.version` | 감사 protocol의 method, params, 오류 계약 | Hub 연결 |
| `schema_version` | 저장된 감사 event object의 모양 | 감사 행의 전체 수명 |

모두 숫자로 표현한다. 예시 응답은 다음과 같다.

```json
{
  "ok": true,
  "identity": "agent-a",
  "capabilities": {
    "audit": {
      "version": 1,
      "max_blob_bytes": 104857600,
      "upload_timeout_seconds": 180,
      "content_addressing": "sha256",
      "max_attachments_per_event": 32,
      "max_attachments_bytes_per_event": 268435456,
      "max_inflight_appends": 4,
      "max_inflight_uploads": 2
    }
  }
}
```

- 클라이언트가 광고된 audit protocol version을 모르면 Hub 감사 송신을 하지 않는다.
- 이 경우 이벤트를 버리지 않고 outbox에 보관하며 명시적인 protocol incompatible 상태를 표시한다.
- Hub는 `schema_version`이 자기 최대값보다 높으면 거부한다.
- 상위 schema event는 영구 오류가 아니라 Hub 선행 업그레이드를 기다리는 일시 정지 상태다.
- 배출 worker는 연결별 `max_inflight_appends`, `max_inflight_uploads`를 넘지 않는다.
- Hub가 capability 한도를 광고하지 않은 구버전이면 클라이언트가 임의 추측하지 않고 감사 protocol을 비호환으로 판정한다.

## 6. Event ID와 생산자 라벨

`event_id` 형식은 다음으로 제안한다.

```text
aud_<UUIDv7 canonical lowercase string>
예: aud_0198b1f8-7d5a-7a12-9f42-7b6c86f54e31
```

- UUIDv7은 RFC 9562 형식이며 생성 시각 기준으로 정렬 가능하다.
- 생산자는 같은 millisecond 안에서도 가능한 한 monotonic한 UUIDv7 generator를 사용한다.
- 시간 정렬은 조회 편의를 위한 것이며 완전성, 전역 인과 순서 또는 신뢰 가능한 발생 시각을 보장하지 않는다.
- 인과관계는 `causation_event_id`로 명시한다.
- `producer_id`는 정합성에 사용하지 않는 최대 64자의 불투명 진단 라벨이다.
- `sequence`, sequence conflict와 checkpoint는 사용하지 않는다.

## 7. `mesh.audit.prepare_blobs`

Runtime Adapter가 event에 속한 첨부의 저장 여부와 업로드 nonce를 요청한다. 요청 배열은 연결에서 광고한 첨부 개수와 합계 크기 한도를 넘지 않는다.

### 7.1. 요청

클라이언트는 최종 `blob_key`를 임의 계산하지 않고 원본 filename을 보낸다. Hub가 기존 HTTP 저장 규칙으로 key를 도출하고 응답한다.

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "mesh.audit.prepare_blobs",
  "params": {
    "event_id": "aud_0198b1f8-7d5a-7a12-9f42-7b6c86f54e31",
    "blobs": [
      {
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "size": 2458211,
        "name": "Report.PDF"
      }
    ]
  },
  "sig": { "alg": "ed25519", "kid": "<fingerprint>", "nonce": "...", "iat": 1786780800, "value": "..." }
}
```

### 7.2. key 정규화

현재 플랫폼의 기존 upload 규칙을 contract utility의 source of truth로 삼는다.

1. filename의 ASCII `[a-zA-Z0-9._-]` 이외 문자를 `_`로 바꾼다.
2. 마지막 suffix가 `.[a-zA-Z0-9]{1,16}`이면 그 부분만 extension으로 사용한다.
3. extension은 lowercase로 변환한다.
4. 조건을 만족하는 extension이 없으면 suffix 없이 SHA-256만 쓴다.
5. 최종 key는 `^[0-9a-f]{64}(?:\.[a-z0-9]{1,16})?$`를 만족한다.

클라이언트와 Hub가 이 로직을 각각 복제하지 않도록 contract package가 정규화 함수와 fixture를 제공하거나, Hub가 응답한 `blob_key`만 클라이언트가 사용한다.

### 7.3. 응답

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "result": {
    "blobs": [
      {
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "blob_key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.pdf",
        "status": "missing",
        "upload": {
          "method": "PUT",
          "url": "https://hub.example/api/v1/audit/blobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.pdf",
          "nonce": "<opaque>",
          "expires_at": "2026-08-15T05:10:00Z"
        }
      }
    ]
  }
}
```

이미 존재하면 `status: "present"`로 반환하고 upload 객체는 생략한다. dedup 단위는 `(sha256, extension)`이므로 같은 bytes라도 extension이 다르면 별도 key와 파일이 생길 수 있다.

## 8. Blob 전체 PUT

누락된 Blob은 `agent-mesh-http`에 raw body로 전체 업로드한다.

```http
PUT /api/v1/audit/blobs/{blob_key}
Authorization: AgentMeshSig kid="<fingerprint>", nonce="<opaque>", sig="<base64url>"
Content-Type: application/octet-stream
Content-Length: 2458211

<entire file bytes>
```

Hub는 발급 nonce row를 `(identity, blob_key, size, expiry)`에 결합한다. Authorization signature는 다음 preimage를 덮는다.

```text
"agent-mesh/upload/v1" ‖ 0x00
‖ LP(nonce)
‖ LP(blob_key)
‖ LP(lowercase sha256)
‖ LP(decimal(size))
```

`LP`는 §8.1과 같은 uint32be byte-length prefix다. nonce는 query string이 아니라 Authorization header에 전달하고 TTL은 `900초`다. Contract의 `formatUploadAuthorization`, `parseUploadAuthorization`, `uploadSignaturePreimage`를 source of truth로 사용한다.

서버 규칙:

- 승인된 identity key로 Authorization을 검증한다.
- nonce가 해당 identity, Blob과 size에 발급됐고 만료되지 않았는지 확인한다.
- `Content-Length`가 선언 size와 일치해야 한다.
- 파일당 한도는 capability의 `max_blob_bytes`, 현재 `100 MiB`다.
- 한 번의 전체 업로드 timeout은 capability의 `upload_timeout_seconds`, 현재 `180초`다.
- 수신 중 SHA-256을 계산한다.
- 실제 hash, size와 `blob_key`가 일치할 때만 임시 파일을 atomic rename한다.
- 실패한 임시 파일은 제거하고 chunk/resumable state는 만들지 않는다.
- 업로드 실패나 timeout은 다음 시도에서 byte 0부터 재전송한다.
- 동일 `blob_key`가 이미 검증돼 있으면 deduplicated success를 반환한다.

기존 browser용 `POST /api/v1/upload`와 다운로드 `GET /api/v1/attachments/{blob_key}`는 유지한다.

## 9. `mesh.audit.append`

### 9.1. 요청

```json
{
  "jsonrpc": "2.0",
  "id": 102,
  "method": "mesh.audit.append",
  "params": {
    "schema_version": 1,
    "event_id": "aud_0198b1f8-7d5a-7a12-9f42-7b6c86f54e31",
    "producer_id": "host-1/agent-a/runtime-adapter",
    "event_type": "channel.inbound.received",
    "occurred_at": "2026-08-15T05:00:01.123Z",
    "correlation_id": "flow_0198b1f8-7d5a-7a12-9f42-7b6c86f54e31",
    "causation_event_id": null,
    "runtime": {
      "kind": "claude",
      "session_id": "tmux-agent-a"
    },
    "channel": {
      "provider": "discord",
      "driver_instance_id": "agent-a-discord-1",
      "account_id": "discord-bot-id",
      "conversation_id": "discord-channel-id",
      "external_message_id": "discord-message-id",
      "external_reply_to": null
    },
    "message": {
      "content_type": "text/plain",
      "content": "전체 메시지 본문",
      "attachments": [
        {
          "blob_key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.pdf",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "name": "Report.PDF",
          "mime": "application/pdf",
          "size": 2458211
        }
      ]
    },
    "outcome": {
      "status": "accepted",
      "error_code": null,
      "error_message": null
    }
  },
  "sig": { "alg": "ed25519", "kid": "<fingerprint>", "nonce": "...", "iat": 1786780800, "value": "..." }
}
```

`identity`, `recorded_by`, `attestation`, `payload_digest`는 클라이언트가 신뢰 경계 안으로 주입하는 필드가 아니다. Hub가 인증된 연결, 검증된 signature와 수신 원문에서 만들어 저장한다.

### 9.2. 최종 ACK

```json
{
  "jsonrpc": "2.0",
  "id": 102,
  "result": {
    "ok": true,
    "committed": true,
    "duplicate": false,
    "event_id": "aud_0198b1f8-7d5a-7a12-9f42-7b6c86f54e31",
    "producer_id": "host-1/agent-a/runtime-adapter",
    "identity": "agent-a",
    "attachments_verified": 1,
    "stored_at": "2026-08-15T05:00:03.456Z"
  }
}
```

Hub는 다음이 모두 완료된 후에만 ACK한다.

- 요청 서명과 identity 검증
- schema와 negotiated limit 검증
- 모든 `blob_key`, SHA-256과 size의 실제 파일 검증
- 같은 `event_id`의 digest conflict 검사
- `audit_events`와 `audit_event_blobs`의 단일 DB transaction commit

Runtime Adapter는 최종 ACK 뒤에만 outbox 항목을 완료 처리한다. ACK가 유실되면 checkpoint를 조회하지 않고 같은 `event_id`와 같은 raw params를 다시 보낸다.

## 10. 기록 주체, 기록자와 attestation

저장 레코드는 활동 주체와 기록자를 분리한다.

```json
{
  "identity": "agent-a",
  "recorded_by": { "kind": "adapter", "identity": "agent-a" },
  "attestation": {
    "signed_by": "agent-a",
    "kid": "<fingerprint>",
    "alg": "ed25519",
    "value": "<base64url>",
    "covers": "audit.params"
  }
}
```

| 이벤트 | `identity` | `recorded_by` | `attestation.covers` |
|---|---|---|---|
| 채널, Adapter 생산 | 해당 에이전트 | `adapter`, 같은 identity | `audit.params` |
| mesh, Hub 생산 | 발신 에이전트 | `hub`, `hub` | `mesh.send.params` |

- 채널 이벤트는 Adapter의 자기 신고다.
- mesh 이벤트는 Hub의 제3자 관측이며 원본 `mesh.send.params` bytes와 송신자 signature를 보존한다.
- `attestation`은 원본 signature가 무엇을 덮는지 명시할 뿐, Hub가 관측한 delivery 결과까지 발신자가 서명했다는 뜻은 아니다.
- trust 수준을 `event_type` prefix로 추론하지 않는다.

## 11. 오류와 outbox 상태

### 11.1. JSON-RPC 오류

SPEC 0.2 오류 코드는 다음과 같다.

| 코드 | 이름 | 분류 |
|---|---|---|
| `-32010` | `DUPLICATE_IDENTITY` | 연결 |
| `-32011` | `IDENTITY_NOT_REGISTERED` | 연결 |
| `-32012` | `SIGNATURE_INVALID` | 요청 수정 필요 |
| `-32013` | `NOT_ENTITLED` | 영구 |
| `-32014` | `KEY_NOT_APPROVED` + `data.key_status` | 인증 대기/복구 |
| `-32040` | `AUDIT_MISSING_BLOBS` | 일시 |
| `-32041` | `AUDIT_EVENT_CONFLICT` | 영구 |
| `-32043` | `AUDIT_BUSY` + `data.retry_after_ms` | 일시, 자동 해소 |
| `-32044` | `AUDIT_STORAGE_EXHAUSTED` | 일시, 운영자 필요 |
| `-32602` | `INVALID_PARAMS`, 한도 초과 | 영구 |

`-32042`는 제거된 `AUDIT_SEQUENCE_CONFLICT` 자리로 남겨두고 재사용하지 않는다. 상위 `schema_version` 거부의 정확한 오류 응답은 contract fixture에서 고정한다.

### 11.2. 분류

| 분류 | 예 | 클라이언트 동작 |
|---|---|---|
| 재시도 | 연결 실패, 503, `AUDIT_MISSING_BLOBS` | outbox 유지, 필요한 upload 후 backoff 재시도 |
| 서버 pacing | `AUDIT_BUSY` | `retry_after_ms` 이상 대기, jitter 적용, in-flight 축소 |
| Hub 용량 소진 | `AUDIT_STORAGE_EXHAUSTED` | outbox 유지, 느린 backoff, 운영자 증설 필요 상태를 강하게 표시 |
| 호환성 대기 | 상위 `schema_version`, 모르는 audit protocol | outbox 유지, 송신 중지, Hub 선행 업그레이드 안내 |
| 인증 대기 | `KEY_NOT_APPROVED`의 pending/denied/revoked key | outbox 유지, hot loop 금지, 승인·교체·복구 절차 표시 |
| 서명 요청 수정 | `SIGNATURE_INVALID` | 새 nonce/현재 iat로 재서명, ±120초 clock skew 검사, key와 serializer 진단 |
| 영구 격리 | 첨부 개수/크기 한도 위반, malformed params, `AUDIT_EVENT_CONFLICT` | active retry에서 제외하고 원문과 Blob을 local dead-letter에 보존, 운영 경고 |

플랫폼 회신의 “permanent event를 drop”은 조용히 물리 삭제한다는 뜻으로 해석하지 않는다. 감사 원본 유실을 피하기 위해 전송 queue에서만 제외하고 local dead-letter/quarantine으로 이동한다. 실제 삭제는 별도 로컬 보존정책에만 따른다.

재시도 횟수의 상한은 두지 않는다. reconnect backoff뿐 아니라 drain loop에도 pacing, jitter와 negotiated in-flight 제한을 적용한다.

## 12. Outbox 처리 순서

```text
1. Channel Driver → Runtime Adapter 직접 전달
2. Runtime Adapter가 event_id를 만들고 params를 한 번 직렬화
3. raw params, 메시지와 첨부 원본을 lane outbox에 내구성 있게 기록
4. Claude/Codex/Antigravity 런타임 또는 channel-driver에 전달
5. 승인된 key로 Hub 연결 및 request 서명
6. mesh.audit.prepare_blobs
7. missing Blob만 최대 2개 병렬 전체 PUT
8. mesh.audit.append를 최대 4개 병렬 처리
9. Hub가 Blob 검증과 audit transaction commit
10. Hub 최종 ACK
11. Runtime Adapter가 outbox 완료 표시
12. 다른 미확정 event가 참조하지 않는 local payload와 Blob 원본 정리
```

한 Host Daemon이 여러 lane을 관리해도 Hub connection, key, in-flight 제한, retry schedule과 outbox는 lane별로 독립이다. Hub 복구 시 모든 lane이 동시에 무제한 drain하지 않도록 lane별 jitter를 추가한다.

Hub가 event와 참조 Blob을 무기한 보존하므로 최종 ACK를 받은 completed outbox payload를 로컬에 중복 보존하지 않는다. ACK 처리와 참조 감소는 crash-safe transaction으로 수행하고, 같은 local Blob을 참조하는 미확정 또는 dead-letter event가 하나라도 있으면 Blob을 지우지 않는다. ACK가 없는 dead-letter는 명시적인 운영자 처리 전까지 보존한다.

## 13. 저장 모델

```text
agents.db
  agents
  agent_keys
  agent_key_events
  upload_nonces

hub.db
  messages

audit.db
  audit_events
    PK: event_id
    schema_version
    identity
    recorded_by_kind + recorded_by_identity
    producer_id
    event_type
    occurred_at + stored_at
    payload_digest
    raw params / immutable event payload
    attestation metadata

  audit_event_blobs
    PK: event_id + ordinal
    blob_key
    sha256
    original name
    mime
    declared size

uploads/
  <sha256>[.<ext>]
```

- `blobs` DB table은 두지 않는다.
- Blob 존재와 크기는 filesystem `stat`과 key 규칙으로 확인한다.
- 동일 Blob을 event 안에서 두 번 참조할 가능성을 보존하기 위해 attachment relation의 식별자는 `(event_id, ordinal)`로 한다.
- Hub audit event와 참조 Blob은 무기한 보존한다. `agents.db`의 identity와 key history도 영구 보존한다.
- `hub.db:messages`는 delivery와 `mesh.fetch_messages`를 위한 운영 저장소로서 배포 정책에 따라 회전할 수 있다.
- orphan 정리는 `uploads/`와 `audit_event_blobs` 참조를 비교하고, 어떤 event도 참조한 적 없는 파일만 유예기간 뒤 수거한다.
- upload 완료와 event commit 사이의 Blob은 정상 상태이므로 즉시 orphan으로 삭제하지 않는다.
- orphan collector는 Hub request path 밖의 idempotent cron/systemd timer로 실행한다.
- `audit.db`와 `uploads/`는 `hub.db`/`agents.db`와 별도 volume에 두고 소진 전에 soft/hard threshold 경보를 건다.
- 감사 volume 소진 시 Hub는 라우팅을 계속하고 감사 write만 `AUDIT_STORAGE_EXHAUSTED`로 거부한다. 복구는 삭제가 아니라 용량 증설이다.

## 14. 관리자 조회

```http
GET /api/v1/audit/events/{event_id}
GET /api/v1/audit/events?identity=agent-a
GET /api/v1/audit/events?recorded_by=hub
GET /api/v1/audit/events?provider=discord
GET /api/v1/audit/events?correlation_id=flow_...
GET /api/v1/audit/events?from=...&to=...
GET /api/v1/attachments/{blob_key}
```

- 목록은 cursor pagination을 사용한다.
- 기본 정렬은 `(stored_at, event_id)` 오름차순이다.
- lane 인증과 관리자 조회 인증을 분리한다.
- provider token, private key, Authorization, thought/reasoning은 저장하거나 반환하지 않는다.

## 15. 수용 조건

- Hub가 없어도 channel-driver와 Runtime Adapter의 직접 통신이 계속된다.
- `hub-direct` 채널 전달 경로가 없다.
- identity마다 독립 Ed25519 key를 생성하고 pending/approved/denied/revoked를 처리한다.
- fingerprint를 TUI와 로그에서 확인하고 관리자 승인 값과 대조할 수 있다.
- JSON-RPC signature가 확정된 length-prefixed preimage fixture와 `±120초` freshness/nonce replay 검사를 통과한다.
- Hub가 key 상태를 요청마다 읽고 rotation/revocation 후 다음 요청에서 이전 key를 거부한다.
- 동일 `event_id`와 동일 raw params 재전송은 한 event만 만든다.
- 같은 `event_id`와 다른 raw params는 conflict로 격리된다.
- checkpoint 없이 ACK 유실에서 복구한다.
- 같은 bytes와 같은 extension은 한 파일, 같은 bytes와 다른 extension은 별도 파일로 저장된다.
- 100 MiB 초과 파일과 event당 32개 또는 합계 256 MiB 초과 첨부는 수용되지 않는다.
- 180초를 넘긴 전체 upload는 중단되고 다음 retry에서 처음부터 보낸다.
- 최종 ACK 전에 모든 Blob과 attachment relation이 검증·commit된다.
- client는 `AUDIT_BUSY`와 negotiated in-flight 제한을 첫 릴리스부터 처리한다.
- client는 `KEY_NOT_APPROVED`의 key 상태를 구분하고 `AUDIT_STORAGE_EXHAUSTED`를 자동 해소 busy와 다르게 표시한다.
- permanent 오류는 hot retry하지 않고 local dead-letter에 보존한다.
- Hub는 채널 이벤트의 주체/기록자/attestation과 mesh 이벤트의 주체/기록자를 구분한다.
- mesh event는 원본 `mesh.send.params` bytes와 발신자 attestation을 보존한다.
- Hub와 client가 contract package의 raw params, signature, UUIDv7, extension 정규화 fixture를 함께 통과한다.
- Hub audit event와 참조 Blob은 무기한 보존하고 감사 volume이 소진돼도 mesh routing은 계속된다.
- 최종 ACK된 local payload와 미참조 Blob은 정리하되 미확정/dead-letter 자료는 보존한다.

## 16. Contract package와 3차 회신 반영

### 16.1. 공개 저장소와 소비 기준

공개 contract 저장소와 현재 소비 기준은 다음과 같다.

```text
package:    @agent-mesh/contracts
repository: sir-mirr/agent-mesh-contracts (public GitHub)
owner:      Agent Mesh Hub/platform team
delivery:   immutable Git tag
registry:   none
consumer:   Hub와 agent-mesh client
current:    v0.3.0 / package 0.3.0 / agentMeshSpec 0.2
```

```json
{
  "dependencies": {
    "@agent-mesh/contracts": "github:sir-mirr/agent-mesh-contracts#v0.3.0"
  }
}
```

`v0.2.0`은 immutable하게 남지만 `AttachmentMeta`가 없으므로 소비하지 않는다. 현재 기준은 이를 추가한 `v0.3.0`이다. Package는 `src/index.ts`와 `fixtures/index.ts`를 직접 export하며 양쪽이 Bun + TypeScript 7을 쓰므로 build, `prepare`와 committed `dist/`를 두지 않는다.

Hub SPEC은 규범적 설명이고 contract 저장소는 실행 가능한 schema, 타입, 상수와 fixture의 source of truth다. Package SemVer, `agentMeshSpec`, audit protocol과 event `schema_version`은 서로 다른 version 축이다.

### 16.2. Core와 attachment 소유권

기존 `@agent-mesh/core`의 envelope, tool contract, capability, ownership, registry, history, action-proxy와 Hub 공통 타입은 `@agent-mesh/contracts`로 이동했다. Hub baseline 안에 소비자가 없고 wire contract이므로 이 소유권을 수용한다.

`@agent-mesh/shared-attachments`의 streaming fetch, SHA-256 검증과 atomic rename은 구현이므로 lane/client 저장소가 소유한다. SPEC §15.2의 `AttachmentMeta`와 `extractAttachmentsMeta`만 contract에서 import하고 로컬 중복 선언은 두지 않는다.

### 16.3. `v0.3.0`에서 확인된 항목

- `requestSignaturePreimage`, `uploadSignaturePreimage`
- UTF-8 byte length, uint32be, raw params와 decimal integer preimage fixture
- `AgentMeshSig` format/parse와 upload header fixture
- `UPLOAD_NONCE_TTL_SECONDS = 900`
- filename/extension/Blob key fixture 8개
- `aud_<UUIDv7>` positive/negative fixture
- `key_status` 값과 error classification
- `AUDIT_BUSY = transient`, `AUDIT_STORAGE_EXHAUSTED = transient-operator`
- append params에서 Hub 생산 필드 제외
- retired `-32042` 재사용 금지 테스트
- `AttachmentMeta`, upload response와 attachment 추출 helper

### 16.4. Unsigned identity — 해결

unsigned 허용 여부는 key row의 존재가 아니라 Hub `agent_types.requires_key`가 결정한다.

```text
requires_key = 1
  → 모든 request에 approved key 서명 필수
  → key가 없으면 -32014 KEY_NOT_APPROVED / key_status: "missing"

requires_key = 0
  → key가 전혀 없을 때만 unsigned 허용
  → approved key가 생기면 이후 요청은 서명 필수
```

`POST /api/v1/agents`도 `requires_key=1` type을 key 없이 등록하는 것을 거부한다. `service`의 예외는 type data로 분리됐으므로 이전 §16.4 확인 항목은 닫는다.

### 16.5. Agent type 확장 — 해결

Agent type은 contract enum이 아니라 Hub의 운영 데이터다.

```sql
CREATE TABLE agent_types (
  type         TEXT PRIMARY KEY,
  description  TEXT,
  requires_key INTEGER NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

새 type 추가는 SPEC/package 변경이 아니라 key 승인과 같은 admin gate 뒤의 운영자 행위다. Antigravity는 다음처럼 사용한다.

```text
runtime.kind        = "antigravity"
identity.type       = "ai-cli-adapter"  # 운영자가 requires_key=1로 provision
runtime.provider    = "google-antigravity"
runtime.cli_version = 실제 agy version
runtime.model       = 실제 실행 model ID
```

Client가 미등록 type을 임의 생성하거나 `ai-claude`/`ai-gemini`로 위장해 fallback하지 않는다. Hub가 등록 가능한 type 목록을 포함해 거부하면 TUI가 운영자 provision 절차를 안내한다. 기존 enum 확장 확인 항목은 닫는다.

### 16.6. Blob PUT wire — 해결

```http
Authorization: AgentMeshSig kid="<fingerprint>", nonce="<opaque>", sig="<base64url>"
```

```text
preimage = "agent-mesh/upload/v1" ‖ 0x00
         ‖ LP(nonce)
         ‖ LP(blob_key)
         ‖ LP(lowercase sha256)
         ‖ LP(decimal(size))
```

- `LP`는 uint32be UTF-8 byte-length prefix다.
- nonce는 URL/query가 아니라 Authorization header에 둔다.
- auth-param은 quoted form이고 순서는 의미가 없다.
- nonce TTL은 `900초`다.
- upload timeout `180초` 후 같은 유효 grant로 전체 재시도할 수 있다.
- RPC 서명과 domain을 분리해 목적 간 replay를 막는다.

Contract의 formatter/parser와 preimage fixture를 사용하므로 이전 §16.6 확인 항목은 닫는다.

### 16.7. Runtime validation schema 결정

클라이언트 측 선택은 TypeBox 1.x(`typebox`) + JSON Schema Draft 2020-12다.

- TypeBox schema object를 canonical authoring source로 사용한다.
- TypeScript 타입은 schema에서 정적으로 추론한다.
- Hub와 client는 동일 schema로 inbound wire payload를 runtime 검증한다.
- coercion, transform과 validation 중 default 삽입은 사용하지 않는다.
- unknown field 허용 여부는 security-critical object와 확장 envelope별로 명시한다.
- 타 언어 구현을 위해 `schemas/*.json`을 tag에 함께 넣고 TypeBox export와 동일성 테스트를 둔다.
- fixture도 `fixtures/*.json`을 canonical language-neutral artifact로 제공하고 TypeScript export는 이를 감싼다.

TypeBox는 JSON Schema 자체를 생성하면서 TypeScript static type을 추론하므로 Zod/Valibot → JSON Schema 변환 계층보다 이번 cross-language contract 목적에 맞다.

### 16.8. 다음 contract tag 전 보완

- TypeBox runtime validation schema와 `schemas/*.json`
- 현재 `fixtures/index.ts`와 동일한 language-neutral `fixtures/*.json`
- Ed25519 signature positive/negative fixture
- nonce replay fixture
- 최초 `mesh.connect` signature fixture
- JSON-RPC method와 HTTP route 상수
- Hub 생산 `mesh.*` 저장 schema/fixture
- 상위 `schema_version`의 정확한 오류 계약
- release metadata의 대응 Hub SPEC commit

### 16.9. GitHub 검증에서 확인한 release 정리

- `v0.3.0` tag와 package `0.3.0`, `AttachmentMeta`, `AgentMeshSig` 및 TTL 900초는 확인됐다.
- `v0.3.0` README 설치 예시는 아직 `v0.2.0`이므로 다음 tag에서 고친다.
- annotated `v0.3.0` tag가 가리키는 GitHub commit은 `48ebba4…`인데 3차 회신의 Bun 출력은 `047b6bf`다. 양쪽 lockfile과 tag resolution을 다시 대조한다.
- 현재 fixture는 TypeScript source뿐이라 “타 언어가 data로 읽는다”는 목표를 충족하지 않는다. JSON artifact를 추가한다.
- `package.json`에는 `agentMeshSpec: "0.2"`만 있고 대응 Hub commit은 없다. 다음 release metadata에 고정한다.
- tag protection은 아직 운영 작업으로 남아 있다. 기존 tag는 이동하지 않고 모든 정정은 새 SemVer tag로 낸다.

### 16.10. 남은 운영 설정

- 참조 없는 Hub Blob의 orphan grace period
- Hub audit volume soft/hard threshold와 경보 채널
- client outbox 최대 용량과 fail-closed 임계값
- `hub.db:messages`의 배포별 회전 기간

Hub 보존정책은 확정됐다. ACK된 local payload는 즉시 정리하고, ACK가 없는 pending/dead-letter는 명시적인 처리 전까지 보존하는 것을 client 기본정책으로 한다.

## 17. 명시할 한계

- sequence가 없으므로 outbox 자체가 유실된 사실과 누락 event를 Hub가 검출할 수 없다.
- 감사 기록은 “수집된 것”의 기록이며 완전성이나 위변조 불가를 보장한다고 표현하지 않는다.
- 채널 이벤트는 Adapter의 자기 신고이고 mesh 이벤트의 delivery 상태는 Hub 관측이다.
- dedup은 SHA-256만이 아니라 `(SHA-256, extension)` 단위다.
- Hub audit와 참조 Blob은 무기한 보존하므로 저장량은 계속 증가하며 용량 증설과 사전 경보가 운영의 일부다.

## 18. 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-08-15 | 최초 Hub 감사 적재 인터페이스 제안 작성 |
| 2026-08-15 | Hub 플랫폼 회신 반영. Ed25519 identity, 요청별 서명, sequence/checkpoint 제거안, 확장자 포함 Blob key, signed nonce upload, 별도 audit DB, capability 한도, busy/error 분류, mesh 감사와 attestation 추가 |
| 2026-08-15 | Hub 문서 간 sequence 불일치, 서명 preimage/replay 모순과 폐기 key 연결 cache 무효화 문제를 구현 전 확인 항목으로 분리 |
| 2026-08-15 | Hub 2차 회신/SPEC 0.2 반영. length-prefixed signature, ±120초 freshness, 요청별 key 조회, KEY_NOT_APPROVED, AUDIT_STORAGE_EXHAUSTED와 Hub 무기한 보존 확정 |
| 2026-08-15 | contract package를 `@agent-mesh/contracts`로 선택. SPEC의 unkeyed identity 우회, runtime identity 확장과 Blob PUT wire 미완성을 신규 확인 항목으로 기록 |
| 2026-08-15 | contract를 공개 `sir-mirr/agent-mesh-contracts` 저장소에서 관리하고 immutable Git tag로 배포하기로 확정. 초기 tag `v0.2.0`, npm publish는 보류 |
| 2026-08-15 | Gemini ACP 전환에 따라 `ai-gemini` 요청을 Antigravity `runtime.kind`와 vendor-neutral `ai-cli-adapter` identity 제안으로 교체 |
| 2026-08-15 | Hub 3차 회신 반영. Contract `v0.3.0`, `agent_types.requires_key`, `AgentMeshSig` upload header/preimage와 TTL 900초 확정 |
| 2026-08-15 | Runtime schema를 TypeBox + Draft 2020-12로 선택하고 language-neutral schema/fixture, 미커버 fixture와 release 정리 항목 기록 |
