const bot = BotManager.getCurrentBot();

if (typeof TimeAlarmManager === 'undefined') {
    var TimeAlarmManager = {
        intervalId: null,
        initialTimeoutId: null,
        lastNotifiedTime: null,
        notifications: [], // 알림 데이터 저장
        dataLoadIntervalId: null // 데이터 로드 타이머 ID
    };
}

const TARGET_ROOMS = ["06-21", "집사 네 마리", "아케인 편안길드", "무친자들의 모임", "앙메톡", "그녀석의 재획교실"]; // 알림을 보낼 방 목록
const EC2_API_URL = "http://ec2-3-34-171-56.ap-northeast-2.compute.amazonaws.com:3000/api/intervalMessage/all"; // EC2 엔드포인트 URL
const FCM_API_URL = "http://ec2-3-34-171-56.ap-northeast-2.compute.amazonaws.com:3000/api/fcm/send-all"; // fcm 알림 전송 URL
// 관리자 설정 (명령어를 사용할 수 있는 사용자)
const ADMIN_USERS = ["승엽[EmotionB_SY]"]; // 관리자 이름 목록

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

        const reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"));
        const response = new StringBuilder();
        let line;

        while ((line = reader.readLine()) !== null) {
            response.append(line);
        }
        reader.close();

        const jsonString = String(response.toString());
        TimeAlarmManager.notifications = JSON.parse(jsonString);


        const count = TimeAlarmManager.notifications.length;
        Log.i("EC2에서 " + count + "개의 알림 데이터를 성공적으로 로드했습니다.");
        bot.send("승엽[EmotionB_SY]", "EC2에서 " + count + "개의 알림 데이터를 성공적으로 로드했습니다.");

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

// 매일 00시 10분에 데이터 로드하는 함수
function scheduleDataLoad() {
    // 스크립트 시작 시 즉시 한 번 로드
    const initialResult = fetchNotificationsFromEC2();
    if (initialResult.success) {
        Log.i("초기 데이터 로드 완료: " + initialResult.count + "개");
    }

    function getMillisUntilNextLoad() {
        const now = new Date();
        const koreaOffset = 9 * 60;
        const localOffset = now.getTimezoneOffset();
        const koreaTime = new Date(now.getTime() + (koreaOffset + localOffset) * 60 * 1000);

        const nextLoad = new Date(koreaTime);
        nextLoad.setHours(0, 10, 0, 0);

        // 이미 오늘 00시 10분이 지났다면 내일로 설정
        if (koreaTime.getHours() > 0 || (koreaTime.getHours() === 0 && koreaTime.getMinutes() >= 10)) {
            nextLoad.setDate(nextLoad.getDate() + 1);
        }

        return nextLoad.getTime() - koreaTime.getTime();
    }

    // 타이머가 이미 있으면 제거
    if (TimeAlarmManager.dataLoadIntervalId) {
        clearInterval(TimeAlarmManager.dataLoadIntervalId);
        TimeAlarmManager.dataLoadIntervalId = null;
    }

    const msUntilFirstLoad = getMillisUntilNextLoad();
    const hoursUntil = Math.floor(msUntilFirstLoad / 1000 / 60 / 60);
    const minutesUntil = Math.floor((msUntilFirstLoad / 1000 / 60) % 60);
    Log.i(`다음 자동 데이터 로드까지 ${hoursUntil}시간 ${minutesUntil}분 대기합니다.`);

    setTimeout(() => {
        Log.i("예약된 시간(00:10)에 도달하여 데이터를 로드합니다.");
        const result = fetchNotificationsFromEC2();
        if (result.success) {
            Log.i("예약 로드 완료: " + result.count + "개");
        }

        // 이후 24시간마다 반복
        TimeAlarmManager.dataLoadIntervalId = setInterval(() => {
            Log.i("예약된 시간(00:10)에 도달하여 데이터를 로드합니다.");
            const result = fetchNotificationsFromEC2();
            if (result.success) {
                Log.i("예약 로드 완료: " + result.count + "개");
            }
        }, 24 * 60 * 60 * 1000); // 24시간

    }, msUntilFirstLoad);
}

