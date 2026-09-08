const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const clientDirectory = process.env.CLIENT_DIR
    ? path.resolve(process.env.CLIENT_DIR)
    : null;

if (clientDirectory) {
    app.use(express.static(clientDirectory));
}

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let globalTopics = [
    { id: 't_1', title: '우리 반 친구들의 진짜 내 키 (cm)', type: '평균' },
    { id: 't_2', title: '내가 한번에 최대로 먹을 수 있는 햄버거 개수', type: '중앙값' },
    { id: 't_3', title: '나를 표현하는 MBTI 전방부 성향 (2글자)', type: '최빈값' },
    { id: 't_4', title: '이번 한주간 하루 유튜브/숏폼 평균 시청시간 (분)', type: '중앙값' }
];

let classes = {
    '3-1': { className: '3학년 1반', students: {}, currentRound: { active: false, topicId: null, revealed: false, usedIds: [] } },
    '3-2': { className: '3학년 2반', students: {}, currentRound: { active: false, topicId: null, revealed: false, usedIds: [] } }
};

const TEACHER_PIN = String(process.env.TEACHER_PIN || '').trim();
const TOPIC_TYPES = new Set(['평균', '중앙값', '최빈값']);

function sanitizeText(value, maxLength) {
    return String(value ?? '')
        .replace(/[<>&"'`]/g, '')
        .trim()
        .slice(0, maxLength);
}

function reject(socket, code, message) {
    socket.emit('server_error', { code, message });
    return false;
}

function requireTeacher(socket, payload) {
    if (!TEACHER_PIN) return true;
    if (String(payload?.teacherPin ?? '') === TEACHER_PIN) return true;
    return reject(socket, 'UNAUTHORIZED', '교사용 PIN이 올바르지 않습니다.');
}

function sanitizeSubmission(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const result = {};
    globalTopics.forEach(topic => {
        if (Object.prototype.hasOwnProperty.call(data, topic.id)) {
            result[topic.id] = sanitizeText(data[topic.id], 60);
        }
    });
    return result;
}

app.get('/', (req, res) => {
    res.send('📊 대푯값 통계 게임 실시간 보안 백엔드 서버 정상 구동 중!');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'stats-game-server' });
});

