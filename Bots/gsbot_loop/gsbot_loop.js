const bot = BotManager.getCurrentBot();

if (typeof TimeAlarmManager === 'undefined') {
    var TimeAlarmManager = {
        intervalId: null,
        initialTimeoutId: null,
        lastCheckedMinute: null, // 마지막으로 판정한 분 (에폭 분 번호). 틱이 늦으면 그 다음 분부터 따라잡는다
        notifications: [], // 알림 데이터 저장
        lastLoadDay: null, // 마지막으로 로드에 성공한 KST 날짜 번호
        lastLoadTryAt: 0, // 마지막 로드 시도 시각(ms). 실패 재시도 간격에 쓴다
        dataLoadIntervalId: null // (구) 24시간 반복 타이머 ID. 남아 있으면 지운다
    };
}

const TARGET_ROOMS = ["06-21", "집사 네 마리", "아케인 편안길드", "무친자들의 모임", "앙메톡", "그녀석의 재획교실"]; // 알림을 보낼 방 목록
const EC2_API_URL = "http://ec2-3-34-171-56.ap-northeast-2.compute.amazonaws.com:3000/api/intervalMessage/all"; // EC2 엔드포인트 URL
const FCM_API_URL = "http://ec2-3-34-171-56.ap-northeast-2.compute.amazonaws.com:3000/api/fcm/send-all"; // fcm 알림 전송 URL
// 관리자 설정 (명령어를 사용할 수 있는 사용자)
const ADMIN_USERS = ["승엽[EmotionB_SY]"]; // 관리자 이름 목록

// 관리자 갠톡으로 보낸다. bot.send 는 그 방의 답장 가능한 카톡 알림이 없으면
// false 를 돌려주는데, 예전에는 그 값을 버려서 안 나간 줄을 몰랐다 — 2026-09-10
// 폰 재부팅으로 갠톡 알림이 사라진 뒤 닷새 동안 재로드 메시지가 조용히 증발했다.
// 갠톡 알림은 관리자가 그 방에 새 메시지를 보내야 다시 생긴다.
function notifyAdmin(text) {
    if (bot.send(ADMIN_USERS[0], text)) return true;
    Log.e("관리자 갠톡 전송 실패(답장 가능한 알림 없음): " + String(text).split("\n")[0].slice(0, 40));
    return false;
}

bot.addListener(Event.START_COMPILE, () => {
    if (TimeAlarmManager.initialTimeoutId) {
        clearTimeout(TimeAlarmManager.initialTimeoutId);
        TimeAlarmManager.initialTimeoutId = null;
    }
    if (TimeAlarmManager.intervalId) {
        clearInterval(TimeAlarmManager.intervalId);
        TimeAlarmManager.intervalId = null;
    }
    if (TimeAlarmManager.dataLoadIntervalId) {
        clearInterval(TimeAlarmManager.dataLoadIntervalId);
        TimeAlarmManager.dataLoadIntervalId = null;
    }
    Log.d("컴파일 시작: 이전 알람 타이머를 모두 종료합니다.");
});

// Flutter 앱에 푸시 알림 전송 함수
function sendNotificationToFlutterApp(title, body, data) {
    try {
        Log.d("Flutter 앱에 알림 전송 시도...");

        const URL = Java.type("java.net.URL");
        const BufferedReader = Java.type("java.io.BufferedReader");
        const InputStreamReader = Java.type("java.io.InputStreamReader");
        const OutputStreamWriter = Java.type("java.io.OutputStreamWriter");
        const StringBuilder = Java.type("java.lang.StringBuilder");

        const url = new URL(FCM_API_URL);
        const connection = url.openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(10000); // 10초 타임아웃
        connection.setReadTimeout(10000);
        connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        connection.setRequestProperty("Accept", "application/json");

        // JSON 데이터 생성
        const jsonData = JSON.stringify({
            title: title,
            body: body,
            data: data || {}
        });

        // 요청 본문 전송
        const writer = new OutputStreamWriter(connection.getOutputStream(), "UTF-8");
        writer.write(jsonData);
        writer.flush();
        writer.close();

        // 응답 읽기
        const responseCode = connection.getResponseCode();
        if (responseCode === 200) {
            const reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"));
            const response = new StringBuilder();
            let line;

            while ((line = reader.readLine()) !== null) {
                response.append(line);
            }
            reader.close();

            Log.i("✅ Flutter 앱 알림 전송 성공: " + title);
            return true;
        } else {
            Log.e("❌ Flutter 앱 알림 전송 실패: HTTP " + responseCode);
            return false;
        }

    } catch (e) {
        Log.e("Flutter 앱 알림 전송 오류: " + e);
        return false;
    }
}

