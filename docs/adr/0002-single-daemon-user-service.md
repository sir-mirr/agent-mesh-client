# ADR-0002: 단일 Host Daemon과 OS 사용자 서비스

- 상태: Accepted
- 날짜: 2026-08-15

## 결정

호스트당 `agent-meshd` process를 하나만 실행하고 lane은 내부 Lane Controller로 구성한다. Linux는 `systemd --user`, macOS는 `launchd` user agent로 daemon을 관리한다. tmux는 daemon supervisor로 사용하지 않고 대화형 Agent CLI와 선택 observer에만 사용한다.

## 결과

- lane 증가가 daemon process와 관리 port 증가로 이어지지 않는다.
- TUI/terminal/tmux 수명과 daemon 수명이 분리된다.
- daemon crash는 모든 lane에 영향을 주므로 OS restart와 lane별 durable recovery가 필수다.
- 단일 address space 안에서도 credential, connection, state와 log context를 lane별로 격리해야 한다.
