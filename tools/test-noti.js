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

// KST 기준 시각으로 봇을 띄운다. 침묵 경보가 시간대를 보기 때문에 필요하다.
function kstBot(month, day, hour, minute) {
    return newBot(Date.UTC(2026, month - 1, day, hour - 9, minute || 0, 0));
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
    check('관리자에게 경보 1건', bot.state.sent.length, 1);
    check('경보 문구에 원인 B', /원인 B/.test(bot.state.sent[0].text), true);
    check('어느 방인지 실림', /대상: 채널 111/.test(bot.state.sent[0].text), true);
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

console.log('\n▸ 심야에는 침묵 경보를 올리지 않는다');
{
    const bot = kstBot(8, 20, 5, 0);       // 05:00 KST
    bot.advanceTime(40 * 60 * 1000);        // 40분간 알림 0건
    bot.fireTimers('interval');
    check('경보 없음', bot.state.sent.length, 0);
}

console.log('\n▸ 낮에 40분간 알림이 없으면 침묵 경보가 나간다');
{
    const bot = kstBot(8, 20, 12, 0);      // 12:00 KST
    bot.advanceTime(40 * 60 * 1000);
    bot.fireTimers('interval');
    check('경보 1건', bot.state.sent.length, 1);
    check('언바인드 의심 문구', /리스너 언바인드 의심/.test(bot.state.sent[0].text), true);
}

console.log('\n▸ 밤새 조용했다고 아침 9시에 바로 터지지는 않는다');
{
    const bot = kstBot(8, 20, 8, 50);      // 08:50 KST — 아직 심야
    bot.advanceTime(25 * 60 * 1000);        // 09:15 · 낮이 된 지 15분
    bot.fireTimers('interval');
    check('아직 경보 없음', bot.state.sent.length, 0);

    bot.advanceTime(20 * 60 * 1000);        // 09:35 · 낮이 된 지 35분
    bot.fireTimers('interval');
    check('그 뒤에는 경보', bot.state.sent.length, 1);
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
    check('타이머 2개 등록', Object.keys(bot.state.timers).length, 2);
    bot.emit('startCompile');
    check('타이머 정리됨', Object.keys(bot.state.timers).length, 0);

    // 재컴파일 후 새로 뜬 봇이 Database 에서 누적값을 이어받는지
    const restarted = loadBot({
        source: require('fs').readFileSync(NOTI_SOURCE, 'utf8'),
        database: { 'state.json': bot.db['state.json'] },
    });
    check('메시지 알림 누적 인수인계', stateOf(restarted).notiMessage, 1);
}

console.log(`\n${failed === 0 ? '전부 통과' : failed + '건 실패'}\n`);
process.exit(failed === 0 ? 0 : 1);
