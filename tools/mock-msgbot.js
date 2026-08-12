#!/usr/bin/env node
/**
 * mock-msgbot.js — 메신저봇 소켓 서버 흉내
 *
 * 폰 없이 mdb.js 자체를 검증할 때 쓴다. 실제 봇 로직은 없고,
 * 받은 debugRoom 메시지에 고정 응답을 돌려주고 compile 에 성공 상태를 돌려준다.
 *
 *   터미널1: node tools/mock-msgbot.js --port 9599
 *   터미널2: node tools/mdb.js --no-forward --port 9599 "/6차 엽이감성"
 */
const net = require('net');

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : 9500;
const HOST = argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';

const server = net.createServer((sock) => {
    console.log(`[mock] 클라이언트 접속: ${sock.remoteAddress}`);
    let buf = '';
    const write = (o) => sock.write(JSON.stringify(o) + '\n');

    sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            console.log(`[mock] 수신: ${line}`);
            let json;
            try { json = JSON.parse(line); } catch (e) { continue; }
            const d = json.data || {};

            if (json.name === 'debugRoom') {
                if (!d.botName) {
                    write({ name: 'badRequest:debugRoom', data: { botName: '', error: 'botName is required' } });
                    continue;
                }
                // 사용자 메시지 에코
                write({ name: 'debugRoom', data: { botName: d.botName, roomName: d.roomName, authorName: d.authorName, message: d.message, isBot: false } });
                // 봇 응답
                setTimeout(() => {
                    write({
                        name: 'debugRoom',
                        data: {
                            botName: d.botName,
                            roomName: d.roomName,
                            authorName: d.botName,
                            message: `[mock 응답] "${d.message}" 를 받았습니다.\nroom=${d.roomName} author=${d.authorName} group=${d.isGroupChat}`,
                            isBot: true,
                        },
                    });
                }, 150);
            } else if (json.name === 'compile') {
                write({ name: 'compileStatus', data: { botName: d.botName, status: 'start' } });
                setTimeout(() => write({ name: 'compileStatus', data: { botName: d.botName, status: 'success' } }), 200);
            }
        }
    });
    sock.on('close', () => console.log('[mock] 연결 종료'));
    sock.on('error', (e) => console.log(`[mock] 에러: ${e.message}`));
});

server.listen(PORT, HOST, () => console.log(`[mock] ${HOST}:${PORT} 대기 중`));
