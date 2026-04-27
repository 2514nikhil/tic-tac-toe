const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Track connected players and active games
const players = new Map();       // socketId -> { id, name, avatar, status }
const games = new Map();         // gameId -> { player1, player2, board, turn, status }
const pendingChallenges = new Map(); // challengedId -> { challengerId, gameId }
const sessionScores = new Map(); // pairKey -> { [p1Id]: n, [p2Id]: n }  (persists across rematches)
const pendingRematches = new Map(); // pairKey -> Set of socketIds who requested rematch

// Canonical key for a pair of players (order-independent)
function pairKey(a, b) { return [a, b].sort().join('|'); }

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function broadcastLobby() {
  const lobby = Array.from(players.values()).map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    status: p.status,
  }));
  io.emit('lobby_update', lobby);
}

function checkWinner(board) {
  const wins = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6]          // diagonals
  ];
  for (const [a,b,c] of wins) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a,b,c] };
    }
  }
  if (board.every(cell => cell !== null)) return { winner: 'draw', line: [] };
  return null;
}

io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);

  // Player joins with profile
  socket.on('join', ({ name, avatar }) => {
    const player = {
      id: socket.id,
      name: name.trim().substring(0, 18) || 'Player',
      avatar: avatar || '#6c63ff',
      status: 'online',
    };
    players.set(socket.id, player);
    socket.emit('joined', player);
    broadcastLobby();
    console.log(`[JOIN] ${player.name} (${socket.id})`);
  });

  // Player sends challenge to another
  socket.on('challenge', ({ targetId }) => {
    const challenger = players.get(socket.id);
    const target = players.get(targetId);
    if (!challenger || !target) return;
    if (target.status !== 'online') {
      socket.emit('challenge_failed', { reason: `${target.name} is busy.` });
      return;
    }
    if (pendingChallenges.has(targetId)) {
      socket.emit('challenge_failed', { reason: `${target.name} already has a pending challenge.` });
      return;
    }

    const gameId = `${socket.id}-${targetId}-${Date.now()}`;
    pendingChallenges.set(targetId, { challengerId: socket.id, gameId });

    // Reset session scores for this NEW pairing (fresh challenge, not a rematch)
    const key = pairKey(socket.id, targetId);
    sessionScores.set(key, { [socket.id]: 0, [targetId]: 0 });

    // Mark challenger as challenging
    challenger.status = 'challenging';
    players.set(socket.id, challenger);
    broadcastLobby();

    // Notify the challenged player
    io.to(targetId).emit('incoming_challenge', {
      challengerId: socket.id,
      challengerName: challenger.name,
      challengerAvatar: challenger.avatar,
      gameId,
    });

    // Notify challenger that challenge was sent
    socket.emit('challenge_sent', { targetName: target.name });
    console.log(`[CHALLENGE] ${challenger.name} → ${target.name}`);
  });

  // Challenged player responds
  socket.on('challenge_response', ({ accept, gameId, challengerId }) => {
    const challenged = players.get(socket.id);
    const challenger = players.get(challengerId);

    // Clean up pending challenge
    pendingChallenges.delete(socket.id);

    if (!accept) {
      // Declined
      if (challenger) {
        challenger.status = 'online';
        players.set(challengerId, challenger);
      }
      broadcastLobby();
      io.to(challengerId).emit('challenge_declined', { byName: challenged ? challenged.name : 'Opponent' });
      return;
    }

    if (!challenger || !challenged) {
      socket.emit('challenge_failed', { reason: 'Challenger disconnected.' });
      return;
    }

    // Fetch (or init) session scores for this pair
    const key = pairKey(challengerId, socket.id);
    if (!sessionScores.has(key)) {
      sessionScores.set(key, { [challengerId]: 0, [socket.id]: 0 });
    }
    const sc = sessionScores.get(key);

    // Start game
    const game = {
      id: gameId,
      player1: { id: challengerId, name: challenger.name, avatar: challenger.avatar, symbol: 'X' },
      player2: { id: socket.id, name: challenged.name, avatar: challenged.avatar, symbol: 'O' },
      board: Array(9).fill(null),
      turn: challengerId, // challenger goes first (X)
      status: 'playing',
      scores: { p1: sc[challengerId] ?? 0, p2: sc[socket.id] ?? 0 },
    };
    games.set(gameId, game);

    // Mark both as in-game
    challenger.status = 'in-game';
    challenged.status = 'in-game';
    players.set(challengerId, challenger);
    players.set(socket.id, challenged);
    broadcastLobby();

    // Join both players to a socket.io room
    const c = io.sockets.sockets.get(challengerId);
    if (c) c.join(gameId);
    socket.join(gameId);

    io.to(gameId).emit('game_start', game);
    console.log(`[GAME START] ${challenger.name} vs ${challenged.name} | Room: ${gameId}`);
  });

  // Cancel an outgoing challenge
  socket.on('cancel_challenge', ({ targetId }) => {
    const challenger = players.get(socket.id);
    const pending = pendingChallenges.get(targetId);
    if (pending && pending.challengerId === socket.id) {
      pendingChallenges.delete(targetId);
      io.to(targetId).emit('challenge_cancelled');
    }
    if (challenger) {
      challenger.status = 'online';
      players.set(socket.id, challenger);
    }
    broadcastLobby();
  });

  // Player makes a move
  socket.on('make_move', ({ gameId, index }) => {
    const game = games.get(gameId);
    if (!game) return;
    if (game.turn !== socket.id) return;
    if (game.board[index] !== null) return;
    if (game.status !== 'playing') return;

    // Place the mark
    const symbol = game.player1.id === socket.id ? 'X' : 'O';
    game.board[index] = symbol;

    const result = checkWinner(game.board);

    if (result) {
      game.status = 'finished';
      io.to(gameId).emit('game_update', { board: game.board, turn: null });

      let winnerId = null;
      if (result.winner === 'X') winnerId = game.player1.id;
      else if (result.winner === 'O') winnerId = game.player2.id;

      // Update session scores on the server
      const key = pairKey(game.player1.id, game.player2.id);
      const sc = sessionScores.get(key) ?? { [game.player1.id]: 0, [game.player2.id]: 0 };
      if (winnerId) sc[winnerId] = (sc[winnerId] ?? 0) + 1;
      sessionScores.set(key, sc);

      io.to(gameId).emit('game_over', {
        winner: result.winner,
        winnerId,
        line: result.line,
        player1: game.player1,
        player2: game.player2,
        scores: { p1: sc[game.player1.id] ?? 0, p2: sc[game.player2.id] ?? 0 },
      });

      // Reset players to online
      [game.player1.id, game.player2.id].forEach(pid => {
        const p = players.get(pid);
        if (p) { p.status = 'online'; players.set(pid, p); }
      });
      games.delete(gameId);
      broadcastLobby();
    } else {
      // Switch turn
      game.turn = game.player1.id === socket.id ? game.player2.id : game.player1.id;
      games.set(gameId, game);
      io.to(gameId).emit('game_update', { board: game.board, turn: game.turn });
    }
  });

  // Player requests rematch
  socket.on('request_rematch', ({ gameId, opponentId }) => {
    const key = pairKey(socket.id, opponentId);

    // Track who has requested rematch
    if (!pendingRematches.has(key)) {
      pendingRematches.set(key, new Set());
    }
    const requestSet = pendingRematches.get(key);
    requestSet.add(socket.id);

    // Notify the requester that we received their request
    socket.emit('rematch_requested');

    // If both players have requested → auto-start rematch
    if (requestSet.has(socket.id) && requestSet.has(opponentId)) {
      pendingRematches.delete(key);
      startRematch(socket.id, opponentId);
    } else {
      // Notify opponent
      const fromName = players.get(socket.id)?.name;
      io.to(opponentId).emit('rematch_request', { from: socket.id, fromName });
    }
  });

  socket.on('rematch_response', ({ accept, opponentId, originalGameId }) => {
    const key = pairKey(socket.id, opponentId);
    pendingRematches.delete(key); // clear pending state

    if (!accept) {
      io.to(opponentId).emit('rematch_declined');
      return;
    }
    startRematch(opponentId, socket.id);
  });

  function startRematch(requesterId, acceptorId) {
    const p1 = players.get(requesterId);
    const p2 = players.get(acceptorId);
    if (!p1 || !p2) return;

    // Carry over session scores (do NOT reset — this is a rematch)
    const key = pairKey(requesterId, acceptorId);
    const sc = sessionScores.get(key) ?? { [requesterId]: 0, [acceptorId]: 0 };

    const newGameId = `${requesterId}-${acceptorId}-${Date.now()}`;
    const game = {
      id: newGameId,
      player1: { id: requesterId, name: p1.name, avatar: p1.avatar, symbol: 'X' },
      player2: { id: acceptorId, name: p2.name, avatar: p2.avatar, symbol: 'O' },
      board: Array(9).fill(null),
      turn: requesterId,
      status: 'playing',
      scores: { p1: sc[requesterId] ?? 0, p2: sc[acceptorId] ?? 0 },
    };
    games.set(newGameId, game);

    p1.status = 'in-game'; players.set(requesterId, p1);
    p2.status = 'in-game'; players.set(acceptorId, p2);
    broadcastLobby();

    const s1 = io.sockets.sockets.get(requesterId);
    const s2 = io.sockets.sockets.get(acceptorId);
    if (s1) s1.join(newGameId);
    if (s2) s2.join(newGameId);

    io.to(newGameId).emit('game_start', game);
    console.log(`[REMATCH] ${p1.name} vs ${p2.name} | Room: ${newGameId}`);
  }

  // Forfeit / leave game
  socket.on('forfeit', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game) return;

    const opponentId = game.player1.id === socket.id ? game.player2.id : game.player1.id;
    const forfeitWinner = opponentId === game.player1.id ? 'X' : 'O';

    // Update session scores for forfeit
    const key = pairKey(game.player1.id, game.player2.id);
    const sc = sessionScores.get(key) ?? { [game.player1.id]: 0, [game.player2.id]: 0 };
    sc[opponentId] = (sc[opponentId] ?? 0) + 1;
    sessionScores.set(key, sc);

    io.to(gameId).emit('game_over', {
      winner: forfeitWinner,
      winnerId: opponentId,
      line: [],
      forfeit: true,
      player1: game.player1,
      player2: game.player2,
      scores: { p1: sc[game.player1.id] ?? 0, p2: sc[game.player2.id] ?? 0 },
    });

    [game.player1.id, game.player2.id].forEach(pid => {
      const p = players.get(pid);
      if (p) { p.status = 'online'; players.set(pid, p); }
    });
    games.delete(gameId);
    broadcastLobby();
  });

  // Disconnect
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (!player) return;
    console.log(`[-] Disconnected: ${player.name} (${socket.id})`);

    // If they were in a game, forfeit it
    for (const [gameId, game] of games.entries()) {
      if (game.player1.id === socket.id || game.player2.id === socket.id) {
        const opponentId = game.player1.id === socket.id ? game.player2.id : game.player1.id;

        // Update session scores for disconnect forfeit
        const key = pairKey(game.player1.id, game.player2.id);
        const sc = sessionScores.get(key) ?? { [game.player1.id]: 0, [game.player2.id]: 0 };
        sc[opponentId] = (sc[opponentId] ?? 0) + 1;
        sessionScores.set(key, sc);

        io.to(gameId).emit('game_over', {
          winner: opponentId === game.player1.id ? 'X' : 'O',
          winnerId: opponentId,
          line: [],
          forfeit: true,
          opponentLeft: true,
          player1: game.player1,
          player2: game.player2,
          scores: { p1: sc[game.player1.id] ?? 0, p2: sc[game.player2.id] ?? 0 },
        });
        const op = players.get(opponentId);
        if (op) { op.status = 'online'; players.set(opponentId, op); }
        games.delete(gameId);
      }
    }

    // Cancel any pending challenges they sent
    for (const [targetId, challenge] of pendingChallenges.entries()) {
      if (challenge.challengerId === socket.id) {
        pendingChallenges.delete(targetId);
        io.to(targetId).emit('challenge_cancelled');
      }
    }
    // Cancel any pending challenges against them
    pendingChallenges.delete(socket.id);

    // Clean up any pending rematch requests involving this player
    for (const [key] of pendingRematches.entries()) {
      if (key.includes(socket.id)) {
        pendingRematches.delete(key);
      }
    }

    players.delete(socket.id);
    broadcastLobby();
  });
});

const localIP = getLocalIP();
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     🎮  Local TicTacToe Server Running!       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Local:    http://localhost:${PORT}             ║`);
  console.log(`║  Network:  http://${localIP}:${PORT}       ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  Share the Network URL with your friend!    ║');
  console.log('║  Both must be on the same WiFi/Hotspot.     ║');
  console.log('╚══════════════════════════════════════════════╝\n');
});
