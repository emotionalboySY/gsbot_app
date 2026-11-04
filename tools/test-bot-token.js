#!/usr/bin/env node
/**
 * test-bot-token.js — 봇 서버 토큰이 봇 서버로만 가는지 본다
 *
 * 저장소가 공개라 토큰은 폰의 Database 에만 있다. 그 값이 헤더로 실리는 곳과 실리면
 * 안 되는 곳(GitHub 에서 스크립트를 받는 연결)을 함께 확인한다.
 *
 *   node tools/test-bot-token.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadBot } = require('./harness.js');

const LOOP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'Bots', 'gsbot_loop', 'gsbot_loop.js'), 'utf8');
const TOKEN = 'token-for-test';
const FILE = 'bot_api_token.txt';
const HOST = 'https://botapi.maple-ing.com';
const ADMIN_HASH = 'a'.repeat(64);
const admin = { name: '승엽[EmotionB_SY]', hash: ADMIN_HASH };
const VALID_SCRIPT = 'const bot = BotManager.getCurrentBot();\n' + '// 채우기\n'.repeat(600);

let fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '  OK  ' : '  FAIL') + ' ' + name + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
};
const suggestion = { content: '/건의 토큰 시험', room: '앙메톡', author: { name: '사용자', hash: 'b'.repeat(64) } };
const postOf = (r) => r.calls.filter((c) => c.method === 'POST');

console.log('[1] gsbot: POST 에 토큰이 실린다');
{
  const r = loadBot({ database: { [FILE]: TOKEN + '\n' } }).send(suggestion);
  const post = postOf(r);
  check('POST 1회', post.length === 1);
  check('헤더 값 (줄바꿈 제거)', post[0] && post[0].headers['X-Bot-Token'] === TOKEN, post[0] && post[0].headers['X-Bot-Token']);
  check('봇 서버 주소', post[0] && post[0].url.startsWith(HOST + '/api/'), post[0] && post[0].url);
  check('Content-Type 유지', post[0] && post[0].headers['Content-Type'] === 'application/json');
}

console.log('\n[2] gsbot: 동기 GET 에 토큰이 실린다');
{
  const bot = loadBot({ database: { [FILE]: TOKEN } });
  vm.runInContext(`syncGetJson("시험", "${HOST}/api/administrator/suggestion")`, bot.context);
  const call = bot.state.calls[bot.state.calls.length - 1];
  check('헤더 값', call.headers['X-Bot-Token'] === TOKEN);
}

console.log('\n[3] gsbot: 토큰 파일이 없어도 멈추지 않는다');
for (const [name, database] of [['파일 없음', {}], ['빈 파일', { [FILE]: '  \n' }]]) {
  const r = loadBot({ database }).send(suggestion);
  const post = postOf(r);
  check(`${name}: POST 는 나감`, post.length === 1);
  check(`${name}: 헤더 없음`, post[0] && !('X-Bot-Token' in post[0].headers));
  check(`${name}: 오류 없음`, !r.error, r.error && String(r.error));
}

console.log('\n[4] gsbot: GitHub 로는 토큰이 나가지 않는다');
{
  const bot = loadBot({
    adminHash: ADMIN_HASH,
    database: { [FILE]: TOKEN },
    responder: (call) => (call.url.indexOf('raw.githubusercontent.com') >= 0 ? VALID_SCRIPT : undefined),
  });
  const r = bot.send({ content: '@@스크립트갱신 gsbot_loop', room: '앙메톡', author: admin }, 'command');
  const raw = r.calls.filter((c) => c.url.indexOf('raw.githubusercontent.com') >= 0);
  check('GitHub 호출 있음', raw.length > 0, String(raw.length));
  check('토큰 헤더 없음', raw.every((c) => !('X-Bot-Token' in c.headers)));
  check('어떤 헤더에도 값 없음', raw.every((c) => !Object.values(c.headers).includes(TOKEN)));
}

console.log('\n[5] gsbot: 호출 주소');
{
  const bot = loadBot();
  check('API_URL', vm.runInContext('API_URL', bot.context) === HOST + '/api');
  check('BASE_URL', vm.runInContext('BASE_URL', bot.context) === HOST);
}

/** gsbot_loop 는 java.net 을 쓴다. 호출 내역만 남기는 가짜를 넣는다. */
function fakeJava(connections, body) {
  return {
    type(name) {
      if (name === 'java.net.URL') {
        return function FakeUrl(url) {
          this.openConnection = () => {
            const c = {
              url: String(url), headers: {}, method: null,
              setRequestMethod(m) { c.method = m; },
              setDoOutput() {}, setConnectTimeout() {}, setReadTimeout() {},
              setRequestProperty(k, v) { c.headers[k] = String(v); },
              getResponseCode: () => 200,
              getInputStream: () => ({ body }),
              getOutputStream: () => ({}),
              disconnect() {},
            };
            connections.push(c);
            return c;
          };
        };
      }
      if (name === 'java.io.InputStreamReader') return function (stream) { this.stream = stream; };
      if (name === 'java.io.BufferedReader') {
        return function (reader) {
          let lines = [reader.stream.body];
          this.readLine = () => (lines.length ? lines.shift() : null);
          this.close = () => {};
        };
      }
      if (name === 'java.io.OutputStreamWriter') return function () { this.write = () => {}; this.flush = () => {}; this.close = () => {}; };
      if (name === 'java.lang.StringBuilder') {
        return function () { let s = ''; this.append = (x) => { s += x; return this; }; this.toString = () => s; };
      }
      throw new Error('가짜에 없는 클래스: ' + name);
    },
  };
}

function runLoop(database) {
  const bot = loadBot({ source: LOOP_SOURCE, database });
  const connections = [];
  bot.sandbox.Java = fakeJava(connections, '[]');
  vm.runInContext('fetchNotificationsFromEC2()', bot.context);
  return connections;
}

console.log('\n[6] gsbot_loop: 조회와 알림 전송에 토큰이 실린다');
{
  const connections = runLoop({ [FILE]: TOKEN + '\n' });
  const get = connections.find((c) => c.url.endsWith('/api/intervalMessage/all'));
  const post = connections.find((c) => c.url.endsWith('/api/fcm/send-all'));
  check('정기 메시지 조회', !!get && get.method === 'GET');
  check('알림 전송', !!post && post.method === 'POST');
  check('조회 헤더', get && get.headers['X-Bot-Token'] === TOKEN);
  check('전송 헤더', post && post.headers['X-Bot-Token'] === TOKEN);
  check('전부 HTTPS 봇 서버', connections.every((c) => c.url.startsWith(HOST + '/api/')), connections.map((c) => c.url).join(' '));
}

console.log('\n[7] gsbot_loop: 토큰 파일이 없어도 멈추지 않는다');
{
  const connections = runLoop({});
  check('호출은 나감', connections.length === 2, String(connections.length));
  check('헤더 없음', connections.every((c) => !('X-Bot-Token' in c.headers)));
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
