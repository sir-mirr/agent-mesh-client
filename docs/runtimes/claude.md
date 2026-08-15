# Claude Runtime Transport v0.1

> 상태: v0.1 implemented · Claude Code 2.1.116 live channel verified

- Claude도 다른 runtime과 동일한 Lane Controller와 Runtime Adapter core를 사용한다.
- Claude CLI는 tmux의 대화형 session에서 실행한다.
- Runtime Adapter transport는 Claude CLI가 local development channel로 연결하는 stdio MCP Channel server다.
- `agent-mesh`가 lane state에 전용 MCP 설정을 만들고 `--mcp-config --strict-mcp-config`로 로드한다.
- MCP server는 lane을 명시해 Host Daemon/Lane Controller에 연결하며 별도 Hub/outbox 구현을 소유하지 않는다.
- Claude process가 종료돼도 daemon, Driver 연결과 outbox는 유지하고 runtime 상태만 `Stopped/Disconnected`로 전환한다.
- `agent-mesh up <lane>`은 daemon user service, lane, MCP config와 tmux session을 멱등적으로 준비한다.
- `agent-mesh attach <lane>`은 해당 tmux agent window에 연결한다.

Claude Code 2.1.116에서 `--dangerously-load-development-channels server:agent-mesh`, `claude/channel` capability와 `notifications/claude/channel` 실제 turn을 확인했습니다. 최초 실행에는 Claude가 workspace 신뢰와 development channel, 보안 profile에 따른 도구 실행 승인을 직접 요구합니다. TUI는 이를 우회하지 않고 `attach`로 사용자가 결정하게 합니다.

실제 smoke에서 채널 inbound가 Claude turn을 깨우고 `reply` MCP tool이 immutable correlation을 통해 원 provider에 `CLAUDE_SMOKE_OK`를 전달했습니다.
