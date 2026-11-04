// ─────────────────────────────────────────────────────────────────────────────
// gsbot_noti — 알림 누락 진단
//
// 봇이 메시지를 놓쳤을 때, 원인은 둘 중 하나인데 봇 입장에서는 구분이 안 된다.
//
//   A. 안드로이드가 알림을 아예 안 띄웠다 (카톡이 그 방을 열고 있음 / 방해금지 /
//      방별 알림 끄기 / Doze). 봇 책임 밖이다.
//   B. 알림은 떴는데 봇이 못 받았다 (NotificationListenerService 언바인드,
//      번들링, 컴파일 중 도착). 이건 조치할 수 있다.
//
// Event.MESSAGE 만 보면 둘 다 "아무 일도 없었음" 으로 똑같이 보인다.
// Event.NOTIFICATION_POSTED 로 원시 알림을 따로 세면 갈린다.
//
//   알림 O / 메시지 X  →  B
//   둘 다 0            →  A 또는 언바인드
//
// ── 실기기에서 확인한 것 (2026-08-13, b0q / Android 16) ─────────────────────
//
// 1. 카카오톡은 메시지 1건마다 알림을 두 개 올린다.
//      id=1 tag=null      flags=512(GROUP_SUMMARY) channel=quiet_new_message  ← 묶음 요약
//      id=2 tag=<채널id>  flags=17                 channel=new_message_v1     ← 진짜
//    요약을 같이 세면 알림이 메시지의 두 배로 보여 없는 누락이 생긴다. 걸러낸다.
//
// 2. 알림의 getTag() 가 Event.MESSAGE 의 channelId 와 같은 값이다.
//    (실측: tag 18276783039076919 = msg.channelId 18276783039076919)
//    덕분에 총량 비교가 아니라 알림 1건과 메시지 1건을 짝지어 볼 수 있다.
//    어느 방에서 새는지까지 나온다.
//
// 3. Event.TICK 은 20ms 주기(50Hz)라 주기 작업에 쓰면 안 된다. setInterval 을 쓴다.
//
// 4. 카톡 알림이라고 다 메시지가 되는 것은 아니다. 메신저봇은 알림의 "답장"
//    액션(RemoteInput)으로 메시지를 만들고 답한다. 그 액션이 없는 알림은
//    Event.MESSAGE 가 될 수 없으므로 짝을 지을 대상이 아니다.
//
//      아케인 편안길드  actions = [0] "읽음"  [1] "답장"   ← RemoteInput 있음
//      카카오톡 선물하기 actions = [0] "읽음"              ← 없음
//
//    이걸 세는 바람에 "카카오톡 선물하기" 채널의 광고가 매일 한 건씩 누락으로
//    잡혔다. 2026-08-20 기준 누적 누락 10건 중 9건이 이것이었다.
//
// 5. 메신저봇이 재시작된 뒤 리스너가 "붙어 있는데 아무것도 안 오는" 상태가 된다.
//    dumpsys 로는 메신저봇이 Live listener 로 보이는데 onNotificationPosted 가
//    한 번도 불리지 않는다. 앱 프로세스를 다시 띄워도 안 풀리고, 알림 접근 권한을
//    껐다 켜야만 풀린다. 간헐적이다 (재시작 10번 중 2번: 09-10, 10-01).
//      2026-10-01 14:44 정전 후 부팅 → 알림 0건이 36시간 → 10-03 권한 토글로 복구
//    스크립트에서 고칠 수는 없었다 (2026-10-03 실험). 리스너 컴포넌트를
//    disable → enable 하면 풀리기만 하고 다시 붙지 않으며, requestRebind() 는
//    아무 반응이 없다. 할 수 있는 것은 빨리 알아채고 사람에게 알리는 것뿐이다.
//
//    그래서 알림이 한동안 없으면 봇이 자기 알림(프로브)을 하나 올려 본다.
//    메신저봇 자신의 알림도 리스너로 들어오므로, 돌아오지 않으면 리스너가 죽은
//    것이다. 경보는 카톡이 아니라 FCM 푸시로 보낸다 — 리스너가 죽으면 카톡
//    답장 세션도 같이 끊겨 bot.send 가 나가지 못한다 (이번에 경보 72건이
//    하나도 도착하지 않았다).
//
// 이 봇은 기록만 한다. 밖으로 나가는 것은 경보(푸시 + 카톡)뿐이고 그마저 쿨다운이 있다.
// 실제 데이터는 EVENT_LOG 에 쌓이므로 adb 로 꺼내 본다.
//
//   adb shell cat /sdcard/msgbot/noti-diag/events.jsonl
// ─────────────────────────────────────────────────────────────────────────────