// EC2에서 알림 데이터를 가져오는 함수
function fetchNotificationsFromEC2() {
    try {
        Log.d("EC2에서 알림 데이터를 가져오는 중...");

        const URL = Java.type("java.net.URL");
        const BufferedReader = Java.type("java.io.BufferedReader");
        const InputStreamReader = Java.type("java.io.InputStreamReader");
        const StringBuilder = Java.type("java.lang.StringBuilder");

        const url = new URL(EC2_API_URL);
        const connection = url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(10000); // 10초 타임아웃
        connection.setReadTimeout(10000);
        connection.setRequestProperty("Accept", "application/json");

        const responseCode = connection.getResponseCode();
        if (responseCode !== 200) {
            Log.e("EC2 API 응답 오류: HTTP " + responseCode);
            return false;
        }

        const inputStream = connection.getInputStream();
        if(inputStream == null) {
            throw new Error("EC2 응답 InputStream이 null입니다");
        }

        const reader = new BufferedReader(new InputStreamReader(inputStream, "UTF-8"));
        const response = new StringBuilder();
        let line;

        while ((line = reader.readLine()) !== null) {
            response.append(line);
        }
        reader.close();

        const jsonString = String(response.toString());
        if(jsonString == null || jsonString.length === 0) {
            throw new Error("EC2 응답 본문이 비어있습니다");
        }

        const parsed = JSON.parse(jsonString);
        if(parsed == null || !Array.isArray(parsed)) {
            throw new Error("EC2 알림 데이터가 배열이 아니거나 null입니다");
        }
        TimeAlarmManager.notifications = parsed;


        const count = TimeAlarmManager.notifications.length;
        Log.i("EC2에서 " + count + "개의 알림 데이터를 성공적으로 로드했습니다.");
        notifyAdmin("EC2에서 " + count + "개의 알림 데이터를 성공적으로 로드했습니다.");

        // Flutter 앱에 알림 전송
        sendNotificationToFlutterApp(
            "알림 데이터 업데이트",
            count + "개의 알림이 업데이트되었습니다.",
            {
                type: "data_update",
                count: String(count),  // ← 문자열로 변환
                timestamp: new Date().toISOString()
            }
        );

        return {
            success: true,
            count: count,
            message: "성공적으로 " + count + "개의 알림을 로드했습니다."
        };

    } catch (e) {
        Log.e("EC2에서 데이터 가져오기 실패: " + e);

        // 에러 발생 시에도 Flutter 앱에 알림
        sendNotificationToFlutterApp(
            "알림 데이터 로드 실패",
            "데이터를 가져오는 중 오류가 발생했습니다.",
            {
                type: "error",
                error: String(e),
                timestamp: new Date().toISOString()
            }
        );

        return {
            success: false,
            message: "데이터 로드 실패: " + e
        };
    }
}

// 매일 00시 10분(KST)에 데이터 로드
//
// 예전에는 다음 00:10 까지 setTimeout 을 걸고 그 뒤 24시간 setInterval 로
// 돌렸는데, 기기가 절전에 들어가면 타이머 시계가 멈춰 날마다 로드가 늦어졌다
// (서버 로그 실측: 00:10 → 01~02시 → 06~08시 → 09시대, 재컴파일하면 00:10 으로
// 복귀). 그래서 긴 타이머를 쓰지 않는다. 30초마다 도는 알람 틱에서 실제
// 시계(Date.now)로 "오늘 00:10 이 지났고 아직 오늘 로드를 안 했으면 로드" 한다.
// 시각은 에폭 밀리초로만 계산해 엔진의 로컬 시간대에 기대지 않는다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOAD_AT_MS = 10 * 60 * 1000; // 00:10
const LOAD_RETRY_MS = 10 * 60 * 1000; // 실패하면 10분 뒤 다시

// KST 기준 날짜 번호 (1970-01-01 KST 부터 며칠째)
function kstDayIndex(ms) {
    return Math.floor((ms + KST_OFFSET_MS) / DAY_MS);
}

function loadAndRemember(reason) {
    const now = Date.now();
    TimeAlarmManager.lastLoadTryAt = now;
    const result = fetchNotificationsFromEC2();
    if (result && result.success) {
        TimeAlarmManager.lastLoadDay = kstDayIndex(now);
        Log.i(reason + " 로드 완료: " + result.count + "개");
    }
    return result;
}

