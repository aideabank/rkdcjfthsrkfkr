const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const clientDirectory = process.env.CLIENT_DIR
    ? path.resolve(process.env.CLIENT_DIR)
    : path.join(__dirname, 'public');

app.use(express.static(clientDirectory));

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
    '1-3': { className: '1학년 3반', students: {}, results: {}, currentRound: { active: false, topicId: null, revealed: false, revealDismissed: true, usedIds: [] } },
    '1-5': { className: '1학년 5반', students: {}, results: {}, currentRound: { active: false, topicId: null, revealed: false, revealDismissed: true, usedIds: [] } }
};

const TEACHER_PIN = String(process.env.TEACHER_PIN || '').trim();
const TOPIC_TYPES = new Set(['평균', '중앙값', '최빈값']);
const PERSISTENCE_DISABLED = String(process.env.DISABLE_PERSISTENCE || '').toLowerCase() === 'true';
const DATA_FILE = process.env.DATA_FILE
    ? path.resolve(process.env.DATA_FILE)
    : path.join(__dirname, 'data', 'game-state.json');
let persistenceQueue = Promise.resolve();

function getSerializableState() {
    return { version: 1, globalTopics, classes };
}

function persistState() {
    if (PERSISTENCE_DISABLED) return Promise.resolve();
    const serialized = JSON.stringify(getSerializableState(), null, 2);
    persistenceQueue = persistenceQueue
        .catch(() => {})
        .then(async () => {
            await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
            const temporaryFile = DATA_FILE + '.tmp';
            await fs.promises.writeFile(temporaryFile, serialized, 'utf8');
            await fs.promises.rename(temporaryFile, DATA_FILE);
        })
        .catch(error => {
            console.error('❌ 게임 상태 저장 실패:', error.message);
            throw error;
        });
    return persistenceQueue;
}

async function initializePersistentState() {
    if (PERSISTENCE_DISABLED) {
        console.log('ℹ️ 테스트 모드: 영구 저장 비활성화');
        return;
    }
    try {
        const saved = JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8'));
        applySavedState(saved);
        console.log(`💾 저장된 게임 상태 복원 완료: ${Object.keys(classes).length}개 반`);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await persistState();
        console.log('💾 초기 게임 상태 저장 완료');
    }
}

function applySavedState(saved) {
    if (!saved || !Array.isArray(saved.globalTopics) || !saved.classes || typeof saved.classes !== 'object') {
        throw new Error('저장 파일 형식이 올바르지 않습니다.');
    }
    globalTopics = saved.globalTopics;
    classes = saved.classes;
}

function saveStateSoon() {
    void persistState().catch(() => {});
}

function sanitizeText(value, maxLength) {
    return String(value ?? '')
        .replace(/[<>&"'`]/g, '')
        .trim()
        .slice(0, maxLength);
}

function normalizeTopicValue(value, topicType) {
    const sanitized = sanitizeText(value, 60);
    if (!sanitized) return '';
    if (topicType === '최빈값') return sanitized.toUpperCase();

    const numericMatch = sanitized.match(/[+-]?(?:(?:\d[\d,]*)(?:\.\d+)?|\.\d+)/);
    if (!numericMatch) return '';
    const number = Number(numericMatch[0].replace(/,/g, ''));
    return Number.isFinite(number) ? String(number) : '';
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
            const normalized = normalizeTopicValue(data[topic.id], topic.type);
            if (!normalized) return;
            result[topic.id] = normalized;
        }
    });
    return Object.keys(result).length === Object.keys(data).length ? result : null;
}

function randomInteger(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createDemoValue(topic) {
    const title = topic.title.toLowerCase();
    if (topic.type === '최빈값') {
        const choices = title.includes('mbti')
            ? ['EN', 'ES', 'IN', 'IS']
            : ['A', 'B', 'C', 'D'];
        return choices[randomInteger(0, choices.length - 1)];
    }
    if (title.includes('키')) return randomInteger(145, 185);
    if (title.includes('햄버거')) return randomInteger(1, 8);
    if (title.includes('유튜브') || title.includes('쇼폼') || title.includes('시청시간')) {
        return randomInteger(10, 300);
    }
    return randomInteger(1, 100);
}

app.get('/', (req, res) => {
    res.send('📊 대푯값 통계 게임 실시간 보안 백엔드 서버 정상 구동 중!');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'stats-game-server' });
});

