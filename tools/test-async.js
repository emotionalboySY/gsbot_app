#!/usr/bin/env node
/**
 * test-async.js — 비동기 서버 호출로 새로 생긴 동작만 검증
 *
 * 명령어별 동작이 그대로인지는 tools/snapshot.js 가 927개 입력으로 본다.
 * 여기서는 그 비교로는 안 보이는 것들을 본다 — 감시 타이머, 연결 실패 경로,
 * 늦게 온 콜백, POST 가 동기로 남아 있는지.
 *
 *   node tools/test-async.js
 */
const path = require('path');
const fs = require('fs');
const { loadBot } = require('./harness.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'Bots', 'gsbot', 'gsbot.js'), 'utf8');
const TIMEOUT_MS = 10000;

let failed = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? '  OK ' : '  실패'} ${name}${ok ? '' : `  기대 ${JSON.stringify(expected)} / 실제 ${JSON.stringify(actual)}`}`);
}
function newBot(opts) { return loadBot(Object.assign({ source: SOURCE }, opts)); }
function watchdogs(bot) { return bot.state.delayed.filter((d) => d.ms === TIMEOUT_MS); }

console.log('\n▸ GET 은 Http.request 를 타고 GET 마다 감시 타이머가 걸린다');
{
    const bot = newBot();
    const r = bot.send({ content: '/6차 0 20' });
    check('GET 1건', r.calls.length, 1);
    check('Http 경유', r.calls[0].via, 'Http');
    check('감시 타이머 1개', watchdogs(bot).length, 1);
}
{
    const bot = newBot();
    bot.send({ content: '/히스토리 엽이감성' });   // 순차 2회 호출
    check('GET 2건이면 감시도 2개', watchdogs(bot).length, 2);
}

console.log('\n▸ 응답이 없으면 감시 타이머가 끊고 안내한다');
{
    // Http.request 가 콜백을 영영 안 부르는 상황
    const bot = newBot();
    bot.sandbox.Http.request = function () { return null; };

    const r = bot.send({ content: '/6차 0 20' });
    check('타이머 전에는 답장 없음', r.replies.length, 0);

    watchdogs(bot).forEach((d) => d.fn());
    check('무응답 안내', /서버가 응답하지 않습니다/.test(bot.state.replies.map((x) => x.text).join()), true);
    check('관리자 알림에 [서버 연결 실패]', /\[서버 연결 실패\]/.test(bot.state.sent[0].text), true);
}

console.log('\n▸ 연결 실패는 예외가 아니라 콜백의 error 로 온다 (실기기 실측)');
{
    const bot = newBot();
    bot.sandbox.Http.request = function (url, cb) {
        cb(new Error('java.net.ConnectException: Failed to connect'), null, null);
    };
    const r = bot.send({ content: '/6차 0 20' });
    check('무응답 안내', /서버가 응답하지 않습니다/.test(r.replies[0].text), true);
}

console.log('\n▸ 감시가 이미 끊은 뒤 콜백이 와도 두 번 답하지 않는다');
{
    const bot = newBot();
    let late = null;
    bot.sandbox.Http.request = function (url, cb) { late = cb; };

    bot.send({ content: '/6차 0 20' });
    watchdogs(bot).forEach((d) => d.fn());
    const before = bot.state.replies.length;

    late(null, { statusCode: () => 200 }, { body: () => ({ text: () => JSON.stringify({ resultRaw: '늦은 응답' }) }) });
    check('답장이 늘지 않음', bot.state.replies.length, before);
}

console.log('\n▸ POST 는 헤더·본문이 필요해 동기 JSoup 으로 남는다');
{
    const bot = newBot();
    const r = bot.send({ content: '/본캐 엽이감성' });
    const posts = r.calls.filter((c) => c.method === 'POST');
    check('POST 1건', posts.length, 1);
    check('Http 경유가 아님', posts[0].via, undefined);
    check('타임아웃 10초', posts[0].timeout, TIMEOUT_MS);
    check('Content-Type 유지', posts[0].headers['Content-Type'], 'application/json');
}

console.log('\n▸ 응답이 오더라도 내용이 잘못됐으면 코드 오류로 안내한다');
{
    const bot = newBot();
    bot.sandbox.Http.request = function (url, cb) {
        cb(null, { statusCode: () => 200 }, { body: () => ({ text: () => 'not json' }) });
    };
    const r = bot.send({ content: '/6차 0 20' });
    check('코드 오류 안내', /명령어 실행에 오류가 발생했습니다/.test(r.replies[0].text), true);
    check('서버 무응답 안내가 아님', /서버가 응답하지 않습니다/.test(r.replies[0].text), false);
}

console.log(`\n${failed === 0 ? '전부 통과' : failed + '건 실패'}\n`);
process.exit(failed === 0 ? 0 : 1);
