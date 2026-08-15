# TUI v0.1 요약 계약

> 상태: v0.1 implemented

화면별 상세는 [`../TUI_DESIGN.md`](../TUI_DESIGN.md)에 있다. 이 문서는 v0.1에서 반드시 유지할 운영 계약만 요약한다.

## 온보딩

1. 지원 OS와 user service 환경 검사
2. Hub base URL 입력, discovery와 protocol 검사
3. 기본값 없는 Agent Identity 입력, Mesh 전체 중복 조회, 내부 lane ID 자동 생성, 키보드 선택형 CLI Runtime과 workspace 선택
4. 선택 Runtime CLI, 인증과 capability 검사
5. lane별 보안 정책 선택 및 영향 확인
6. 선택 Channel Driver와 credential 설정
7. 생성·변경될 config, secret, service, tmux와 MCP 파일 검토
8. daemon user service 설치/기동, lane/key 등록, driver/runtime 준비
9. health check와 필요한 대화형 runtime attach

Antigravity one-shot lane은 tmux를 필수 dependency로 판정하지 않는다. Claude/Codex 대화형 session을 선택한 경우에만 tmux를 요구한다.

## 운영 화면 필수 상태

- daemon user service와 restart 상태
- Hub endpoint/connection/protocol
- lane identity와 key approval/fingerprint
- runtime kind, Idle/Running/Stopped/Failed, queue와 deadline
- channel driver instance, capability와 drain 상태
- outbox pending/retry/dead-letter 수, bytes와 마지막 ACK/error
- 선택된 security policy, 실제 적용 상태와 위험 경고

## Channel lifecycle

- `add`: config/secret validation 뒤 child 시작 및 registration 확인
- `disable`: 신규 수락 중지, in-flight drain, config 유지
- `enable`: credential/capability 재검사 뒤 재연결
- `remove`: drain 뒤 config 제거; secret 삭제는 별도 명시 선택
- 어떤 작업도 pending/dead-letter outbox나 Hub audit record를 삭제하지 않는다.

## CLI 대응

모든 필수 TUI 작업은 non-interactive CLI로 제공해야 한다. 최소 namespace는 다음과 같다.

```text
agent-mesh daemon ...
agent-mesh config hub ...
agent-mesh lane ...
agent-mesh identity ...
agent-mesh channel ...
agent-mesh outbox ...
agent-mesh doctor
agent-mesh up|down|restart|attach|status|logs
```

## 위험 UX

- secret 삭제, identity rotation/revocation과 완화된 runtime permission 선택은 영향 범위를 표시하고 명시적으로 확인한다.
- config 삭제와 secret 삭제를 합치지 않는다.
- 위험한 runtime policy를 선택한 경우 실행을 몰래 차단하거나 설정을 바꾸지 않고 지속 경고한다.
- Hub 장애, provider 장애, runtime 장애와 local durability failure를 서로 다른 상태로 표시한다.
