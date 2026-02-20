/**
 * 백그라운드 위치 서비스 시뮬레이터
 * 
 * 이 스크립트는 다음을 시뮬레이션합니다:
 * 1. 수신자(User B): Socket.IO로 서버에 접속하여 그룹 참여
 * 2. 발신자(User A - LocationService 시뮬레이션): 
 *    - Socket.IO로 그룹 참여 (앱이 처음 실행될 때)
 *    - HTTP POST로 위치 업데이트 전송 (백그라운드에서 네이티브 서비스가 하는 일)
 * 3. User B가 User A의 위치 업데이트를 수신하는지 확인
 */

const io = require('socket.io-client');
const http = require('http');

const SERVER_URL = 'http://localhost:3000';
const USER_A = 'TestUserA_Native'; // 네이티브 서비스 시뮬레이션
const USER_B = 'TestUserB_Receiver'; // 수신자
const GROUP = 'SimTestGroup';

let testsPassed = 0;
let testsFailed = 0;

function log(emoji, msg) {
    console.log(`${emoji} [${new Date().toISOString().substr(11, 8)}] ${msg}`);
}

function httpPost(path, data) {
    return new Promise((resolve, reject) => {
        const jsonData = JSON.stringify(data);
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(jsonData)
            },
            timeout: 5000
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: body });
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(jsonData);
        req.end();
    });
}

function assert(condition, testName) {
    if (condition) {
        log('✅', `PASS: ${testName}`);
        testsPassed++;
    } else {
        log('❌', `FAIL: ${testName}`);
        testsFailed++;
    }
}

