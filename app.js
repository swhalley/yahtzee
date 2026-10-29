// Game Categories & Forfeit Order (Bottom-up)
const CATEGORIES = [
    { id: 'ones', label: 'Ones', isUpper: true },
    { id: 'twos', label: 'Twos', isUpper: true },
    { id: 'threes', label: 'Threes', isUpper: true },
    { id: 'fours', label: 'Fours', isUpper: true },
    { id: 'fives', label: 'Fives', isUpper: true },
    { id: 'sixes', label: 'Sixes', isUpper: true },
    { id: 'threeOfKind', label: '3 of a Kind', isUpper: false },
    { id: 'fourOfKind', label: '4 of a Kind', isUpper: false },
    { id: 'fullHouse', label: 'Full House (25)', isUpper: false },
    { id: 'smStraight', label: 'Sm Straight (30)', isUpper: false },
    { id: 'lgStraight', label: 'Lg Straight (40)', isUpper: false },
    { id: 'yahtzee', label: 'YAHTZEE (50)', isUpper: false },
    { id: 'chance', label: 'Chance', isUpper: false }
];
const FORFEIT_ORDER = [...CATEGORIES].reverse().map(c => c.id);

// State Variables
let peer = null;
let hostConnection = null; // Used by clients to talk to host
let clientConnections = {}; // Used by host to talk to clients
let isHost = false;
let myInitials = "";
let myPeerId = "";

// Authoritative Game State (Maintained by Host)
let gameState = {
    players: [], // { id, initials, connected }
    scores: {},  // { peerId: { ones: 2, twos: 4, ..., total: 6 } }
    turnIndex: 0,
    dice: [1, 1, 1, 1, 1],
    rollsLeft: 3,
    timer: 120
};
let hostTimerInterval = null;
let heldDiceIndices = []; // Client-side tracking of held dice

// DOM Elements
const screens = {
    setup: document.getElementById('setup-screen'),
    game: document.getElementById('game-screen')
};
const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const inputInitials = document.getElementById('initials');
const inputCode = document.getElementById('join-code');
const statusText = document.getElementById('connection-status');
const uiTurnDisplay = document.getElementById('current-turn-display');
const uiTimer = document.getElementById('timer-display');
const uiRollBtn = document.getElementById('btn-roll');
const uiDice = Array.from(document.querySelectorAll('.die'));
const uiHostCode = document.getElementById('host-code-display');

// ==========================================
// INITIALIZATION & CONNECTION
// ==========================================

btnHost.addEventListener('click', () => {
    myInitials = inputInitials.value.trim().toUpperCase() || "H";
    isHost = true;
    initPeer();
});

btnJoin.addEventListener('click', () => {
    myInitials = inputInitials.value.trim().toUpperCase() || "J";
    const code = inputCode.value.trim();
    if (!code) return alert("Enter host code");
    isHost = false;
    initPeer(code);
});

function initPeer(hostCode = null) {
    statusText.innerText = "Connecting to signaling server...";
    peer = new Peer();

    peer.on('open', (id) => {
        myPeerId = id;
        if (isHost) {
            setupHostEnvironment();
        } else {
            connectToHost(hostCode);
        }
    });

    peer.on('error', (err) => {
        statusText.innerText = "Error: " + err.type;
        console.error(err);
    });
}

function setupHostEnvironment() {
    uiHostCode.style.display = 'block';
    uiHostCode.querySelector('span').innerText = myPeerId;
    statusText.innerText = "Hosting Game! Give code to players.";
    
    // Add host to player list
    gameState.players.push({ id: myPeerId, initials: myInitials, connected: true });
    gameState.scores[myPeerId] = initializeScorecard();
    
    peer.on('connection', (conn) => {
        conn.on('open', () => {
            clientConnections[conn.peer] = conn;
            setupHostListeners(conn);
        });
    });

    switchScreen('game');
    startHostTimer();
    renderState(gameState); // Initial render
}

function connectToHost(hostCode) {
    statusText.innerText = "Joining game...";
    hostConnection = peer.connect(hostCode, { metadata: { initials: myInitials } });
    
    hostConnection.on('open', () => {
        setupClientListeners();
        switchScreen('game');
    });
}

function switchScreen(screenId) {
    screens.setup.classList.remove('active');
    screens.game.classList.remove('active');
    screens[screenId].classList.add('active');
}

function initializeScorecard() {
    let card = { total: 0, upperBonus: 0 };
    CATEGORIES.forEach(c => card[c.id] = null);
    return card;
}

// ==========================================
// HOST LOGIC (Authoritative)
// ==========================================

