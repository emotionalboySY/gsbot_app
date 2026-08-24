#!/usr/bin/env node
/**
 * test-berry.js — /농장 의 인자 해석
 *
 * 인자 개수로만 갈린다. 예전에는 첫 인자가 농장 이름일 수 있었는데
 * "크림슨"(Lv.282)·"딸기농장"(Lv.215)·"블루베리"(Lv.286) 처럼 농장과 이름이
 * 같은 캐릭터가 실제로 있어서 닉네임인지 농장인지 가릴 수 없었다.
 *
 *   node tools/test-berry.js
 */
const { loadBot } = require('./harness.js');

let fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '  OK  ' : '  FAIL') + ' ' + name + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
};
const run = (content) => {
  const bot = loadBot();
  const r = bot.send({ content, room: '앙메톡', author: { name: '홍길동', hash: 'h1' } });
  const call = r.calls.find((c) => c.endpoint.indexOf('/berry/') >= 0);
  return { r, call, reply: r.replies.length ? r.replies[0].text : '' };
};

console.log('▸ 인자 1개 — 본캐로 조회');
{
  const { call } = run('/농장 30');
  check('본캐 엔드포인트 (닉네임 없음)', call.endpoint === '/api/berry/character', call.endpoint);
  check('entries=30', call.params.entries === '30');
  check('방·프로필을 함께 보냄', call.params.chatRoomName === '앙메톡' && call.params.talkProfileName === '홍길동');
  check('target 은 안 보냄', call.params.target === undefined);
}

console.log('\n▸ 인자 2개 — 닉네임 지정');
{
  const { call } = run('/농장 베베 30');
  check('닉네임이 경로에', call.endpoint === '/api/berry/character/%EB%B2%A0%EB%B2%A0', call.endpoint);
  check('entries=30', call.params.entries === '30');
}

console.log('\n▸ 목표 레벨 모드');
{
  const { call } = run('/농장 290렙');
  check('target=290', call.params.target === '290');
  check('entries 는 안 보냄', call.params.entries === undefined);
}
{
  const { call } = run('/농장 베베 290렙');
  check('닉네임 + 목표', call.endpoint.indexOf('/character/') >= 0 && call.params.target === '290');
}

console.log('\n▸ 접미사 7종');
{
  for (const suffix of ['렙', '레벨', 'lv', 'Lv', 'LV', 'lV', 'level']) {
    const { call } = run('/농장 290' + suffix);
    check(`290${suffix}`, call && call.params.target === '290');
  }
}

console.log('\n▸ 농장 이름과 같은 닉네임 — 닉네임으로 읽는다');
{
  // 전부 실존하는 캐릭터다. 농장으로 읽으면 조용히 틀린 답이 나간다.
  for (const name of ['크림슨', '딸기농장', '블루베리', '메카베리', '딸기', '블루']) {
    const { call } = run('/농장 ' + name + ' 30');
    const encoded = encodeURIComponent(name);
    check(`${name} → 닉네임`, call.endpoint === '/api/berry/character/' + encoded, call.endpoint);
    check(`${name} → farm 인자 없음`, call.params.farm === undefined);
  }
}

console.log('\n▸ 잘못된 입력은 API 를 부르지 않는다');
{
  for (const content of ['/농장', '/농장 abc', '/농장 렙290', '/농장 3.5', '/농장 베베 abc', '/농장 크림슨 베베 30']) {
    const { call, reply } = run(content);
    check(`${content} → 안내`, !call && reply.length > 0, reply.split('\n')[0].slice(0, 30));
  }
}

console.log('\n▸ 초성 명령어');
{
  for (const cmd of ['/ㄴㅈ 30', '/ㄵ 30']) {
    const { call } = run(cmd);
    check(cmd, call && call.params.entries === '30');
  }
}

console.log('\n결과: ' + (fail === 0 ? '전부 통과' : fail + '건 실패'));
process.exit(fail ? 1 : 0);