async function runTests() {
    log('🚀', '========== 시뮬레이터 시작 ==========');

    // ==== 테스트 1: 서버 상태 확인 ====
    log('📋', '--- 테스트 1: 서버 상태 확인 ---');
    try {
        const status = await httpPost('/api/status', {}).catch(() => null);
        // GET 요청이지만 일단 서버 접속 가능한지 확인
    } catch (e) { }

    // ==== 테스트 2: User A가 소켓으로 JOIN ====
    log('📋', '--- 테스트 2: User A 소켓 JOIN (앱 처음 실행 시뮬레이션) ---');
    const socketA = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 3
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Socket A 연결 타임아웃'));
        }, 5000);

        socketA.on('connect', () => {
            clearTimeout(timeout);
            log('🔗', `User A 소켓 연결 성공 (id: ${socketA.id})`);

            socketA.emit('join-group', { userId: USER_A, groupName: GROUP });
            log('📍', `User A가 그룹 "${GROUP}"에 참여`);
            resolve();
        });

        socketA.on('connect_error', (e) => {
            clearTimeout(timeout);
            reject(new Error('Socket A 연결 실패: ' + e.message));
        });
    });
    assert(socketA.connected, 'User A 소켓 연결');

    // 잠시 대기 (서버 처리)
    await new Promise(r => setTimeout(r, 500));

    // ==== 테스트 3: User B가 소켓으로 JOIN + 이벤트 수신 준비 ====
    log('📋', '--- 테스트 3: User B 소켓 JOIN + 이벤트 수신 ---');
    const socketB = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 3
    });

    let receivedLocations = [];

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Socket B 연결 타임아웃'));
        }, 5000);

        socketB.on('connect', () => {
            clearTimeout(timeout);
            log('🔗', `User B 소켓 연결 성공 (id: ${socketB.id})`);

            socketB.emit('join-group', { userId: USER_B, groupName: GROUP });
            log('📍', `User B가 그룹 "${GROUP}"에 참여`);
            resolve();
        });

        socketB.on('connect_error', (e) => {
            clearTimeout(timeout);
            reject(new Error('Socket B 연결 실패: ' + e.message));
        });
    });
    assert(socketB.connected, 'User B 소켓 연결');

    // location-update 이벤트 리스너 등록
    socketB.on('location-update', (data) => {
        log('📡', `User B가 위치 수신: ${JSON.stringify(data)}`);
        receivedLocations.push(data);
    });

    // 잠시 대기 (서버 처리)
    await new Promise(r => setTimeout(r, 500));

    // ==== 테스트 4: User A 초기 위치 전송 (소켓으로) ====
    log('📋', '--- 테스트 4: User A 소켓으로 초기 위치 전송 ---');
    socketA.emit('update-location', {
        lat: 37.5665, lng: 126.9780, speed: 0, heading: 0
    });
    await new Promise(r => setTimeout(r, 500));
    assert(receivedLocations.length >= 1, 'User B가 소켓 위치 수신');
    if (receivedLocations.length > 0) {
        const last = receivedLocations[receivedLocations.length - 1];
        assert(last.userId === USER_A, '수신된 userId 확인');
        assert(Math.abs(last.lat - 37.5665) < 0.001, '수신된 lat 확인');
    }

    // ==== 테스트 5: HTTP POST 위치 업데이트 (네이티브 서비스 시뮬레이션) ====
    log('📋', '--- 테스트 5: HTTP POST 위치 (네이티브 서비스 시뮬레이션) ---');
    const countBefore = receivedLocations.length;

    const postResult = await httpPost('/api/update-location', {
        userId: USER_A,
        groupName: GROUP,
        lat: 37.5670,
        lng: 126.9785,
        speed: 5.5,
        heading: 90.0
    });
    log('📤', `HTTP POST 결과: ${postResult.status} ${JSON.stringify(postResult.body)}`);
    assert(postResult.status === 200, 'HTTP POST 응답 200');
    assert(postResult.body.ok === true, 'HTTP POST 응답 ok:true');

    // 브로드캐스트 수신 대기
    await new Promise(r => setTimeout(r, 1000));
    assert(receivedLocations.length > countBefore, 'HTTP POST 후 User B가 Socket.IO로 위치 수신');

    if (receivedLocations.length > countBefore) {
        const httpLoc = receivedLocations[receivedLocations.length - 1];
        assert(Math.abs(httpLoc.lat - 37.5670) < 0.001, 'HTTP POST로 보낸 lat 확인');
        assert(Math.abs(httpLoc.speed - 5.5) < 0.1, 'HTTP POST로 보낸 speed 확인');
        log('🎯', `HTTP POST → Socket.IO 브로드캐스트 경로 정상 동작!`);
    }

    // ==== 테스트 6: 존재하지 않는 사용자 HTTP POST (404 확인) ====
    log('📋', '--- 테스트 6: 존재하지 않는 사용자 HTTP POST ---');
    const notFound = await httpPost('/api/update-location', {
        userId: 'NonExistentUser',
        groupName: GROUP,
        lat: 0, lng: 0, speed: 0, heading: 0
    });
    assert(notFound.status === 200, '자동 등록으로 200 응답 (존재하지 않는 사용자도 자동 등록)');

    // ==== 테스트 7: 파라미터 누락 HTTP POST (400 확인) ====
    log('📋', '--- 테스트 7: 파라미터 누락 HTTP POST ---');
    const badReq = await httpPost('/api/update-location', {
        lat: 0, lng: 0
    });
    assert(badReq.status === 400, '파라미터 누락 400 응답');

    // ==== 테스트 8: 연속 HTTP POST (백그라운드 서비스 3초 간격 시뮬레이션) ====
    log('📋', '--- 테스트 8: 연속 HTTP POST (백그라운드 3초 간격) ---');
    const countBeforeSeq = receivedLocations.length;
    for (let i = 0; i < 3; i++) {
        const res = await httpPost('/api/update-location', {
            userId: USER_A,
            groupName: GROUP,
            lat: 37.5670 + i * 0.0001,
            lng: 126.9785 + i * 0.0001,
            speed: 10 + i,
            heading: 90 + i * 10
        });
        log('📤', `  POST #${i + 1}: HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 500));
    const newLocations = receivedLocations.length - countBeforeSeq;
    assert(newLocations >= 3, `연속 3회 POST 후 User B가 ${newLocations}회 수신 (기대: >=3)`);

    // ==== 테스트 9: User A 소켓 연결 해제 후에도 HTTP POST 동작 확인 ====
    log('📋', '--- 테스트 9: 소켓 끊긴 후 HTTP POST (실제 백그라운드 시나리오) ---');
    socketA.disconnect();
    log('🔌', 'User A 소켓 연결 해제 (화면 꺼짐 시뮬레이션)');
    await new Promise(r => setTimeout(r, 1000));

    const countBeforeDisc = receivedLocations.length;
    const postAfterDisc = await httpPost('/api/update-location', {
        userId: USER_A,
        groupName: GROUP,
        lat: 37.5680,
        lng: 126.9790,
        speed: 15.0,
        heading: 180.0
    });
    log('📤', `소켓 끊긴 후 HTTP POST: ${postAfterDisc.status} ${JSON.stringify(postAfterDisc.body)}`);

    // 핵심: 소켓이 끊겨서 서버가 사용자를 active:false로 변경해도,
    // HTTP POST가 active:true로 복구하여 브로드캐스트 해야 함
    assert(postAfterDisc.status === 200, '소켓 끊긴 후에도 HTTP POST 200 응답');

    await new Promise(r => setTimeout(r, 1000));
    const locAfterDisc = receivedLocations.length - countBeforeDisc;
    assert(locAfterDisc >= 1, `소켓 끊긴 후에도 User B가 위치 ${locAfterDisc}회 수신 (기대: >=1)`);

    if (locAfterDisc >= 1) {
        log('🎯', '핵심 시나리오 성공: 소켓 끊겨도 HTTP POST로 위치 업데이트 계속됨!');
    } else {
        log('🔥', '핵심 시나리오 실패: 소켓 끊기면 HTTP POST가 404를 반환함!');
        log('🔥', '원인: 서버 disconnect 핸들러가 사용자를 삭제했거나 active:false로 변경하여 REST API에서 거부');
    }

    // ==== 결과 요약 ====
    log('📊', '========== 테스트 결과 ==========');
    log('📊', `통과: ${testsPassed} / 실패: ${testsFailed} / 총: ${testsPassed + testsFailed}`);

    if (testsFailed > 0) {
        log('❌', '일부 테스트 실패! 서버 코드 수정 필요');
    } else {
        log('✅', '모든 테스트 통과!');
    }

    // 정리
    socketB.disconnect();
    process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(e => {
    log('💥', `시뮬레이터 오류: ${e.message}`);
    process.exit(1);
});