const bot = BotManager.getCurrentBot();

const ADMIN_NAME = "승엽[EmotionB_SY]";
const KAKAO_PACKAGE = "com.kakao.talk";

// android.app.Notification.FLAG_GROUP_SUMMARY
const FLAG_GROUP_SUMMARY = 512;

const DIAG_DIR = "/sdcard/msgbot/noti-diag";
const EVENT_LOG = DIAG_DIR + "/events.jsonl";
const STATE_FILE = "state.json";           // 봇 전용 Database (재컴파일 후에도 남는다)

// 알림과 메시지는 순서가 보장되지 않아 서로 기다려 준다. 이 시간을 넘겨도
// 짝이 안 맞으면 진짜 누락으로 본다.
const PAIR_GRACE_MS = 20 * 1000;
const SWEEP_MS = 60 * 1000;                 // 짝 안 맞은 것 걷어내는 주기
const SUMMARY_MS = 10 * 60 * 1000;          // 요약 적재 주기
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;   // 같은 종류의 경보 재발송 간격

// ── 리스너 생존 확인 (프로브) ──
// 예전에는 "30분간 알림 0건" 으로 언바인드를 짐작했다. 새벽에는 그게 정상이라
// 오탐이 쏟아졌고(2026-08-20 기준 51건 중 47건이 01~08시), 그래서 심야를 빼고
// 셌더니 정작 밤사이 끊기면 아침 9시 반에야 알았다. 프로브는 시간대와 무관하다.
const PACKAGE_SELF = "com.xfl.msgbot";
const PROBE_TAG = "gsbot_noti-probe";
const PROBE_ID = 7301;
// 메신저봇이 만들어 둔 채널. 중요도 2(낮음)라 소리·진동 없이 잠깐 떴다 사라진다.
const PROBE_CHANNEL = "com.xfl.msgbot.notification.compile_status";
const PROBE_IDLE_MS = 10 * 60 * 1000;       // 알림이 이만큼 없으면 프로브를 쏜다
const PROBE_TIMEOUT_MS = 15 * 1000;         // 이 안에 안 돌아오면 리스너가 죽은 것
// 재시작 직후가 제일 위험하다(5번 항목). 컴파일되고 이만큼 뒤에 한 번 확인한다.
const PROBE_AFTER_START_MS = 60 * 1000;
// 리스너가 죽어 있는 동안 경보 재발송 간격. 사람이 폰을 만질 때까지 계속 운다.
const DEAD_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// 경보는 관리자 앱(Flutter)으로 FCM 푸시를 보낸다. gsbot_loop 와 같은 경로다.
const FCM_API_URL = "https://botapi.maple-ing.com/api/fcm/send-all";
// 봇 서버 토큰. 저장소가 공개라 코드에 두지 않고 폰의 Database 에만 둔다.
// Database 는 봇별로 나뉘어 gsbot, gsbot_loop 와 따로 넣어야 한다. 파일이 없으면 헤더 없이 보낸다.
const BOT_API_TOKEN_FILE = "bot_api_token.txt";

// 누락 하나로는 경보를 올리지 않는다.
//
// 예전에는 한 건만 새도 "권한을 껐다 켜면 리스너가 다시 붙습니다" 라는 조치
// 안내가 나갔다. 실제 빈도는 열흘에 한두 건이고(2026-08-13 ~ 08-21: 알림
// 5,000건 중 진짜 누락 2건) 그때마다 리스너를 다시 붙일 일은 아니다. 조치가
// 필요한 것은 짧은 시간에 여러 건이 몰릴 때다 — 리스너가 떨어지면 방을 가리지
// 않고 한꺼번에 샌다. 단발은 경보 없이 기록에만 남기고, /알림진단 에는 그대로
// 보인다.
const MISSED_WINDOW_MS = 6 * 60 * 60 * 1000;
const MISSED_BURST = 3;