function setupHostListeners(conn) {
    // New player joined
    if (!gameState.players.find(p => p.id === conn.peer)) {
        gameState.players.push({ id: conn.peer, initials: conn.metadata.initials, connected: true });
        gameState.scores[conn.peer] = initializeScorecard();
        broadcastState();
    }

    conn.on('data', (data) => {
        const currentPlayer = gameState.players[gameState.turnIndex];
        
        // Only accept game actions from the player whose turn it is
        if (currentPlayer.id !== conn.peer) return;

        if (data.type === 'REQUEST_ROLL' && gameState.rollsLeft > 0) {
            handleHostRoll(data.heldIndices);
        } else if (data.type === 'REQUEST_SCORE') {
            handleHostScore(conn.peer, data.category);
        }
    });

    conn.on('close', () => {
        const p = gameState.players.find(p => p.id === conn.peer);
        if (p) {
            p.connected = false;
            // If it was their turn, skip them
            if (gameState.players[gameState.turnIndex].id === conn.peer) {
                nextTurn();
            } else {
                broadcastState();
            }
        }
    });
}

function handleHostRoll(heldIndices) {
    gameState.rollsLeft--;
    gameState.dice = gameState.dice.map((val, idx) => {
        return heldIndices.includes(idx) ? val : Math.floor(Math.random() * 6) + 1;
    });
    // Tell clients to trigger roll animation, then send state
    broadcastToAll({ type: 'ANIMATE_ROLL' });
    setTimeout(broadcastState, 400); // Wait for animation before revealing numbers
}

function handleHostScore(peerId, categoryId) {
    if (gameState.scores[peerId][categoryId] !== null) return; // Already scored

    const score = calculateYahtzeeScore(gameState.dice, categoryId);
    gameState.scores[peerId][categoryId] = score;
    updateTotals(peerId);
    nextTurn();
}

function updateTotals(peerId) {
    let sheet = gameState.scores[peerId];
    let upperTotal = 0;
    CATEGORIES.filter(c => c.isUpper).forEach(c => {
        if (sheet[c.id]) upperTotal += sheet[c.id];
    });
    sheet.upperBonus = upperTotal >= 63 ? 35 : 0;
    
    let grandTotal = sheet.upperBonus;
    CATEGORIES.forEach(c => {
        if (sheet[c.id]) grandTotal += sheet[c.id];
    });
    sheet.total = grandTotal;
}

function nextTurn() {
    gameState.rollsLeft = 3;
    gameState.dice = [1, 1, 1, 1, 1];
    
    // Find next connected player
    let loops = 0;
    do {
        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
        loops++;
    } while (!gameState.players[gameState.turnIndex].connected && loops < gameState.players.length);

    gameState.timer = 120;
    broadcastState();
}

function startHostTimer() {
    hostTimerInterval = setInterval(() => {
        gameState.timer--;
        if (gameState.timer <= 0) {
            // Time out: score 0 bottom up
            const currentPlayer = gameState.players[gameState.turnIndex];
            const pScores = gameState.scores[currentPlayer.id];
            for (let catId of FORFEIT_ORDER) {
                if (pScores[catId] === null) {
                    pScores[catId] = 0;
                    break;
                }
            }
            updateTotals(currentPlayer.id);
            nextTurn();
        }
        broadcastToAll({ type: 'TICK', time: gameState.timer });
        renderTimer(gameState.timer); // update host's own UI
    }, 1000);
}

function broadcastState() {
    renderState(gameState); // Update host's own UI
    broadcastToAll({ type: 'STATE_UPDATE', state: gameState });
}

function broadcastToAll(message) {
    Object.values(clientConnections).forEach(conn => {
        if (conn.open) conn.send(message);
    });
}

// ==========================================
// CLIENT LOGIC (Dumb Terminal)
// ==========================================

function setupClientListeners() {
    hostConnection.on('data', (data) => {
        if (data.type === 'STATE_UPDATE') {
            gameState = data.state;
            renderState(gameState);
        } else if (data.type === 'TICK') {
            renderTimer(data.time);
        } else if (data.type === 'ANIMATE_ROLL') {
            triggerDiceAnimation();
        }
    });

    hostConnection.on('close', () => {
        alert("Host disconnected.");
        location.reload();
    });
}

// ==========================================
// UI & INTERACTION
// ==========================================

uiDice.forEach(die => {
    die.addEventListener('click', (e) => {
        if (!isMyTurn()) return;
        if (gameState.rollsLeft === 3) return; // Can't hold before first roll
        
        const idx = parseInt(e.target.dataset.index);
        if (heldDiceIndices.includes(idx)) {
            heldDiceIndices = heldDiceIndices.filter(i => i !== idx);
            e.target.classList.remove('held');
        } else {
            heldDiceIndices.push(idx);
            e.target.classList.add('held');
        }
    });
});

