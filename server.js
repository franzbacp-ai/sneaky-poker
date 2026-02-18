const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

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

let gameState = {
    players: [],
    pot: 0,
    sidePots: [],
    board: [],
    currentTurn: 0,
    dealerIdx: 0,
    phase: 'LOBBY',
    deck: new Deck(),
    hostId: null,
    currentCall: 0,
    actionCount: 0,
    bettingRoundStartIdx: -1,
    lastRaiserIdx: -1,
    _prevCall: 0,
    settings: { sb: 0.5, bb: 1.0, startStack: 100 },
    lastAction: 'Waiting for host...',
    allInShowdown: false,
    handNumber: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function activePlayers()  { return gameState.players.filter(p => !p.outOfChips); }
function inHandPlayers()  { return gameState.players.filter(p => !p.folded && !p.outOfChips); }

function nextActive(from) {
    const n = gameState.players.length;
    let idx = (from + 1) % n;
    while (gameState.players[idx].outOfChips) idx = (idx + 1) % n;
    return idx;
}

function nextInHand(from) {
    const n = gameState.players.length;
    let idx = (from + 1) % n;
    while (gameState.players[idx].folded || gameState.players[idx].outOfChips) idx = (idx + 1) % n;
    return idx;
}

// ─── Side-pot calculation ─────────────────────────────────────────────────────
function buildSidePots() {
    const contribs = gameState.players
        .filter(p => (p.totalContrib || 0) > 0)
        .map(p => ({ id: p.id, contrib: p.totalContrib || 0, folded: p.folded }));
    if (contribs.length === 0)
        return [{ amount: gameState.pot, eligibleIds: inHandPlayers().map(p => p.id) }];
    const sorted = [...contribs].sort((a, b) => a.contrib - b.contrib);
    const pots = [];
    let prevLevel = 0;
    for (let i = 0; i < sorted.length; i++) {
        const level = sorted[i].contrib;
        if (level <= prevLevel) continue;
        const eligible = [];
        let amount = 0;
        for (const c of contribs) {
            const participation = Math.min(c.contrib, level) - Math.min(c.contrib, prevLevel);
            amount += participation;
            if (!c.folded && c.contrib >= level) eligible.push(c.id);
        }
        if (amount > 0) pots.push({ amount: Math.round(amount * 100) / 100, eligibleIds: eligible });
        prevLevel = level;
    }
    const distributed = pots.reduce((s, p) => s + p.amount, 0);
    const remainder = Math.round((gameState.pot - distributed) * 100) / 100;
    if (remainder > 0.001 && pots.length > 0) pots[0].amount += remainder;
    return pots;
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        if (gameState.players.find(p => p.id === socket.id)) return;
        const isHost = gameState.players.length === 0;
        if (isHost) gameState.hostId = socket.id;
        gameState.players.push({
            id: socket.id,
            baseName: data.name || 'Player',
            reentries: 0,
            stack: parseFloat(gameState.settings.startStack),
            bet: 0,
            totalContrib: 0,
            cards: [],
            folded: false,
            role: '',
            lastAction: '',
            outOfChips: false,
            isAllIn: false,
            master: data.master || false,
            handWinnings: 0,
        });
        broadcastState();
    });

    socket.on('updateSettings', (data) => {
        if (socket.id !== gameState.hostId) return;
        gameState.settings = { sb: parseFloat(data.sb), bb: parseFloat(data.bb), startStack: parseFloat(data.startStack) };
        gameState.players.forEach(p => p.stack = gameState.settings.startStack);
        broadcastState();
    });

    socket.on('startGame', () => { if (socket.id === gameState.hostId) startNewHand(); });

    socket.on('action', (data) => {
        const idx = gameState.players.findIndex(p => p.id === socket.id);
        if (idx !== gameState.currentTurn || gameState.allInShowdown) return;
        handlePlayerAction(idx, data);
    });

    socket.on('reenter', () => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (p && p.outOfChips) {
            p.stack = parseFloat(gameState.settings.startStack);
            p.reentries++; p.outOfChips = false; p.folded = true; 
            broadcastState();
        }
    });

    socket.on('disconnect', () => {
        gameState.players = gameState.players.filter(p => p.id !== socket.id);
        if (gameState.hostId === socket.id) gameState.hostId = gameState.players.length > 0 ? gameState.players[0].id : null;
        broadcastState();
    });
});