// ── 상태 ────────────────────────────────────────────────────────────────────
// 재컴파일되면 이 파일은 처음부터 다시 돈다. 누적값은 Database 에 실어 나른다.
const state = loadState();

// 짝 맞추기용 대기열. 채널별로 알림/메시지를 쌓아 두고 서로 만나면 지운다.
const notiQueue = {};   // channelId → [{ t }]
const msgQueue = {};    // channelId → [{ t }]
const roomNames = {};   // channelId → 방 이름 (Event.MESSAGE 에서만 알 수 있다)

let sweepTimer = null;
let summaryTimer = null;
let startProbeTimer = null;

// 응답을 기다리는 프로브. 한 번에 하나만 띄운다.
let pendingProbe = null;    // { sentAt, timer, reason }

function nowMs() { return Date.now(); }

function defaultState() {
    return {
        startedAt: nowMs(),
        notiTotal: 0,        // 모든 앱의 알림
        notiKakao: 0,        // 카카오톡 알림 (요약 포함)
        notiSummary: 0,      // 그중 GROUP_SUMMARY
        notiNoReply: 0,      // 그중 답장 액션이 없는 것 (채널 광고 등) — 짝 대상 아님
        notiMessage: 0,      // 그중 실제 메시지 알림 — 이게 비교 대상이다
        msgTotal: 0,         // Event.MESSAGE
        paired: 0,           // 알림과 메시지가 짝을 이룬 건수
        missedNoti: 0,       // 알림은 왔는데 메시지가 안 온 건수 → B 후보
        msgWithoutNoti: 0,   // 메시지는 왔는데 알림 기록이 없는 건수 (번들링 등)
        recentMissed: [],    // 최근 누락 시각. 몰려서 나는지 보려고 창 안의 것만 남긴다
        lastNotiAt: 0,
        lastMsgAt: 0,
        byChannel: {},       // channelId → { room, noti, msg, missed }
        alerts: {},          // 종류 → 마지막 발송 시각
        lastProbeAt: 0,      // 마지막으로 프로브를 쏜 시각
        lastProbeOkAt: 0,    // 마지막으로 프로브가 돌아온 시각
        probeFailed: 0,      // 프로브가 안 돌아온 횟수 (누적)
        listenerDeadSince: 0, // 리스너가 죽었다고 판정한 시각. 0 이면 살아 있음
    };
}

function loadState() {
    try {
        if (Database.exists(STATE_FILE)) {
            const parsed = JSON.parse(Database.readString(STATE_FILE));
            if (parsed && typeof parsed === "object") {
                // 필드가 늘어나도 예전 파일이 그대로 살아나도록 기본값 위에 덮는다
                return Object.assign(defaultState(), parsed);
            }
        }
    } catch (e) {
        Log.e("상태 파일을 읽지 못했습니다: " + e);
    }
    return defaultState();
}

function saveState() {
    try {
        Database.writeString(STATE_FILE, JSON.stringify(state));
    } catch (e) {
        Log.e("상태 저장 실패: " + e);
    }
}

function channelStat(channelId) {
    if (!state.byChannel[channelId]) {
        state.byChannel[channelId] = { room: roomNames[channelId] || null, noti: 0, msg: 0, missed: 0 };
    }
    if (!state.byChannel[channelId].room && roomNames[channelId]) {
        state.byChannel[channelId].room = roomNames[channelId];
    }
    return state.byChannel[channelId];
}

/** 진단 기록은 한 줄 JSON 으로 쌓는다. 나중에 adb 로 꺼내 그대로 파싱한다. */
function logEvent(type, data) {
    try {
        if (!FileStream.exists(DIAG_DIR)) FileStream.createDir(DIAG_DIR);
        const line = JSON.stringify(Object.assign({ t: nowMs(), type: type }, data));
        FileStream.append(EVENT_LOG, line + "\n");
    } catch (e) {
        Log.e("기록 실패: " + e);
    }
}

