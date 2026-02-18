const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ─── Open Graph / Link Preview route ─────────────────────────────────────────
app.get('/lobby/:lobbyId', (req, res) => {
    const lobby = lobbies.get(req.params.lobbyId);
    const name  = lobby ? `Poker Club – ${lobby.settings.startStack}BB Stack` : 'Poker Club';
    const desc  = lobby
        ? `${lobby.players.length} player(s) at the table. Blinds ${lobby.settings.sb}/${lobby.settings.bb} BB.`
        : 'No Limit Hold\'em – click to join';
    const url   = `${req.protocol}://${req.get('host')}/?lobby=${req.params.lobbyId}`;
    res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>${name}</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${name}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${req.protocol}://${req.get('host')}/preview.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${name}">
<meta name="twitter:description" content="${desc}">
<script>window.location.replace('${url}');</script>
</head><body><a href="${url}">Join ${name}</a></body></html>`);
});

// ─── Deck ─────────────────────────────────────────────────────────────────────
class Deck {
    constructor() {
        this.ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
        this.suits = ['s','h','d','c'];
        this.reset();
    }
    reset() {
        this.cards = [];
        this.communityCards = [];
        this._communityDeck = [];
        for (let s of this.suits) for (let r of this.ranks) this.cards.push(r + s);
        this.cards.sort(() => Math.random() - 0.5);
        this.communityCards = this.cards.splice(0, 5);
        this._communityDeck = structuredClone(this.communityCards);
    }
    deal(n) { return this.cards.splice(0, n); }
    dealCommunity(n) { return this._communityDeck.splice(0, n); }
}

// ─── Lobby registry & session store ──────────────────────────────────────────
const lobbies  = new Map();   // lobbyId → LobbyState
const sessions = new Map();   // sessionToken → { lobbyId, seatIndex, name, master, stack }
const MAX_SEATS = 8;

function newToken() { return crypto.randomBytes(12).toString('hex'); }

function makePlayer(socketId, token, name, master, stack) {
    return {
        id: socketId, token,
        baseName: name || 'Player',
        reentries: 0,
        stack: parseFloat(stack) || 100,
        bet: 0, totalContrib: 0,
        cards: [], folded: false,
        role: '', lastAction: '',
        outOfChips: false, isAllIn: false,
        master: master || false,
        handWinnings: 0,
        seatIndex: -1,
        queued: false,
    };
}

function createLobbyState(hostSocketId, hostName, master, startStack) {
    const lobbyId = crypto.randomBytes(4).toString('hex');
    const token   = newToken();
    const host    = makePlayer(hostSocketId, token, hostName, master, startStack || 100);
    host.seatIndex = 0;
    const lobby = {
        id: lobbyId, hostId: hostSocketId,
        players: [host], queue: [],
        pot: 0, sidePots: [], board: [],
        currentTurn: 0, dealerIdx: 0, phase: 'LOBBY',
        deck: new Deck(), currentCall: 0, actionCount: 0,
        bettingRoundStartIdx: -1, lastRaiserIdx: -1, _prevCall: 0,
        settings: { sb: 0.5, bb: 1.0, startStack: startStack || 100 },
        lastAction: 'Waiting for host...', allInShowdown: false, handNumber: 0,
    };
    lobbies.set(lobbyId, lobby);
    sessions.set(token, { lobbyId, seatIndex: 0, name: hostName, master, stack: startStack || 100 });
    return { lobby, token };
}

// ─── Helpers (all scoped to a lobby object) ───────────────────────────────────
function activePlayers(g)  { return g.players.filter(p => !p.outOfChips && !p.queued); }
function inHandPlayers(g)  { return g.players.filter(p => !p.folded && !p.outOfChips && !p.queued); }

function nextActive(g, from) {
    const n = g.players.length;
    let idx = (from + 1) % n, guard = 0;
    while ((g.players[idx].outOfChips || g.players[idx].queued) && guard++ < n)
        idx = (idx + 1) % n;
    return idx;
}

function nextInHand(g, from) {
    const n = g.players.length;
    let idx = (from + 1) % n, guard = 0;
    while ((g.players[idx].folded || g.players[idx].outOfChips || g.players[idx].queued) && guard++ < n)
        idx = (idx + 1) % n;
    return idx;
}

// ─── Side-pot calculation ─────────────────────────────────────────────────────
function buildSidePots(g) {
    const contribs = g.players
        .filter(p => (p.totalContrib || 0) > 0)
        .map(p => ({ id: p.id, contrib: p.totalContrib || 0, folded: p.folded }));
    if (contribs.length === 0)
        return [{ amount: g.pot, eligibleIds: inHandPlayers(g).map(p => p.id) }];
    const sorted = [...contribs].sort((a, b) => a.contrib - b.contrib);
    const pots = [];
    let prevLevel = 0;
    for (const entry of sorted) {
        const level = entry.contrib;
        if (level <= prevLevel) continue;
        let amount = 0;
        const eligible = [];
        for (const c of contribs) {
            amount += Math.min(c.contrib, level) - Math.min(c.contrib, prevLevel);
            if (!c.folded && c.contrib >= level) eligible.push(c.id);
        }
        if (amount > 0) pots.push({ amount: Math.round(amount * 100) / 100, eligibleIds: eligible });
        prevLevel = level;
    }
    const distributed = pots.reduce((s, p) => s + p.amount, 0);
    const remainder = Math.round((g.pot - distributed) * 100) / 100;
    if (remainder > 0.001 && pots.length > 0) pots[0].amount += remainder;
    return pots;
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcastState(g) {
    const sendTo = (p, isQueued) => {
        const copy = JSON.parse(JSON.stringify(g));
        const showAll = copy.phase === 'SHOWDOWN' || copy.allInShowdown;
        copy.players.forEach(other => {
            if (other.id !== p.id && !showAll && p.master !== true && p.master !== 'true')
                other.cards = ['??', '??'];
        });
        if (p.master === true || p.master === 'true') copy.masterBoard = g.deck._communityDeck.slice();
        copy.players.forEach(pl => { delete pl.token; });
        copy.queue.forEach(pl => { delete pl.token; });
        io.to(p.id).emit('stateUpdate', { ...copy, me: p.id, queued: isQueued || false });
    };
    g.players.forEach(p => sendTo(p, false));
    g.queue.forEach(p => sendTo(p, true));
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function getLobbyForSocket(socketId) {
    for (const [, lobby] of lobbies) {
        if (lobby.players.find(p => p.id === socketId)) return lobby;
        if (lobby.queue.find(p => p.id === socketId)) return lobby;
    }
    return null;
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

    // ── Create Lobby ──────────────────────────────────────────────────────────
    socket.on('createLobby', (data) => {
        const { lobby, token } = createLobbyState(socket.id, data.name, data.master, data.startStack);
        socket.join(lobby.id);
        socket.emit('lobbyCreated', { lobbyId: lobby.id, token });
        broadcastState(lobby);
    });

    // ── Join Lobby (fresh or reconnect) ───────────────────────────────────────
    socket.on('joinLobby', (data) => {
        const { lobbyId, name, token: resumeToken, master } = data;
        const lobby = lobbies.get(lobbyId);
        if (!lobby) { socket.emit('error', { msg: 'Lobby not found.' }); return; }

        // Reconnect path
        if (resumeToken) {
            const sess = sessions.get(resumeToken);
            if (sess && sess.lobbyId === lobbyId) {
                let existing = lobby.players.find(p => p.token === resumeToken)
                            || lobby.queue.find(p => p.token === resumeToken);
                if (existing) {
                    existing.id = socket.id;
                    socket.join(lobbyId);
                    socket.emit('reconnected', { token: resumeToken, lobbyId });
                    broadcastState(lobby);
                    return;
                }
                // Session valid but player was cleaned up – restore
                const restored = makePlayer(socket.id, resumeToken, sess.name, sess.master, sess.stack);
                restored.seatIndex = sess.seatIndex;
                restored.queued = lobby.phase !== 'LOBBY';
                restored.folded = restored.queued;
                if (restored.queued) lobby.queue.push(restored); else lobby.players.push(restored);
                socket.join(lobbyId);
                socket.emit('reconnected', { token: resumeToken, lobbyId });
                broadcastState(lobby);
                return;
            }
        }

        // Fresh join
        if (lobby.players.find(p => p.id === socket.id) || lobby.queue.find(p => p.id === socket.id)) return;
        const total = lobby.players.length + lobby.queue.length;
        if (total >= MAX_SEATS) { socket.emit('error', { msg: 'Table full (max 8 players).' }); return; }

        const token = newToken();
        const seatIndex = total;
        const player = makePlayer(socket.id, token, name, master, lobby.settings.startStack);
        player.seatIndex = seatIndex;
        sessions.set(token, { lobbyId, seatIndex, name, master, stack: lobby.settings.startStack });

        const midHand = lobby.phase !== 'LOBBY';
        if (midHand) { player.queued = true; player.folded = true; lobby.queue.push(player); }
        else          { lobby.players.push(player); }

        socket.join(lobbyId);
        socket.emit('joined', { token, lobbyId, queued: midHand });
        broadcastState(lobby);
    });

    // ── Settings ──────────────────────────────────────────────────────────────
    socket.on('updateSettings', (data) => {
        const lobby = getLobbyForSocket(socket.id);
        if (!lobby || socket.id !== lobby.hostId) return;
        lobby.settings = { sb: parseFloat(data.sb), bb: parseFloat(data.bb), startStack: parseFloat(data.startStack) };
        lobby.players.forEach(p => { if (!p.outOfChips) p.stack = lobby.settings.startStack; });
        broadcastState(lobby);
    });

    // ── Start Game ────────────────────────────────────────────────────────────
    socket.on('startGame', () => {
        const lobby = getLobbyForSocket(socket.id);
        if (!lobby || socket.id !== lobby.hostId) return;
        startNewHand(lobby);
    });

    // ── Action ────────────────────────────────────────────────────────────────
    socket.on('action', (data) => {
        const lobby = getLobbyForSocket(socket.id);
        if (!lobby) return;
        const idx = lobby.players.findIndex(p => p.id === socket.id);
        if (idx < 0 || idx !== lobby.currentTurn || lobby.allInShowdown) return;
        handlePlayerAction(lobby, idx, data);
    });

    // ── Re-enter ──────────────────────────────────────────────────────────────
    socket.on('reenter', () => {
        const lobby = getLobbyForSocket(socket.id);
        if (!lobby) return;
        let p = lobby.players.find(pl => pl.id === socket.id)
             || lobby.queue.find(pl => pl.id === socket.id);
        if (p && p.outOfChips) {
            p.stack = parseFloat(lobby.settings.startStack);
            p.reentries++; p.outOfChips = false; p.queued = true; p.folded = true;
            if (!lobby.queue.find(q => q.id === p.id)) {
                lobby.players = lobby.players.filter(pl => pl.id !== p.id);
                lobby.queue.push(p);
            }
            broadcastState(lobby);
            // If the game is stuck (only 1 or 0 active players left), kick off next hand now
            const active = activePlayers(lobby);
            if (lobby.phase !== 'LOBBY' && active.length < 2) {
                // Wait a beat then start – the reenter player will be flushed from queue
                setTimeout(() => { if (lobby.phase !== 'LOBBY') startNewHand(lobby); }, 1500);
            }
        }
    });

    // ── Leave lobby (intentional) ──────────────────────────────────────────
    socket.on('leave', () => {
        const lobby = getLobbyForSocket(socket.id);
        if (!lobby) return;
        // Remove from players and queue entirely
        lobby.players = lobby.players.filter(p => p.id !== socket.id);
        lobby.queue   = lobby.queue.filter(p => p.id !== socket.id);
        // Remove token mapping so they can't reconnect as this player
        for (const [tok, sid] of sessions) { if (sid === socket.id) { sessions.delete(tok); break; } }
        socket.leave(lobby.id);
        // If mid-hand and now fewer than 2 active players, advance the hand
        const active = activePlayers(lobby);
        if (lobby.phase !== 'LOBBY' && active.length < 2) {
            setTimeout(() => { if (lobby.phase !== 'LOBBY') startNewHand(lobby); }, 800);
        } else {
            broadcastState(lobby);
        }
        // Clean up empty lobbies
        if (lobby.players.length === 0 && lobby.queue.length === 0) lobbies.delete(lobby.id);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const lobby = getLobbyForSocket(socket.id);
        if (!lobby) return;
        // Keep ghost seat for token-reconnect; just broadcast the disconnect state
        broadcastState(lobby);
    });
});

// ─── Turn timer (30s auto-fold) ───────────────────────────────────────────────
const turnTimers = new Map(); // lobbyId → timeout handle

function clearTurnTimer(g) {
    const t = turnTimers.get(g.id);
    if (t) { clearTimeout(t); turnTimers.delete(g.id); }
}

function armTurnTimer(g) {
    clearTurnTimer(g);
    if (g.allInShowdown || g.phase === 'LOBBY' || g.phase === 'SHOWDOWN') return;
    const p = g.players[g.currentTurn];
    if (!p || p.folded || p.isAllIn || p.outOfChips || p.queued) return;
    // Attach turn token so we only act if the player hasn't already moved
    const token = g.actionCount;
    const handle = setTimeout(() => {
        if (!lobbies.has(g.id)) return;
        if (g.actionCount !== token) return; // player already acted
        const idx = g.currentTurn;
        if (idx >= 0 && idx < g.players.length) {
            handlePlayerAction(g, idx, { type: 'fold' });
        }
    }, 30000);
    turnTimers.set(g.id, handle);
}

// ─── Start New Hand ───────────────────────────────────────────────────────────
function startNewHand(g) {
    // Flush queue → active seats
    g.queue.forEach(qp => {
        qp.queued = false; qp.folded = false; qp.outOfChips = false;
        g.players.push(qp);
    });
    g.queue = [];

    const active = activePlayers(g);
    if (active.length < 2) return;

    g.handNumber++;
    g.deck.reset();
    g.board = []; g.pot = 0; g.sidePots = [];
    g.phase = 'PREFLOP'; g.allInShowdown = false;
    g.actionCount = 0; g.lastRaiserIdx = -1; g._prevCall = 0;
    g.lastAction = `Hand #${g.handNumber}`;

    const { sb, bb } = g.settings;
    g.players.forEach(p => {
        p.cards = (p.outOfChips || p.queued) ? [] : g.deck.deal(2);
        p.folded = p.outOfChips || p.queued;
        p.bet = 0; p.totalContrib = 0; p.lastAction = ''; p.role = ''; p.isAllIn = false; p.handWinnings = 0;
    });

    const isHeadsUp = active.length === 2;
    g.players[g.dealerIdx].role = isHeadsUp ? 'D/SB' : 'D';
    const sbIdx = isHeadsUp ? g.dealerIdx : nextActive(g, g.dealerIdx);
    const bbIdx = nextActive(g, sbIdx);

    function postBlind(player, amount, roleName) {
        if (!player.role) player.role = roleName;
        const actual = Math.min(player.stack, amount);
        player.stack -= actual; player.bet = actual; player.totalContrib = actual; g.pot += actual;
        if (player.stack === 0) { player.isAllIn = true; player.lastAction = 'ALL IN!'; }
        else player.lastAction = roleName;
    }
    postBlind(g.players[sbIdx], sb, 'SB');
    postBlind(g.players[bbIdx], bb, 'BB');
    g.currentCall = bb; g.lastRaiserIdx = bbIdx;

    let firstToAct = isHeadsUp ? sbIdx : nextActive(g, bbIdx);
    while (g.players[firstToAct].isAllIn || g.players[firstToAct].folded)
        firstToAct = nextActive(g, firstToAct);
    g.currentTurn = firstToAct;
    g.bettingRoundStartIdx = firstToAct;
    broadcastState(g);
    armTurnTimer(g);
}

// ─── Handle Player Action ─────────────────────────────────────────────────────────────
function handlePlayerAction(g, idx, action) {
    clearTurnTimer(g);
    const p = g.players[idx];
    const { currentCall } = g;

    if (action.type === 'fold') {
        p.folded = true; p.lastAction = 'Fold';
    } else if (action.type === 'call') {
        const diff = Math.min(p.stack, currentCall - p.bet);
        p.stack -= diff; p.bet += diff; p.totalContrib += diff; g.pot += diff;
        if (p.stack === 0) { p.isAllIn = true; p.lastAction = 'ALL IN!'; }
        else p.lastAction = diff === 0 ? 'Check' : `Call ${p.bet.toFixed(1)}`;
    } else if (action.type === 'raise' || action.type === 'allin') {
        let raiseTo = action.type === 'allin' ? p.stack + p.bet : parseFloat(action.amount);
        if (action.type === 'raise') {
            const lastRaiseSize = currentCall - (g._prevCall || 0);
            const minRaise = currentCall + Math.max(lastRaiseSize, g.settings.bb);
            if (raiseTo < minRaise) raiseTo = minRaise;
            raiseTo = Math.min(raiseTo, p.stack + p.bet);
        }
        g._prevCall = currentCall;
        const diff = raiseTo - p.bet;
        p.stack -= diff; p.bet = raiseTo; p.totalContrib += diff; g.pot += diff;
        if (p.stack === 0) { p.isAllIn = true; p.lastAction = 'ALL IN!'; }
        else p.lastAction = `Raise \u2192 ${raiseTo.toFixed(1)}`;
        if (raiseTo > g.currentCall) {
            g.currentCall = raiseTo; g.lastRaiserIdx = idx;
            let newStart = nextInHand(g, idx);
            while (g.players[newStart].isAllIn) newStart = nextInHand(g, newStart);
            g.bettingRoundStartIdx = newStart;
        }
    }
    g.actionCount++;

    const stillIn = inHandPlayers(g);
    if (stillIn.length === 1) { endHand(g, stillIn[0]); return; }

    const canAct = g.players.filter(pl => !pl.folded && !pl.outOfChips && !pl.isAllIn && !pl.queued);
    if (canAct.length <= 1) {
        if (stillIn.length > 1) {
            g.allInShowdown = true; g.lastAction = '⚡ ALL-IN SHOWDOWN!';
            g.sidePots = buildSidePots(g); broadcastState(g);
            setTimeout(() => runOutBoard(g), 2500);
        }
        return;
    }
    let nextIdx = nextInHand(g, idx);
    while (g.players[nextIdx].isAllIn) nextIdx = nextInHand(g, nextIdx);
    const everyoneMatchedOrAllIn = g.players.every(
        pl => pl.folded || pl.outOfChips || pl.isAllIn || pl.queued || pl.bet === g.currentCall
    );
    if (everyoneMatchedOrAllIn && (nextIdx === g.bettingRoundStartIdx || canAct.length <= 1)) {
        advancePhase(g); return;
    }
    g.currentTurn = nextIdx;
    broadcastState(g);
    armTurnTimer(g);
}

// ─── Advance Phase ─────────────────────────────────────────────────────────────
function advancePhase(g) {
    clearTurnTimer(g);
    g.players.forEach(p => { if (!p.outOfChips) p.bet = 0; });
    g.currentCall = 0; g.actionCount = 0; g._prevCall = 0; g.lastRaiserIdx = -1;
    if      (g.phase === 'PREFLOP') { g.board.push(...g.deck.dealCommunity(3)); g.phase = 'FLOP'; }
    else if (g.phase === 'FLOP')    { g.board.push(...g.deck.dealCommunity(1)); g.phase = 'TURN'; }
    else if (g.phase === 'TURN')    { g.board.push(...g.deck.dealCommunity(1)); g.phase = 'RIVER'; }
    else { g.sidePots = buildSidePots(g); determineWinner(g); return; }
    const canAct = inHandPlayers(g).filter(p => !p.isAllIn);
    // If nobody or only one player can act (everyone else all-in/folded), auto-run the board
    if (canAct.length <= 1) {
        if (g.phase === 'RIVER') { g.sidePots = buildSidePots(g); determineWinner(g); }
        else { broadcastState(g); setTimeout(() => advancePhase(g), 2000); }
        return;
    }
    let first = nextActive(g, g.dealerIdx);
    while (g.players[first].folded || g.players[first].isAllIn) first = nextActive(g, first);
    g.currentTurn = first; g.bettingRoundStartIdx = first;
    broadcastState(g);
    armTurnTimer(g);
}

// ─── Run Out Board ────────────────────────────────────────────────────────────
async function runOutBoard(g) {
    while (g.board.length < 5) {
        if (g.board.length === 0)  g.board.push(...g.deck.dealCommunity(3));
        else                       g.board.push(...g.deck.dealCommunity(1));
        broadcastState(g);
        await new Promise(r => setTimeout(r, 2000));
    }
    g.sidePots = buildSidePots(g);
    determineWinner(g);
}

// ─── Determine Winner ─────────────────────────────────────────────────────────
function determineWinner(g) {
    g.phase = 'SHOWDOWN';
    const pots = g.sidePots.length > 0 ? g.sidePots : buildSidePots(g);
    const winMessages = [];
    pots.forEach((pot, potIdx) => {
        const contestants = g.players.filter(p => pot.eligibleIds.includes(p.id));
        if (contestants.length === 0) return;
        if (contestants.length === 1) {
            contestants[0].stack += pot.amount; contestants[0].handWinnings += pot.amount;
            winMessages.push(`${contestants[0].baseName} wins ${pot.amount.toFixed(1)} BB`);
            return;
        }
        const hands = contestants.map(p => {
            const h = Hand.solve([...p.cards, ...g.board]); h.playerId = p.id; return h;
        });
        const winners = Hand.winners(hands);
        const share = pot.amount / winners.length;
        winners.forEach(w => {
            const p = g.players.find(pl => pl.id === w.playerId);
            p.stack += share; p.handWinnings += share;
            winMessages.push(potIdx === 0
                ? `${p.baseName} wins ${share.toFixed(1)} BB (${w.descr})`
                : `Side pot: ${p.baseName} +${share.toFixed(1)} BB`);
        });
    });
    g.lastAction = winMessages.join('  \u00b7  ');
    g.players.forEach(p => { const s = sessions.get(p.token); if (s) s.stack = p.stack; });
    finishRound(g);
}

// ─── End Hand (everyone folded) ───────────────────────────────────────────────
function endHand(g, winner) {
    winner.stack += g.pot; winner.handWinnings = g.pot;
    g.lastAction = `${winner.baseName} wins ${g.pot.toFixed(1)} BB (all folded)`;
    finishRound(g);
}

// ─── Finish Round ─────────────────────────────────────────────────────────────
function finishRound(g) {
    clearTurnTimer(g);
    g.pot = 0; g.sidePots = [];
    g.players.forEach(p => { if (p.stack <= 0) p.outOfChips = true; });
    g.dealerIdx = (g.dealerIdx + 1) % g.players.length;
    let guard = 0;
    while ((g.players[g.dealerIdx].outOfChips || g.players[g.dealerIdx].queued) && guard++ < g.players.length)
        g.dealerIdx = (g.dealerIdx + 1) % g.players.length;
    broadcastState(g);
    setTimeout(() => {
        if (g.phase === 'LOBBY') return;
        // Only auto-start next hand if there are enough active+queued players
        const canPlay = activePlayers(g).length + g.queue.filter(q => !q.outOfChips).length;
        if (canPlay >= 2) startNewHand(g);
        // else: waiting for a re-enter event to trigger startNewHand
    }, 6000);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));