const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(baseUrl = BASE_URL) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
        } catch {
            // The child process may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Local server did not become ready');
}

function once(socket, eventName, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
        socket.once(eventName, value => {
            clearTimeout(timeout);
            resolve(value);
        });
    });
}

test('health endpoint and Socket.IO handshake work', async t => {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT), TEACHER_PIN: 'test-pin', DISABLE_PERSISTENCE: 'true' },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => child.kill());

    await waitForServer();

    const healthResponse = await fetch(`${BASE_URL}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
        status: 'ok',
        service: 'stats-game-server'
    });

    const studentPageResponse = await fetch(`${BASE_URL}/`);
    assert.equal(studentPageResponse.status, 200);
    assert.match(await studentPageResponse.text(), /학생용/);

    const teacherPageResponse = await fetch(`${BASE_URL}/teacher.html`);
    assert.equal(teacherPageResponse.status, 200);
    const teacherPage = await teacherPageResponse.text();
    assert.match(teacherPage, /선생님 대시보드/);
    assert.match(teacherPage, /<div class="logo">GY<\/div>/);
    assert.match(teacherPage, /data-tab-panel="guide"/);
    assert.match(teacherPage, /언제 어떤 대푯값을 쓸까\?/);
    assert.match(teacherPage, /id="guideAnswerBank"/);
    assert.match(teacherPage, /function checkGuideQuiz\(\)/);
    assert.match(teacherPage, /function buildGuideQuizItems\(\)/);
    assert.match(teacherPage, /matchingTopics\.join\(' · '\)/);
    assert.match(teacherPage, /replace\(\/\\s\*\\\(\[\^\)\]\*\\\)\/g, ''\)/);
    assert.match(teacherPage, /draggable="true"/);
    assert.match(teacherPage, /id="teacherPinInput"[^>]*type="password"/);
    assert.doesNotMatch(teacherPage, /prompt\('교사용 PIN/);

    const rouletteSoundResponse = await fetch(`${BASE_URL}/assets/audio/roulette.wav`);
    assert.equal(rouletteSoundResponse.status, 200);
    assert.match(rouletteSoundResponse.headers.get('content-type') || '', /audio\/wav/);
    assert.ok((await rouletteSoundResponse.arrayBuffer()).byteLength > 0);

    const socketResponse = await fetch(`${BASE_URL}/socket.io/?EIO=4&transport=polling`);
    assert.equal(socketResponse.status, 200);
    assert.match(await socketResponse.text(), /^0\{"sid":/);
    assert.equal(stderr, '');

    const socket = createClient(BASE_URL, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false
    });
    t.after(() => socket.close());
    await once(socket, 'connect');

    const initialState = once(socket, 'init_state');
    socket.emit('join_room', { classId: '1-3' });
    assert.equal((await initialState).teacherAuthRequired, true);

    const rejectedPin = once(socket, 'teacher_pin_verification');
    socket.emit('verify_teacher_pin', { teacherPin: 'wrong' });
    assert.equal((await rejectedPin).valid, false);

    const acceptedPin = once(socket, 'teacher_pin_verification');
    socket.emit('verify_teacher_pin', { teacherPin: 'test-pin' });
    assert.equal((await acceptedPin).valid, true);

    const unauthorized = once(socket, 'server_error');
    socket.emit('create_class', { classId: 'test-class' });
    assert.equal((await unauthorized).code, 'UNAUTHORIZED');

    const invalidStudent = once(socket, 'server_error');
    socket.emit('student_login', { classId: '1-3', number: 99, name: '<b>test</b>' });
    assert.equal((await invalidStudent).code, 'INVALID_STUDENT');

    const classCreated = once(socket, 'refresh_global');
    socket.emit('create_class', {
        classId: 'test-class',
        className: 'Test Class',
        teacherPin: 'test-pin'
    });
    await classCreated;

    const newClassState = once(socket, 'init_state');
    socket.emit('join_room', { classId: 'test-class' });
    assert.equal((await newClassState).selectedClassId, 'test-class');

    const unauthorizedDemo = once(socket, 'server_error');
    socket.emit('seed_demo_data', { classId: 'test-class' });
    assert.equal((await unauthorizedDemo).code, 'UNAUTHORIZED');

    for (const number of [1, 2]) {
        socket.emit('student_login', { classId: 'test-class', number, name: `Student ${number}` });
        socket.emit('student_submit_realdata', {
            classId: 'test-class',
            stuId: `id_${number}`,
            realData: {
                t_1: number === 1 ? `${150 + number}cm` : 150 + number,
                t_2: number === 1 ? `약 ${number}개` : number,
                t_3: number === 1 ? 'en' : 'EN',
                t_4: number === 1 ? `${30 + number}분` : 30 + number
            }
        });
    }

    const demoResult = once(socket, 'demo_data_seeded');
    socket.emit('seed_demo_data', { classId: 'test-class', teacherPin: 'test-pin' });
    const seededResult = await demoResult;
    const seededState = once(socket, 'init_state');
    socket.emit('join_room', { classId: 'test-class' });
    const seededInit = await seededState;
    const seededClass = seededInit.classData;
    assert.equal(seededResult.totalStudents, 30);
    assert.equal(Object.keys(seededClass.students).length, 30);
    assert.equal(seededClass.students.id_1.realData.t_1, '151');
    assert.equal(seededClass.students.id_1.realData.t_2, '1');
    assert.equal(seededClass.students.id_1.realData.t_3, 'EN');
    assert.equal(seededClass.students.id_1.realData.t_4, '31');
    Object.values(seededClass.students).forEach(student => {
        assert.equal(Object.keys(student.realData).length, 4);
    });

    const roundStarted = once(socket, 'roulette_start_signal', 8000);
    socket.emit('trigger_roulette', { classId: 'test-class', teacherPin: 'test-pin' });
    const { targetTopicId } = await roundStarted;
    const normalizedTestGuess = targetTopicId === 't_3' ? 'EN' : '0';

    for (const number of [1, 2]) {
        const guessUpdated = once(socket, 'class_data_update');
        socket.emit('student_submit_guess', {
            classId: 'test-class',
            stuId: `id_${number}`,
            topicId: targetTopicId,
            guessValue: targetTopicId === 't_3' ? 'en' : '약 0cm'
        });
        await guessUpdated;
    }

    const revealed = once(socket, 'answer_revealed_signal');
    socket.emit('reveal_answer', { classId: 'test-class', teacherPin: 'test-pin' });
    let revealedClass = await revealed;
    assert.notEqual(revealedClass.currentRound.answer, null);
    assert.equal(revealedClass.currentRound.answerDetailsRevealed, false);
    assert.equal(revealedClass.students.id_1.guessData[targetTopicId], normalizedTestGuess);
    assert.equal(revealedClass.students.id_2.guessData[targetTopicId], normalizedTestGuess);
    assert.equal(revealedClass.students.id_3.guessData[targetTopicId], revealedClass.students.id_3.realData[targetTopicId]);

    const savedResult = revealedClass.results[targetTopicId];
    assert.deepEqual(savedResult.answer, revealedClass.currentRound.answer);
    assert.equal(savedResult.rankings.length, 30);
    const firstStudentRanking = savedResult.rankings.find(entry => entry.studentId === 'id_1');
    const secondStudentRanking = savedResult.rankings.find(entry => entry.studentId === 'id_2');
    assert.equal(firstStudentRanking.error, secondStudentRanking.error);
    assert.equal(firstStudentRanking.rank, secondStudentRanking.rank);
    const duplicateReveal = once(socket, 'server_error');
    socket.emit('reveal_answer', { classId: 'test-class', teacherPin: 'test-pin' });
    assert.equal((await duplicateReveal).code, 'ALREADY_REVEALED');

    const blockedNextRound = once(socket, 'server_error');
    socket.emit('trigger_roulette', { classId: 'test-class', teacherPin: 'test-pin' });
    assert.equal((await blockedNextRound).code, 'RESULT_NOT_DISMISSED');

    const blockedEarlyDismiss = once(socket, 'server_error');
    socket.emit('dismiss_answer_reveal', { classId: 'test-class', teacherPin: 'test-pin' });
    assert.equal((await blockedEarlyDismiss).code, 'INVALID_ROUND');

    const detailsRevealed = once(socket, 'answer_details_revealed_signal');
    socket.emit('reveal_answer_details', { classId: 'test-class', teacherPin: 'test-pin' });
    revealedClass = await detailsRevealed;
    assert.equal(revealedClass.currentRound.answerDetailsRevealed, true);

    const initialDismissed = once(socket, 'answer_reveal_dismissed');
    socket.emit('dismiss_answer_reveal', { classId: 'test-class', teacherPin: 'test-pin' });
    assert.equal((await initialDismissed).currentRound.revealDismissed, true);

    let modeClass;
    let scoresBeforeModeReveal;
    if (targetTopicId === 't_3') {
        modeClass = revealedClass;
        scoresBeforeModeReveal = Object.fromEntries(
            Object.values(modeClass.students).map(student => [student.id, 0])
        );
    } else {
        let latestClass = revealedClass;
        let latestTopicId = targetTopicId;
        while (latestTopicId !== 't_3') {
            const nextRound = once(socket, 'roulette_start_signal', 8000);
            socket.emit('trigger_roulette', { classId: 'test-class', teacherPin: 'test-pin' });
            latestTopicId = (await nextRound).targetTopicId;
            if (latestTopicId !== 't_3') {
                const intermediateReveal = once(socket, 'answer_revealed_signal');
                socket.emit('reveal_answer', { classId: 'test-class', teacherPin: 'test-pin' });
                latestClass = await intermediateReveal;
                const intermediateDetails = once(socket, 'answer_details_revealed_signal');
                socket.emit('reveal_answer_details', { classId: 'test-class', teacherPin: 'test-pin' });
                latestClass = await intermediateDetails;
                const intermediateDismissed = once(socket, 'answer_reveal_dismissed');
                socket.emit('dismiss_answer_reveal', { classId: 'test-class', teacherPin: 'test-pin' });
                latestClass = await intermediateDismissed;
            }
        }

        scoresBeforeModeReveal = Object.fromEntries(
            Object.values(latestClass.students).map(student => [student.id, student.score])
        );
        const modeReveal = once(socket, 'answer_revealed_signal');
        socket.emit('reveal_answer', { classId: 'test-class', teacherPin: 'test-pin' });
        modeClass = await modeReveal;
        const modeDetails = once(socket, 'answer_details_revealed_signal');
        socket.emit('reveal_answer_details', { classId: 'test-class', teacherPin: 'test-pin' });
        modeClass = await modeDetails;
    }

    const modeResult = modeClass.results.t_3;
    Object.values(modeClass.students).forEach(student => {
        const ranking = modeResult.rankings.find(entry => entry.studentId === student.id);
        const expectedGain = ranking.error === 0 ? 30 : 0;
        assert.equal(student.score - scoresBeforeModeReveal[student.id], expectedGain);
    });

    const finalDismissed = once(socket, 'answer_reveal_dismissed');
    socket.emit('dismiss_answer_reveal', { classId: 'test-class', teacherPin: 'test-pin' });
    assert.equal((await finalDismissed).currentRound.revealDismissed, true);
});

test('game state survives a server restart', async t => {
    const persistencePort = 3101;
    const persistenceUrl = `http://127.0.0.1:${persistencePort}`;
    const dataFile = path.join(os.tmpdir(), `stats-game-state-${process.pid}-${Date.now()}.json`);
    const children = [];

    const spawnPersistentServer = () => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: __dirname,
            env: {
                ...process.env,
                PORT: String(persistencePort),
                TEACHER_PIN: 'test-pin',
                DATA_FILE: dataFile,
                DISABLE_PERSISTENCE: 'false'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        children.push(child);
        return child;
    };

    t.after(async () => {
        children.forEach(child => {
            if (!child.killed) child.kill();
        });
        await fs.promises.rm(dataFile, { force: true });
        await fs.promises.rm(dataFile + '.tmp', { force: true });
    });

    const firstServer = spawnPersistentServer();
    await waitForServer(persistenceUrl);

    const firstSocket = createClient(persistenceUrl, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false
    });
    await once(firstSocket, 'connect');

    const classCreated = once(firstSocket, 'refresh_global');
    firstSocket.emit('create_class', {
        classId: 'saved-class',
        className: '저장 테스트반',
        teacherPin: 'test-pin'
    });
    await classCreated;

    const joined = once(firstSocket, 'init_state');
    firstSocket.emit('join_room', { classId: 'saved-class' });
    await joined;

    const studentUpdated = once(firstSocket, 'class_data_update');
    firstSocket.emit('student_login', {
        classId: 'saved-class',
        number: 7,
        name: '재시작테스트'
    });
    await studentUpdated;

    const topicAdded = once(firstSocket, 'refresh_global');
    firstSocket.emit('add_global_topic', {
        title: '재시작 후에도 남는 주제',
        type: '평균',
        teacherPin: 'test-pin'
    });
    await topicAdded;
    await new Promise(resolve => setTimeout(resolve, 250));
    firstSocket.close();

    const firstExited = new Promise(resolve => firstServer.once('exit', resolve));
    firstServer.kill('SIGTERM');
    await firstExited;

    const savedFile = JSON.parse(await fs.promises.readFile(dataFile, 'utf8'));
    assert.equal(savedFile.classes['saved-class'].students.id_7.name, '재시작테스트');
    assert.ok(savedFile.globalTopics.some(topic => topic.title === '재시작 후에도 남는 주제'));

    const secondServer = spawnPersistentServer();
    await waitForServer(persistenceUrl);
    const secondSocket = createClient(persistenceUrl, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false
    });
    t.after(() => secondSocket.close());
    await once(secondSocket, 'connect');

    const restoredState = once(secondSocket, 'init_state');
    secondSocket.emit('join_room', { classId: 'saved-class' });
    const restored = await restoredState;
    assert.equal(restored.classData.className, '저장 테스트반');
    assert.equal(restored.classData.students.id_7.name, '재시작테스트');
    assert.ok(restored.globalTopics.some(topic => topic.title === '재시작 후에도 남는 주제'));

    const secondExited = new Promise(resolve => secondServer.once('exit', resolve));
    secondServer.kill('SIGTERM');
    await secondExited;
});
