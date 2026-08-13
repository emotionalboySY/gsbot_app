#!/usr/bin/env node
/**
 * harness.js — 메신저봇 런타임 흉내 (폰 없이 봇 스크립트를 실행한다)
 *
 * gsbot.js 는 GraalJS 위에서 BotManager·App·Database·Packages 같은 전역에 기대므로
 * 그냥 node 로는 못 돌린다. 그 전역들만 최소로 채워 vm 컨텍스트에서 원본 소스를
 * 그대로 실행한다. 소스는 손대지 않는다 — 손대면 검증한 것이 실물과 달라진다.
 *
 * 네트워크는 타지 않는다. JSOUP 은 호출 내역(엔드포인트·파라미터)만 기록하고
 * 정해진 응답을 돌려준다. 리팩터링 전후로 "어떤 명령이 어떤 API 를 부르고
 * 무엇을 답장하는가" 가 같은지 비교하는 것이 목적이다.
 *
 *   const { loadBot } = require('./harness.js');
 *   const bot = loadBot();
 *   bot.send({ content: '/6차 0 20', room: '테스트방' });
 *   console.log(bot.calls, bot.replies);
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BOT_SOURCE = path.join(__dirname, '..', 'Bots', 'gsbot', 'gsbot.js');

/** 서버 응답 기본값. 핸들러가 참조하는 필드를 넉넉히 채워 둔다. */
function defaultResponse(call) {
    const body = `<MOCK ${call.method} ${call.endpoint}>`;
    return {
        success: true,
        result: encodeURIComponent(body),
        resultRaw: body,
        resultMarkdown: `## ${body}`,
        title: 'MOCK의 히스토리',
        characterName: 'MOCK',
        message: body,
    };
}

/**
 * 컨텍스트 안에서 난수·시각을 고정하는 프렐류드.
 * gsbot.js 보다 먼저 돌아야 하므로 별도 스크립트로 심는다.
 */
const PRELUDE = `(function (seed, fixedNow) {
    let s = seed >>> 0;
    Math.random = function () {
        // xorshift32 — 시드만 같으면 항상 같은 수열이 나온다.
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5;  s >>>= 0;
        return s / 4294967296;
    };

    let clock = fixedNow;
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
        construct(target, args) {
            return args.length ? new target(...args) : new target(clock);
        },
    });
    globalThis.Date.now = function () { return clock; };
    globalThis.__advanceClock = function (ms) { clock += ms; return clock; };
})`;

/**
 * @param {object} opts
 *   - responder(call): 응답 객체를 돌려준다. 없으면 defaultResponse.
 *   - seed: Math.random 시드 (기본 20260813)
 *   - now: 고정 시각 ms (기본 2026-08-13 12:00 KST)
 *   - source: 실행할 소스 문자열 (기본 Bots/gsbot/gsbot.js)
 *   - database: Database 초기 내용 { 파일명: 문자열 }
 *   - adminHash: Database 의 admin.json 에 심을 hash (관리자 명령 검증용)
 *   - adminToken: admin_token.txt 에 심을 토큰
 */