// 알람 틱마다 부른다. 오늘(KST) 00:10 이 지났는데 오늘 로드가 없으면 로드한다
function maybeLoadForToday() {
    const now = Date.now();
    if ((now + KST_OFFSET_MS) % DAY_MS < LOAD_AT_MS) return;
    if (TimeAlarmManager.lastLoadDay === kstDayIndex(now)) return;
    if (now - TimeAlarmManager.lastLoadTryAt < LOAD_RETRY_MS) return;
    Log.i("예약된 시간(00:10 KST)이 지나 데이터를 로드합니다.");
    loadAndRemember("예약");
}

function scheduleDataLoad() {
    // 예전 스크립트가 남긴 24시간 반복 타이머가 있으면 지운다
    if (TimeAlarmManager.dataLoadIntervalId) {
        clearInterval(TimeAlarmManager.dataLoadIntervalId);
        TimeAlarmManager.dataLoadIntervalId = null;
    }
    // 스크립트 시작 시 즉시 한 번 로드
    loadAndRemember("초기 데이터");
}

// ─────────────────────────────────────────────────────────────────────────────
// 알림 판정
//
// 틱은 30초마다 돌지만 기기가 절전에 들어가면 타이머 시계가 멈춰 틱이 몇 분씩
// 늦게 온다 — 로드 타이머에서 실측한 것과 같은 현상이다. 예전에는 "지금 분이
// 알림 시각과 정확히 같으면" 보냈으므로 틱이 그 분을 건너뛰면 알림도 조용히
// 사라졌다. 그래서 마지막으로 판정한 분을 기억해 두고, 틱마다 그 다음 분부터
// 지금 분까지 차례로 판정한다. 틱이 늦어도 지나간 분의 알림을 따라잡아 보낸다.
//
// 다만 너무 오래 지난 알림은 보내지 않는다 — "잠시 후 패치" 를 한 시간 뒤에
// 받으면 틀린 안내다. 그 경우는 관리자에게 무엇을 못 보냈는지 알린다.
//
// 시각은 에폭 분 번호로만 다루고 KST 달력 값은 UTC 게터에 9시간을 더해 얻는다.
// 엔진의 로컬 시간대에 기대지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
const MINUTE_MS = 60 * 1000;
const CATCH_UP_MINUTES = 30;        // 이보다 오래 지난 알림은 보내지 않는다
const SCAN_LIMIT_MINUTES = 24 * 60; // 못 보낸 알림을 세는 범위 상한

const DAY_OF_WEEK_INDEX = {
    '일': 0, 'sunday': 0, 'sun': 0,
    '월': 1, 'monday': 1, 'mon': 1,
    '화': 2, 'tuesday': 2, 'tue': 2,
    '수': 3, 'wednesday': 3, 'wed': 3,
    '목': 4, 'thursday': 4, 'thu': 4,
    '금': 5, 'friday': 5, 'fri': 5,
    '토': 6, 'saturday': 6, 'sat': 6
};

function currentMinute() {
    return Math.floor(Date.now() / MINUTE_MS);
}

// 에폭 분 번호 → KST 달력 값
function kstFieldsOf(minute) {
    const d = new Date(minute * MINUTE_MS + KST_OFFSET_MS);
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        dayOfWeek: d.getUTCDay(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes()
    };
}

function kstClock(minute) {
    const t = kstFieldsOf(minute);
    return (t.hour < 10 ? "0" : "") + t.hour + ":" + (t.minute < 10 ? "0" : "") + t.minute;
}

function firstLineOf(message) {
    return String(message).split("\n")[0].slice(0, 30);
}

// 알림이 그 분(KST 달력 값 t)에 나가야 하는가
function isDueAt(n, t) {
    if (n.hour === undefined || n.minute === undefined) return false;
    if (n.hour !== t.hour || n.minute !== t.minute) return false;

    // 1. 특정 날짜
    if (n.year !== undefined && n.month !== undefined && n.day !== undefined) {
        return n.year === t.year && n.month === t.month && n.day === t.day;
    }
    // 2. 요일
    if (n.dayOfWeek !== undefined) {
        return DAY_OF_WEEK_INDEX[String(n.dayOfWeek).toLowerCase()] === t.dayOfWeek;
    }
    // 3. 매일
    return n.year === undefined && n.month === undefined && n.day === undefined;
}

// 방마다 보내고, 못 보낸 방 이름을 돌려준다. bot.send 는 그 방의 답장 가능한
// 알림이 없으면 false 를 돌려주는데, 예전에는 그 값을 버려서 안 나간 줄을 몰랐다.
function sendToRooms(message) {
    const failed = [];
    TARGET_ROOMS.forEach(roomName => {
        if (bot.send(roomName, message)) return;
        failed.push(roomName);
    });
    return failed;
}

