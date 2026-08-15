# ADR-0001: Channel 직접 경로와 Hub 비동기 감사

- 상태: Accepted
- 날짜: 2026-08-15

## 결정

Channel Driver는 같은 호스트의 Lane Controller와 UDS로 직접 통신한다. Hub는 channel 실시간 relay에 들어가지 않으며 모든 inbound/outbound 본문과 첨부는 local durable outbox를 거쳐 Hub에 비동기 감사 적재한다. Mesh agent 간 메시지는 Hub를 경유한다.

## 결과

- Hub 장애와 무관하게 local channel latency를 유지할 수 있다.
- Client가 outbox, Blob spool, retry와 fail-closed local durability를 책임져야 한다.
- Hub 감사에는 realtime delivery보다 늦게 도착하는 event가 존재할 수 있다.
