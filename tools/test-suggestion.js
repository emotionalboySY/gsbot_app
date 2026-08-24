#!/usr/bin/env node
/**
 * test-suggestion.js — /건의 의 내용 보존과 POST 재시도
 *
 * 저장이 타임아웃으로 실패해도 건의 본문이 관리자에게는 닿아야 한다. 예전에는
 * 저장 성공을 먼저 확인하고 전달했는데, 저장이 예외를 던지면 전달까지 건너뛰어
 * 본문이 서버에도 관리자에게도 남지 않고 사라졌다(실측: 2026-08-21 16:43).
 *
 *   node tools/test-suggestion.js
 */
const { loadBot } = require('./harness.js');
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? '  OK  ' : '  FAIL') + ' ' + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };
const timeout = () => new Error('java.net.SocketTimeoutException: timeout');

console.log('[1] 정상 경로');
{
  const bot = loadBot();
  const r = bot.send({ content: '/건의 농장 계산기 만들어주세요', room: '앙메톡', author: { name: '홍길동', hash: 'h1' } });
  const post = r.calls.filter(c => c.method === 'POST');
  const body = post.length ? JSON.parse(post[0].body) : {};
  check('POST 1회', post.length === 1);
  check('clientKey 실림', !!body.clientKey, body.clientKey);
  check('본문 그대로', body.content === '농장 계산기 만들어주세요');
  check('관리자 전달됨', r.sent.length === 1);
  check('관리자 DM 에 본문 포함', r.sent.length>0 && r.sent[0].text.includes('농장 계산기 만들어주세요'));
  check('사용자 응답 있음', r.replies.length === 1);
}

console.log('\n[2] 첫 POST 타임아웃 -> 재시도 성공');
{
  let n = 0;
  const bot = loadBot({ responder: (c) => { if (c.method === 'POST' && ++n === 1) return timeout(); return undefined; } });
  const r = bot.send({ content: '/건의 재시도 테스트', room: '앙메톡', author: { name: '홍길동', hash: 'h1' } });
  const post = r.calls.filter(c => c.method === 'POST');
  check('POST 2회 (재시도)', post.length === 2);
  const keys = post.map(p => JSON.parse(p.body).clientKey);
  check('두 요청의 clientKey 동일', keys[0] === keys[1], String(keys.join(' / ')));
  check('사용자에게 실패 안내 안 감', r.replies.length>0 && !/실패/.test(r.replies[0].text));
}

console.log('\n[3] 재시도까지 실패 - 본문이 사라지지 않는가');
{
  const bot = loadBot({ responder: (c) => (c.method === 'POST' ? timeout() : undefined) });
  const r = bot.send({ content: '/건의 사라지면 안 되는 내용', room: '아케인 편안길드', author: { name: '밀념 92', hash: 'h2' } });
  const post = r.calls.filter(c => c.method === 'POST');
  check('POST 2회 시도', post.length === 2);
  check('관리자에게 본문 전달됨', r.sent.some(s => s.text.includes('사라지면 안 되는 내용')));
  check('사용자에게 접수 안내', r.replies.length>0 && /접수되었습니다/.test(r.replies[0].text), r.replies.length? JSON.stringify(r.replies[0].text).slice(0,60):'');
  check('명령이 예외로 죽지 않음', r.replies.length === 1);
}

console.log('\n[4] ConnectException 은 재시도하지 않는다');
{
  const bot = loadBot({ responder: (c) => (c.method === 'POST' ? new Error('java.net.ConnectException: Failed to connect') : undefined) });
  const r = bot.send({ content: '/건의 연결 거부', room: '앙메톡', author: { name: '홍길동', hash: 'h1' } });
  check('POST 1회만', r.calls.filter(c => c.method === 'POST').length === 1);
  check('관리자에게는 전달됨', r.sent.some(s => s.text.includes('연결 거부')));
}

console.log('\n[5] 인자 없이 /건의');
{
  const bot = loadBot();
  const r = bot.send({ content: '/건의', room: '앙메톡', author: { name: '홍길동', hash: 'h1' } });
  check('POST 안 감', r.calls.filter(c => c.method === 'POST').length === 0);
  check('사용법 안내', r.replies.length>0 && /건의내용/.test(r.replies[0].text));
  check('관리자 전달 안 함', r.sent.length === 0);
}

console.log('\n[6] 여러 줄 건의 - 줄바꿈 보존');
{
  const bot = loadBot();
  const r = bot.send({ content: '/건의 첫 줄\n둘째 줄\n셋째 줄', room: '앙메톡', author: { name: '홍길동', hash: 'h1' } });
  const posts = r.calls.filter(c => c.method === 'POST');
  const body = posts.length? JSON.parse(posts[0].body) : {};
  check('줄바꿈 유지', body.content === '첫 줄\n둘째 줄\n셋째 줄', JSON.stringify(body.content));
  check('관리자 DM 도 유지', r.sent.length>0 && r.sent[0].text.includes('첫 줄\n둘째 줄\n셋째 줄'));
}

console.log('\n[7] 다른 POST 경로(/본캐)도 재시도가 붙는가');
{
  let n = 0;
  const bot = loadBot({ responder: (c) => { if (c.method === 'POST' && ++n === 1) return timeout(); return undefined; } });
  const r = bot.send({ content: '/본캐 엽이감성', room: '앙메톡', author: { name: '홍길동', hash: 'h1' } });
  check('POST 2회 (재시도 동작)', r.calls.filter(c => c.method === 'POST').length === 2);
  check('사용자 응답 있음', r.replies.length === 1);
}

console.log('\n결과: ' + (fail === 0 ? '전부 통과' : fail + '건 실패'));
process.exit(fail ? 1 : 0);