function checkTimeAndNotify() {
    try {
        maybeLoadForToday();

        const nowMinute = currentMinute();
        const last = TimeAlarmManager.lastCheckedMinute;
        // 같은 분의 두 번째 틱. 시계가 뒤로 간 경우도 여기서 기준을 다시 잡는다.
        if (last !== null && last >= nowMinute) {
            TimeAlarmManager.lastCheckedMinute = nowMinute;
            return;
        }
        TimeAlarmManager.lastCheckedMinute = nowMinute;

        const notifications = TimeAlarmManager.notifications;
        if (!notifications || notifications.length === 0) return;

        const from = last === null ? nowMinute : Math.max(last + 1, nowMinute - SCAN_LIMIT_MINUTES + 1);
        const sendFrom = nowMinute - CATCH_UP_MINUTES + 1;

        const skipped = [];
        for (let minute = from; minute <= nowMinute; minute++) {
            const t = kstFieldsOf(minute);
            notifications.forEach(notification => {
                try {
                    if (!notification.message || !isDueAt(notification, t)) return;

                    const label = kstClock(minute) + " " + firstLineOf(notification.message);
                    if (minute < sendFrom) {
                        skipped.push(label);
                        return;
                    }

                    const delay = nowMinute - minute;
                    Log.i("알림 전송" + (delay > 0 ? " (" + delay + "분 늦음)" : "") + ": " + label);
                    const failed = sendToRooms(notification.message);
                    if (failed.length > 0) {
                        Log.e("알림을 보내지 못한 방: " + failed.join(" / "));
                        notifyAdmin("알림을 보내지 못한 방: " + failed.join(" / ") + "\n" + label);
                    }
                } catch (e) {
                    Log.e("개별 알림 처리 중 오류: " + e);
                    notifyAdmin("개별 알림 처리 중 오류: " + e);
                }
            });
        }

        if (skipped.length > 0) {
            const text = "알림 확인이 " + (nowMinute - last) + "분 멈춰 있어 지나간 알림 " + skipped.length + "개를 보내지 않았습니다.\n" + skipped.join("\n");
            Log.e(text);
            notifyAdmin(text);
        }

    } catch (e) {
        Log.e("시간 확인 및 알림 전송 중 오류 발생: " + e);
        notifyAdmin("시간 확인 및 알림 전송 중 오류 발생: " + e);
    }
}

function startSyncedAlarmService() {
    if (TimeAlarmManager.intervalId || TimeAlarmManager.initialTimeoutId) {
        Log.d("알람 서비스가 이미 실행 중이거나 예약되어 있습니다.");
        return;
    }

    // 컴파일된 분은 이전 컨텍스트가 이미 봤다. 여기서 기준을 잡아 두면 첫 틱이
    // 절전으로 늦더라도 그 다음 분부터는 따라잡는다.
    if (TimeAlarmManager.lastCheckedMinute === null) {
        TimeAlarmManager.lastCheckedMinute = currentMinute();
    }

    const now = new Date();
    const seconds = now.getSeconds();
    const msUntilNextMinute = (60 - seconds) * 1000 - now.getMilliseconds();

    Log.i(`다음 분 정각까지 ${msUntilNextMinute / 1000}초 대기 후 알람 서비스를 시작합니다.`);

    TimeAlarmManager.initialTimeoutId = setTimeout(() => {
        Log.i("정각 동기화 완료. 첫 확인을 실행하고 30초 간격의 타이머를 시작합니다.");
        checkTimeAndNotify();

        TimeAlarmManager.intervalId = setInterval(checkTimeAndNotify, 30000);
        TimeAlarmManager.initialTimeoutId = null;
    }, msUntilNextMinute);
}

// 현재 로드된 알림 정보와 틱 상태
function getNotificationInfo() {
    let exactCount = 0;
    let weeklyCount = 0;
    let dailyCount = 0;

    const notifications = TimeAlarmManager.notifications || [];
    notifications.forEach(n => {
        if (n.year !== undefined) {
            exactCount++;
        } else if (n.dayOfWeek !== undefined) {
            weeklyCount++;
        } else if (n.hour !== undefined && n.minute !== undefined) {
            dailyCount++;
        }
    });

    const last = TimeAlarmManager.lastCheckedMinute;
    const tick = last === null ? "아직 없음" : kstClock(last) + " (" + (currentMinute() - last) + "분 전)";
    const blocked = TARGET_ROOMS.filter(roomName => !bot.canReply(roomName));

    const loaded = notifications.length === 0
        ? "현재 로드된 알림이 없습니다."
        : `현재 로드된 알림:\n- 정확한 시간: ${exactCount}개\n- 요일 시간: ${weeklyCount}개\n- 매일 시간: ${dailyCount}개\n- 총합: ${notifications.length}개`;

    return `${loaded}\n\n마지막 확인: ${tick}\n답장 불가 방: ${blocked.length > 0 ? blocked.join(" / ") : "없음"}`;
}