function deviceSnapshot() {
    const snap = {};
    const probes = {
        battery: function () { return Device.getBatteryLevel(); },
        charging: function () { return Device.isCharging(); },
        powerSave: function () { return Device.isPowerSaveMode(); },
        screenOn: function () { return Device.isScreenOn(); },
        freeMemory: function () { return Device.getFreeMemory(); },
    };
    for (const key in probes) {
        try { snap[key] = probes[key](); } catch (e) { snap[key] = null; }
    }
    return snap;
}

/**
 * 이 알림이 Event.MESSAGE 가 될 수 있는가.
 *
 * 메신저봇은 "답장" 액션에 실린 RemoteInput 으로 메시지를 만들고 답한다.
 * 그게 없으면 봇이 받을 방법 자체가 없으므로 누락으로 셀 대상이 아니다.
 * 구조를 못 읽으면 true 로 둔다 — 세는 쪽이 진짜 누락을 놓치지 않는다.
 */
function hasReplyAction(notification) {
    try {
        const actions = notification.actions;
        if (!actions) return false;
        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            if (!action) continue;
            const inputs = action.getRemoteInputs();
            if (inputs && inputs.length > 0) return true;
        }
        return false;
    } catch (e) {
        Log.e("답장 액션 확인 실패: " + e);
        return true;
    }
}

function setBotToken(connection) {
    try {
        if (Database.exists(BOT_API_TOKEN_FILE)) {
            const token = String(Database.readString(BOT_API_TOKEN_FILE) || "").trim();
            if (token) connection.setRequestProperty("X-Bot-Token", token);
        }
    } catch (e) {
        Log.e("봇 서버 토큰을 읽지 못했습니다: " + e);
    }
}

/**
 * 관리자 앱으로 FCM 푸시를 보낸다. 성공 여부만 돌려주고 예외는 삼킨다.
 * data 값은 서버(FCM)가 문자열만 받는다.
 */
function sendPush(title, body, data) {
    try {
        const URL = Packages.java.net.URL;
        const OutputStreamWriter = Packages.java.io.OutputStreamWriter;

        const connection = new URL(FCM_API_URL).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(10000);
        connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        setBotToken(connection);

        const writer = new OutputStreamWriter(connection.getOutputStream(), "UTF-8");
        writer.write(JSON.stringify({ title: title, body: body, data: data || {} }));
        writer.flush();
        writer.close();

        const code = connection.getResponseCode();
        connection.disconnect();
        if (code !== 200) Log.e("푸시 전송 실패: HTTP " + code);
        return code === 200;
    } catch (e) {
        Log.e("푸시 전송 오류: " + e);
        return false;
    }
}

/**
 * 같은 종류의 경보는 쿨다운 안에 다시 보내지 않는다.
 * 푸시가 주 경로다. 카톡(bot.send)은 리스너가 살아 있을 때만 닿으므로 덤으로 보낸다.
 */
function alert(kind, text, cooldownMs) {
    const last = state.alerts[kind] || 0;
    if (nowMs() - last < (cooldownMs || ALERT_COOLDOWN_MS)) return false;
    state.alerts[kind] = nowMs();
    saveState();

    const pushed = sendPush("[알림진단] " + kind, text, { type: "gsbot_noti", kind: kind });
    let sent = false;
    try {
        sent = !!bot.send(ADMIN_NAME, "[알림진단] " + text);
    } catch (e) {
        Log.e("경보 전송 실패: " + e);
    }
    logEvent("alert", { kind: kind, text: text, pushed: pushed, sent: sent });
    return true;
}

// ── 리스너 생존 확인 ─────────────────────────────────────────────────────────
// 자기 알림을 하나 올리고 NOTIFICATION_POSTED 로 돌아오는지 본다.
// 안드로이드 API 를 직접 부르는 곳은 여기 두 함수뿐이다.

function notificationManager() {
    const context = App.getContext();
    return context.getSystemService(Packages.android.content.Context.NOTIFICATION_SERVICE);
}

