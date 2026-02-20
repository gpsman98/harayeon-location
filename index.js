const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());

// 정적 파일 서빙 (프론트엔드)
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// 그룹별 사용자 관리
const groups = {};

// API: 서버 상태
app.get('/api/status', (req, res) => {
    const status = {};
    for (const [groupName, members] of Object.entries(groups)) {
        status[groupName] = {
            memberCount: Object.keys(members).length,
            members: Object.keys(members)
        };
    }
    res.json({ status: 'ok', groups: status });
});

// 모든 경로를 index.html로 (SPA 지원)
app.get('*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ====== HTTPS 자체 서명 인증서 생성 (node-forge) ======
function getOrCreateCerts() {
    const certDir = path.join(__dirname, 'certs');
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }

    try {
        const forge = require('node-forge');
        console.log('🔐 HTTPS 인증서 생성 중...');

        if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

        // RSA 키 쌍 생성
        const keys = forge.pki.rsa.generateKeyPair(2048);

        // 인증서 생성
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

        const attrs = [
            { name: 'commonName', value: 'Harayeon Local' },
            { name: 'organizationName', value: 'Harayeon' }
        ];
        cert.setSubject(attrs);
        cert.setIssuer(attrs);

        // SAN (Subject Alternative Name) - IP 접속 허용
        cert.setExtensions([
            {
                name: 'subjectAltName', altNames: [
                    { type: 2, value: 'localhost' },
                    { type: 7, ip: '127.0.0.1' }
                ]
            }
        ]);

        cert.sign(keys.privateKey, forge.md.sha256.create());

        const pemKey = forge.pki.privateKeyToPem(keys.privateKey);
        const pemCert = forge.pki.certificateToPem(cert);

        fs.writeFileSync(keyPath, pemKey);
        fs.writeFileSync(certPath, pemCert);
        console.log('✅ 인증서 생성 완료');

        return { key: pemKey, cert: pemCert };
    } catch (e) {
        console.warn('⚠️ 인증서 생성 실패:', e.message);
        return null;
    }
}

// ====== Socket.IO 설정 ======
function setupSocketIO(server) {
    const io = new Server(server, {
        cors: { origin: '*', methods: ['GET', 'POST'] }
    });

    io.on('connection', (socket) => {
        console.log(`[연결] ${socket.id}`);
        let currentUserId = null;
        let currentGroup = null;

        socket.on('join-group', ({ userId, groupName }) => {
            if (currentGroup && currentUserId) leaveGroup(currentGroup, currentUserId, socket, io);
            currentUserId = userId;
            currentGroup = groupName;
            if (!groups[groupName]) groups[groupName] = {};

            // 기존 데이터가 있으면 유지하되, 소켓ID와 상태만 갱신
            const existingUser = groups[groupName][userId];
            groups[groupName][userId] = {
                lat: existingUser ? existingUser.lat : null,
                lng: existingUser ? existingUser.lng : null,
                speed: existingUser ? existingUser.speed : null,
                heading: existingUser ? existingUser.heading : null,
                sharing: existingUser ? existingUser.sharing : true,
                socketId: socket.id,
                active: true,
                lastSeen: Date.now()
            };

            socket.join(groupName);
            console.log(`[참여] ${userId} → 그룹: ${groupName}`);
            broadcastGroupMembers(groupName, io);
        });

        socket.on('update-location', ({ lat, lng, speed, heading }) => {
            if (!currentGroup || !currentUserId) return;
            if (!groups[currentGroup]?.[currentUserId]) return;
            const user = groups[currentGroup][currentUserId];
            user.lat = lat;
            user.lng = lng;
            user.speed = speed;
            user.heading = heading;
            user.active = true;
            user.lastSeen = Date.now();
            if (user.sharing) {
                socket.to(currentGroup).emit('location-update', { userId: currentUserId, lat, lng, sharing: true, speed, heading });
            }
        });

        socket.on('toggle-sharing', ({ sharing }) => {
            if (!currentGroup || !currentUserId) return;
            if (!groups[currentGroup]?.[currentUserId]) return;
            groups[currentGroup][currentUserId].sharing = sharing;
            console.log(`[공유 ${sharing ? 'ON' : 'OFF'}] ${currentUserId} (그룹: ${currentGroup})`);
            if (!sharing) socket.to(currentGroup).emit('member-hidden', { userId: currentUserId });
            broadcastGroupMembers(currentGroup, io);
        });

        socket.on('disconnect', () => {
            console.log(`[해제] ${socket.id} (${currentUserId || '미등록'})`);
            // 연결이 끊겨도 그룹에서 삭제하지 않고 '오프라인' 상태로 전환 (마커 유지)
            if (currentGroup && currentUserId && groups[currentGroup]?.[currentUserId]) {
                const user = groups[currentGroup][currentUserId];
                user.active = false;
                user.lastSeen = Date.now();
                // 다른 멤버들에게 상태 변경 알림
                broadcastGroupMembers(currentGroup, io);
            }
        });

        // 명시적으로 그룹 나가기 (로그아웃 버튼 등)
        socket.on('leave-group', () => {
            if (currentGroup && currentUserId) {
                leaveGroup(currentGroup, currentUserId, socket, io);
                currentUserId = null;
                currentGroup = null;
            }
        });
    });
}

function leaveGroup(groupName, userId, socket, io) {
    if (groups[groupName]?.[userId]) {
        delete groups[groupName][userId];
        console.log(`[나가기] ${userId} (그룹: ${groupName})`);

        if (Object.keys(groups[groupName]).length === 0) {
            delete groups[groupName];
            console.log(`[그룹 삭제] ${groupName}`);
        } else {
            socket.to(groupName).emit('member-left', { userId });
            broadcastGroupMembers(groupName, io);
        }
    }
    socket.leave(groupName);
}

function broadcastGroupMembers(groupName, io) {
    if (!groups[groupName]) return;
    const members = Object.entries(groups[groupName]).map(([userId, data]) => ({
        userId,
        lat: data.lat,
        lng: data.lng,
        sharing: data.sharing,
        speed: data.speed,
        heading: data.heading,
        active: data.active,
        lastSeen: data.lastSeen
    }));
    io.to(groupName).emit('group-members', { members });
}

// ====== 서버 시작 ======
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = 3443;

const os = require('os');
const nets = os.networkInterfaces();
let localIP = 'localhost';
for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
}

// HTTP 서버
const httpServer = http.createServer(app);
setupSocketIO(httpServer);
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌐 해라연 위치 공유 서버`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`💻 PC 접속:     http://localhost:${PORT}`);
});

// HTTPS 서버
const certs = getOrCreateCerts();
if (certs) {
    const httpsServer = https.createServer(certs, app);
    setupSocketIO(httpsServer);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`🔒 HTTPS 접속:  https://${localIP}:${HTTPS_PORT}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`\n📱 핸드폰에서 아래 주소로 접속하세요:`);
        console.log(`   👉 https://${localIP}:${HTTPS_PORT}`);
        console.log(`\n   ⚠️ "연결이 비공개가 아닙니다" 경고 나오면`);
        console.log(`   → "고급" → "○○○(안전하지 않음)으로 이동" 클릭!\n`);
    });
} else {
    console.log(`📱 HTTP 접속:   http://${localIP}:${PORT}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}