io.on('connection', (socket) => {
    console.log('🔗 새로운 단말기 연결:', socket.id);

    socket.on('verify_teacher_pin', (payload = {}) => {
        socket.emit('teacher_pin_verification', {
            valid: !TEACHER_PIN || String(payload.teacherPin ?? '') === TEACHER_PIN
        });
    });

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
            classes[classId] = { className, students: {}, results: {}, currentRound: { active: false, topicId: null, revealed: false, revealDismissed: true, usedIds: [] } };
            saveStateSoon();
            io.emit('refresh_global');
        }
    });

    socket.on('delete_class', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        if (classes[classId]) {
            delete classes[classId];
            saveStateSoon();
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
        saveStateSoon();
        io.emit('refresh_global');
    });

    socket.on('delete_global_topic', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const topicId = sanitizeText(payload.topicId, 64);
        globalTopics = globalTopics.filter(t => t.id !== topicId);
        Object.values(classes).forEach(cls => {
            cls.currentRound.usedIds = cls.currentRound.usedIds.filter(id => id !== topicId);
            if (cls.results) delete cls.results[topicId];
        });
        saveStateSoon();
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
        saveStateSoon();
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
            saveStateSoon();
            io.to(classId).emit('class_data_update', currentClass);
        }
    });

    socket.on('seed_demo_data', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        const currentClass = classes[classId];
        if (!currentClass) return reject(socket, 'INVALID_CLASS', '존재하지 않는 반입니다.');
        let addedStudents = 0;
        let filledValues = 0;
        for (let number = 1; number <= 30; number += 1) {
            const stuId = 'id_' + number;
            if (!currentClass.students[stuId]) {
                currentClass.students[stuId] = {
                    id: stuId,
                    number,
                    name: `시범학생 ${number}`,
                    realData: {},
                    guessData: {},
                    score: 0
                };
                addedStudents += 1;
            }
            const student = currentClass.students[stuId];
            student.realData = student.realData || {};
            globalTopics.forEach(topic => {
                if (student.realData[topic.id] === undefined || student.realData[topic.id] === '') {
                    student.realData[topic.id] = normalizeTopicValue(createDemoValue(topic), topic.type);
                    filledValues += 1;
                }
            });
        }

        saveStateSoon();
        io.to(classId).emit('class_data_update', currentClass);
        io.emit('refresh_global');
        socket.emit('demo_data_seeded', { classId, addedStudents, filledValues, totalStudents: Object.keys(currentClass.students).length });
    });

    socket.on('trigger_roulette', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        const currentClass = classes[classId];
        if (!currentClass) return reject(socket, 'INVALID_CLASS', '존재하지 않는 반입니다.');
        if (currentClass.currentRound.revealed && !currentClass.currentRound.revealDismissed) {
            return reject(socket, 'RESULT_NOT_DISMISSED', '먼저 결과 화면에서 다음 문제를 눌러주세요.');
        }

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
            currentClass.currentRound.revealDismissed = false;
            currentClass.currentRound.topicId = targetTopicId;
            currentClass.currentRound.answer = null;
            currentClass.currentRound.rankings = [];
            currentClass.currentRound.usedIds.push(targetTopicId);
            Object.keys(currentClass.students).forEach(sid => {
                currentClass.students[sid].guessData = currentClass.students[sid].guessData || {};
                currentClass.students[sid].guessData[targetTopicId] = '';
            });
            saveStateSoon();
            io.to(classId).emit('roulette_start_signal', { targetTopicId, classData: currentClass });
        }, 5200);
    });

    socket.on('student_submit_guess', (payload = {}) => {
        const classId = sanitizeText(payload.classId, 30);
        const stuId = sanitizeText(payload.stuId, 20);
        const topicId = sanitizeText(payload.topicId, 64);
        const currentClass = classes[classId];
        const currentTopic = globalTopics.find(topic => topic.id === topicId);
        const guessValue = currentTopic ? normalizeTopicValue(payload.guessValue, currentTopic.type) : '';
        if (!currentClass || !currentClass.students[stuId]
            || !currentClass.currentRound.active
            || currentClass.currentRound.topicId !== topicId
            || !guessValue) {
            return reject(socket, 'INVALID_GUESS', '현재 문제의 예측값을 확인하세요.');
        }
        if (currentClass && currentClass.students[stuId]) {
            currentClass.students[stuId].guessData = currentClass.students[stuId].guessData || {};
            currentClass.students[stuId].guessData[topicId] = guessValue;
            saveStateSoon();
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
        if (currentClass.currentRound.revealed) {
            return reject(socket, 'ALREADY_REVEALED', '이미 정답이 공개된 라운드입니다.');
        }
        currentClass.currentRound.revealed = true;
        currentClass.currentRound.revealDismissed = false;
        const currentTopic = globalTopics.find(t => t.id === currentClass.currentRound.topicId);
        const answerSheet = calculateServerStats(currentClass.students, currentTopic);
        currentClass.currentRound.answer = answerSheet.raw;

        Object.values(currentClass.students).forEach(student => {
            student.guessData = student.guessData || {};
            const currentGuess = student.guessData[currentTopic.id];
            const ownValue = student.realData ? student.realData[currentTopic.id] : null;
            if ((currentGuess === undefined || currentGuess === null || currentGuess === '')
                && ownValue !== undefined && ownValue !== null && ownValue !== '') {
                student.guessData[currentTopic.id] = normalizeTopicValue(ownValue, currentTopic.type);
            }
        });

        const rankings = answerSheet.raw === null
            ? []
            : calculateRankings(currentClass.students, currentTopic, answerSheet.raw);
        currentClass.currentRound.rankings = rankings;
        currentClass.results = currentClass.results || {};
        currentClass.results[currentTopic.id] = { answer: answerSheet.raw, rankings };

        const scoreByRank = { 1: 50, 2: 40, 3: 30, 4: 20, 5: 10 };
        rankings.forEach(entry => {
            const earnedScore = currentTopic.type === '최빈값'
                ? (entry.error === 0 ? 30 : 0)
                : (scoreByRank[entry.rank] || 0);
            currentClass.students[entry.studentId].score += earnedScore;
        });
        saveStateSoon();
        io.to(classId).emit('answer_revealed_signal', currentClass);
    });

    socket.on('dismiss_answer_reveal', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        const currentClass = classes[classId];
        if (!currentClass || !currentClass.currentRound.revealed) {
            return reject(socket, 'INVALID_ROUND', '닫을 수 있는 결과 화면이 없습니다.');
        }
        currentClass.currentRound.revealDismissed = true;
        saveStateSoon();
        io.to(classId).emit('answer_reveal_dismissed', currentClass);
    });

    socket.on('reset_class', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        const classId = sanitizeText(payload.classId, 30);
        if (classes[classId]) {
            classes[classId].students = {};
            classes[classId].results = {};
            classes[classId].currentRound = { active: false, topicId: null, revealed: false, revealDismissed: true, usedIds: [] };
            saveStateSoon();
            io.to(classId).emit('refresh_global');
        }
    });

    socket.on('reset_all_server', (payload = {}) => {
        if (!requireTeacher(socket, payload)) return;
        classes = {
            '1-3': { className: '1학년 3반', students: {}, results: {}, currentRound: { active: false, topicId: null, revealed: false, revealDismissed: true, usedIds: [] } },
            '1-5': { className: '1학년 5반', students: {}, results: {}, currentRound: { active: false, topicId: null, revealed: false, revealDismissed: true, usedIds: [] } }
        };
        saveStateSoon();
        io.emit('refresh_global');
    });

    socket.on('disconnect', () => {
        console.log('❌ 연결 해제:', socket.id);
    });
});