function postProbeNotification() {
    const context = App.getContext();
    const notification = new Packages.android.app.Notification.Builder(context, PROBE_CHANNEL)
        .setSmallIcon(Packages.android.R.drawable.stat_notify_sync)
        .setContentTitle("알림 리스너 확인")
        .setOnlyAlertOnce(true)
        .setTimeoutAfter(PROBE_TIMEOUT_MS)   // 못 지우고 끝나도 알아서 사라진다
        .build();
    notificationManager().notify(PROBE_TAG, PROBE_ID, notification);
}

function cancelProbeNotification() {
    try {
        notificationManager().cancel(PROBE_TAG, PROBE_ID);
    } catch (e) {
        Log.e("프로브 알림 정리 실패: " + e);
    }
}

function isProbe(sbn) {
    return String(sbn.getPackageName()) === PACKAGE_SELF && String(sbn.getTag()) === PROBE_TAG;
}

/** 프로브를 쏜다. 이미 기다리는 중이면 아무것도 안 한다. */
function startProbe(reason) {
    if (pendingProbe) return false;
    try {
        postProbeNotification();
    } catch (e) {
        // 알림을 못 올린 것은 리스너 탓이 아니다. 판정하지 않는다.
        Log.e("프로브 알림을 올리지 못했습니다: " + e);
        logEvent("probeError", { reason: reason, error: String(e) });
        return false;
    }
    state.lastProbeAt = nowMs();
    pendingProbe = {
        sentAt: nowMs(),
        reason: reason,
        timer: setTimeout(onProbeTimeout, PROBE_TIMEOUT_MS),
    };
    return true;
}

function onProbeTimeout() {
    if (!pendingProbe) return;
    const probe = pendingProbe;
    pendingProbe = null;
    cancelProbeNotification();

    state.probeFailed++;
    if (!state.listenerDeadSince) state.listenerDeadSince = probe.sentAt;
    logEvent("probeFailed", {
        reason: probe.reason,
        deadSince: state.listenerDeadSince,
        lastNotiAt: state.lastNotiAt,
        device: deviceSnapshot(),
    });

    const silentMin = Math.round((nowMs() - (state.lastNotiAt || state.startedAt)) / 60000);
    alert("dead",
        `알림 리스너가 끊겼습니다 — 봇이 카톡을 못 받고 있습니다 (마지막 알림 ${silentMin}분 전)\n` +
        "→ 설정 > 애플리케이션 > 특별한 접근 > 알림 읽기, 답장 및 제어 > 메신저봇 끄고 다시 켜기",
        DEAD_ALERT_COOLDOWN_MS);
    saveState();
}

/** 리스너로 무엇이든 들어왔다 = 살아 있다. 죽었다고 봤던 상태면 복구로 기록한다. */
function markListenerAlive(via) {
    if (!state.listenerDeadSince) return;
    const downMin = Math.round((nowMs() - state.listenerDeadSince) / 60000);
    logEvent("listenerRecovered", { via: via, deadSince: state.listenerDeadSince, downMin: downMin });
    state.listenerDeadSince = 0;
    state.alerts.dead = 0;      // 다음에 또 끊기면 바로 알린다
    saveState();
    // 리스너 콜백 안에서 네트워크를 타지 않는다. 다른 알림 처리가 밀린다.
    setTimeout(function () {
        sendPush("[알림진단] 복구", `알림 리스너가 다시 붙었습니다 (${downMin}분간 끊김)`,
            { type: "gsbot_noti", kind: "recovered" });
    }, 0);
}

function onProbeReturned() {
    if (pendingProbe) {
        clearTimeout(pendingProbe.timer);
        pendingProbe = null;
    }
    cancelProbeNotification();
    state.lastProbeOkAt = nowMs();
    markListenerAlive("probe");
}

/** 알림이 한동안 없었고 최근에 확인한 적도 없으면 프로브를 쏜다. */
function probeIfIdle() {
    const lastSign = Math.max(state.lastNotiAt, state.lastProbeAt, state.startedAt);
    if (nowMs() - lastSign >= PROBE_IDLE_MS) startProbe("idle");
}

// ── 짝 맞추기 ────────────────────────────────────────────────────────────────
// 알림이 먼저 올 수도, Event.MESSAGE 가 먼저 올 수도 있다. 어느 쪽이 오든
// 반대편 대기열을 먼저 보고, 있으면 그 자리에서 짝을 짓는다.