// 서비스 시작
scheduleDataLoad(); // 데이터 로드 스케줄링
startSyncedAlarmService(); // 알람 서비스 시작

/**
 * (string) msg.content: 메시지의 내용
 * (string) msg.room: 메시지를 받은 방 이름
 * (User) msg.author: 메시지 전송자
 * (string) msg.author.name: 메시지 전송자 이름
 * (Image) msg.author.avatar: 메시지 전송자 프로필 사진
 * (string) msg.author.avatar.getBase64()
 * (string | null) msg.author.hash: 사용자의 고유 id
 * (boolean) msg.isGroupChat: 단체/오픈채팅 여부
 * (boolean) msg.isDebugRoom: 디버그룸에서 받은 메시지일 시 true
 * (string) msg.packageName: 메시지를 받은 메신저의 패키지명
 * (void) msg.reply(string): 답장하기
 * (boolean) msg.isMention: 메세지 맨션 포함 여부
 * (bigint) msg.logId: 각 메세지의 고유 id
 * (bigint) msg.channelId: 각 방의 고유 id
 */
function onMessage(msg) {
    // 관리자만 명령어 사용 가능
    if (!ADMIN_USERS.includes(msg.author.name)) {
        return;
    }

    const content = msg.content.trim();

    // !알림로드 명령어
    if (content === "!알림로드") {
        msg.reply("알림 데이터를 다시 로드하는 중...");

        const result = fetchNotificationsFromEC2();

        if (result.success) {
            msg.reply("✅ " + result.message);
        } else {
            msg.reply("❌ " + result.message);
        }
    }

    // !알림확인 명령어
    else if (content === "!알림확인") {
        const info = getNotificationInfo();
        msg.reply(info);
    }

    // !알림도움 명령어
    else if (content === "!알림도움") {
        const helpText =
            "[정기 알림 봇 명령어]\n\n" +
            "!알림로드 - EC2에서 알림 데이터 다시 로드\n" +
            "!알림확인 - 현재 로드된 알림 개수 확인\n" +
            "!알림도움 - 이 도움말 표시\n\n" +
            "※ 알림은 자동으로 매일 00:10에 업데이트됩니다.";
        msg.reply(helpText);
    }}
bot.addListener(Event.MESSAGE, onMessage);


/**
 * (string) msg.content: 메시지의 내용
 * (string) msg.room: 메시지를 받은 방 이름
 * (User) msg.author: 메시지 전송자
 * (string) msg.author.name: 메시지 전송자 이름
 * (Image) msg.author.avatar: 메시지 전송자 프로필 사진
 * (string) msg.author.avatar.getBase64()
 * (boolean) msg.isDebugRoom: 디버그룸에서 받은 메시지일 시 true
 * (boolean) msg.isGroupChat: 단체/오픈채팅 여부
 * (string) msg.packageName: 메시지를 받은 메신저의 패키지명
 * (void) msg.reply(string): 답장하기
 * (string) msg.command: 명령어 이름
 * (Array) msg.args: 명령어 인자 배열
 */
function onCommand(msg) {}
bot.setCommandPrefix("@"); //@로 시작하는 메시지를 command로 판단
bot.addListener(Event.COMMAND, onCommand);


function onCreate(savedInstanceState, activity) {
    var textView = new Packages.android.widget.TextView(activity);
    textView.setText("Hello, World!");
    textView.setTextColor(Packages.android.graphics.Color.DKGRAY);
    activity.setContentView(textView);
}

function onStart(activity) {}

function onResume(activity) {}

function onPause(activity) {}

function onStop(activity) {}

function onRestart(activity) {}

function onDestroy(activity) {}

function onBackPressed(activity) {}

bot.addListener(Event.Activity.CREATE, onCreate);
bot.addListener(Event.Activity.START, onStart);
bot.addListener(Event.Activity.RESUME, onResume);
bot.addListener(Event.Activity.PAUSE, onPause);
bot.addListener(Event.Activity.STOP, onStop);
bot.addListener(Event.Activity.RESTART, onRestart);
bot.addListener(Event.Activity.DESTROY, onDestroy);
bot.addListener(Event.Activity.BACK_PRESSED, onBackPressed);