function checkTimeAndNotify() {
    try {
        const now = new Date();

        // 중복 알림 방지
        const currentMinute = now.getTime() - (now.getTime() % 60000);
        if (TimeAlarmManager.lastNotifiedTime === currentMinute) {
            return;
        }

        // 알림 데이터가 없으면 종료
        if (!TimeAlarmManager.notifications || TimeAlarmManager.notifications.length === 0) {
            return;
        }

        // 모든 알림 데이터 확인
        TimeAlarmManager.notifications.forEach(notification => {
            try {
                let shouldSend = false;

                // 1. 특정 날짜와 시간 체크
                if (notification.year !== undefined &&
                    notification.month !== undefined &&
                    notification.day !== undefined &&
                    notification.hour !== undefined &&
                    notification.minute !== undefined) {

                    shouldSend = isExactDayAndTime(
                        notification.year,
                        notification.month,
                        notification.day,
                        notification.hour,
                        notification.minute
                    );

                    if (shouldSend) {
                        Log.d(`특정 날짜 알림 조건 충족: ${notification.year}-${notification.month}-${notification.day} ${notification.hour}:${notification.minute}`);
                    }
                }
                // 2. 요일과 시간 체크
                else if (notification.dayOfWeek !== undefined &&
                    notification.hour !== undefined &&
                    notification.minute !== undefined) {

                    shouldSend = isExactDayOfWeekAndTime(
                        notification.dayOfWeek,
                        notification.hour,
                        notification.minute
                    );

                    if (shouldSend) {
                        Log.d(`요일 알림 조건 충족: ${notification.dayOfWeek}요일 ${notification.hour}:${notification.minute}`);
                    }
                }

                // 조건이 맞으면 메시지 전송
                if (shouldSend && notification.message) {
                    TARGET_ROOMS.forEach(roomName => {
                        bot.send(roomName, notification.message);
                        Log.i(`'${roomName}' 방에 알림 전송: ${notification.message}`);
                    });

                    // 중복 알림 방지를 위해 시간 기록
                    TimeAlarmManager.lastNotifiedTime = currentMinute;
                }

            } catch (e) {
                Log.e("개별 알림 처리 중 오류: " + e);
                bot.send("승엽[EmotionB_SY]", "개별 알림 처리 중 오류: " + e);
            }
        });

    } catch (e) {
        Log.e("시간 확인 및 알림 전송 중 오류 발생: " + e);
        bot.send("승엽[EmotionB_SY]", "시간 확인 및 알림 전송 중 오류 발생: " + e);
    }
}


function isExactDayAndTime(year, month, day, hour, minute) {
    let now = new Date();

    // UTC 시간을 한국 시간(+9시간)으로 변환
    let koreaOffset = 9 * 60; // 한국은 UTC+9
    let localOffset = now.getTimezoneOffset(); // 현재 로컬 타임존의 UTC 차이 (분)
    let koreaTime = new Date(now.getTime() + (koreaOffset + localOffset) * 60 * 1000);

    return koreaTime.getFullYear() === year &&
        koreaTime.getMonth() === month - 1 && // getMonth()는 0부터 시작
        koreaTime.getDate() === day &&
        koreaTime.getHours() === hour &&
        koreaTime.getMinutes() === minute;
}

function isExactDayOfWeekAndTime(dayName, hour, minute) {
    const days = {
        '일': 0, 'sunday': 0, 'sun': 0,
        '월': 1, 'monday': 1, 'mon': 1,
        '화': 2, 'tuesday': 2, 'tue': 2,
        '수': 3, 'wednesday': 3, 'wed': 3,
        '목': 4, 'thursday': 4, 'thu': 4,
        '금': 5, 'friday': 5, 'fri': 5,
        '토': 6, 'saturday': 6, 'sat': 6
    };

    // UTC 시간을 한국 시간(+9시간)으로 변환
    let now = new Date();
    let koreaOffset = 9 * 60; // 한국은 UTC+9
    let localOffset = now.getTimezoneOffset(); // 현재 로컬 타임존의 UTC 차이 (분)
    let koreaTime = new Date(now.getTime() + (koreaOffset + localOffset) * 60 * 1000);

    let dayOfWeek = days[dayName.toLowerCase()];

    return koreaTime.getDay() === dayOfWeek &&
        koreaTime.getHours() === hour &&
        koreaTime.getMinutes() === minute;
}

function startSyncedAlarmService() {
    if (TimeAlarmManager.intervalId || TimeAlarmManager.initialTimeoutId) {
        Log.d("알람 서비스가 이미 실행 중이거나 예약되어 있습니다.");
        return;
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

// 현재 로드된 알림 정보를 확인하는 함수
function getNotificationInfo() {
    if (!TimeAlarmManager.notifications || TimeAlarmManager.notifications.length === 0) {
        return "현재 로드된 알림이 없습니다.";
    }

    let exactCount = 0;
    let weeklyCount = 0;

    TimeAlarmManager.notifications.forEach(n => {
        if (n.year !== undefined) {
            exactCount++;
        } else if (n.dayOfWeek !== undefined) {
            weeklyCount++;
        }
    });

    return `현재 로드된 알림:\n- 정확한 시간: ${exactCount}개\n- 요일 시간: ${weeklyCount}개\n- 총합: ${TimeAlarmManager.notifications.length}개`;
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