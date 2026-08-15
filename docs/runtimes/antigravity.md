# Antigravity Runtime Transport v0.1

> 상태: v0.1 implemented · agy 1.1.13 live one-shot verified

상세 근거와 실험 기록은 [`../../ANTIGRAVITY_RUNTIME_ADAPTER_DESIGN.md`](../../ANTIGRAVITY_RUNTIME_ADAPTER_DESIGN.md)를 따른다.

## Process와 queue

- 상주 `agy` process나 별도 Antigravity daemon을 두지 않는다.
- inbound turn마다 shell을 거치지 않고 `agy --print --output-format json --print-timeout 30m` child를 실행한다.
- 초기 lane-wide concurrency는 1이다.
- 후속 병렬화를 하더라도 같은 `conversation_id`를 사용하는 turn은 동시에 실행하지 않는다.
- stdout의 최종 JSON `response`만 자동 회신 후보로 사용한다.
- turn timeout은 1800초이며 timeout child의 process group을 종료하고 late output을 폐기한다.

## Conversation

Context key는 최소한 lane, workspace identity, source kind, provider/mesh, account, external conversation/thread와 필요한 peer identity를 포함한다.

- 고정 최대 turn 수를 두지 않는다.
- turn-count를 이유로 conversation을 자동 reset하지 않는다.
- 사용자의 명시적 reset과 workspace identity 변경은 reset 조건이다.
- 유효하지 않거나 resume할 수 없는 conversation의 처리 방식은 동결 전 확정한다.
- Hub upload 실패는 conversation reset 조건이 아니다.

## Reply

- 기본 후보는 inbound 최종 response를 원 source와 `reply_to`로 정확히 한 번 자동 회신하는 `reply_mode=auto`다.
- Agent Mesh MCP는 다른 대상에 대한 능동 발신에 사용한다.
- 자동 회신과 MCP 발신이 같은 응답을 중복 전송하지 않도록 action ID와 correlation을 사용한다.
- `reply_mode` 최종 선택지는 아직 동결 전이다.

## 보안과 인증

- sandbox, workspace 격리, permission mode, OAuth/API key는 설치 사용자가 lane별로 선택한다.
- TUI는 가능한 profile을 설명하되 최종 선택을 강제하지 않는다.
- 선택된 policy와 실제 child argv/capability probe 결과가 다르면 `Degraded`로 표시한다.
- 완화된 policy는 외부 channel 연결 전 영향 확인을 받고 운영 화면에 위험을 계속 표시한다.
- auth URL/code/token, keyring content, message body, reasoning과 secret path는 일반 observer/diagnostics/audit에 노출하지 않는다.

## Attachment

- 공통 spool 검증을 통과한 파일만 turn별 read-only view로 노출한다.
- Hub upload 완료 여부는 runtime 노출의 선행조건이 아니다.
- 정확한 `--add-dir` 사용법과 지원 media type은 compatibility test 뒤 동결한다.
