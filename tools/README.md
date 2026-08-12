# 디버그룸 소켓 테스트 도구

카카오톡 없이 맥에서 봇 명령어를 직접 실행한다. 메신저봇이 소켓 **서버**(기본 9500),
`mdb.js`가 클라이언트다. adb 포워딩으로 폰의 9500 포트를 맥의 9500에 연결한다.

```
맥: node tools/mdb.js  ──▶ 127.0.0.1:9500 ──[adb forward]──▶ 폰:9500 메신저봇
                       ◀── 봇 응답 (isBot:true) ◀──
```

## 1회 설정

### 1. 폰에서 USB 디버깅 켜기

설정 → 휴대전화 정보 → 소프트웨어 정보 → 빌드번호 7회 탭 → 개발자 옵션 → **USB 디버깅** ON

### 2. 맥에 연결

한 번 페어링해두면 이후에는 **mDNS로 자동 연결**된다. `adb devices`에 이렇게 뜨면 끝난 상태다.

```
adb-R3CT3135Y3H-yMr2iP._adb-tls-connect._tcp  device  model:SM_S908N
```

안 뜨면:

```bash
adb mdns services      # 폰이 광고 중이면 여기 IP:포트가 보인다
adb connect 192.168.0.9:43893
```

> **`adb connect <IP>:5555`는 실패한다.** Android 11+ 무선 디버깅은 5555가 아니라
> **매번 바뀌는 랜덤 포트**를 쓴다. 포트는 폰의 무선 디버깅 화면이나 `adb mdns services`로 확인한다.
> 5555는 USB로 `adb tcpip 5555`를 실행했을 때만 열린다.

처음 페어링하는 경우:

```bash
# 폰: 개발자 옵션 → 무선 디버깅 ON → "페어링 코드로 기기 페어링"
adb pair 192.168.0.9:PORT       # 화면의 6자리 코드 입력
```

USB로 할 경우 케이블 연결 후 `adb devices` → 폰 팝업 승인.

### 3. 메신저봇 소켓 서버 켜기

앱 → 우상단 **더보기** → **공용 설정** → 아래로 스크롤 → **소켓 통신**
→ **Open Socket Server** 스위치 ON. 아래 칸의 포트가 9500인지 확인한다.
켜지면 화면에 `Listening on port 9500`이 뜬다.

이 스위치는 앱을 재시작하면 꺼질 수 있으니, 접속이 안 되면 여기부터 확인한다.

폰 화면을 못 만지는 상황이면 adb로 조작할 수 있다:

```bash
adb shell am start -n com.xfl.msgbot/.application.activity.SplashActivity
adb shell uiautomator dump /sdcard/ui.xml && adb shell cat /sdcard/ui.xml   # 좌표 확인
adb shell input tap <x> <y>
```

리스닝 여부는 폰 쪽에서 직접 확인 가능하다 (9500 = 0x251C):

```bash
adb shell "cat /proc/net/tcp /proc/net/tcp6" | grep -i 251C
```

## 사용

```bash
cd ~/dev/gsbot/gsbot_app

# 단발 실행 — adb forward 는 자동으로 걸어준다
node tools/mdb.js "/6차 엽이감성"
node tools/mdb.js "/도움말"

# 스크립트 수정 후: 재컴파일 → 바로 테스트
node tools/mdb.js --compile "/6차 40 50"

# 대화형 — 여러 명령을 연속으로
node tools/mdb.js
> /스타포스시뮬 17 22
> :room 앙메톡
> :author 홍길동
> :compile
> :quit
```

### 자주 쓰는 옵션

| 옵션 | 설명 |
|---|---|
| `--bot gsbot_loop` | 대상 봇 변경 (스크립트 폴더명과 동일해야 함) |
| `--room <이름>` | 방 이름. `ROOM_LIST` 소속 방 이름을 넣으면 실방 조건 재현 |
| `--author <이름>` | 발신자. 관리자 분기 테스트에 사용 |
| `--dm` | `isGroupChat:false` 로 전송 |
| `--raw` | 수신 원본 JSON 출력 |
| `--port 9500` | 포트 변경 (`--remote-port` 로 폰 쪽만 따로 지정 가능) |
| `--no-forward` | adb forward 생략 |

