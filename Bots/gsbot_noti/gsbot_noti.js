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
// 이 봇은 기록만 한다. 카카오톡으로 나가는 것은 경보뿐이고 그마저 쿨다운이 있다.
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
// 모든 앱을 통틀어 알림이 이 시간 동안 0건이면 리스너 언바인드를 의심한다.
const SILENCE_ALERT_MS = 30 * 60 * 1000;
// 심야에는 아무도 대화하지 않아 30분 침묵이 정상이다. 그대로 두면 경보가
// 새벽에만 쏟아진다 — 2026-08-20 기준 51건 중 47건이 01~08시였다.
// 이 시간대에는 경보를 올리지 않고, 낮이 된 뒤 흐른 시간만 침묵으로 센다.
const QUIET_HOUR_END = 9;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;   // 같은 종류의 경보 재발송 간격

// ── 상태 ────────────────────────────────────────────────────────────────────
// 재컴파일되면 이 파일은 처음부터 다시 돈다. 누적값은 Database 에 실어 나른다.
const state = loadState();

// 짝 맞추기용 대기열. 채널별로 알림/메시지를 쌓아 두고 서로 만나면 지운다.
const notiQueue = {};   // channelId → [{ t }]
const msgQueue = {};    // channelId → [{ t }]
const roomNames = {};   // channelId → 방 이름 (Event.MESSAGE 에서만 알 수 있다)

let sweepTimer = null;
let summaryTimer = null;

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
        lastNotiAt: 0,
        lastMsgAt: 0,
        byChannel: {},       // channelId → { room, noti, msg, missed }
        alerts: {},          // 종류 → 마지막 발송 시각
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

/**
 * 경보 판단에 쓸 침묵 시간. 심야는 0 으로 본다.
 * 심야를 막 벗어났을 때는 낮이 된 뒤 흐른 시간까지만 센다 — 밤새 조용했다고
 * 아침 9시 정각에 경보가 터지면 그것도 거짓이다.
 */
function effectiveSilenceMs() {
    const since = nowMs() - (state.lastNotiAt || state.startedAt);

    const dayStart = new Date();
    dayStart.setHours(QUIET_HOUR_END, 0, 0, 0);
    const sinceDayStart = nowMs() - dayStart.getTime();

    if (sinceDayStart < 0) return 0;          // 아직 심야다
    return Math.min(since, sinceDayStart);
}

/** 같은 종류의 경보는 쿨다운 안에 다시 보내지 않는다. */
function alert(kind, text) {
    const last = state.alerts[kind] || 0;
    if (nowMs() - last < ALERT_COOLDOWN_MS) return false;
    state.alerts[kind] = nowMs();
    saveState();

    logEvent("alert", { kind: kind, text: text });
    try {
        bot.send(ADMIN_NAME, "[알림진단] " + text);
    } catch (e) {
        Log.e("경보 전송 실패: " + e);
    }
    return true;
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
        // 어느 방인지 같이 싣는다. 방 이름 없이 숫자만 오면 매번 기록을 뒤져야 한다.
        const where = missedRooms.length > 0 ? "\n대상: " + missedRooms.join(", ") : "";
        alert("missed",
            `알림은 왔는데 봇이 못 받은 메시지 ${newMissed}건 (누적 ${state.missedNoti}건)${where}\n` +
            "→ 원인 B. 알림 접근 권한을 껐다 켜면 리스너가 다시 붙습니다.");
    }

    // 모든 앱을 통틀어 알림이 오래 0건이면 리스너 자체가 떨어진 것으로 본다.
    const silence = effectiveSilenceMs();
    if (silence > SILENCE_ALERT_MS) {
        alert("silence",
            `${Math.round(silence / 60000)}분간 알림이 한 건도 없습니다 — 리스너 언바인드 의심\n` +
            `noti=${state.notiTotal} msg=${state.msgTotal}`);
    }

    saveState();
}

// ── 리스너 ──────────────────────────────────────────────────────────────────

bot.addListener(Event.NOTIFICATION_POSTED, function (sbn) {
    try {
        state.notiTotal++;
        state.lastNotiAt = nowMs();

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
    // 막 띄운 직후에는 알림이 0건인 게 정상이다. 그걸 언바인드로 부르면
    // 재컴파일할 때마다 거짓 경보처럼 읽힌다.
    if (state.notiTotal === 0) {
        const observedMs = nowMs() - state.startedAt;
        if (observedMs < SILENCE_ALERT_MS) {
            return `관측 ${Math.round(observedMs / 60000)}분 · 아직 판단할 데이터 없음`;
        }
        return "알림이 한 건도 안 들어옴 — 리스너 언바인드 의심";
    }
    if (state.missedNoti > 0) return "B (알림은 떴는데 봇이 못 받음) 사례 있음";
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
    saveState();
    Log.d("컴파일 시작: 진단 타이머를 정리했습니다.");
});

sweepTimer = setInterval(sweep, SWEEP_MS);
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
