#!/usr/bin/env node
/**
 * test-script-update.js — @@스크립트갱신 의 인증·검증·롤백 대비
 *
 * 이 명령은 폰에 파일을 쓰고 재컴파일한다. 인증이 새거나 받은 내용을 그대로
 * 믿으면 봇이 죽거나 임의 코드가 심긴다. 막아야 할 것들을 전부 확인한다.
 *
 *   node tools/test-script-update.js
 */
const { loadBot } = require('./harness.js');

const ADMIN_NAME = '승엽[EmotionB_SY]';
const ADMIN_HASH = 'a'.repeat(64);
const admin = { name: ADMIN_NAME, hash: ADMIN_HASH };

// 스크립트로 인정받는 최소 조건을 갖춘 가짜 소스
const VALID = 'const bot = BotManager.getCurrentBot();\n' + '// 채우기\n'.repeat(600);

let fail = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '  OK  ' : '  FAIL') + ' ' + name + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
};
const bootWith = (body, opts) => loadBot(Object.assign({
  adminHash: ADMIN_HASH,
  responder: (call) => (call.url.indexOf('raw.githubusercontent.com') >= 0 ? body : undefined),
}, opts || {}));

console.log('[1] 관리자가 아니면 아무것도 하지 않는다');
{
  const bot = bootWith(VALID);
  const r = bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: { name: '아무개', hash: 'zzz' } }, 'command');
  check('저장소를 부르지 않음', r.calls.length === 0);
  check('재컴파일 없음', r.compiled.length === 0);
}

console.log('\n[2] 이름만 관리자이고 hash 가 없으면 거부 (위조 방지)');
{
  const bot = bootWith(VALID);
  const r = bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: { name: ADMIN_NAME, hash: null } }, 'command');
  check('저장소를 부르지 않음', r.calls.length === 0);
  check('재컴파일 없음', r.compiled.length === 0);
}

console.log('\n[3] 정상 갱신');
{
  const bot = bootWith(VALID);
  // 폰에는 이미 돌고 있는 스크립트가 있다 — 백업 대상이 생기는 실제 상황
  bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] = '이전 스크립트';
  const r = bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: admin }, 'command');
  const url = r.calls.length ? r.calls[0].url : '';
  check('저장소에서 받아옴', r.calls.length === 1);
  check('주소가 상수로 고정', url === 'https://raw.githubusercontent.com/emotionalboySY/gsbot_app/main/Bots/gsbot/gsbot.js', url);
  check('파일에 기록됨', bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] === VALID);
  check('직전 것을 .bak 으로 남김', bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js.bak'] === '이전 스크립트');
  check('재컴파일 호출', r.compiled.length === 1 && r.compiled[0] === 'gsbot', String(r.compiled));
  check('보고가 재컴파일보다 먼저', r.replies.length >= 1 && /갱신/.test(r.replies[0].text));
}

console.log('\n[4] 목록에 없는 봇 이름은 거부 (경로 조작 포함)');
{
  for (const name of ['../../etc/hosts', 'gsbot/../../x', '없는봇']) {
    const bot = bootWith(VALID);
    const r = bot.send({ content: '@@스크립트갱신 ' + name, room: '앙메톡', author: admin }, 'command');
    check('거부: ' + name, r.calls.length === 0 && r.compiled.length === 0 && /갱신할 수 있는 봇이 아닙니다/.test(r.replies[0].text));
  }
}

console.log('\n[5] 짧은 응답은 덮어쓰지 않는다 (404·잘린 응답)');
{
  const bot = bootWith('Not Found');
  bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] = '원본 유지되어야 함';
  const r = bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: admin }, 'command');
  check('파일 그대로', bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] === '원본 유지되어야 함');
  check('재컴파일 안 함', r.compiled.length === 0);
  check('사유 안내', /너무 짧습니다/.test(r.replies[0].text));
}

console.log('\n[6] 길지만 스크립트가 아니면 거부 (HTML 안내 페이지)');
{
  const bot = bootWith('GitHub - Page not found. '.repeat(500));
  bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] = '원본 유지되어야 함';
  const r = bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: admin }, 'command');
  check('파일 그대로', bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] === '원본 유지되어야 함');
  check('재컴파일 안 함', r.compiled.length === 0);
  check('사유 안내', /표식을 찾지 못했습니다/.test(r.replies[0].text));
}

console.log('\n[7] 내용이 같으면 재컴파일하지 않는다');
{
  const bot = bootWith(VALID);
  bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] = VALID;
  const r = bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: admin }, 'command');
  check('재컴파일 없음', r.compiled.length === 0);
  check('최신 안내', /이미 최신입니다/.test(r.replies[0].text));
}

console.log('\n[8] 네트워크 실패는 파일을 건드리지 않는다');
{
  const bot = bootWith(new Error('java.net.SocketTimeoutException: timeout'));
  bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] = '원본 유지되어야 함';
  const r = bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: admin }, 'command');
  check('파일 그대로', bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] === '원본 유지되어야 함');
  check('재컴파일 안 함', r.compiled.length === 0);
  check('사유 안내', /받지 못했습니다/.test(r.replies[0].text));
}

console.log('\n[9] 줄바꿈이 뭉개진 응답은 덮어쓰지 않는다 (실제 사고)');
{
  // JSoup 의 get().body().text() 가 돌려주던 모양. 길이도 충분하고 표식도
  // 그대로라 예전 검사 두 개를 모두 통과한 채 봇을 한 줄로 만들어 죽였다.
  const flattened = VALID.split('\n').join(' ');
  const bot = bootWith(flattened);
  bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] = '원본 유지되어야 함';
  const r = bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: admin }, 'command');
  check('길이는 하한을 넘김 (길이 검사로는 못 거름)', flattened.length > 4000, String(flattened.length) + '자');
  check('표식도 들어있음 (표식 검사로도 못 거름)', flattened.indexOf('BotManager.getCurrentBot') >= 0);
  check('그래도 파일은 그대로', bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'] === '원본 유지되어야 함');
  check('재컴파일 안 함', r.compiled.length === 0);
  check('사유 안내', /줄바꿈이 뭉개진/.test(r.replies[0].text), JSON.stringify(r.replies[0].text).slice(0, 70));
}

console.log('\n[10] 받은 소스의 줄바꿈이 그대로 보존된다');
{
  const bot = bootWith(VALID);
  bot.send({ content: '@@스크립트갱신', room: '앙메톡', author: admin }, 'command');
  const written = bot.state.files['/sdcard/msgbot/Bots/gsbot/gsbot.js'];
  check('줄 수 유지', written.split('\n').length === VALID.split('\n').length,
    written.split('\n').length + ' / ' + VALID.split('\n').length);
  check('내용 동일', written === VALID);
}

console.log('\n[11] 다른 봇도 갱신할 수 있다');
{
  const bot = bootWith(VALID);
  const r = bot.send({ content: '@@스크립트갱신 gsbot_noti', room: '앙메톡', author: admin }, 'command');
  check('경로가 그 봇의 것', bot.state.files['/sdcard/msgbot/Bots/gsbot_noti/gsbot_noti.js'] === VALID);
  check('그 봇을 재컴파일', r.compiled.length === 1 && r.compiled[0] === 'gsbot_noti', String(r.compiled));
}

console.log('\n결과: ' + (fail === 0 ? '전부 통과' : fail + '건 실패'));
process.exit(fail ? 1 : 0);