function loadBot(opts) {
    opts = opts || {};

    const state = {
        calls: [],        // { method, endpoint, params, url }
        replies: [],      // { type: 'plain'|'markdown', text }
        sent: [],         // bot.send(room, text)
        logs: [],
        delayed: [],      // App.runDelayed 로 예약된 것
        background: [],   // App.runOnBackgroundThread 로 넘긴 것
        files: {},        // FileStream 이 쓴 내용 (메모리)
        timers: {},       // 등록된 setInterval/setTimeout — 자동으로 돌지 않는다
        timerSeq: 0,
        listeners: {},
    };

    const db = Object.assign({}, opts.database || {});
    if (opts.adminHash) {
        db['admin.json'] = JSON.stringify({
            hash: opts.adminHash, name: '관리자', room: '테스트방', registeredAt: '2026-01-01',
        });
    }
    if (opts.adminToken) db['admin_token.txt'] = opts.adminToken;

    const responder = opts.responder || defaultResponse;

    // ── JSoup 흉내 ──────────────────────────────────────────────────────────
    function jsoupConnect(url) {
        const call = { url: String(url), timeout: null, headers: {}, body: null };

        function finish(method) {
            call.method = method;
            const u = new URL(call.url);
            call.endpoint = u.pathname;
            call.params = Object.fromEntries(u.searchParams.entries());
            state.calls.push(call);

            const res = responder(call);
            if (res instanceof Error) throw res;
            const text = typeof res === 'string' ? res : JSON.stringify(res);
            return { body: () => ({ text: () => text }) };
        }

        const conn = {
            ignoreContentType() { return conn; },
            timeout(ms) { call.timeout = ms; return conn; },
            header(k, v) { call.headers[k] = String(v); return conn; },
            requestBody(b) { call.body = String(b); return conn; },
            get() { return finish('GET'); },
            post() { return finish('POST'); },
        };
        return conn;
    }

    // ── 전역 ────────────────────────────────────────────────────────────────
    const bot = {
        addListener(event, fn) {
            if (!state.listeners[event]) state.listeners[event] = [];
            state.listeners[event].push(fn);
        },
        send(room, text) { state.sent.push({ room, text: String(text) }); return true; },
        canReply() { return true; },
        setCommandPrefix() {},
    };

    const Event = {
        MESSAGE: 'message',
        COMMAND: 'command',
        START_COMPILE: 'startCompile',
        TICK: 'tick',
        NOTIFICATION_REMOVED: 'notificationRemoved',
        NOTIFICATION_POSTED: 'notificationPosted',
        Activity: {
            CREATE: 'a.create', START: 'a.start', RESUME: 'a.resume', PAUSE: 'a.pause',
            STOP: 'a.stop', RESTART: 'a.restart', DESTROY: 'a.destroy', BACK_PRESSED: 'a.back',
        },
    };

    const sandbox = {
        console,
        URL, URLSearchParams,
        BotManager: { getCurrentBot: () => bot },
        Event,
        Log: {
            e(x) { state.logs.push({ level: 'e', text: String(x) }); },
            d(x) { state.logs.push({ level: 'd', text: String(x) }); },
            i(x) { state.logs.push({ level: 'i', text: String(x) }); },
            w(x) { state.logs.push({ level: 'w', text: String(x) }); },
        },
        Database: {
            exists: (f) => Object.prototype.hasOwnProperty.call(db, f),
            readString: (f) => (Object.prototype.hasOwnProperty.call(db, f) ? db[f] : null),
            writeString: (f, v) => { db[f] = String(v); },
        },
        App: {
            getContext: () => ({ startActivity() {} }),
            runDelayed(fn, ms) { state.delayed.push({ fn, ms }); },
            runOnBackgroundThread(fn) { state.background.push(fn); fn(); },
            runOnUiThread(fn) { fn(); },
            isMainThread: () => true,
        },
        // 메신저봇의 Http. 실기기 실측대로 콜백은 (error, response, document) 이고
        // 연결 실패는 예외가 아니라 error 로 온다. 여기서는 콜백을 그 자리에서
        // 부른다 — 트램펄린이 send() 안에서 끝나야 스냅샷으로 비교할 수 있다.
        Http: {
            request(url, callback) {
                const call = { url: String(url), timeout: null, headers: {}, body: null, via: 'Http' };
                call.method = 'GET';
                const u = new URL(call.url);
                call.endpoint = u.pathname;
                call.params = Object.fromEntries(u.searchParams.entries());
                state.calls.push(call);

                const res = responder(call);
                if (res instanceof Error) { callback(res, null, null); return null; }
                const text = typeof res === 'string' ? res : JSON.stringify(res);
                callback(null, { statusCode: () => 200 }, { body: () => ({ text: () => text }) });
                return null;
            },
        },
        // 파일은 메모리에만 둔다. 실제 디스크를 건드리면 검증이 기기 상태에 얽힌다.
        FileStream: {
            read: (f) => (Object.prototype.hasOwnProperty.call(state.files, f) ? state.files[f] : null),
            write: (f, v) => { state.files[f] = String(v); return true; },
            append: (f, v) => { state.files[f] = (state.files[f] || '') + String(v); return true; },
            exists: (f) => Object.prototype.hasOwnProperty.call(state.files, f),
            remove: (f) => { delete state.files[f]; return true; },
            create: (f) => { state.files[f] = state.files[f] || ''; return true; },
            createDir: (f) => { state.files[f] = state.files[f] || ''; return true; },
            getSdcardPath: () => '/sdcard',
        },
        Device: Object.assign({
            getBatteryLevel: () => 79,
            isCharging: () => true,
            isPowerSaveMode: () => false,
            isScreenOn: () => true,
            getFreeMemory: () => 48709200,
            getTotalMemory: () => 90843632,
            getPhoneModel: () => 'b0q',
            getAndroidVersionName: () => '16',
        }, opts.device || {}),
        // 타이머는 자동으로 돌지 않는다. 등록만 받아 두고 테스트가 직접 부른다 —
        // 그래야 "60초 뒤" 를 기다리지 않고 sweep 을 검증할 수 있다.
        setInterval(fn, ms) { const id = ++state.timerSeq; state.timers[id] = { fn, ms, kind: 'interval' }; return id; },
        setTimeout(fn, ms) { const id = ++state.timerSeq; state.timers[id] = { fn, ms, kind: 'timeout' }; return id; },
        clearInterval(id) { delete state.timers[id]; },
        clearTimeout(id) { delete state.timers[id]; },
        Packages: {
            org: { jsoup: { Jsoup: { connect: jsoupConnect } } },
            java: {
                net: {
                    URLEncoder: { encode: (s) => encodeURIComponent(String(s)) },
                    URLDecoder: { decode: (s) => decodeURIComponent(String(s)) },
                },
            },
            android: {
                content: {
                    Intent: function Intent(action) {
                        this.action = action;
                        this.addCategory = () => {};
                        this.setFlags = () => {};
                    },
                },
            },
        },
    };
    sandbox.Packages.android.content.Intent.ACTION_MAIN = 'android.intent.action.MAIN';
    sandbox.Packages.android.content.Intent.CATEGORY_HOME = 'android.intent.category.HOME';
    sandbox.Packages.android.content.Intent.FLAG_ACTIVITY_NEW_TASK = 0x10000000;
    sandbox.global = sandbox;

    const context = vm.createContext(sandbox);

    // 난수와 시각을 고정한다. 그러지 않으면 /뭐먹지·/뭐하지 처럼 무작위로 고르는
    // 명령과 0~2시에만 붙는 넥슨 점검 안내 때문에 같은 소스에서도 스냅샷이 달라져
    // 리팩터링이 바꾼 것과 구분할 수 없다.
    vm.runInContext(PRELUDE, context, { filename: 'prelude.js' })(
        opts.seed === undefined ? 20260813 : opts.seed,
        opts.now === undefined ? Date.UTC(2026, 7, 13, 3, 0, 0) : opts.now,
    );

    const source = opts.source || fs.readFileSync(BOT_SOURCE, 'utf8');
    vm.runInContext(source, context, { filename: 'gsbot.js' });

    /** 메시지 1건을 리스너에 흘려보내고, 그 호출로 생긴 기록만 돌려준다. */
    function send(msg, event) {
        const before = { calls: state.calls.length, replies: state.replies.length, sent: state.sent.length };
        const full = Object.assign({
            content: '',
            room: '테스트방',
            isGroupChat: true,
            isDebugRoom: false,
            packageName: 'com.kakao.talk',
            logId: 1n,
            channelId: 1n,
            isMention: false,
            reply(text) { state.replies.push({ type: 'plain', text: String(text) }); return true; },
            replyWithMarkdown(text) { state.replies.push({ type: 'markdown', text: String(text) }); return true; },
        }, msg);
        full.author = Object.assign({ name: '테스터', hash: null }, (msg && msg.author) || {});

        let error = null;
        const handlers = state.listeners[event || Event.MESSAGE] || [];
        for (const handler of handlers) {
            try {
                handler(full);
            } catch (e) {
                error = e;
            }
        }
        return {
            error,
            calls: state.calls.slice(before.calls),
            replies: state.replies.slice(before.replies),
            sent: state.sent.slice(before.sent),
        };
    }

    /** 임의 이벤트를 임의 인자로 발생시킨다 (NOTIFICATION_POSTED·START_COMPILE 등). */
    function emit(event) {
        const args = Array.prototype.slice.call(arguments, 1);
        const handlers = state.listeners[event] || [];
        const errors = [];
        for (const handler of handlers) {
            try { handler.apply(null, args); } catch (e) { errors.push(e); }
        }
        return errors;
    }

    /** 등록된 타이머 중 kind 가 맞는 것을 한 번씩 돌린다. */
    function fireTimers(kind) {
        for (const id in state.timers) {
            const timer = state.timers[id];
            if (!kind || timer.kind === kind) timer.fn();
        }
    }

    /** 고정 시각을 앞으로 감는다. 유예·쿨다운처럼 시간이 얽힌 로직 검증용. */
    function advanceTime(ms) { return sandbox.__advanceClock(ms); }

    return { send, emit, fireTimers, advanceTime, state, db, sandbox, context, Event };
}

module.exports = { loadBot, defaultResponse, BOT_SOURCE };