io.on('connection', (socket) => {
    console.log('🔗 새로운 단말기 연결:', socket.id);

    socket.on('join_room', (payload = {}) => {
        const classId = sanitizeText(payload.classId, 30);
        if (!classId) return reject(socket, 'INVALID_CLASS', '올바른 반을 선택하세요.');
        if (!classes[classId]) return reject(socket, 'INVALID_CLASS', '존재하지 않는 반입니다.');
        socket.join(classId);
        const allClassIds = Object.keys(classes).map(id => ({
            id,
            className: classes[id].className,
            studentCount: Object.keys(classes[id].students).length
        }));
        socket.emit('init_state', {
            globalTopics,
            classData: classes[classId],
            selectedClassId: classId,
            allClassIds,
            teacherAuthRequired: Boolean(TEACHER_PIN)
        });
    });

    socket.on('create_class', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        const className = sanitizeText(payload.className, 30) || classId;
        if (!classId) return reject(socket, 'INVALID_CLASS', '반 이름을 입력하세요.');
        if (!classes[classId]) {
            classes[classId] = { className, students: {}, currentRound: { active: false, topicId: null, revealed: false, usedIds: [] } };
            io.emit('refresh_global');
        }
    });

    socket.on('delete_class', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        if (classes[classId]) {
            delete classes[classId];
            io.emit('refresh_global');
        }
    });

    socket.on('add_global_topic', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const title = sanitizeText(payload.title, 100);
        const type = sanitizeText(payload.type, 10);
        if (!title || !TOPIC_TYPES.has(type)) {
            return reject(socket, 'INVALID_TOPIC', '주제와 대푯값 유형을 확인하세요.');
        }
        const newTopic = { id: 'gt_' + Date.now(), title, type };
        globalTopics.push(newTopic);
        io.emit('refresh_global');
    });

    socket.on('delete_global_topic', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const topicId = sanitizeText(payload.topicId, 64);
        globalTopics = globalTopics.filter(t => t.id !== topicId);
        Object.values(classes).forEach(cls => {
            cls.currentRound.usedIds = cls.currentRound.usedIds.filter(id => id !== topicId);
        });
        io.emit('refresh_global');
    });

    socket.on('student_login', (payload = {}) => {
        const classId = sanitizeText(payload.classId, 30);
        const number = Number(payload.number);
        const name = sanitizeText(payload.name, 20);
        if (!classes[classId] || !Number.isInteger(number) || number < 1 || number > 40 || !name) {
            return reject(socket, 'INVALID_STUDENT', '반, 번호(1~40), 이름을 확인하세요.');
        }
        const currentClass = classes[classId];
        const stuId = 'id_' + number;
        if (!currentClass.students[stuId]) {
            currentClass.students[stuId] = { id: stuId, number, name, realData: {}, guessData: {}, score: 0 };
        } else {
            currentClass.students[stuId].name = name;
        }
        io.to(classId).emit('class_data_update', currentClass);
    });

    socket.on('student_submit_realdata', (payload = {}) => {
        const classId = sanitizeText(payload.classId, 30);
        const stuId = sanitizeText(payload.stuId, 20);
        const realData = sanitizeSubmission(payload.realData);
        const currentClass = classes[classId];
        if (!currentClass || !currentClass.students[stuId] || !realData) {
            return reject(socket, 'INVALID_SUBMISSION', '학생 정보와 제출 데이터를 확인하세요.');
        }
        if (currentClass && currentClass.students[stuId]) {
            currentClass.students[stuId].realData = realData;
            io.to(classId).emit('class_data_update', currentClass);
        }
    });

    socket.on('trigger_roulette', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        const currentClass = classes[classId];
        if (!currentClass) return reject(socket, 'INVALID_CLASS', '존재하지 않는 반입니다.');

        const availableTopics = globalTopics.filter(t => !currentClass.currentRound.usedIds.includes(t.id));
        if (availableTopics.length === 0) {
            return reject(socket, 'NO_TOPIC', '사용 가능한 주제가 없습니다.');
        }

        const targetTopicId = availableTopics[Math.floor(Math.random() * availableTopics.length)].id;

        io.to(classId).emit('roulette_spin_start', {
            allTopics: availableTopics.map(t => ({ id: t.id, title: t.title, type: t.type })),
            targetTopicId,
            duration: 5000
        });

        setTimeout(() => {
            currentClass.currentRound.active = true;
            currentClass.currentRound.revealed = false;
            currentClass.currentRound.topicId = targetTopicId;
            currentClass.currentRound.usedIds.push(targetTopicId);
            Object.keys(currentClass.students).forEach(sid => {
                currentClass.students[sid].guessData = currentClass.students[sid].guessData || {};
                currentClass.students[sid].guessData[targetTopicId] = '';
            });
            io.to(classId).emit('roulette_start_signal', { targetTopicId, classData: currentClass });
        }, 5200);
    });

    socket.on('student_submit_guess', (payload = {}) => {
        const classId = sanitizeText(payload.classId, 30);
        const stuId = sanitizeText(payload.stuId, 20);
        const topicId = sanitizeText(payload.topicId, 64);
        const guessValue = sanitizeText(payload.guessValue, 60);
        const currentClass = classes[classId];
        if (!currentClass || !currentClass.students[stuId]
            || !currentClass.currentRound.active
            || currentClass.currentRound.topicId !== topicId
            || !guessValue) {
            return reject(socket, 'INVALID_GUESS', '현재 문제의 예측값을 확인하세요.');
        }
        if (currentClass && currentClass.students[stuId]) {
            currentClass.students[stuId].guessData = currentClass.students[stuId].guessData || {};
            currentClass.students[stuId].guessData[topicId] = guessValue;
            io.to(classId).emit('class_data_update', currentClass);
        }
    });

    socket.on('reveal_answer', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        const currentClass = classes[classId];
        if (!currentClass || !currentClass.currentRound.topicId) {
            return reject(socket, 'NO_ACTIVE_ROUND', '진행 중인 문제가 없습니다.');
        }
        currentClass.currentRound.revealed = true;
        const currentTopic = globalTopics.find(t => t.id === currentClass.currentRound.topicId);
        const answerSheet = calculateServerStats(currentClass.students, currentTopic);

        if (answerSheet.raw !== null) {
            const scoreMatchingPool = [];
            Object.values(currentClass.students).forEach(st => {
                const userGuess = st.guessData ? st.guessData[currentTopic.id] : null;
                if (!userGuess) return;
                let delta = Infinity;
                if (currentTopic.type === '평균' || currentTopic.type === '중앙값') {
                    const parsedGuess = parseFloat(stripUnit(userGuess, currentTopic.type));
                    if (!isNaN(parsedGuess)) delta = Math.abs(answerSheet.raw - parsedGuess);
                } else if (currentTopic.type === '최빈값') {
                    delta = answerSheet.raw.includes(String(userGuess).trim().toUpperCase()) ? 0 : 1;
                }
                scoreMatchingPool.push({ id: st.id, delta: delta });
            });

            scoreMatchingPool.sort((a, b) => a.delta - b.delta);
            const trueWinners = scoreMatchingPool.filter(w => w.delta !== Infinity && (currentTopic.type !== '최빈값' || w.delta === 0));
            if (trueWinners[0]) currentClass.students[trueWinners[0].id].score += 30;
            if (trueWinners[1]) currentClass.students[trueWinners[1].id].score += 20;
            if (trueWinners[2]) currentClass.students[trueWinners[2].id].score += 10;
        }
        io.to(classId).emit('answer_revealed_signal', currentClass);
    });

    socket.on('reset_class', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        if (classes[classId]) {
            classes[classId].students = {};
            classes[classId].currentRound = { active: false, topicId: null, revealed: false, usedIds: [] };
            io.to(classId).emit('refresh_global');
        }
    });

    socket.on('reset_all_server', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        classes = {
            '3-1': { className: '3학년 1반', students: {}, currentRound: { active: false, topicId: null, revealed: false, usedIds: [] } },
            '3-2': { className: '3학년 2반', students: {}, currentRound: { active: false, topicId: null, revealed: false, usedIds: [] } }
        };
        io.emit('refresh_global');
    });

    socket.on('disconnect', () => {
        console.log('❌ 연결 해제:', socket.id);
    });
});