function pair(queueMine, queueOther, channelId, entry) {
    const other = queueOther[channelId];
    if (other && other.length > 0) {
        other.shift();
        state.paired++;
        return true;
    }
    if (!queueMine[channelId]) queueMine[channelId] = [];
    queueMine[channelId].push(entry);
    return false;
}

/** 유예 시간을 넘긴 미매칭 항목을 정리한다. 알림 쪽이 남으면 그게 누락(B)이다. */
function sweep() {
    const cutoff = nowMs() - PAIR_GRACE_MS;
    let newMissed = 0;
    const missedRooms = [];

    for (const channelId in notiQueue) {
        const queue = notiQueue[channelId];
        while (queue.length > 0 && queue[0].t < cutoff) {
            queue.shift();
            state.missedNoti++;
            channelStat(channelId).missed++;
            newMissed++;
            const where = roomNames[channelId] || ("채널 " + channelId);
            if (missedRooms.indexOf(where) < 0) missedRooms.push(where);
            logEvent("missed", {
                channelId: channelId,
                room: roomNames[channelId] || null,
                device: deviceSnapshot(),
            });
        }
        if (queue.length === 0) delete notiQueue[channelId];
    }

    for (const channelId in msgQueue) {
        const queue = msgQueue[channelId];
        while (queue.length > 0 && queue[0].t < cutoff) {
            queue.shift();
            state.msgWithoutNoti++;
        }
        if (queue.length === 0) delete msgQueue[channelId];
    }

    if (newMissed > 0) {
        // 창 밖으로 나간 것은 버리고 방금 것을 넣는다.
        const windowStart = nowMs() - MISSED_WINDOW_MS;
        const recent = [];
        for (let i = 0; i < state.recentMissed.length; i++) {
            if (state.recentMissed[i] > windowStart) recent.push(state.recentMissed[i]);
        }
        for (let i = 0; i < newMissed; i++) recent.push(nowMs());
        state.recentMissed = recent;

        // 어느 방인지 같이 싣는다. 방 이름 없이 숫자만 오면 매번 기록을 뒤져야 한다.
        const where = missedRooms.length > 0 ? "\n대상: " + missedRooms.join(", ") : "";
        const hours = Math.round(MISSED_WINDOW_MS / 3600000);

        if (recent.length >= MISSED_BURST) {
            alert("missed",
                `알림은 왔는데 봇이 못 받은 메시지가 ${hours}시간 안에 ${recent.length}건입니다 ` +
                `(누적 ${state.missedNoti}건)${where}\n` +
                "→ 원인 B. 알림 접근 권한을 껐다 켜면 리스너가 다시 붙습니다.");
        } else {
            // 단발은 조용히 둔다. 기록에는 이미 남았고 /알림진단 에서 보인다.
            Log.d(`누락 ${newMissed}건 (${hours}시간 내 ${recent.length}건) — 경보 기준 미만`);
        }
    }

    // 알림이 끊긴 게 조용해서인지 리스너가 죽어서인지는 프로브로 가린다.
    probeIfIdle();

    saveState();
}

// ── 리스너 ──────────────────────────────────────────────────────────────────

bot.addListener(Event.NOTIFICATION_POSTED, function (sbn) {
    try {
        // 메신저봇 자신의 알림은 통계에 넣지 않는다. lastNotiAt 도 건드리지 않는다 —
        // 그래야 다음 확인 시점이 "진짜 알림이 마지막으로 온 때" 기준으로 잡힌다.
        // 프로브를 올리면 안드로이드가 메신저봇 알림을 자동으로 묶으면서 그룹 요약을
        // 하나 더 올리는데(실측 2026-10-03), 그것도 여기서 걸러진다.
        if (String(sbn.getPackageName()) === PACKAGE_SELF) {
            if (isProbe(sbn)) onProbeReturned();
            return;
        }

        state.notiTotal++;
        state.lastNotiAt = nowMs();
        markListenerAlive("notification");

        if (String(sbn.getPackageName()) !== KAKAO_PACKAGE) return;
        state.notiKakao++;

        // 묶음 요약은 메시지 1건이 아니다. 세면 알림이 두 배로 보인다.
        const notification = sbn.getNotification();
        if (notification && (notification.flags & FLAG_GROUP_SUMMARY) !== 0) {
            state.notiSummary++;
            return;
        }

        // 답장 액션이 없는 알림은 애초에 Event.MESSAGE 가 될 수 없다.
        // 카톡 채널(선물하기 등) 광고가 여기 걸린다.
        if (notification && !hasReplyAction(notification)) {
            state.notiNoReply++;
            return;
        }

        const tag = sbn.getTag();
        if (tag === null) return;           // 방을 특정할 수 없는 알림은 짝을 못 짓는다
        const channelId = String(tag);

        state.notiMessage++;
        channelStat(channelId).noti++;
        pair(notiQueue, msgQueue, channelId, { t: nowMs() });
    } catch (e) {
        Log.e("알림 처리 실패: " + e);
    }
});

