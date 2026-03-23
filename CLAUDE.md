# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**MessengerBot** 안드로이드 스크립팅 플랫폼(API Level 2) 기반의 카카오톡 메신저 봇 시스템. 봇은 MessengerBot 런타임 내에서 **GraalJS** 엔진으로 실행되며, `Packages.*`를 통한 Java 연동과 Android API 접근이 가능하다. 별도의 빌드 시스템 없이 프레임워크의 컴파일 이벤트로 핫 리로드된다. GraalJS는 표준 JavaScript(V8/Node.js)와 동작이 다를 수 있으므로 코딩 시 주의가 필요하다.

## 아키텍처

`Bots/` 하위에 두 개의 독립적인 봇이 존재한다:

- **gsbot** (`Bots/gsbot/gsbot.js`) — 명령어 봇. `/` 접두사로 사용자 메시지를 처리한다. 메이플스토리 시뮬레이터(스타포스, 슈페리얼 강화, 가챠), 캐릭터 히스토리/추적, 랜덤 음식/활동 추천, "vs" 랜덤 선택 기능을 제공한다. `@@` 접두사로 관리자 공지 전송이 가능하다.
- **gsbot_loop** (`Bots/gsbot_loop/gsbot_loop.js`) — 정기 알림 봇. 30초 간격으로 시간을 확인하여 조건에 맞는 알림을 전송한다(특정 날짜, 요일별, 매일). 매일 00:10 KST에 EC2에서 알림 데이터를 동기화하며, Flutter 앱에 FCM 푸시 알림을 전송한다. 관리자 명령어는 `!` 접두사를 사용한다(`!알림로드`, `!알림확인`, `!알림도움`).

두 봇 모두 EC2의 Node.js API 서버와 통신한다:
- Base URL: `http://ec2-3-34-171-56.ap-northeast-2.compute.amazonaws.com:3000/api`
- gsbot: JSoup (`Packages.org.jsoup.Jsoup`)으로 HTTP 통신
- gsbot_loop: `java.net.URL` / `HttpURLConnection`으로 HTTP 통신

## 주요 패턴

- **메시지 처리**: `bot.addListener(Event.MESSAGE, onMessage)` — 접두사 파싱 후 `stringMatchResult()`로 기능 매칭, API 호출, 응답
- **커맨드 처리**: `bot.setCommandPrefix("@@")` + `bot.addListener(Event.COMMAND, onCommand)`로 관리자 명령어 처리
- **API 헬퍼** (gsbot): `callApiGet(apiFeat, params)`와 `callApiPost(apiFeat, dataObj)` — URL 인코딩, JSoup 사용, JSON 파싱
- **타이머 관리** (gsbot_loop): `TimeAlarmManager` 싱글톤이 리컴파일 간 상태를 유지하며, `Event.START_COMPILE` 시 타이머를 정리
- **시간 계산**: 모든 시간 비교는 수동으로 KST(UTC+9)로 변환하여 처리
- **에러 리포팅**: 에러 발생 시 관리자 "승엽[EmotionB_SY]"에게 `bot.send()`로 전송

## 봇 프레임워크 API

MessengerBot 런타임이 제공하는 주요 전역 객체 (import 불필요):
- `BotManager.getCurrentBot()` — 봇 인스턴스 반환
- `bot.send(room, message)` — 특정 방에 메시지 전송
- `bot.canReply(room)` — 해당 방에 응답 가능 여부 확인
- `bot.addListener(event, callback)` — 이벤트 핸들러 등록
- `Event.MESSAGE`, `Event.COMMAND`, `Event.START_COMPILE`, `Event.Activity.*`
- `Log.d()`, `Log.i()`, `Log.e()` — 로깅
- `Packages.*` — Java 클래스 접근 (예: `Packages.org.jsoup.Jsoup`, `Packages.java.net.URL`)
- `Java.type()` — Java 클래스 접근의 대안 방식 (gsbot_loop에서 사용)

## 설정

각 봇은 진입점과 옵션을 지정하는 `bot.json`을 가진다:
```json
{
    "main": "gsbot.js",
    "option": {
        "apiLevel": 2,
        "useConsoleApi": true,
        "scriptPower": true
    }
}
```

## 개발 참고사항

- 빌드 단계나 테스트 프레임워크 없음 — MessengerBot 안드로이드 앱에서 직접 실행
- 모든 사용자 대면 텍스트는 한국어
- 명령어 별칭에 초성 축약어 포함 (예: `ㅅㅌㅍㅅㅅㅁ` → `스타포스시뮬`)
- `ROOM_LIST` / `TARGET_ROOMS` 배열이 봇이 동작하는 카카오톡 채팅방을 정의
- 관리자 이름은 `"승엽[EmotionB_SY]"`로 하드코딩되어 있음
