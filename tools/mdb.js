#!/usr/bin/env node
/**
 * mdb.js — MessengerBot 디버그룸 소켓 클라이언트
 *
 * 카카오톡 없이 맥에서 봇 명령어를 직접 테스트한다.
 * 메신저봇이 서버(기본 9500), 이 스크립트가 클라이언트.
 * 폰은 adb로 연결되어 있어야 하며 포트는 adb forward로 터널링한다.
 *
 * 프로토콜: 줄 단위 JSON (readLine 기반)
 *   보냄 {"name":"debugRoom","data":{isGroupChat,botName,packageName,roomName,authorName,message}}
 *   받음 {"name":"debugRoom","data":{botName,roomName,authorName,message,isBot}}
 *        {"name":"compileStatus","data":{botName,status,error}}
 *        {"name":"runtimeError","data":{botName,error}}
 *        {"name":"badRequest:debugRoom"|"badRequest:compile","data":{botName,error}}
 *
 * 사용법:
 *   node tools/mdb.js                       대화형 모드
 *   node tools/mdb.js "/6차 엽이감성"        단발 전송 후 응답 출력
 *   node tools/mdb.js --compile             봇 재컴파일만
 *   node tools/mdb.js --compile "/도움말"    재컴파일 후 전송
 *
 * 옵션:
 *   --bot <이름>       대상 봇 (기본 gsbot)
 *   --room <이름>      방 이름 (기본 디버그룸)
 *   --author <이름>    발신자 (기본 승엽[EmotionB_SY])
 *   --package <pkg>    메신저 패키지 (기본 com.kakao.talk)
 *   --dm               1:1 대화로 전송 (기본은 단체방)
 *   --port <n>         로컬 포트 (기본 9500)
 *   --remote-port <n>  폰 쪽 포트 (기본 --port 와 동일)
 *   --host <ip>        접속 주소 (기본 127.0.0.1). 지정 시 adb forward 생략
 *   --no-forward       adb forward 생략
 *   --wait <ms>        단발 모드에서 마지막 응답 후 대기 시간 (기본 3000)
 *   --timeout <ms>     단발 모드 전체 제한 시간 (기본 30000)
 *   --raw              수신 원본 JSON 도 함께 출력
 *
 * 대화형 모드 명령:
 *   :compile [봇]   재컴파일       :room <이름>   방 변경
 *   :author <이름>  발신자 변경     :bot <이름>    대상 봇 변경
 *   :raw            원본 토글       :quit          종료
 */

const net = require('net');
const readline = require('readline');
const { execFileSync } = require('child_process');