## 폰 없이 도구만 점검

```bash
node tools/mock-msgbot.js --port 9599          # 터미널 1
node tools/mdb.js --no-forward --port 9599 "/6차 엽이감성"   # 터미널 2
```

## 주의

- **`@@` 관리자 명령은 디버그룸에서 실행되지 않는다 (2026-08-12부터).**
  디버그룸·소켓으로 들어온 메시지는 `msg.author.hash`가 `null`이라 관리자 검증을 통과하지
  못한다. `@@공지전송`을 테스트하려면 실제 카카오톡에서 관리자 계정으로 보내야 한다.
- 반대로 `/` 명령은 누구나 주입할 수 있다. 공개 기능이라 무해하지만 EC2 API 는 실제로 호출된다.
- 에러 핸들러(`bot.send("승엽[EmotionB_SY]", ...)`)는 gsbot의 에러 핸들러(`bot.send("승엽[EmotionB_SY]", ...)`)도 실제 1:1 톡으로 간다.
- **소켓 서버는 `0.0.0.0`에 바인딩된다 (2026-08-12 실측 확인).**
  `/proc/net/tcp6`의 local_addr이 `::`이고, adb forward 없이 맥에서
  `nc -z 192.168.0.9 9500`이 성공했다. 즉 **같은 Wi-Fi의 아무 기기나 인증 없이 접속해
  봇에 명령을 주입할 수 있다.** `onCommand`에 발신자 검증이 없는 현재 상태에서는
  발신자 검증이 붙어 `@@` 명령은 막혔지만, `/` 명령 주입과 정보 노출은 여전히 가능하다.
  → 테스트가 끝나면 스위치를 끄는 것을 권장한다.

## 폰에 배포할 때

`bot.json`은 앱이 `debugRoom` 설정을 덧붙여 저장소 버전과 다르다. **`.js`만 밀 것.**

```bash
adb push Bots/gsbot/gsbot.js /sdcard/msgbot/Bots/gsbot/gsbot.js
node tools/mdb.js --compile "/도움말"
```

밀기 전에 폰 쪽이 저장소와 같은지 확인하면 남의 수정을 덮어쓰는 사고를 막을 수 있다:

```bash
adb pull /sdcard/msgbot/Bots/gsbot/gsbot.js /tmp/phone.js
git show HEAD:Bots/gsbot/gsbot.js | diff - /tmp/phone.js && echo "동일"
```

## 프로토콜

줄 단위 JSON. 맥 → 폰:

```json
{"name":"debugRoom","data":{"isGroupChat":true,"botName":"gsbot","packageName":"com.kakao.talk","roomName":"디버그룸","authorName":"승엽[EmotionB_SY]","message":"/6차 엽이감성"}}
{"name":"compile","data":{"botName":"gsbot"}}
```

폰 → 맥:

```json
{"name":"debugRoom","data":{"botName":"gsbot","roomName":"...","authorName":"...","message":"...","isBot":true}}
{"name":"compileStatus","data":{"botName":"gsbot","status":"start|success|error","error":"..."}}
{"name":"runtimeError","data":{"botName":"gsbot","error":"..."}}
{"name":"badRequest:debugRoom","data":{"botName":"...","error":"..."}}
{"name":"badRequest:compile","data":{"botName":"...","error":"..."}}
```

## ADB 브로드캐스트 (소켓 없이)

```bash
adb shell am broadcast -a com.xfl.msgbot.broadcast.compile        -p com.xfl.msgbot --es name gsbot
adb shell am broadcast -a com.xfl.msgbot.broadcast.set_bot_power  -p com.xfl.msgbot --es name gsbot --ez power true
adb shell am broadcast -a com.xfl.msgbot.broadcast.set_activation -p com.xfl.msgbot --ez activation true
```

## 참조

- 프로토콜 원본: https://github.com/VioletXF/MessengerBotDebugBridge
- APK `messengerbot-0.7.41-alpha.6` 문자열 테이블에서 위 이름 전부 확인