bot.addListener(Event.MESSAGE, function (msg) {
    try {
        if (msg.isDebugRoom) {
            handleCommand(msg);
            return;
        }
        if (String(msg.packageName) !== KAKAO_PACKAGE) return;

        const channelId = String(msg.channelId);
        roomNames[channelId] = String(msg.room);

        state.msgTotal++;
        state.lastMsgAt = nowMs();
        markListenerAlive("message");
        channelStat(channelId).msg++;
        pair(msgQueue, notiQueue, channelId, { t: nowMs() });

        handleCommand(msg);
    } catch (e) {
        Log.e("메시지 처리 실패: " + e);
    }
});

// ── 조회 명령 ────────────────────────────────────────────────────────────────
// 디버그룸(소켓)과 관리자에게만 답한다. hash 가 null 이면 소켓으로 주입된
// 메시지라 이름을 위조한 것일 수 있다 — 디버그룸이 아닌 곳에서는 거른다.

function isAllowed(msg) {
    if (msg.isDebugRoom) return true;
    return String(msg.author.name) === ADMIN_NAME && msg.author.hash !== null;
}

function summaryText() {
    const uptimeMin = Math.round((nowMs() - state.startedAt) / 60000);
    const lines = [
        "[알림진단]",
        `관측 ${uptimeMin}분 · 마지막 알림 ${sinceText(state.lastNotiAt)} · 마지막 메시지 ${sinceText(state.lastMsgAt)}`,
        "",
        `전체 알림 ${state.notiTotal} (카톡 ${state.notiKakao} = 요약 ${state.notiSummary}` +
            ` + 답장불가 ${state.notiNoReply} + 메시지 ${state.notiMessage})`,
        `Event.MESSAGE ${state.msgTotal} · 짝 맞음 ${state.paired}`,
        `누락 의심(알림 O·메시지 X) ${state.missedNoti} · 알림 없이 온 메시지 ${state.msgWithoutNoti}`,
        `리스너 ${state.listenerDeadSince ? "끊김(" + sinceText(state.listenerDeadSince) + "부터)" : "정상"}` +
            ` · 프로브 확인 ${sinceText(state.lastProbeOkAt)} · 프로브 실패 누적 ${state.probeFailed}`,
    ];

    const channels = [];
    for (const channelId in state.byChannel) {
        const stat = state.byChannel[channelId];
        channels.push({ id: channelId, stat: stat });
    }
    channels.sort(function (a, b) { return b.stat.missed - a.stat.missed; });

    if (channels.length > 0) {
        lines.push("", "방별 (알림/메시지/누락)");
        for (let i = 0; i < channels.length && i < 10; i++) {
            const entry = channels[i];
            const name = entry.stat.room || ("채널 " + entry.id);
            lines.push(`- ${name} : ${entry.stat.noti}/${entry.stat.msg}/${entry.stat.missed}`);
        }
    }

    const device = deviceSnapshot();
    lines.push("", `배터리 ${device.battery}% 충전 ${device.charging} 절전 ${device.powerSave} 화면 ${device.screenOn}`);
    lines.push("판정: " + verdict());
    return lines.join("\n");
}