function startNewHand() {
    const active = activePlayers();
    if (active.length < 2) return;
    gameState.handNumber++;
    gameState.deck.reset();
    gameState.board = []; gameState.pot = 0; gameState.sidePots = [];
    gameState.phase = 'PREFLOP'; gameState.allInShowdown = false;
    gameState.actionCount = 0; gameState.lastRaiserIdx = -1; gameState._prevCall = 0;
    gameState.lastAction = `Hand #${gameState.handNumber}`;
    const { sb, bb } = gameState.settings;
    gameState.players.forEach(p => {
        p.cards = p.outOfChips ? [] : gameState.deck.deal(2);
        p.folded = p.outOfChips; p.bet = 0; p.totalContrib = 0;
        p.lastAction = ''; p.role = ''; p.isAllIn = false; p.handWinnings = 0;
    });
    const isHeadsUp = active.length === 2;
    gameState.players[gameState.dealerIdx].role = isHeadsUp ? 'D/SB' : 'D';
    const sbIdx = isHeadsUp ? gameState.dealerIdx : nextActive(gameState.dealerIdx);
    const bbIdx = nextActive(sbIdx);
    function postBlind(player, amount, roleName) {
        if (!player.role) player.role = roleName;
        const actual = Math.min(player.stack, amount);
        player.stack -= actual; player.bet = actual; player.totalContrib = actual;
        gameState.pot += actual;
        if (player.stack === 0) { player.isAllIn = true; player.lastAction = 'ALL IN!'; }
        else player.lastAction = roleName;
    }
    postBlind(gameState.players[sbIdx], sb, 'SB');
    postBlind(gameState.players[bbIdx], bb, 'BB');
    gameState.currentCall = bb;
    gameState.lastRaiserIdx = bbIdx;
    let firstToAct = isHeadsUp ? sbIdx : nextActive(bbIdx);
    while (gameState.players[firstToAct].isAllIn || gameState.players[firstToAct].folded)
        firstToAct = nextActive(firstToAct);
    gameState.currentTurn = firstToAct;
    gameState.bettingRoundStartIdx = firstToAct;
    broadcastState();
}

function handlePlayerAction(idx, action) {
    const p = gameState.players[idx];
    const { currentCall } = gameState;
    if (action.type === 'fold') {
        p.folded = true; p.lastAction = 'Fold';
    } else if (action.type === 'call') {
        const diff = Math.min(p.stack, currentCall - p.bet);
        p.stack -= diff; p.bet += diff; p.totalContrib += diff; gameState.pot += diff;
        if (p.stack === 0) { p.isAllIn = true; p.lastAction = 'ALL IN!'; }
        else p.lastAction = diff === 0 ? 'Check' : `Call ${p.bet.toFixed(1)}`;
    } else if (action.type === 'raise' || action.type === 'allin') {
        let raiseTo;
        if (action.type === 'allin') {
            raiseTo = p.stack + p.bet;
        } else {
            raiseTo = parseFloat(action.amount);
            const lastRaiseSize = currentCall - (gameState._prevCall || 0);
            const minRaise = currentCall + Math.max(lastRaiseSize, gameState.settings.bb);
            if (raiseTo < minRaise) raiseTo = minRaise;
            raiseTo = Math.min(raiseTo, p.stack + p.bet);
        }
        gameState._prevCall = currentCall;
        const diff = raiseTo - p.bet;
        p.stack -= diff; p.bet = raiseTo; p.totalContrib += diff; gameState.pot += diff;
        if (p.stack === 0) { p.isAllIn = true; p.lastAction = 'ALL IN!'; }
        else p.lastAction = `Raise \u2192 ${raiseTo.toFixed(1)}`;
        if (raiseTo > gameState.currentCall) {
            gameState.currentCall = raiseTo;
            gameState.lastRaiserIdx = idx;
            let newStart = nextInHand(idx);
            while (gameState.players[newStart].isAllIn) newStart = nextInHand(newStart);
            gameState.bettingRoundStartIdx = newStart;
        }
    }
    gameState.actionCount++;
    const stillIn = inHandPlayers();
    if (stillIn.length === 1) { endHand(stillIn[0]); return; }
    const canAct = gameState.players.filter(pl => !pl.folded && !pl.outOfChips && !pl.isAllIn);
    if (canAct.length === 0) {
        if (stillIn.length > 1) {
            gameState.allInShowdown = true;
            gameState.lastAction = '\u26a1 ALL-IN SHOWDOWN!';
            gameState.sidePots = buildSidePots();
            broadcastState();
            setTimeout(() => runOutBoard(), 2500);
        }
        return;
    }
    let nextIdx = nextInHand(idx);
    while (gameState.players[nextIdx].isAllIn) nextIdx = nextInHand(nextIdx);
    const everyoneMatchedOrAllIn = gameState.players.every(
        pl => pl.folded || pl.outOfChips || pl.isAllIn || pl.bet === gameState.currentCall
    );
    if (everyoneMatchedOrAllIn && (nextIdx === gameState.bettingRoundStartIdx || canAct.length <= 1)) {
        advancePhase(); return;
    }
    gameState.currentTurn = nextIdx;
    broadcastState();
}

