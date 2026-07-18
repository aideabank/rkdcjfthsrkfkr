const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

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

app.get('/', (req, res) => {
    res.send('📊 대푯값 통계 게임 실시간 보안 백엔드 서버 정상 구동 중!');
});

io.on('connection', (socket) => {
    console.log('🔗 새로운 단말기 연결:', socket.id);

    socket.on('join_room', ({ classId }) => {
        socket.join(classId);
        if (!classes[classId]) {
            classes[classId] = { className: classId, students: {}, currentRound: { active: false, topicId: null, revealed: false, usedIds: [] } };
        }
        const allClassIds = Object.keys(classes).map(id => ({
            id,
            className: classes[id].className,
            studentCount: Object.keys(classes[id].students).length
        }));
        socket.emit('init_state', { globalTopics, classData: classes[classId], selectedClassId: classId, allClassIds });
    });

    socket.on('create_class', ({ classId, className }) => {
        if (!classes[classId]) {
            classes[classId] = { className: className || classId, students: {}, currentRound: { active: false, topicId: null, revealed: false, usedIds: [] } };
            io.emit('refresh_global');
        }
    });

    socket.on('delete_class', ({ classId }) => {
        if (classes[classId]) {
            delete classes[classId];
            io.emit('refresh_global');
        }
    });

    socket.on('add_global_topic', ({ title, type }) => {
        const newTopic = { id: 'gt_' + Date.now(), title, type };
        globalTopics.push(newTopic);
        io.emit('refresh_global');
    });

    socket.on('delete_global_topic', ({ topicId }) => {
        globalTopics = globalTopics.filter(t => t.id !== topicId);
        Object.values(classes).forEach(cls => {
            cls.currentRound.usedIds = cls.currentRound.usedIds.filter(id => id !== topicId);
        });
        io.emit('refresh_global');
    });

    socket.on('student_login', ({ classId, number, name }) => {
        const currentClass = classes[classId];
        if (!currentClass) return;
        const stuId = 'id_' + number;
        if (!currentClass.students[stuId]) {
            currentClass.students[stuId] = { id: stuId, number, name, realData: {}, guessData: {}, score: 0 };
        }
        io.to(classId).emit('class_data_update', currentClass);
    });

    socket.on('student_submit_realdata', ({ classId, stuId, realData }) => {
        const currentClass = classes[classId];
        if (currentClass && currentClass.students[stuId]) {
            currentClass.students[stuId].realData = realData;
            io.to(classId).emit('class_data_update', currentClass);
        }
    });

    socket.on('trigger_roulette', ({ classId, targetTopicId }) => {
        const currentClass = classes[classId];
        if (!currentClass) return;
        currentClass.currentRound.active = true;
        currentClass.currentRound.revealed = false;
        currentClass.currentRound.topicId = targetTopicId;
        currentClass.currentRound.usedIds.push(targetTopicId);
        Object.keys(currentClass.students).forEach(sid => {
            currentClass.students[sid].guessData = currentClass.students[sid].guessData || {};
            currentClass.students[sid].guessData[targetTopicId] = '';
        });
        io.to(classId).emit('roulette_start_signal', { targetTopicId, classData: currentClass });
    });

    socket.on('student_submit_guess', ({ classId, stuId, topicId, guessValue }) => {
        const currentClass = classes[classId];
        if (currentClass && currentClass.students[stuId]) {
            currentClass.students[stuId].guessData = currentClass.students[stuId].guessData || {};
            currentClass.students[stuId].guessData[topicId] = guessValue;
            io.to(classId).emit('class_data_update', currentClass);
        }
    });

    socket.on('reveal_answer', ({ classId }) => {
        const currentClass = classes[classId];
        if (!currentClass || !currentClass.currentRound.topicId) return;
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

    socket.on('reset_all_server', () => {
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
