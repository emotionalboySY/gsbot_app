#!/usr/bin/env node
/**
 * test-loop.js — gsbot_loop(정기 알림)의 틱 판정 검증
 *
 * 절전으로 틱이 늦게 와도 지나간 분의 알림을 따라잡는지, 같은 분에 두 번
 * 보내지 않는지, 너무 오래된 것은 건너뛰고 관리자에게 알리는지를 본다.
 * 실기기에서는 절전을 재현하기 어렵지만 하니스에서는 시계만 감으면 된다.
 *
 *   node tools/test-loop.js
 */
const path = require('path');
const fs = require('fs');
const { loadBot } = require('./harness.js');

const LOOP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'Bots', 'gsbot_loop', 'gsbot_loop.js'), 'utf8');
const ADMIN = '승엽[EmotionB_SY]';
const ROOM_COUNT = 6;

let failed = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? '  OK ' : '  실패'} ${name}${ok ? '' : `  기대 ${JSON.stringify(expected)} / 실제 ${JSON.stringify(actual)}`}`);
}

// KST 시각으로 봇을 띄운다. (2026-09-09 는 수요일)
function kst(month, day, hour, minute, second) {
    return Date.UTC(2026, month - 1, day, hour - 9, minute || 0, second || 0);
}
function newBot(now) {
    const bot = loadBot({ source: LOOP_SOURCE, now });
    bot.sandbox.TimeAlarmManager.notifications = [
        { hour: 22, minute: 0, message: '[매일] 메할일 점검\n둘째 줄' },
        { dayOfWeek: '수', hour: 22, minute: 30, message: '[수요일] 주간 초기화 대비' },
        { dayOfWeek: '목', hour: 0, minute: 0, message: '[목요일] 초기화됨' },
        { year: 2026, month: 9, day: 9, hour: 22, minute: 5, message: '[특정] 패치 예고' },
        { year: 2026, hour: 22, minute: 0, message: '[불완전] 절대 안 나감' },
    ];
    return bot;
}
function sentSince(bot, from) { return bot.state.sent.slice(from); }
function rooms(list) { return list.map(s => s.room); }
function texts(list) { return Array.from(new Set(list.map(s => s.text))); }

console.log('\n▸ 정각 틱: 그 분의 알림을 방마다 한 번씩 보낸다');
{
    const bot = newBot(kst(9, 9, 21, 59, 40));
    check('로드 직후 전송 없음', bot.state.sent.length, 0);
    check('기준 분은 컴파일된 분', bot.sandbox.TimeAlarmManager.lastCheckedMinute, Math.floor(kst(9, 9, 21, 59) / 60000));

    bot.advanceTime(20 * 1000);          // 22:00:00
    bot.fireTimers('timeout');
    const sent = bot.state.sent;
    check('6개 방에 전송', sent.length, ROOM_COUNT);
    check('방이 겹치지 않음', new Set(rooms(sent)).size, ROOM_COUNT);
    check('본문 그대로', texts(sent), ['[매일] 메할일 점검\n둘째 줄']);
    check('불완전한 알림은 안 나감', sent.some(s => /불완전/.test(s.text)), false);

    bot.advanceTime(30 * 1000);          // 22:00:30
    bot.fireTimers('interval');
    check('같은 분의 두 번째 틱은 중복 전송 없음', bot.state.sent.length, ROOM_COUNT);
}

console.log('\n▸ 틱이 몇 분 늦어도 지나간 분을 따라잡는다');
{
    const bot = newBot(kst(9, 9, 21, 59, 40));
    bot.advanceTime(20 * 1000);
    bot.fireTimers('timeout');           // 22:00 전송
    const before = bot.state.sent.length;

    bot.advanceTime(8 * 60 * 1000 + 10 * 1000);   // 22:08:10, 그 사이 틱 없음
    bot.fireTimers('interval');
    const sent = sentSince(bot, before);
    check('22:05 특정 알림을 6개 방에', sent.length, ROOM_COUNT);
    check('본문', texts(sent), ['[특정] 패치 예고']);
    check('늦은 분수를 로그에', bot.state.logs.some(l => /3분 늦음/.test(l.text)), true);
}

console.log('\n▸ 상한(30분)보다 오래된 알림은 보내지 않고 관리자에게 알린다');
{
    const bot = newBot(kst(9, 9, 22, 8, 10));
    bot.advanceTime(50 * 1000);          // 22:09:00
    bot.fireTimers('timeout');
    const before = bot.state.sent.length;
    check('22:09 에는 보낼 것 없음', before, 0);

    bot.advanceTime(66 * 60 * 1000);     // 23:15:00 — 22:30 은 45분 전
    bot.fireTimers('interval');
    const sent = sentSince(bot, before);
    check('방 전송 없음, 관리자 1건', rooms(sent), [ADMIN]);
    check('멈춘 시간과 놓친 알림', /66분 멈춰.*1개.*\n22:30 \[수요일\] 주간 초기화 대비/s.test(sent[0].text), true);
}

console.log('\n▸ 요일 알림: 자정 넘어 목요일 00:00, 목요일 22:30 에는 수요일 것이 안 나감');
{
    const bot = newBot(kst(9, 9, 23, 59, 30));
    bot.advanceTime(30 * 1000);          // 09-10 목 00:00:00
    bot.fireTimers('timeout');
    check('목 00:00 알림', texts(bot.state.sent), ['[목요일] 초기화됨']);
    check('6개 방', bot.state.sent.length, ROOM_COUNT);

    const before = bot.state.sent.length;
    bot.advanceTime(kst(9, 10, 22, 29) - kst(9, 10, 0, 0));
    bot.fireTimers('interval');          // 22:29 — 22:00 매일 알림이 29분 늦게(상한 안)
    check('매일 알림 29분 늦게 전송', texts(sentSince(bot, before)), ['[매일] 메할일 점검\n둘째 줄']);

    const before2 = bot.state.sent.length;
    bot.advanceTime(60 * 1000);          // 목 22:30
    bot.fireTimers('interval');
    check('수요일 22:30 알림은 목요일에 안 나감', sentSince(bot, before2).length, 0);
}

console.log('\n▸ 컴파일 직후 첫 틱이 절전으로 늦어도 컴파일 다음 분부터 따라잡는다');
{
    const bot = newBot(kst(9, 9, 21, 59, 50));
    bot.advanceTime(7 * 60 * 1000 + 10 * 1000);   // 22:07:00 에야 첫 틱
    bot.fireTimers('timeout');
    check('22:00 과 22:05 둘 다', texts(bot.state.sent), ['[매일] 메할일 점검\n둘째 줄', '[특정] 패치 예고']);
    check('각 6개 방', bot.state.sent.length, ROOM_COUNT * 2);
}

console.log('\n▸ 컴파일된 분 자체는 다시 보지 않는다 (이전 컨텍스트가 이미 봤다)');
{
    const bot = newBot(kst(9, 9, 22, 0, 10));
    bot.advanceTime(50 * 1000);          // 22:01:00
    bot.fireTimers('timeout');
    check('22:00 알림 전송 없음', bot.state.sent.length, 0);
}

console.log('\n▸ bot.send 가 false 를 돌려주면 관리자에게 그 방을 알린다');
{
    const bot = newBot(kst(9, 9, 21, 59, 40));
    const inner = bot.sandbox.BotManager.getCurrentBot();
    const realSend = inner.send;
    inner.send = (room, text) => { realSend(room, text); return room !== '앙메톡'; };
    bot.advanceTime(20 * 1000);
    bot.fireTimers('timeout');
    const admin = bot.state.sent.filter(s => s.room === ADMIN);
    check('관리자 보고 1건', admin.length, 1);
    check('못 보낸 방과 알림', /보내지 못한 방: 앙메톡\n22:00 \[매일\] 메할일 점검/.test(admin[0].text), true);
}

console.log('\n▸ !알림확인 에 마지막 틱과 답장 불가 방이 붙는다');
{
    const bot = newBot(kst(9, 9, 21, 59, 40));
    bot.advanceTime(20 * 1000);
    bot.fireTimers('timeout');
    bot.advanceTime(3 * 60 * 1000);      // 22:03
    const r = bot.send({ content: '!알림확인', author: { name: ADMIN } });
    // 불완전한 알림(year 만 있음)은 집계에서 '정확한 시간' 으로 잡힌다
    check('개수 요약', /정확한 시간: 2개\n- 요일 시간: 2개\n- 매일 시간: 1개\n- 총합: 5개/.test(r.replies[0].text), true);
    check('마지막 확인', /마지막 확인: 22:00 \(3분 전\)/.test(r.replies[0].text), true);
    check('답장 불가 방 없음', /답장 불가 방: 없음/.test(r.replies[0].text), true);

    const inner = bot.sandbox.BotManager.getCurrentBot();
    inner.canReply = (room) => room !== '06-21' && room !== '앙메톡';
    const r2 = bot.send({ content: '!알림확인', author: { name: ADMIN } });
    check('답장 불가 방 나열', /답장 불가 방: 06-21 \/ 앙메톡/.test(r2.replies[0].text), true);

    const r3 = bot.send({ content: '!알림확인', author: { name: '남' } });
    check('관리자 아니면 무응답', r3.replies.length, 0);
}

console.log('\n▸ 시계가 뒤로 가도 멈추지 않는다');
{
    const bot = newBot(kst(9, 9, 21, 59, 40));
    bot.advanceTime(20 * 1000);
    bot.fireTimers('timeout');           // 22:00 전송
    const before = bot.state.sent.length;
    bot.advanceTime(-5 * 60 * 1000);     // 21:55
    bot.fireTimers('interval');
    check('뒤로 간 동안 전송 없음', bot.state.sent.length, before);
    bot.advanceTime(10 * 60 * 1000);     // 22:05
    bot.fireTimers('interval');
    check('다시 앞으로 가면 이어서 판정', texts(sentSince(bot, before)), ['[매일] 메할일 점검\n둘째 줄', '[특정] 패치 예고']);
}

console.log(failed ? `\n${failed}개 실패\n` : '\n모두 통과\n');
process.exit(failed ? 1 : 0);