async function runOutBoard() {
    while (gameState.board.length < 5) {
        if (gameState.board.length === 0)      gameState.board.push(...gameState.deck.dealCommunity(3));
        else if (gameState.board.length < 5)   gameState.board.push(...gameState.deck.dealCommunity(1));
        broadcastState();
        await new Promise(r => setTimeout(r, 2000));
    }
    gameState.sidePots = buildSidePots();
    determineWinner();
}

function advancePhase() {
    gameState.players.forEach(p => { if (!p.outOfChips) p.bet = 0; });
    gameState.currentCall = 0; gameState.actionCount = 0; gameState._prevCall = 0; gameState.lastRaiserIdx = -1;
    if      (gameState.phase === 'PREFLOP') { gameState.board.push(...gameState.deck.dealCommunity(3)); gameState.phase = 'FLOP'; }
    else if (gameState.phase === 'FLOP')    { gameState.board.push(...gameState.deck.dealCommunity(1)); gameState.phase = 'TURN'; }
    else if (gameState.phase === 'TURN')    { gameState.board.push(...gameState.deck.dealCommunity(1)); gameState.phase = 'RIVER'; }
    else { gameState.sidePots = buildSidePots(); determineWinner(); return; }
    const canAct = inHandPlayers().filter(p => !p.isAllIn);
    if (canAct.length === 0) {
        if (gameState.phase === 'RIVER') { gameState.sidePots = buildSidePots(); determineWinner(); }
        else { broadcastState(); setTimeout(() => advancePhase(), 2000); }
        return;
    }
    let first = nextActive(gameState.dealerIdx);
    while (gameState.players[first].folded || gameState.players[first].isAllIn) first = nextActive(first);
    gameState.currentTurn = first;
    gameState.bettingRoundStartIdx = first;
    broadcastState();
}

function determineWinner() {
    gameState.phase = 'SHOWDOWN';
    const pots = gameState.sidePots.length > 0 ? gameState.sidePots : buildSidePots();
    const winMessages = [];
    pots.forEach((pot, potIdx) => {
        const contestants = gameState.players.filter(p => pot.eligibleIds.includes(p.id));
        if (contestants.length === 0) return;
        if (contestants.length === 1) {
            contestants[0].stack += pot.amount;
            contestants[0].handWinnings += pot.amount;
            winMessages.push(`${contestants[0].baseName} wins ${pot.amount.toFixed(1)} BB`);
            return;
        }
        const hands = contestants.map(p => {
            const h = Hand.solve([...p.cards, ...gameState.board]);
            h.playerId = p.id; return h;
        });
        const winners = Hand.winners(hands);
        const share = pot.amount / winners.length;
        winners.forEach(w => {
            const p = gameState.players.find(pl => pl.id === w.playerId);
            p.stack += share; p.handWinnings += share;
            winMessages.push(potIdx === 0
                ? `\ud83c\udfc6 ${p.baseName} wins ${share.toFixed(1)} BB (${w.descr})`
                : `\u21b3 Side pot: ${p.baseName} +${share.toFixed(1)} BB`);
        });
    });
    gameState.lastAction = winMessages.join('  \u00b7  ');
    finishRound();
}

function endHand(winner) {
    winner.stack += gameState.pot;
    winner.handWinnings = gameState.pot;
    gameState.lastAction = `${winner.baseName} wins ${gameState.pot.toFixed(1)} BB (all folded)`;
    finishRound();
}

function finishRound() {
    gameState.pot = 0; gameState.sidePots = [];
    gameState.players.forEach(p => { if (p.stack <= 0) p.outOfChips = true; });
    gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
    while (gameState.players[gameState.dealerIdx].outOfChips)
        gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
    broadcastState();
    setTimeout(() => { if (gameState.phase !== 'LOBBY') startNewHand(); }, 6000);
}

function broadcastState() {
    gameState.players.forEach(p => {
        const copy = JSON.parse(JSON.stringify(gameState));
        const showAll = copy.phase === 'SHOWDOWN' || copy.allInShowdown;
        copy.players.forEach(other => {
            if (p.id !== copy.hostId && other.id !== p.id && !showAll && p.master !== 'true')
                other.cards = ['??', '??'];
        });
        if (p.master === 'true') copy.board = copy.deck.communityCards;
        io.to(p.id).emit('stateUpdate', { ...copy, me: p.id });
    });
}
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
