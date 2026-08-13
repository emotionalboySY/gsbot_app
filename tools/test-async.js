#!/usr/bin/env node
/**
 * test-async.js — 비동기 서버 호출에서 새로 생긴 동작만 검증
 *
 * 명령어별 동작이 그대로인지는 tools/snapshot.js 가 927개 입력으로 본다.
 * 여기서는 그 비교로는 안 보이는 것들을 본다 — 1.5초 컷 뒤의 동기 재시도,
 * 연결 실패 경로, POST 가 동기로 남아 있는지, 예약 타이머를 안 쓰는지.
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

console.log('\n▸ GET 은 Http.request 를 탄다');
{
    const bot = newBot();
    const r = bot.send({ content: '/6차 0 20' });
    check('GET 1건', r.calls.length, 1);
    check('Http 경유', r.calls[0].via, 'Http');
}
{
    const bot = newBot();
    bot.send({ content: '/히스토리 엽이감성' });   // 순차 2회 호출
    check('GET 2건', bot.state.calls.length, 2);
}

console.log('\n▸ App.runDelayed 로는 아무것도 예약하지 않는다');
{
    // 예약해 둔 콜백이 재컴파일 뒤에 터지면 "The Context is already closed" 로
    // 봇 전원이 꺼진다(실기기 실측). setTimeout 은 같은 상황에서 조용히 버려진다.
    check('소스에 App.runDelayed 호출 없음', /App\.runDelayed\s*\(/.test(SOURCE), false);

    const bot = newBot();
    bot.send({ content: '/6차 0 20' });
    check('예약된 지연 작업 없음', bot.state.delayed.length, 0);
}

console.log('\n▸ 1.5초에 잘린 응답은 동기로 한 번 더 간다');
{
    // Http.request 의 타임아웃은 약 1.5초로 고정이다(실측). 서버가 그보다 느리면
    // 정상 응답도 SocketTimeoutException 으로 오는데, 그걸 실패로 버리면 안 된다.
    const bot = newBot();
    bot.sandbox.Http.request = function (url, cb) {
        cb(new Error('java.net.SocketTimeoutException: Read timed out'), null, null);
    };
    const r = bot.send({ content: '/6차 0 20' });
    const sync = r.calls.filter((c) => c.via !== 'Http');
    check('동기 재시도 1건', sync.length, 1);
    check('재시도에는 10초 타임아웃', sync[0].timeout, TIMEOUT_MS);
    check('정상 답장', /MOCK/.test((r.replies[0] || {}).text || ''), true);
}

console.log('\n▸ 연결 자체가 안 되면 재시도하지 않는다');
{
    // 연결 실패는 예외가 아니라 콜백의 error 로 온다 (실기기 실측).
    // 기다린다고 될 일이 아니므로 바로 안내한다.
    const bot = newBot();
    bot.sandbox.Http.request = function (url, cb) {
        cb(new Error('java.net.ConnectException: Failed to connect'), null, null);
    };
    const r = bot.send({ content: '/6차 0 20' });
    check('동기 재시도 없음', r.calls.filter((c) => c.via !== 'Http').length, 0);
    check('무응답 안내', /서버가 응답하지 않습니다/.test(r.replies[0].text), true);
    check('관리자 알림에 [서버 연결 실패]', /\[서버 연결 실패\]/.test(bot.state.sent[0].text), true);
}

console.log('\n▸ 동기 재시도까지 실패하면 그때 안내한다');
{
    const bot = newBot();
    bot.sandbox.Http.request = function (url, cb) {
        cb(new Error('java.net.SocketTimeoutException: Read timed out'), null, null);
    };
    bot.sandbox.Packages.org.jsoup.Jsoup.connect = function () {
        throw new Error('java.net.SocketTimeoutException: Read timed out');
    };
    const r = bot.send({ content: '/6차 0 20' });
    check('무응답 안내', /서버가 응답하지 않습니다/.test(r.replies[0].text), true);
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

console.log('\n▸ 응답이 와도 내용이 잘못됐으면 코드 오류로 안내한다');
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