const C = process.stdout.isTTY
    ? { r: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m', cyn: '\x1b[36m', b: '\x1b[1m' }
    : { r: '', dim: '', red: '', grn: '', ylw: '', cyn: '', b: '' };

function parseArgs(argv) {
    const o = {
        bot: 'gsbot',
        room: '디버그룸',
        author: '승엽[EmotionB_SY]',
        packageName: 'com.kakao.talk',
        isGroupChat: true,
        port: 9500,
        remotePort: null,
        host: '127.0.0.1',
        forward: true,
        wait: 3000,
        timeout: 30000,
        raw: false,
        compile: false,
        message: null,
    };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--bot': o.bot = argv[++i]; break;
            case '--room': o.room = argv[++i]; break;
            case '--author': o.author = argv[++i]; break;
            case '--package': o.packageName = argv[++i]; break;
            case '--dm': o.isGroupChat = false; break;
            case '--group': o.isGroupChat = true; break;
            case '--port': o.port = Number(argv[++i]); break;
            case '--remote-port': o.remotePort = Number(argv[++i]); break;
            case '--host': o.host = argv[++i]; o.forward = false; break;
            case '--no-forward': o.forward = false; break;
            case '--wait': o.wait = Number(argv[++i]); break;
            case '--timeout': o.timeout = Number(argv[++i]); break;
            case '--raw': o.raw = true; break;
            case '--compile': o.compile = true; break;
            case '-h': case '--help': o.help = true; break;
            default:
                if (a.startsWith('--')) { console.error(`알 수 없는 옵션: ${a}`); process.exit(2); }
                rest.push(a);
        }
    }
    if (o.remotePort === null) o.remotePort = o.port;
    if (rest.length) o.message = rest.join(' ');
    return o;
}

function adbForward(local, remote) {
    try {
        const devices = execFileSync('adb', ['devices'], { encoding: 'utf8' })
            .split('\n').slice(1).filter(l => /\tdevice$/.test(l.trim()));
        if (devices.length === 0) {
            console.error(`${C.red}연결된 안드로이드 기기가 없습니다.${C.r}`);
            console.error(`${C.dim}USB: 케이블 연결 후 폰에서 USB 디버깅 허용`);
            console.error(`무선: adb pair <ip>:<페어링포트>  →  adb connect <ip>:<포트>${C.r}`);
            process.exit(1);
        }
        if (devices.length > 1) {
            console.error(`${C.ylw}기기가 여러 대 연결되어 있습니다. ANDROID_SERIAL 로 지정하세요.${C.r}`);
        }
        execFileSync('adb', ['forward', `tcp:${local}`, `tcp:${remote}`], { encoding: 'utf8' });
        console.error(`${C.dim}adb forward tcp:${local} → tcp:${remote}${C.r}`);
    } catch (e) {
        if (e.status === undefined && e.code === 'ENOENT') {
            console.error(`${C.red}adb 를 찾을 수 없습니다. brew install android-platform-tools${C.r}`);
        } else {
            console.error(`${C.red}adb forward 실패: ${(e.stderr || e.message || '').toString().trim()}${C.r}`);
        }
        process.exit(1);
    }
}

function ts() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) {
        console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
        return;
    }

    if (o.forward) adbForward(o.port, o.remotePort);

    const interactive = !o.message && !o.compile;
    let lastActivity = Date.now();
    let sawReply = false;

    const sock = net.createConnection({ host: o.host, port: o.port }, () => {
        console.error(`${C.grn}연결됨${C.r} ${C.dim}${o.host}:${o.port} · bot=${o.bot} room=${o.room} author=${o.author}${C.r}`);
        if (o.compile) send({ name: 'compile', data: { botName: o.bot } });
        else if (o.message) sendMessage(o.message);
        if (interactive) startRepl();
    });

    sock.on('error', (e) => {
        console.error(`${C.red}소켓 연결 실패: ${e.message}${C.r}`);
        console.error(`${C.dim}메신저봇 앱 설정에서 소켓 서버가 켜져 있는지, 포트가 ${o.remotePort} 인지 확인하세요.${C.r}`);
        process.exit(1);
    });

    sock.on('close', () => {
        console.error(`${C.dim}연결 종료${C.r}`);
        process.exit(0);
    });

    function send(obj) {
        sock.write(JSON.stringify(obj) + '\n');
    }

    function sendMessage(text) {
        lastActivity = Date.now();
        send({
            name: 'debugRoom',
            data: {
                isGroupChat: o.isGroupChat,
                botName: o.bot,
                packageName: o.packageName,
                roomName: o.room,
                authorName: o.author,
                message: text,
            },
        });
        console.log(`${C.dim}${ts()}${C.r} ${C.cyn}→ ${o.author}:${C.r} ${text}`);
    }

    // 줄 단위 수신
    let buf = '';
    sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (line.trim()) handleLine(line);
        }
    });

    function handleLine(line) {
        lastActivity = Date.now();
        if (o.raw) console.log(`${C.dim}${line}${C.r}`);
        let json;
        try { json = JSON.parse(line); } catch (e) {
            console.log(`${C.ylw}파싱 불가:${C.r} ${line}`);
            return;
        }
        const d = json.data || {};
        switch (json.name) {
            case 'debugRoom':
                if (d.isBot) {
                    sawReply = true;
                    console.log(`${C.dim}${ts()}${C.r} ${C.grn}${C.b}← ${d.botName}:${C.r}\n${d.message}`);
                } else if (!o.raw) {
                    // 앱이 되돌려주는 내 메시지 에코 — 조용히 무시
                }
                break;
            case 'compileStatus':
                if (d.status === 'start') {
                    console.log(`${C.dim}${ts()} 컴파일 시작: ${d.botName}${C.r}`);
                } else if (d.status === 'success') {
                    console.log(`${C.grn}컴파일 성공: ${d.botName}${C.r}`);
                    if (o.compile && o.message) sendMessage(o.message);
                    else if (o.compile && !interactive) finish(0);
                } else {
                    console.log(`${C.red}컴파일 실패: ${d.botName}\n${d.error}${C.r}`);
                    if (o.compile && !interactive) finish(1);
                }
                break;
            case 'runtimeError':
                console.log(`${C.red}런타임 에러 (${d.botName}):\n${d.error}${C.r}`);
                break;
            case 'badRequest:debugRoom':
            case 'badRequest:compile':
                console.log(`${C.red}거부됨 [${json.name}] ${d.botName || ''}: ${d.error}${C.r}`);
                console.log(`${C.dim}봇 이름이 실제 스크립트 폴더명과 같은지, 봇 전원이 켜져 있는지 확인하세요.${C.r}`);
                break;
            default:
                console.log(`${C.ylw}알 수 없는 메시지:${C.r} ${line}`);
        }
    }

    function finish(code) {
        try { sock.end(); } catch (e) {}
        process.exit(code);
    }

    // 단발 모드: 마지막 수신 후 --wait 만큼 조용하면 종료
    if (!interactive) {
        const started = Date.now();
        const tick = setInterval(() => {
            if (Date.now() - lastActivity > o.wait && (sawReply || Date.now() - started > o.wait * 2)) {
                clearInterval(tick);
                if (!sawReply) console.error(`${C.ylw}봇 응답 없음. 봇 전원 / 명령어 / 서버 상태를 확인하세요.${C.r}`);
                finish(sawReply ? 0 : 1);
            }
            if (Date.now() - started > o.timeout) {
                clearInterval(tick);
                console.error(`${C.ylw}제한 시간 초과 (${o.timeout}ms)${C.r}`);
                finish(1);
            }
        }, 200);
    }

    function startRepl() {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
        console.error(`${C.dim}메시지를 입력하면 그대로 봇에 전달됩니다. :help 로 메타 명령 확인, :quit 종료${C.r}`);
        rl.prompt();
        rl.on('line', (line) => {
            const t = line.trim();
            if (!t) { rl.prompt(); return; }
            if (t.startsWith(':')) {
                const [cmd, ...args] = t.slice(1).split(/\s+/);
                const arg = args.join(' ');
                switch (cmd) {
                    case 'quit': case 'q': case 'exit': rl.close(); return;
                    case 'compile': case 'c':
                        send({ name: 'compile', data: { botName: arg || o.bot } });
                        break;
                    case 'room': o.room = arg; console.error(`${C.dim}room=${o.room}${C.r}`); break;
                    case 'author': o.author = arg; console.error(`${C.dim}author=${o.author}${C.r}`); break;
                    case 'bot': o.bot = arg; console.error(`${C.dim}bot=${o.bot}${C.r}`); break;
                    case 'dm': o.isGroupChat = false; console.error(`${C.dim}isGroupChat=false${C.r}`); break;
                    case 'group': o.isGroupChat = true; console.error(`${C.dim}isGroupChat=true${C.r}`); break;
                    case 'raw': o.raw = !o.raw; console.error(`${C.dim}raw=${o.raw}${C.r}`); break;
                    case 'help': case 'h':
                        console.error(`${C.dim}:compile [봇] :room <이름> :author <이름> :bot <이름> :dm :group :raw :quit${C.r}`);
                        break;
                    default: console.error(`${C.ylw}알 수 없는 명령: :${cmd}${C.r}`);
                }
            } else {
                sendMessage(t);
            }
            rl.prompt();
        });
        rl.on('close', () => finish(0));
    }
}

main();
