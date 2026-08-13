#!/usr/bin/env node
/**
 * test-rawtext.js — 사용자가 쓴 모양 그대로 옮겨야 하는 값의 줄바꿈 보존
 *
 * options 는 /\s+/ 로 쪼갠 것이라 줄바꿈이 사라지고 연속 공백도 뭉개진다.
 * 공지·건의는 그러면 안 된다. 반대로 검색어(도움말·주문서)는 공백을 뭉개는
 * 지금 동작이 맞으므로 그쪽은 바뀌지 않았는지도 함께 본다.
 *
 *   node tools/test-rawtext.js
 */
const path = require('path');
const fs = require('fs');
const { loadBot } = require('./harness.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'Bots', 'gsbot', 'gsbot.js'), 'utf8');
const ADMIN_NAME = '승엽[EmotionB_SY]';
const ADMIN_HASH = 'a'.repeat(64);
const ROOM_COUNT = 6;   // ROOM_LIST 의 방 수

const NOTICE = [
    '감성봇 업데이트가 다시 돌아갑니다...',
    '',
    '- 보스 반지 연마 시뮬레이션 가능 (/연마석 [반지레벨] [사용 연마석 개수] [시도횟수])',
    '- 생명의 보스 반지 상자 시뮬레이션 (/생명 [횟수])',
    '',
    '/건의 명령어로 보내주시면 반영해보겠습니다 꾸벅 (__ )',
].join('\n');

let failed = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? '  OK ' : '  실패'} ${name}${ok ? '' : `\n       기대 ${JSON.stringify(expected)}\n       실제 ${JSON.stringify(actual)}`}`);
}
function adminBot() {
    return loadBot({ source: SOURCE, adminHash: ADMIN_HASH, adminToken: 'token' });
}
function asAdmin(content) {
    return { content, room: '테스트방', author: { name: ADMIN_NAME, hash: ADMIN_HASH } };
}

console.log('\n▸ @@공지전송 은 쓴 그대로 나간다');
{
    const bot = adminBot();
    bot.send(asAdmin(`@@공지전송 ${NOTICE}`), 'command');

    const notices = bot.state.sent.filter((s) => s.text === NOTICE);
    check('6개 방 전부에 원문 그대로', notices.length, ROOM_COUNT);
    check('줄바꿈 개수 유지', (notices[0] || { text: '' }).text.split('\n').length, NOTICE.split('\n').length);
    check('빈 줄도 유지', /\n\n/.test((notices[0] || { text: '' }).text), true);
}

console.log('\n▸ 명령어와 내용 사이 줄바꿈으로 시작해도 된다');
{
    const bot = adminBot();
    bot.send(asAdmin('@@공지전송\n첫 줄\n둘째 줄'), 'command');
    check('앞쪽 줄바꿈만 떼고 본문 유지', bot.state.sent.filter((s) => s.text === '첫 줄\n둘째 줄').length, ROOM_COUNT);
}

console.log('\n▸ 내용 없는 공지는 6개 방으로 나가지 않는다');
{
    const bot = adminBot();
    const r = bot.send(asAdmin('@@공지전송'), 'command');
    check('방 전송 0건', bot.state.sent.length, 0);
    check('사용법 안내', /보낼 공지 내용이 없습니다/.test((r.replies[0] || {}).text || ''), true);
}
{
    const bot = adminBot();
    bot.send(asAdmin('@@공지전송    '), 'command');
    check('공백뿐이어도 전송 0건', bot.state.sent.length, 0);
}

console.log('\n▸ /건의 도 여러 줄 그대로 접수한다');
{
    const content = '1번 기능이 있으면 좋겠어요\n2번도요\n\n감사합니다';
    const bot = loadBot({ source: SOURCE });
    const r = bot.send({ content: `/건의 ${content}`, room: '테스트방' });

    const post = r.calls.find((c) => c.method === 'POST');
    check('서버에 원문 그대로', JSON.parse(post.body).content, content);
    check('관리자 전달에도 원문 그대로', r.sent[0].text.endsWith(content), true);
}
{
    const bot = loadBot({ source: SOURCE });
    const r = bot.send({ content: '/건의', room: '테스트방' });
    check('내용 없으면 안내만', r.calls.length, 0);
    check('사용법 안내', /건의 내용을 함께 입력해 주세요/.test(r.replies[0].text), true);
}

console.log('\n▸ 검색어는 지금처럼 공백을 뭉갠다 (바꾸면 안 되는 쪽)');
{
    const bot = loadBot({ source: SOURCE });
    const r = bot.send({ content: '/도움말  게임   정보', room: '테스트방' });
    check('도움말 검색어는 공백 하나로', r.calls[0].params.query, '게임 정보');
}
{
    const bot = loadBot({ source: SOURCE });
    const r = bot.send({ content: '/주문서  놀라운 긍정의  혼돈 10', room: '테스트방' });
    check('주문서 검색어도 공백 하나로', r.calls[0].params.query, '놀라운 긍정의 혼돈');
    check('마지막 숫자는 횟수로', r.calls[0].params.iteration, '10');
}

console.log(`\n${failed === 0 ? '전부 통과' : failed + '건 실패'}\n`);
process.exit(failed === 0 ? 0 : 1);
