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
        this.ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
        this.suits = ['s', 'h', 'd', 'c'];
        this.reset();
    }
    reset() {
        this.cards = [];
        for (let s of this.suits) for (let r of this.ranks) this.cards.push(r + s);
        this.cards.sort(() => Math.random() - 0.5);
    }
    deal(n) { return this.cards.splice(0, n); }
}

let gameState = {
    players: [], pot: 0, board: [], currentTurn: 0, dealerIdx: 0,
    phase: 'LOBBY', deck: new Deck(), hostId: null,
    currentCall: 0, actionCount: 0,
    settings: { sb: 0.5, bb: 1.0, startStack: 100 },
    lastAction: "Warten auf den Host...", allInShowdown: false
};

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        if (gameState.players.find(p => p.id === socket.id)) return;
        const isHost = gameState.players.length === 0;
        if (isHost) gameState.hostId = socket.id;
        gameState.players.push({
            id: socket.id, baseName: data.name || "Spieler", reentries: 0,
            stack: parseFloat(gameState.settings.startStack), bet: 0,
            cards: [], folded: false, role: '', lastAction: '', outOfChips: false
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
    const active = gameState.players.filter(p => !p.outOfChips);
    if (active.length < 2) return;
    gameState.deck.reset(); gameState.board = []; gameState.pot = 0;
    gameState.phase = 'PREFLOP'; gameState.allInShowdown = false;
    const n = gameState.players.length;
    const { sb, bb } = gameState.settings;
    gameState.players.forEach((p, i) => {
        p.cards = p.outOfChips ? [] : gameState.deck.deal(2);
        p.folded = p.outOfChips; p.bet = 0; p.lastAction = ""; p.role = "";
        if (i === gameState.dealerIdx) p.role = 'D';
        if (i === (gameState.dealerIdx + 1) % n) { p.role = 'SB'; p.stack -= sb; p.bet = sb; gameState.pot += sb; }
        if (i === (gameState.dealerIdx + 2) % n) { p.role = 'BB'; p.stack -= bb; p.bet = bb; gameState.pot += bb; }
    });
    gameState.currentCall = bb;
    gameState.currentTurn = (gameState.dealerIdx + 3) % n;
    while(gameState.players[gameState.currentTurn].outOfChips) gameState.currentTurn = (gameState.currentTurn + 1) % n;
    gameState.actionCount = 0;
    broadcastState();
}

function handlePlayerAction(idx, action) {
    const p = gameState.players[idx];
    gameState.actionCount++;
    if (action.type === 'fold') { p.folded = true; p.lastAction = "Fold"; } 
    else if (action.type === 'call') {
        const diff = Math.min(p.stack, gameState.currentCall - p.bet);
        p.stack -= diff; p.bet += diff; gameState.pot += diff;
        p.lastAction = diff === 0 ? "Check" : "Call";
    } else if (action.type === 'raise' || action.type === 'allin') {
        let raiseTo = action.type === 'allin' ? p.stack + p.bet : parseFloat(action.amount);
        const diff = raiseTo - p.bet;
        p.stack -= diff; p.bet = raiseTo; gameState.pot += diff;
        if (raiseTo > gameState.currentCall) gameState.currentCall = raiseTo;
        p.lastAction = action.type === 'allin' ? "ALL IN!" : "Raise " + raiseTo;
    }

    const playing = gameState.players.filter(pl => !pl.folded && !pl.outOfChips);
    if (playing.length === 1) { endHand(playing[0]); return; }

    let nextIdx = idx;
    do { nextIdx = (nextIdx + 1) % gameState.players.length; } 
    while (gameState.players[nextIdx].folded || gameState.players[nextIdx].outOfChips);

    const everyoneMatched = gameState.players.every(pl => pl.folded || pl.outOfChips || pl.bet === gameState.currentCall || pl.stack === 0);
    
    if (everyoneMatched && gameState.actionCount >= playing.length) {
        const playersWithChips = playing.filter(pl => pl.stack > 0);
        if (playersWithChips.length <= 1 && playing.length > 1) {
            gameState.allInShowdown = true;
            gameState.lastAction = "ALL-IN SHOWDOWN!";
            broadcastState();
            setTimeout(() => runOutBoard(), 2000);
        } else {
            advancePhase();
        }
    } else {
        gameState.currentTurn = nextIdx;
        broadcastState();
    }
}

async function runOutBoard() {
    while (gameState.board.length < 5) {
        if (gameState.board.length === 0) gameState.board = gameState.deck.deal(3);
        else gameState.board.push(...gameState.deck.deal(1));
        broadcastState();
        await new Promise(r => setTimeout(r, 4000));
    }
    determineWinner();
}

function advancePhase() {
    gameState.players.forEach(p => p.bet = 0);
    gameState.currentCall = 0; gameState.actionCount = 0;
    if (gameState.phase === 'PREFLOP') { gameState.board = gameState.deck.deal(3); gameState.phase = 'FLOP'; }
    else if (gameState.phase === 'FLOP') { gameState.board.push(...gameState.deck.deal(1)); gameState.phase = 'TURN'; }
    else if (gameState.phase === 'TURN') { gameState.board.push(...gameState.deck.deal(1)); gameState.phase = 'RIVER'; }
    else { determineWinner(); return; }
    let first = (gameState.dealerIdx + 1) % gameState.players.length;
    while(gameState.players[first].folded || gameState.players[first].outOfChips) first = (first + 1) % gameState.players.length;
    gameState.currentTurn = first;
    broadcastState();
}

function determineWinner() {
    gameState.phase = 'SHOWDOWN';
    const playing = gameState.players.filter(p => !p.folded && !p.outOfChips);
    const hands = playing.map(p => {
        const solved = Hand.solve(p.cards.concat(gameState.board));
        solved.playerId = p.id; return solved;
    });
    const winners = Hand.winners(hands);
    const winAmount = gameState.pot / winners.length;
    winners.forEach(w => {
        const p = gameState.players.find(pl => pl.id === w.playerId);
        p.stack += winAmount;
        gameState.lastAction = `GEWINNER: ${p.baseName} (${w.descr})`;
    });
    finishRound();
}

function endHand(winner) { winner.stack += gameState.pot; gameState.lastAction = `${winner.baseName} gewinnt!`; finishRound(); }

function finishRound() {
    gameState.pot = 0;
    gameState.players.forEach(p => { if (p.stack <= 0) p.outOfChips = true; });
    gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
    broadcastState();
    setTimeout(() => { if (gameState.phase !== 'LOBBY') startNewHand(); }, 6000);
}

function broadcastState() {
    gameState.players.forEach(p => {
        let stateCopy = JSON.parse(JSON.stringify(gameState));
        stateCopy.players.forEach(other => {
            const showOthers = (gameState.phase === 'SHOWDOWN' || gameState.allInShowdown);
            if (p.id !== gameState.hostId && other.id !== p.id && !showOthers) other.cards = ['??', '??'];
        });
        io.to(p.id).emit('stateUpdate', { ...stateCopy, me: p.id });
    });
}
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));