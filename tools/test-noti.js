#!/usr/bin/env node
/**
 * test-noti.js — gsbot_noti(알림 누락 진단)의 판정 로직 검증
 *
 * 알림과 메시지를 짝짓는 부분이 핵심이라 실기기에서 한참 기다려야 확인되는데,
 * 하니스에서는 알림·메시지·sweep 을 원하는 순서로 직접 쏠 수 있다.
 *
 *   node tools/test-noti.js
 */
const path = require('path');
const { loadBot } = require('./harness.js');

const NOTI_SOURCE = path.join(__dirname, '..', 'Bots', 'gsbot_noti', 'gsbot_noti.js');
const KAKAO = 'com.kakao.talk';
const FLAG_GROUP_SUMMARY = 512;

/**
 * 실기기에서 확인한 StatusBarNotification 의 모양만 흉내 낸다.
 *
 * 액션 구성이 중요하다 — 실측(2026-08-20, dumpsys notification):
 *   대화방      actions = [0] "읽음"  [1] "답장"(RemoteInput 있음)
 *   채널 광고   actions = [0] "읽음"                 ← 답장이 없다
 * 봇은 답장 액션으로 메시지를 만들므로, 없으면 Event.MESSAGE 가 될 수 없다.
 */
function notification(opts) {
    const o = Object.assign({ pkg: KAKAO, tag: '111', flags: 17, reply: true }, opts);
    const actions = [{ title: '읽음', getRemoteInputs: () => null }];
    if (o.reply) actions.push({ title: '답장', getRemoteInputs: () => [{}] });
    return {
        getPackageName: () => o.pkg,
        getTag: () => o.tag,
        getId: () => 2,
        getNotification: () => ({ flags: o.flags, actions: actions }),
    };
}

/** 메신저봇이 올린 프로브 알림이 리스너로 돌아온 모양 */
function probeNotification() {
    return {
        getPackageName: () => 'com.xfl.msgbot',
        getTag: () => 'gsbot_noti-probe',
        getId: () => 7301,
        getNotification: () => ({ flags: 0, actions: null }),
    };
}

/**
 * 프로브와 푸시가 부르는 안드로이드·자바 API 를 채운 봇.
 * 올린 알림, 지운 알림, 보낸 푸시를 bot.android 에 모은다.
 */
function androidBot(now) {
    const bot = newBot(now);
    const android = { posted: [], cancelled: [], pushes: [] };
    bot.android = android;

    const manager = {
        notify(tag, id) { android.posted.push({ tag: String(tag), id }); },
        cancel(tag, id) { android.cancelled.push({ tag: String(tag), id }); },
    };
    bot.sandbox.App.getContext = () => ({ getSystemService: () => manager, startActivity() {} });

    const P = bot.sandbox.Packages;
    P.android.content.Context = { NOTIFICATION_SERVICE: 'notification' };
    P.android.R = { drawable: { stat_notify_sync: 1 } };
    P.android.app = {
        Notification: {
            Builder: function Builder() {
                const b = {};
                for (const m of ['setSmallIcon', 'setContentTitle', 'setOnlyAlertOnce', 'setTimeoutAfter']) b[m] = () => b;
                b.build = () => ({});
                return b;
            },
        },
    };
    P.java.net.URL = function URL(url) {
        this.openConnection = () => {
            const conn = { body: '' };
            for (const m of ['setRequestMethod', 'setDoOutput', 'setConnectTimeout', 'setReadTimeout', 'setRequestProperty', 'disconnect']) conn[m] = () => {};
            conn.getOutputStream = () => conn;
            conn.getResponseCode = () => { android.pushes.push({ url: String(url), body: JSON.parse(conn.body) }); return 200; };
            return conn;
        };
    };
    P.java.io = {
        OutputStreamWriter: function OutputStreamWriter(stream) {
            this.write = (s) => { stream.body += s; };
            this.flush = () => {};
            this.close = () => {};
        },
    };
    return bot;
}