uiRollBtn.addEventListener('click', () => {
    if (!isMyTurn() || gameState.rollsLeft <= 0) return;
    
    if (isHost) {
        handleHostRoll(heldDiceIndices);
    } else {
        hostConnection.send({ type: 'REQUEST_ROLL', heldIndices: heldDiceIndices });
    }
});

function isMyTurn() {
    if (!gameState.players.length) return false;
    return gameState.players[gameState.turnIndex].id === myPeerId;
}

function triggerDiceAnimation() {
    uiDice.forEach((die, idx) => {
        if (!heldDiceIndices.includes(idx)) {
            die.classList.remove('rolling');
            void die.offsetWidth; // trigger reflow
            die.classList.add('rolling');
        }
    });
}

function renderState(state) {
    const currentPlayer = state.players[state.turnIndex];
    uiTurnDisplay.innerText = currentPlayer.initials + (isMyTurn() ? " (You)" : "");
    document.getElementById('rolls-left').innerText = state.rollsLeft;
    
    uiRollBtn.disabled = !isMyTurn() || state.rollsLeft === 0;

    // Reset holds on new turn
    if (state.rollsLeft === 3) {
        heldDiceIndices = [];
        uiDice.forEach(d => d.classList.remove('held'));
    }

    // Update dice numbers
    state.dice.forEach((val, idx) => {
        uiDice[idx].innerText = val;
    });

    renderScoresheet(state);
}

function renderTimer(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    uiTimer.innerText = `${m}:${s.toString().padStart(2, '0')}`;
}

function renderScoresheet(state) {
    const headRow = document.getElementById('scoresheet-header');
    const tbody = document.getElementById('scoresheet-body');
    
    // Build Headers
    headRow.innerHTML = '<th>Category</th>';
    state.players.forEach(p => {
        const th = document.createElement('th');
        th.innerText = p.initials;
        if (!p.connected) th.style.opacity = '0.4';
        headRow.appendChild(th);
    });

    // Build Rows
    tbody.innerHTML = '';
    CATEGORIES.forEach(cat => {
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.className = 'category-name';
        tdName.innerText = cat.label;
        
        // Click to score
        tdName.addEventListener('click', () => {
            if (!isMyTurn() || state.rollsLeft === 3) return; // Must roll at least once
            
            if (isHost) {
                handleHostScore(myPeerId, cat.id);
            } else {
                hostConnection.send({ type: 'REQUEST_SCORE', category: cat.id });
            }
        });
        tr.appendChild(tdName);

        state.players.forEach(p => {
            const td = document.createElement('td');
            td.className = 'score-cell';
            const val = state.scores[p.id][cat.id];
            td.innerText = val !== null ? val : '';
            if (!p.connected) td.classList.add('disabled');
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    // Totals Row
    const trTotal = document.createElement('tr');
    trTotal.innerHTML = '<th><strong>TOTAL</strong></th>';
    state.players.forEach(p => {
        trTotal.innerHTML += `<td><strong>${state.scores[p.id].total}</strong></td>`;
    });
    tbody.appendChild(trTotal);
}

// ==========================================
// YAHTZEE MATH
// ==========================================

function calculateYahtzeeScore(dice, category) {
    const counts = [0, 0, 0, 0, 0, 0, 0]; // index 1-6
    let sum = 0;
    dice.forEach(d => { counts[d]++; sum += d; });

    switch(category) {
        case 'ones': return counts[1] * 1;
        case 'twos': return counts[2] * 2;
        case 'threes': return counts[3] * 3;
        case 'fours': return counts[4] * 4;
        case 'fives': return counts[5] * 5;
        case 'sixes': return counts[6] * 6;
        case 'threeOfKind': return counts.some(c => c >= 3) ? sum : 0;
        case 'fourOfKind': return counts.some(c => c >= 4) ? sum : 0;
        case 'fullHouse': return (counts.includes(3) && counts.includes(2)) ? 25 : 0;
        case 'smStraight': 
            const str = counts.map(c => c > 0 ? 1 : 0).join('').slice(1);
            return (str.includes('1111')) ? 30 : 0;
        case 'lgStraight':
            const strLg = counts.map(c => c > 0 ? 1 : 0).join('').slice(1);
            return (strLg === '111110' || strLg === '011111') ? 40 : 0;
        case 'yahtzee': return counts.some(c => c === 5) ? 50 : 0;
        case 'chance': return sum;
        default: return 0;
    }
}