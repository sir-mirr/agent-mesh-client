# ADR-0003: Antigravity one-shot Runtime Transport

- 상태: Accepted
- 날짜: 2026-08-15

## 결정

구 Gemini ACP 상주 session 대신 Antigravity CLI의 one-shot JSON headless 호출을 사용한다. 기본 turn timeout은 30분이고 고정 최대 연속 turn 수는 두지 않는다. Sandbox, permission, workspace 격리와 인증 방식은 설치 사용자가 lane별로 선택한다.

## 결과

- Antigravity 전용 상주 daemon, ACP chunk 조립과 tainted session 교체가 필요 없다.
- turn마다 process spawn 비용이 발생한다.
- conversation continuity는 외부 context와 `conversation_id` mapping에 의존한다.
- 사용자 선택 policy의 실제 적용 상태와 위험을 TUI가 명확히 표시해야 한다.