function verdict() {
    if (state.listenerDeadSince) {
        return "리스너 끊김 (프로브 미응답) — 알림 접근 권한을 껐다 켜야 함";
    }
    // 막 띄운 직후에는 알림이 0건인 게 정상이다. 그걸 언바인드로 부르면
    // 재컴파일할 때마다 거짓 경보처럼 읽힌다. 살아 있는지는 프로브가 말해 준다.
    if (state.notiTotal === 0) {
        const observedMin = Math.round((nowMs() - state.startedAt) / 60000);
        if (state.lastProbeOkAt) return `관측 ${observedMin}분 · 알림은 아직 없지만 리스너는 살아 있음`;
        return `관측 ${observedMin}분 · 아직 판단할 데이터 없음`;
    }
    if (state.missedNoti > 0) {
        // 같은 "1건" 이라도 열흘에 하나와 한 시간에 셋은 다른 이야기다.
        // 비율과 최근 몰림을 같이 적어 둔다.
        const rate = state.notiMessage > 0
            ? (state.missedNoti / state.notiMessage * 100).toFixed(2)
            : "?";
        const windowStart = nowMs() - MISSED_WINDOW_MS;
        let recent = 0;
        for (let i = 0; i < state.recentMissed.length; i++) {
            if (state.recentMissed[i] > windowStart) recent++;
        }
        const hours = Math.round(MISSED_WINDOW_MS / 3600000);
        if (recent >= MISSED_BURST) {
            return `B 사례가 ${hours}시간 안에 ${recent}건 — 리스너 재바인드 필요`;
        }
        return `B 사례 ${state.missedNoti}건 (메시지 알림의 ${rate}%) · 최근 ${hours}시간 ${recent}건 — 산발적`;
    }
    if (state.notiMessage === 0) return "카톡 메시지 알림이 아직 없음 — 더 관측 필요";
    return "지금까지는 누락 없음";
}

function sinceText(t) {
    if (!t) return "없음";
    const min = Math.round((nowMs() - t) / 60000);
    return min <= 0 ? "방금" : min + "분 전";
}

function handleCommand(msg) {
    const content = String(msg.content).trim();
    if (content !== "/알림진단" && content !== "/알림진단 초기화") return;
    if (!isAllowed(msg)) return;

    if (content === "/알림진단 초기화") {
        const previous = summaryText();
        logEvent("reset", { previous: previous });
        const kept = state.startedAt;
        const fresh = defaultState();
        for (const key in fresh) state[key] = fresh[key];
        state.startedAt = nowMs();
        saveState();
        msg.reply("[알림진단] 누적값을 지웠습니다. (이전 관측 시작 " +
            Math.round((nowMs() - kept) / 60000) + "분 전, 기록은 파일에 남았습니다)");
        return;
    }

    msg.reply(summaryText());
}

// ── 타이머 ──────────────────────────────────────────────────────────────────

bot.addListener(Event.START_COMPILE, function () {
    // 재컴파일 때 정리하지 않으면 타이머가 겹쳐서 돈다.
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
    if (startProbeTimer) { clearTimeout(startProbeTimer); startProbeTimer = null; }
    if (pendingProbe) {
        clearTimeout(pendingProbe.timer);
        pendingProbe = null;
        cancelProbeNotification();
    }
    saveState();
    Log.d("컴파일 시작: 진단 타이머를 정리했습니다.");
});

sweepTimer = setInterval(sweep, SWEEP_MS);
// 재시작 직후 리스너가 죽은 채로 붙는 경우가 있다(머리말 5번). 알림이 오기를
// 기다리지 않고 곧바로 확인한다.
startProbeTimer = setTimeout(function () {
    startProbeTimer = null;
    startProbe("start");
}, PROBE_AFTER_START_MS);
summaryTimer = setInterval(function () {
    logEvent("summary", {
        notiTotal: state.notiTotal,
        notiKakao: state.notiKakao,
        notiSummary: state.notiSummary,
        notiMessage: state.notiMessage,
        msgTotal: state.msgTotal,
        paired: state.paired,
        missedNoti: state.missedNoti,
        msgWithoutNoti: state.msgWithoutNoti,
        device: deviceSnapshot(),
    });
    saveState();
}, SUMMARY_MS);

logEvent("start", { device: deviceSnapshot(), carriedOver: state.notiTotal });
saveState();