/** 지연 시간이 ms 인 setTimeout 을 하나 꺼내 돌린다. 하니스는 타이머를 자동으로 돌리지 않는다. */
function fireTimeout(bot, ms) {
    for (const id in bot.state.timers) {
        const timer = bot.state.timers[id];
        if (timer.kind === 'timeout' && timer.ms === ms) {
            delete bot.state.timers[id];
            timer.fn();
            return true;
        }
    }
    return false;
}

function hasTimeout(bot, ms) {
    return Object.values(bot.state.timers).some((t) => t.kind === 'timeout' && t.ms === ms);
}

/** 카카오톡이 실제로 올리는 한 쌍: 묶음 요약 + 진짜 메시지 알림 */
function kakaoPair(bot, channelId) {
    bot.emit('notificationPosted', notification({ tag: null, flags: FLAG_GROUP_SUMMARY }));
    bot.emit('notificationPosted', notification({ tag: channelId, flags: 17 }));
}

let failed = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? '  OK ' : '  실패'} ${name}${ok ? '' : `\n       기대 ${JSON.stringify(expected)}\n       실제 ${JSON.stringify(actual)}`}`);
}

function newBot(now) {
    return loadBot({ source: require('fs').readFileSync(NOTI_SOURCE, 'utf8'), now });
}

/**
 * 누적 상태는 Database 에 실린다. 다만 알림마다 파일을 쓰면 낭비라
 * 저장은 sweep 시점에만 한다 — 읽기 전에 sweep 을 한 번 돌린다.
 */
function stateOf(bot) {
    bot.fireTimers('interval');
    return JSON.parse(bot.db['state.json']);
}

/** /알림진단 출력. 판정 문구를 보려고 관리자 자격으로 부른다. */
function summaryOf(bot) {
    const r = bot.send({ content: '/알림진단', isDebugRoom: true });
    return r.replies.length ? r.replies[r.replies.length - 1].text : '';
}

console.log('\n▸ 카카오톡 알림 한 쌍은 메시지 알림 1건으로 센다');
{
    const bot = newBot();
    kakaoPair(bot, '111');
    const s = stateOf(bot);
    check('전체 알림 2건', s.notiTotal, 2);
    check('카톡 알림 2건', s.notiKakao, 2);
    check('묶음 요약 1건', s.notiSummary, 1);
    check('메시지 알림 1건 (요약 제외)', s.notiMessage, 1);
}

console.log('\n▸ 알림 뒤에 메시지가 오면 짝이 맞는다 (정상)');
{
    const bot = newBot();
    kakaoPair(bot, '111');
    bot.send({ content: '안녕', room: '테스트방', channelId: '111' });
    bot.fireTimers('interval');
    const s = stateOf(bot);
    check('짝 1건', s.paired, 1);
    check('누락 0건', s.missedNoti, 0);
    check('알림 없이 온 메시지 0건', s.msgWithoutNoti, 0);
}

console.log('\n▸ 메시지가 알림보다 먼저 와도 짝이 맞는다 (순서 무관)');
{
    const bot = newBot();
    bot.send({ content: '안녕', room: '테스트방', channelId: '111' });
    kakaoPair(bot, '111');
    bot.fireTimers('interval');
    const s = stateOf(bot);
    check('짝 1건', s.paired, 1);
    check('누락 0건', s.missedNoti, 0);
}

console.log('\n▸ 알림만 오고 메시지가 없으면 누락(B)으로 잡힌다');
{
    const bot = newBot();
    kakaoPair(bot, '111');
    bot.fireTimers('interval');   // 유예 안이라 아직 아님
    check('유예 중에는 누락 아님', stateOf(bot).missedNoti, 0);

    // 유예(20초)를 넘긴 뒤의 sweep
    bot.advanceTime(30000);
    const s = stateOf(bot);
    check('누락 1건', s.missedNoti, 1);
    check('방별 누락 1건', s.byChannel['111'].missed, 1);
    // 단발은 경보를 올리지 않는다. 열흘에 한두 건이 실제 빈도라 그때마다
    // 리스너를 다시 붙일 일이 아니다 — 기록에만 남기고 /알림진단 에서 본다.
    check('단발이라 경보 없음', bot.state.sent.length, 0);
    check('판정에는 산발적으로 표기', /산발적/.test(summaryOf(bot)), true);
}

console.log('\n▸ 짧은 시간에 몰리면 경보를 올린다');
{
    const bot = newBot();
    // 창(6시간) 안에서 세 번 샌다 — 리스너가 떨어지면 이렇게 방을 가리지 않는다
    for (const channelId of ['111', '222', '333']) {
        kakaoPair(bot, channelId);
        bot.advanceTime(30000);
    }
    const s = stateOf(bot);
    check('누락 3건', s.missedNoti, 3);
    check('관리자에게 경보', bot.state.sent.length >= 1, true);
    const text = bot.state.sent.length ? bot.state.sent[bot.state.sent.length - 1].text : '';
    check('경보 문구에 원인 B', /원인 B/.test(text), true);
    check('어느 방인지 실림', /대상: /.test(text), true);
    check('판정은 재바인드 필요', /재바인드 필요/.test(summaryOf(bot)), true);
}

console.log('\n▸ 창을 벗어난 누락은 몰림으로 세지 않는다');
{
    const bot = newBot();
    kakaoPair(bot, '111');
    bot.advanceTime(30000);
    bot.advanceTime(7 * 60 * 60 * 1000);   // 6시간 창 밖으로 밀어낸다
    kakaoPair(bot, '222');
    bot.advanceTime(30000);
    check('누락은 2건', stateOf(bot).missedNoti, 2);
    check('창 안에는 1건뿐이라 경보 없음', bot.state.sent.length, 0);
}

console.log('\n▸ 답장 액션이 없는 알림(채널 광고)은 누락으로 세지 않는다');
{
    const bot = newBot();
    // "카카오톡 선물하기" 채널이 실제로 이 모양이다. 읽음만 있고 답장이 없다.
    bot.emit('notificationPosted', notification({ tag: null, flags: FLAG_GROUP_SUMMARY }));
    bot.emit('notificationPosted', notification({ tag: '4867538442305625', reply: false }));
    bot.advanceTime(30000);
    const s = stateOf(bot);
    check('답장불가로 분류', s.notiNoReply, 1);
    check('메시지 알림으로 세지 않음', s.notiMessage, 0);
    check('누락 0건', s.missedNoti, 0);
    check('경보 없음', bot.state.sent.length, 0);
}

console.log('\n▸ 재시작 1분 뒤 프로브를 쏘고, 돌아오면 정상');
{
    const bot = androidBot();
    fireTimeout(bot, 60 * 1000);
    check('프로브 알림 1건 올림', bot.android.posted.length, 1);
    check('응답 대기 타이머 등록', hasTimeout(bot, 15 * 1000), true);

    bot.emit('notificationPosted', probeNotification());
    const s = stateOf(bot);
    check('대기 타이머 해제', hasTimeout(bot, 15 * 1000), false);
    check('프로브 알림 지움', bot.android.cancelled.length, 1);
    check('확인 시각 기록', s.lastProbeOkAt > 0, true);
    check('리스너 정상', s.listenerDeadSince, 0);
    check('프로브는 통계에 안 들어감', s.notiTotal, 0);
    check('푸시 없음', bot.android.pushes.length, 0);

    // 프로브를 올리면 안드로이드가 메신저봇 알림을 묶으며 그룹 요약을 더 올린다
    bot.emit('notificationPosted', notification({ pkg: 'com.xfl.msgbot', tag: null, flags: FLAG_GROUP_SUMMARY }));
    check('메신저봇 자신의 알림도 통계에 안 들어감', stateOf(bot).notiTotal, 0);
}

console.log('\n▸ 프로브가 안 돌아오면 리스너 끊김 — 푸시로 알린다');
{
    const bot = androidBot();
    fireTimeout(bot, 60 * 1000);
    fireTimeout(bot, 15 * 1000);
    const s = stateOf(bot);
    check('끊김 판정', s.listenerDeadSince > 0, true);
    check('실패 누적 1', s.probeFailed, 1);
    check('푸시 1건', bot.android.pushes.length, 1);
    const push = bot.android.pushes[0] || { body: {} };
    check('푸시 종류 dead', push.body.data && push.body.data.kind, 'dead');
    check('조치 안내 포함', /알림 읽기, 답장 및 제어/.test(push.body.body), true);
    check('FCM 경로', /\/api\/fcm\/send-all$/.test(push.url), true);
    check('판정은 리스너 끊김', /리스너 끊김/.test(summaryOf(bot)), true);
}

console.log('\n▸ 끊긴 동안 10분마다 다시 확인하되 푸시는 2시간에 한 번');
{
    const bot = androidBot();
    fireTimeout(bot, 60 * 1000);
    fireTimeout(bot, 15 * 1000);

    bot.advanceTime(10 * 60 * 1000);
    bot.fireTimers('interval');
    check('다시 프로브', bot.android.posted.length, 2);
    fireTimeout(bot, 15 * 1000);
    check('쿨다운이라 푸시 그대로 1건', bot.android.pushes.length, 1);

    bot.advanceTime(2 * 60 * 60 * 1000);
    bot.fireTimers('interval');
    fireTimeout(bot, 15 * 1000);
    check('2시간 뒤에는 다시 푸시', bot.android.pushes.length, 2);
}

console.log('\n▸ 끊긴 뒤 알림이 다시 들어오면 복구로 기록하고 알린다');
{
    const bot = androidBot();
    fireTimeout(bot, 60 * 1000);
    fireTimeout(bot, 15 * 1000);
    bot.advanceTime(30 * 60 * 1000);

    kakaoPair(bot, '111');
    fireTimeout(bot, 0);      // 복구 푸시는 리스너 콜백 밖에서 보낸다
    const s = stateOf(bot);
    check('리스너 정상으로', s.listenerDeadSince, 0);
    check('복구 푸시', bot.android.pushes.map((p) => p.body.data.kind), ['dead', 'recovered']);
    check('복구 기록', /"type":"listenerRecovered"/.test(bot.state.files['/sdcard/msgbot/noti-diag/events.jsonl']), true);
}

console.log('\n▸ 알림이 계속 들어오는 동안은 프로브를 쏘지 않는다');
{
    const bot = androidBot();
    bot.advanceTime(9 * 60 * 1000);
    kakaoPair(bot, '111');
    bot.advanceTime(9 * 60 * 1000);   // 시작 후 18분이지만 마지막 알림은 9분 전
    bot.fireTimers('interval');
    check('프로브 없음', bot.android.posted.length, 0);

    bot.advanceTime(2 * 60 * 1000);   // 마지막 알림이 11분 전
    bot.fireTimers('interval');
    check('10분 넘게 조용하면 프로브', bot.android.posted.length, 1);
}

console.log('\n▸ 프로브 알림을 못 올리면 끊김으로 판정하지 않는다');
{
    const bot = newBot();             // 안드로이드 API 가 없는 상태
    fireTimeout(bot, 60 * 1000);
    const s = stateOf(bot);
    check('대기 타이머 없음', hasTimeout(bot, 15 * 1000), false);
    check('리스너 정상 유지', s.listenerDeadSince, 0);
    check('오류는 기록', /"type":"probeError"/.test(bot.state.files['/sdcard/msgbot/noti-diag/events.jsonl']), true);
}

console.log('\n▸ 카카오톡이 아닌 알림은 전체 수만 올린다');
{
    const bot = newBot();
    bot.emit('notificationPosted', notification({ pkg: 'com.android.shell', tag: 'x', flags: 0 }));
    const s = stateOf(bot);
    check('전체 알림 1건', s.notiTotal, 1);
    check('카톡 알림 0건', s.notiKakao, 0);
    check('메시지 알림 0건', s.notiMessage, 0);
}

console.log('\n▸ 방마다 따로 센다 (어느 방에서 새는지 보이게)');
{
    const bot = newBot();
    kakaoPair(bot, '111');
    bot.send({ content: 'a', room: 'A방', channelId: '111' });
    kakaoPair(bot, '222');   // B방은 메시지가 안 온다
    bot.advanceTime(30000);
    const s = stateOf(bot);
    check('A방 누락 0건', s.byChannel['111'].missed, 0);
    check('B방 누락 1건', s.byChannel['222'].missed, 1);
    check('A방 이름 기록됨', s.byChannel['111'].room, 'A방');
}

console.log('\n▸ 경보는 쿨다운 안에 다시 나가지 않는다');
{
    const bot = newBot();
    for (let i = 0; i < 3; i++) {
        kakaoPair(bot, String(300 + i));
        bot.advanceTime(30000);
        bot.fireTimers('interval');
    }
    check('누락 3건', stateOf(bot).missedNoti, 3);
    check('경보는 1건만', bot.state.sent.length, 1);
}

console.log('\n▸ 조회 명령');
{
    const bot = newBot();
    kakaoPair(bot, '111');
    bot.send({ content: 'a', room: 'A방', channelId: '111' });

    const asAdmin = bot.send({ content: '/알림진단', room: 'A방', channelId: '111', author: { name: '승엽[EmotionB_SY]', hash: 'abc' } });
    check('관리자에게 응답', asAdmin.replies.length, 1);
    check('판정 줄 포함', /판정:/.test(asAdmin.replies[0].text), true);

    const asStranger = bot.send({ content: '/알림진단', room: 'A방', channelId: '111', author: { name: '아무개', hash: 'zzz' } });
    check('남에게는 무응답', asStranger.replies.length, 0);

    // 소켓 주입은 이름을 위조할 수 있다 — hash 가 null 이면 거른다
    const asForged = bot.send({ content: '/알림진단', room: 'A방', channelId: '111', author: { name: '승엽[EmotionB_SY]', hash: null } });
    check('이름 위조 차단', asForged.replies.length, 0);

    const inDebug = bot.send({ content: '/알림진단', isDebugRoom: true });
    check('디버그룸에서는 응답', inDebug.replies.length, 1);
}

console.log('\n▸ 초기화');
{
    const bot = newBot();
    kakaoPair(bot, '111');
    bot.send({ content: '/알림진단 초기화', isDebugRoom: true });
    const s = stateOf(bot);
    check('누적값 0', [s.notiTotal, s.notiMessage, s.msgTotal], [0, 0, 0]);
    check('이전 값은 파일에 남음', /"type":"reset"/.test(bot.state.files['/sdcard/msgbot/noti-diag/events.jsonl']), true);
}

console.log('\n▸ 재컴파일 시 타이머 정리 · 누적값 인수인계');
{
    const bot = newBot();
    kakaoPair(bot, '111');
    // sweep · 요약 · 시작 직후 프로브
    check('타이머 3개 등록', Object.keys(bot.state.timers).length, 3);
    bot.emit('startCompile');
    check('타이머 정리됨', Object.keys(bot.state.timers).length, 0);

    // 재컴파일 후 새로 뜬 봇이 Database 에서 누적값을 이어받는지
    const restarted = loadBot({
        source: require('fs').readFileSync(NOTI_SOURCE, 'utf8'),
        database: { 'state.json': bot.db['state.json'] },
    });
    check('메시지 알림 누적 인수인계', stateOf(restarted).notiMessage, 1);
}

console.log('\n▸ 재컴파일 때 응답 대기 중인 프로브도 정리한다');
{
    const bot = androidBot();
    fireTimeout(bot, 60 * 1000);
    check('응답 대기 중', hasTimeout(bot, 15 * 1000), true);
    bot.emit('startCompile');
    check('대기 타이머 정리', hasTimeout(bot, 15 * 1000), false);
    check('프로브 알림 지움', bot.android.cancelled.length, 1);
}

console.log(`\n${failed === 0 ? '전부 통과' : failed + '건 실패'}\n`);
process.exit(failed === 0 ? 0 : 1);
