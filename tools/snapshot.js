#!/usr/bin/env node
/**
 * snapshot.js — 명령어 전수 동작을 스냅샷으로 떠서 비교한다
 *
 * gsbot.js 소스에서 stringMatchResult 의 별칭 배열을 전부 긁어 명령어 목록을 만들고,
 * 별칭마다 인자 조합을 몇 가지씩 흘려보내 "어떤 API 를 어떤 파라미터로 부르고
 * 무엇을 답장하는가" 를 기록한다. 리팩터링 전후로 이 파일이 같으면 동작이 같다.
 *
 *   node tools/snapshot.js > before.json      # 리팩터링 전
 *   node tools/snapshot.js > after.json       # 리팩터링 후
 *   node tools/snapshot.js --diff before.json after.json
 */
const fs = require('fs');
const { loadBot, BOT_SOURCE } = require('./harness.js');

function parseArray(literal) {
    return literal
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 1)
        .map((s) => s.replace(/^["'`]|["'`]$/g, ''));
}

/**
 * 소스에서 명령어 별칭을 전부 뽑는다. 두 갈래가 있다.
 *   - stringMatchResult(featString, [...])  직접 나열한 것
 *   - CASH_BOXES / SEED_RING_BOXES 의 aliases  루프로 도는 것
 * 후자를 빠뜨리면 캐시샵·보스반지 10종이 통째로 검증에서 새어나간다.
 */
function extractAliases(source) {
    const groups = [];

    const inline = /stringMatchResult\(\s*featString\s*,\s*\[([^\]]*)\]/g;
    let m;
    while ((m = inline.exec(source)) !== null) {
        const aliases = parseArray(m[1]);
        if (aliases.length) groups.push(aliases);
    }

    const boxed = /"aliases"\s*:\s*\[([^\]]*)\]/g;
    while ((m = boxed.exec(source)) !== null) {
        const aliases = parseArray(m[1]);
        if (aliases.length) groups.push(aliases);
    }

    return groups;
}

/** 인자 개수별 동작이 갈리므로 0~3개를 모두 흘려본다. */
const ARG_SETS = [
    [],
    ['엽이감성'],
    ['0', '20'],
    ['1', '2', '3'],
    ['10', '15', '1', '0', '0', '0'],
];

function run(sourcePath) {
    const source = fs.readFileSync(sourcePath || BOT_SOURCE, 'utf8');
    const groups = extractAliases(source);
    const out = { commandGroups: groups.length, aliases: 0, cases: [] };

    for (const aliases of groups) {
        out.aliases += aliases.length;
        for (const alias of aliases) {
            for (const args of ARG_SETS) {
                // 별칭마다 봇을 새로 올린다 — 모듈 스코프 상태가 케이스 간에 새지 않게.
                const bot = loadBot({ source });
                const content = `/${alias}${args.length ? ' ' + args.join(' ') : ''}`;
                const r = bot.send({ content });
                out.cases.push({
                    input: content,
                    error: r.error ? String(r.error).split('\n')[0] : null,
                    calls: r.calls.map((c) => ({
                        method: c.method,
                        endpoint: c.endpoint,
                        params: c.params,
                        body: c.body,
                        timeout: c.timeout,
                    })),
                    replies: r.replies.map((x) => ({ type: x.type, text: x.text })),
                    sent: r.sent,
                });
            }
        }
    }
    return out;
}

/** timeout 은 이번 변경의 의도된 차이라 따로 무시할 수 있게 한다. */
function diff(aPath, bPath, ignoreTimeout) {
    const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
    const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
    const key = (c) => c.input;
    const am = new Map(a.cases.map((c) => [key(c), c]));
    const bm = new Map(b.cases.map((c) => [key(c), c]));

    let changed = 0;
    for (const [k, av] of am) {
        if (!bm.has(k)) { console.log(`- 사라짐: ${k}`); changed++; continue; }
        const bv = bm.get(k);
        const strip = (c) => (ignoreTimeout ? c.calls.map((x) => Object.assign({}, x, { timeout: null })) : c.calls);
        const as = JSON.stringify({ calls: strip(av), replies: av.replies, sent: av.sent, error: av.error });
        const bs = JSON.stringify({ calls: strip(bv), replies: bv.replies, sent: bv.sent, error: bv.error });
        if (as !== bs) {
            changed++;
            console.log(`~ 다름: ${k}`);
            console.log(`   before: ${as.slice(0, 300)}`);
            console.log(`   after : ${bs.slice(0, 300)}`);
        }
    }
    for (const k of bm.keys()) if (!am.has(k)) { console.log(`+ 새로 생김: ${k}`); changed++; }

    console.log(`\n케이스 ${am.size}건 중 ${changed}건 차이`);
    return changed;
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv[0] === '--diff') {
        process.exit(diff(argv[1], argv[2], argv.includes('--ignore-timeout')) === 0 ? 0 : 1);
    } else {
        const i = argv.indexOf('--source');
        process.stdout.write(JSON.stringify(run(i >= 0 ? argv[i + 1] : null), null, 1));
    }
}

module.exports = { run, extractAliases };
