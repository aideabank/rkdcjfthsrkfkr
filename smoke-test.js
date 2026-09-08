const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
            const response = await fetch(`${BASE_URL}/health`);
            if (response.ok) return;
        } catch {
            // The child process may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Local server did not become ready');
}

function once(socket, eventName) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), 2000);
        socket.once(eventName, value => {
            clearTimeout(timeout);
            resolve(value);
        });
    });
}

test('health endpoint and Socket.IO handshake work', async t => {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT), TEACHER_PIN: 'test-pin' },
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
    socket.emit('join_room', { classId: '3-1' });
    assert.equal((await initialState).teacherAuthRequired, true);

    const unauthorized = once(socket, 'server_error');
    socket.emit('create_class', { classId: 'test-class' });
    assert.equal((await unauthorized).code, 'UNAUTHORIZED');

    const invalidStudent = once(socket, 'server_error');
    socket.emit('student_login', { classId: '3-1', number: 99, name: '<b>test</b>' });
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
});
