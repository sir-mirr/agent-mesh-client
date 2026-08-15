# ADR-0004: UDS JSON-RPC 2.0 over NDJSON

- 상태: Accepted
- 날짜: 2026-08-15

## 결정

Channel Driver와 Lane Controller는 lane별 Unix Domain Socket의 지속 duplex connection에서 JSON-RPC 2.0 over NDJSON을 사용한다. JSON payload frame 상한은 10 MiB이며 attachment bytes는 frame 밖의 검증 가능한 local file reference로 전달한다.

## 결과

- lane별 TCP port와 callback server 설정이 사라진다.
- 사람이 진단 가능한 framing과 양방향 request/response를 얻는다.
- 10 MiB 이상 binary는 별도 Blob staging이 필수다.
- same-user local process 신뢰 경계와 attachment path 검증이 protocol의 일부가 된다.