function stripUnit(value, topicType) {
    if (topicType === '최빈값') return value;
    return String(value).replace(/[^0-9.\-]/g, '');
}

function calculateServerStats(students, topic) {
    const rawList = Object.values(students).map(s => s.realData ? s.realData[topic.id] : null).filter(v => v !== undefined && v !== null && v !== '');
    if (rawList.length === 0) return { raw: null };
    if (topic.type === '평균') {
        const numbers = rawList.map(v => parseFloat(stripUnit(v, '평균'))).filter(v => !isNaN(v));
        if (numbers.length === 0) return { raw: null };
        return { raw: numbers.reduce((a, b) => a + b, 0) / numbers.length };
    } else if (topic.type === '중앙값') {
        const numbers = rawList.map(v => parseFloat(stripUnit(v, '중앙값'))).filter(v => !isNaN(v));
        if (numbers.length === 0) return { raw: null };
        numbers.sort((a, b) => a - b);
        const mid = Math.floor(numbers.length / 2);
        return { raw: numbers.length % 2 !== 0 ? numbers[mid] : (numbers[mid - 1] + numbers[mid]) / 2 };
    } else if (topic.type === '최빈값') {
        const map = {}; let max = 0; let modes = [];
        rawList.forEach(v => {
            const normalized = String(v).trim().toUpperCase();
            map[normalized] = (map[normalized] || 0) + 1;
            if (map[normalized] > max) max = map[normalized];
        });
        for (let key in map) { if (map[key] === max) modes.push(key); }
        return { raw: modes };
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 정상 구동 중입니다!`);
});
