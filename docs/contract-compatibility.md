# Hub Contract Compatibility

> 상태: v0.1 integrated

## 현재 기준

- 공개 저장소: [`sir-mirr/agent-mesh-contracts`](https://github.com/sir-mirr/agent-mesh-contracts)
- 고정 tag: `v0.5.1`
- Hub SPEC baseline: `0.2`
- 소비 방식: immutable Git tag + Bun lockfile, npm registry publish 없음

포함 surface는 Ed25519 request/upload preimage, Blob key, audit limits/error classification, TypeBox provisioning/message schema, mailbox lease/ACK와 `client_message_id` 멱등성입니다. Client는 preimage나 공유 상수를 복제하지 않습니다.

## 호환 정책

- `mesh.connect.capabilities.audit.version`이 없거나 지원하지 않으면 audit method를 추측해 사용하지 않습니다.
- 광고된 file/event/in-flight/timeout 한도를 실제 local 한도와 함께 적용합니다.
- Hub가 반환한 절대 upload URL과 권위 `blob_key`를 사용합니다. 전환기 상대 URL은 operator-facing `base_url`을 기준으로 해석합니다.
- `-32040`은 Blob 전체 재준비, `-32041`과 `-32015`는 영구 충돌로 분류합니다.
- `mesh.send.client_message_id`는 runtime turn처럼 논리적으로 같은 송신에서 안정적으로 유지합니다.
- Hub request params는 한 번만 직렬화하고 서명한 바로 그 UTF-8 bytes를 wire에 삽입합니다.
- 상위 protocol/schema는 fail-closed하며 outbox payload를 삭제하지 않습니다.

## CI/통합 검증

- lockfile의 resolved Git object를 검토합니다.
- contract package 자체 fixture와 Client typecheck를 실행합니다.
- 실제 Hub harness에서 pending→approve→signed connect와 한글 params를 확인합니다.
- 실제 Blob PUT, audit append final ACK와 admin query를 확인합니다.
- 동일 `reply_to` 구조로 자동응답 loop가 생기지 않는지 확인합니다.
- 동일 `client_message_id` 재전송은 원 message ID와 `duplicate:true`를 반환해야 합니다.