function stripUnit(value, topicType) {
    return normalizeTopicValue(value, topicType);
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

function calculateRankings(students, topic, answer) {
    const entries = Object.values(students).map(student => {
        const guess = student.guessData ? student.guessData[topic.id] : null;
        let error = null;
        if (guess !== undefined && guess !== null && guess !== '') {
            if (topic.type === '평균' || topic.type === '중앙값') {
                const parsedGuess = parseFloat(stripUnit(guess, topic.type));
                if (!Number.isNaN(parsedGuess)) error = Math.abs(answer - parsedGuess);
            } else if (topic.type === '최빈값') {
                error = answer.includes(String(guess).trim().toUpperCase()) ? 0 : 1;
            }
        }
        return {
            studentId: student.id,
            number: student.number,
            name: student.name,
            guess,
            error,
            rank: null
        };
    });

    const rankable = entries
        .filter(entry => Number.isFinite(entry.error) && (topic.type !== '최빈값' || entry.error === 0))
        .sort((a, b) => a.error - b.error || a.number - b.number);

    let previousError = null;
    rankable.forEach((entry, index) => {
        if (previousError === null || Math.abs(entry.error - previousError) > 1e-9) {
            entry.rank = index + 1;
            previousError = entry.error;
        } else {
            entry.rank = rankable[index - 1].rank;
        }
    });

    return entries.sort((a, b) => {
        const rankA = a.rank === null ? Infinity : a.rank;
        const rankB = b.rank === null ? Infinity : b.rank;
        return rankA - rankB || a.number - b.number;
    });
}

const PORT = process.env.PORT || 3000;

async function startServer() {
    await initializePersistentState();
    server.listen(PORT, () => {
        console.log(`🚀 서버가 포트 ${PORT}에서 정상 구동 중입니다!`);
    });
}

async function shutdown(signal) {
    console.log(`${signal} 수신: 게임 상태를 저장하고 서버를 종료합니다.`);
    try {
        await persistenceQueue;
    } finally {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
    }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

startServer().catch(error => {
    console.error('❌ 서버 초기화 실패:', error);
    process.exit(1);
});
