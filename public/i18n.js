// ─── Translations ─────────────────────────────────────────────────────────────
const TRANSLATIONS = {
    en: {
        fold: 'FOLD', check: 'CHECK', call: 'CALL', raise: 'RAISE', allIn: 'ALL-IN',
        createLobby: 'Create Lobby', joinLobby: 'Join Lobby', startGame: 'Start Game',
        yourName: 'Your name', joinCode: 'Lobby ID or invite link',
        waiting: 'Waiting for next hand…', queuedBadge: 'Next Hand',
        busted: 'BUSTED', reenter: 'Re-enter', pot: 'POT', hand: 'HAND',
        players: 'players', copyLink: '🔗 Copy Invite Link', copied: 'Copied!',
        disconnected: 'Disconnected', spectating: 'Spectating',
        raiseAmount: 'Raise to', minRaise: 'Min', maxRaise: 'Max',
        phase_LOBBY: 'LOBBY', phase_PREFLOP: 'PRE-FLOP', phase_FLOP: 'FLOP',
        phase_TURN: 'TURN', phase_RIVER: 'RIVER', phase_SHOWDOWN: 'SHOWDOWN',
        settings: 'Settings', sb: 'Small Blind', bb: 'Big Blind', startStack: 'Start Stack',
        apply: 'Apply', lobbyCreated: 'Lobby created!', errorLobbyFull: 'Table is full.',
        errorNotFound: 'Lobby not found.',
        allInShowdown: '⚡ ALL-IN SHOWDOWN!',
    },
    de: {
        fold: 'AUFGEBEN', check: 'CHECKEN', call: 'CALLEN', raise: 'ERHÖHEN', allIn: 'ALL-IN',
        createLobby: 'Lobby erstellen', joinLobby: 'Lobby beitreten', startGame: 'Spiel starten',
        yourName: 'Dein Name', joinCode: 'Lobby-ID oder Einladungslink',
        waiting: 'Warte auf nächste Hand…', queuedBadge: 'Nächste Hand',
        busted: 'PLEITE', reenter: 'Zurückkehren', pot: 'POT', hand: 'HAND',
        players: 'Spieler', copyLink: '🔗 Einladungslink kopieren', copied: 'Kopiert!',
        disconnected: 'Getrennt', spectating: 'Zuschauer',
        raiseAmount: 'Erhöhen auf', minRaise: 'Min', maxRaise: 'Max',
        phase_LOBBY: 'LOBBY', phase_PREFLOP: 'PRE-FLOP', phase_FLOP: 'FLOP',
        phase_TURN: 'TURN', phase_RIVER: 'RIVER', phase_SHOWDOWN: 'SHOWDOWN',
        settings: 'Einstellungen', sb: 'Small Blind', bb: 'Big Blind', startStack: 'Startstack',
        apply: 'Anwenden', lobbyCreated: 'Lobby erstellt!', errorLobbyFull: 'Tisch ist voll.',
        errorNotFound: 'Lobby nicht gefunden.',
        allInShowdown: '⚡ ALL-IN SHOWDOWN!',
    }
};

let _lang = localStorage.getItem('pokerLang') || 'en';
function t(key) { return (TRANSLATIONS[_lang] || TRANSLATIONS.en)[key] || key; }
function setLang(l) { _lang = l; localStorage.setItem('pokerLang', l); }
function getLang() { return _lang; }
