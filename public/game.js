/* ─── game.js ─── Local TicTacToe Client ─── */

const socketUrl = (window.APP_CONFIG && window.APP_CONFIG.socketUrl) || window.location.origin;
const socket = io(socketUrl, { transports: ['websocket', 'polling'] });

// ── State
let me = null;             // { id, name, avatar, status }
let currentGame = null;    // { id, player1, player2, board, turn }
let mySymbol = null;       // 'X' or 'O'
let pendingRematchInfo = null;  // { opponentId }
let chToast_targetId = null;    // for cancel challenge

// ── DOM helpers
const $ = id => document.getElementById(id);
const screens = {
  setup: $('screen-setup'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
};

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle('active', k === name);
  });
}

// ── Toast notifications
function showToast(msg, type = 'info', duration = 3500) {
  const container = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 350);
  }, duration);
}

// ── Avatar helpers
function initials(name) {
  return name ? name.trim()[0].toUpperCase() : '?';
}

function makeAvatarEl(color, name, size = 48) {
  const div = document.createElement('div');
  div.className = 'avatar-circle';
  div.style.cssText = `
    width:${size}px; height:${size}px; border-radius:50%;
    background:${color};
    display:flex; align-items:center; justify-content:center;
    font-size:${Math.round(size * 0.44)}px; font-weight:800; color:#fff;
    box-shadow: 0 0 14px ${color}55;
    flex-shrink:0;
  `;
  div.textContent = initials(name);
  return div;
}

// ── Setup Screen
const avatarBtns = document.querySelectorAll('.avatar-btn');
let selectedColor = '#6c63ff';

avatarBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    avatarBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedColor = btn.dataset.color;
  });
});

$('btn-join').addEventListener('click', () => {
  const nameInput = $('player-name');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    nameInput.style.borderColor = '#ff6584';
    nameInput.style.boxShadow = '0 0 0 3px rgba(255,101,132,0.25)';
    setTimeout(() => {
      nameInput.style.borderColor = '';
      nameInput.style.boxShadow = '';
    }, 1200);
    showToast('Please enter your name!', 'error', 2500);
    return;
  }
  socket.emit('join', { name, avatar: selectedColor });
});

$('player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-join').click();
});

// ── Server: joined
socket.on('joined', (player) => {
  me = player;
  renderMyProfile();
  showScreen('lobby');
});

function renderMyProfile() {
  const container = $('my-profile');
  container.innerHTML = '';
  const av = makeAvatarEl(me.avatar, me.name, 46);
  const info = document.createElement('div');
  info.className = 'profile-info';
  info.innerHTML = `
    <span class="profile-name">${escHtml(me.name)}</span>
    <span class="profile-label">You · Online</span>
  `;
  container.appendChild(av);
  container.appendChild(info);
}

// ── Lobby Update
socket.on('lobby_update', (players) => {
  const others = players.filter(p => p.id !== me?.id);
  $('online-count').textContent = `${players.length} online`;

  const list = $('player-list');
  list.innerHTML = '';

  if (others.length === 0) {
    list.innerHTML = `
      <div class="empty-lobby">
        <div class="empty-icon">👥</div>
        <p>Waiting for others to join…</p>
        <span>Share the server URL with your friend!</span>
      </div>`;
    return;
  }

  others.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.id = `player-card-${p.id}`;
    card.style.animationDelay = `${idx * 0.05}s`;

    const statusText = p.status === 'online' ? 'Online' :
                        p.status === 'in-game' ? 'In a game' : 'Challenging…';
    const statusClass = p.status === 'online' ? 'status-online' :
                        p.status === 'in-game' ? 'status-ingame' : 'status-challenging';

    const av = document.createElement('div');
    av.className = 'card-avatar';
    av.style.cssText = `background:${p.avatar}; box-shadow:0 0 12px ${p.avatar}55;`;
    av.textContent = initials(p.name);

    const info = document.createElement('div');
    info.className = 'card-info';
    info.innerHTML = `
      <div class="card-name">${escHtml(p.name)}</div>
      <div class="card-status ${statusClass}">${statusText}</div>
    `;

    const btn = document.createElement('button');
    btn.className = 'btn-challenge';
    btn.innerHTML = '<i class="ph-bold ph-swords"></i> Challenge';
    btn.disabled = p.status !== 'online';
    btn.addEventListener('click', () => sendChallenge(p.id, p.name));

    card.appendChild(av);
    card.appendChild(info);
    card.appendChild(btn);
    list.appendChild(card);
  });
});

// ── Send Challenge
function sendChallenge(targetId, targetName) {
  chToast_targetId = targetId;
  socket.emit('challenge', { targetId });
  showChallengeToast(`Challenge sent to ${targetName}…`, targetId);
}

function showChallengeToast(msg, targetId) {
  const toast = $('challenge-toast');
  $('challenge-toast-msg').textContent = msg;
  toast.style.display = 'flex';
  chToast_targetId = targetId;
}

function hideChallengeToast() {
  $('challenge-toast').style.display = 'none';
  chToast_targetId = null;
}

$('btn-cancel-challenge').addEventListener('click', () => {
  if (chToast_targetId) {
    socket.emit('cancel_challenge', { targetId: chToast_targetId });
    hideChallengeToast();
  }
});

socket.on('challenge_sent', ({ targetName }) => {
  // toast already shown
});

socket.on('challenge_failed', ({ reason }) => {
  showToast(reason, 'error');
  hideChallengeToast();
});

socket.on('challenge_cancelled', () => {
  hideIncomingModal();
});

// ── Incoming Challenge
let incomingChallengeData = null;

socket.on('incoming_challenge', ({ challengerId, challengerName, challengerAvatar, gameId }) => {
  incomingChallengeData = { challengerId, gameId };
  const avatarEl = $('modal-challenger-avatar');
  avatarEl.style.cssText = `
    background:${challengerAvatar};
    box-shadow: 0 0 24px ${challengerAvatar}66;
  `;
  avatarEl.textContent = initials(challengerName);
  $('modal-challenger-name').textContent = challengerName;
  $('modal-challenge').style.display = 'flex';
});

function hideIncomingModal() {
  $('modal-challenge').style.display = 'none';
  incomingChallengeData = null;
}

$('btn-accept').addEventListener('click', () => {
  if (!incomingChallengeData) return;
  socket.emit('challenge_response', {
    accept: true,
    gameId: incomingChallengeData.gameId,
    challengerId: incomingChallengeData.challengerId,
  });
  hideIncomingModal();
  hideChallengeToast();
});

$('btn-decline').addEventListener('click', () => {
  if (!incomingChallengeData) return;
  socket.emit('challenge_response', {
    accept: false,
    gameId: incomingChallengeData.gameId,
    challengerId: incomingChallengeData.challengerId,
  });
  hideIncomingModal();
});

socket.on('challenge_declined', ({ byName }) => {
  hideChallengeToast();
  showToast(`${byName} declined your challenge.`, 'error');
});

// ── Game Start
socket.on('game_start', (game) => {
  currentGame = game;
  hideChallengeToast();
  hideIncomingModal();
  hideRematchBanner();
  $('modal-gameover').style.display = 'none';
  $('rematch-waiting').style.display = 'none';
  // Reset rematch button
  $('btn-rematch').disabled = false;
  $('btn-rematch').innerHTML = '<i class="ph-bold ph-arrows-clockwise"></i> Rematch';

  mySymbol = game.player1.id === me.id ? 'X' : 'O';

  // Set up player info
  setPlayerChip('game-p1-avatar', 'game-p1-name', game.player1);
  setPlayerChip('game-p2-avatar', 'game-p2-name', game.player2);

  // Show scores from server (0–0 for new match, carried over for rematches)
  const sc = game.scores ?? { p1: 0, p2: 0 };
  $('score-p1').textContent = sc.p1;
  $('score-p2').textContent = sc.p2;

  renderBoard(game.board);
  updateTurnUI(game.turn);

  showScreen('game');
});


function setPlayerChip(avatarId, nameId, player) {
  const av = $(avatarId);
  av.style.cssText = `background:${player.avatar}; box-shadow:0 0 12px ${player.avatar}55;`;
  av.textContent = initials(player.name);
  $(nameId).textContent = player.name;
}

// ── Game Update
socket.on('game_update', ({ board, turn }) => {
  currentGame.board = board;
  currentGame.turn = turn;
  renderBoard(board);
  updateTurnUI(turn);
});

// ── Board Rendering
function renderBoard(board) {
  const cells = document.querySelectorAll('#game-board .cell');
  cells.forEach((cell, i) => {
    // Don't re-render existing marks (avoid animation re-trigger)
    if (cell.dataset.filled === board[i]) return;
    cell.innerHTML = '';
    cell.classList.remove('taken', 'disabled', 'winner-cell');
    cell.dataset.filled = board[i] || '';

    if (board[i]) {
      const mark = document.createElement('span');
      mark.className = `mark ${board[i] === 'X' ? 'x-mark' : 'o-mark'}`;
      mark.textContent = board[i];
      cell.appendChild(mark);
      cell.classList.add('taken');
    }
  });
}

function clearBoard() {
  const cells = document.querySelectorAll('#game-board .cell');
  cells.forEach(cell => {
    cell.innerHTML = '';
    cell.classList.remove('taken', 'disabled', 'winner-cell');
    cell.dataset.filled = '';
  });
  clearWinLine();
}

function updateTurnUI(turn) {
  const isMyTurn = turn === me?.id;
  const indicator = $('turn-indicator');
  const p1Info = $('game-p1-info');
  const p2Info = $('game-p2-info');

  if (!turn) {
    indicator.innerHTML = '<i class="ph-bold ph-flag-checkered"></i> Game Over';
    indicator.className = 'turn-indicator waiting';
    p1Info.classList.remove('active-turn');
    p2Info.classList.remove('active-turn');
    return;
  }

  if (isMyTurn) {
    indicator.innerHTML = '<i class="ph-fill ph-sparkle"></i> Your Turn';
    indicator.className = 'turn-indicator';
  } else {
    indicator.innerHTML = '<i class="ph-bold ph-hourglass"></i> Opponent\'s Turn';
    indicator.className = 'turn-indicator waiting';
  }

  const isP1Turn = turn === currentGame?.player1?.id;
  p1Info.classList.toggle('active-turn', isP1Turn);
  p2Info.classList.toggle('active-turn', !isP1Turn);

  // Enable/disable cells
  const cells = document.querySelectorAll('#game-board .cell');
  cells.forEach(cell => {
    cell.classList.toggle('disabled', !isMyTurn);
  });
}

// ── Cell click
document.querySelectorAll('#game-board .cell').forEach(cell => {
  cell.addEventListener('click', () => {
    if (!currentGame) return;
    if (currentGame.turn !== me?.id) return;
    if (cell.classList.contains('taken')) return;
    if (cell.classList.contains('disabled')) return;
    if (!mySymbol) return;

    const index = parseInt(cell.dataset.index);
    // Optimistic UI: render immediately, then confirm via server update
    currentGame.board[index] = mySymbol;
    currentGame.turn = currentGame.player1.id === me.id ? currentGame.player2.id : currentGame.player1.id;
    renderBoard(currentGame.board);
    updateTurnUI(currentGame.turn);
    socket.emit('make_move', { gameId: currentGame.id, index });
  });
});

// ── Game Over
socket.on('game_over', ({ winner, winnerId, line, forfeit, opponentLeft, player1, player2, scores }) => {
  updateTurnUI(null);

  // Highlight winning cells
  if (line && line.length > 0) {
    const cells = document.querySelectorAll('#game-board .cell');
    line.forEach(idx => cells[idx].classList.add('winner-cell'));
    drawWinLine(line);
  }

  // Update scores from server
  const sc = scores ?? { p1: 0, p2: 0 };
  $('score-p1').textContent = sc.p1;
  $('score-p2').textContent = sc.p2;

  // Build modal content
  let icon, title, subtitle;
  const amWinner = winnerId === me?.id;
  const winnerName = winnerId === player1.id ? player1.name : player2.name;

  if (winner === 'draw') {
    icon = '<i class="ph-fill ph-handshake"></i>'; title = "It's a Draw!"; subtitle = 'Neither of you could outwit the other.';
  } else if (forfeit) {
    if (amWinner) {
      icon = '<i class="ph-fill ph-trophy"></i>'; title = 'You Win!';
      subtitle = opponentLeft ? 'Your opponent left the game.' : 'Your opponent resigned.';
    } else {
      icon = '<i class="ph-fill ph-heart-break"></i>'; title = 'You Resigned';
      subtitle = `${winnerName} wins this round.`;
    }
  } else if (amWinner) {
    icon = '<i class="ph-fill ph-trophy"></i>'; title = 'You Win!'; subtitle = 'Outstanding play!';
  } else {
    icon = '<i class="ph-fill ph-smiley-sad"></i>'; title = 'You Lost'; subtitle = `${winnerName} wins this round.`;
  }

  $('gameover-icon').innerHTML = icon;
  $('gameover-title').textContent = title;
  $('gameover-subtitle').textContent = subtitle;
  $('rematch-waiting').style.display = 'none';
  // Always reset rematch button to default state
  $('btn-rematch').disabled = false;
  $('btn-rematch').innerHTML = '<i class="ph-bold ph-arrows-clockwise"></i> Rematch';
  $('modal-gameover').style.display = 'flex';

  // Store rematch info
  pendingRematchInfo = {
    opponentId: me?.id === player1.id ? player2.id : player1.id,
    gameId: currentGame?.id,
  };
});

// ── Win Line Drawing
const WIN_LINE_COORDS = {
  // rows
  '0,1,2': { x1:0.5/3, y1:0.5/3, x2:2.5/3, y2:0.5/3 },
  '3,4,5': { x1:0.5/3, y1:1.5/3, x2:2.5/3, y2:1.5/3 },
  '6,7,8': { x1:0.5/3, y1:2.5/3, x2:2.5/3, y2:2.5/3 },
  // cols
  '0,3,6': { x1:0.5/3, y1:0.5/3, x2:0.5/3, y2:2.5/3 },
  '1,4,7': { x1:1.5/3, y1:0.5/3, x2:1.5/3, y2:2.5/3 },
  '2,5,8': { x1:2.5/3, y1:0.5/3, x2:2.5/3, y2:2.5/3 },
  // diagonals
  '0,4,8': { x1:0.5/3, y1:0.5/3, x2:2.5/3, y2:2.5/3 },
  '2,4,6': { x1:2.5/3, y1:0.5/3, x2:0.5/3, y2:2.5/3 },
};

function drawWinLine(line) {
  const key = line.slice().sort((a,b)=>a-b).join(',');
  const coords = WIN_LINE_COORDS[key];
  if (!coords) return;

  const svg = $('win-line-svg');
  const lineEl = $('win-line');
  // Convert [0..1] to viewBox [0..3]
  lineEl.setAttribute('x1', coords.x1 * 3);
  lineEl.setAttribute('y1', coords.y1 * 3);
  lineEl.setAttribute('x2', coords.x2 * 3);
  lineEl.setAttribute('y2', coords.y2 * 3);

  const len = Math.hypot(
    (coords.x2 - coords.x1) * 3,
    (coords.y2 - coords.y1) * 3
  );
  lineEl.setAttribute('stroke-dasharray', len);
  lineEl.setAttribute('stroke-dashoffset', len);
  // Trigger animation
  requestAnimationFrame(() => {
    lineEl.setAttribute('stroke-dashoffset', 0);
    lineEl.style.transition = 'stroke-dashoffset 0.5s ease';
  });
}

function clearWinLine() {
  const lineEl = $('win-line');
  lineEl.setAttribute('stroke-dasharray', '0');
  lineEl.setAttribute('stroke-dashoffset', '0');
  lineEl.style.transition = 'none';
}

// ── Forfeit
$('btn-forfeit').addEventListener('click', () => {
  if (!currentGame) return;
  if (confirm('Are you sure you want to resign?')) {
    socket.emit('forfeit', { gameId: currentGame.id });
  }
});

// ── Game Over Modal: Buttons
$('btn-lobby').addEventListener('click', () => {
  $('modal-gameover').style.display = 'none';
  currentGame = null;
  clearBoard();
  showScreen('lobby');
});

$('btn-rematch').addEventListener('click', () => {
  if (!pendingRematchInfo) return;
  // Disable the button after clicking to prevent duplicate requests
  $('btn-rematch').disabled = true;
  $('btn-rematch').innerHTML = '<i class="ph-bold ph-hourglass-high"></i> Waiting…';
  socket.emit('request_rematch', {
    gameId: pendingRematchInfo.gameId,
    opponentId: pendingRematchInfo.opponentId,
  });
});

// Server confirmed our rematch request was received
socket.on('rematch_requested', () => {
  $('rematch-waiting').style.display = 'flex';
});

// Opponent clicked Rematch — show small accept banner (not a full modal)
socket.on('rematch_request', ({ from, fromName }) => {
  showRematchBanner(from, fromName);
});

function showRematchBanner(fromId, fromName) {
  const banner = $('rematch-banner');
  $('rematch-banner-msg').textContent = `${fromName} wants a rematch!`;
  banner.style.display = 'flex';

  // Wire accept
  $('rematch-banner-accept').onclick = () => {
    hideRematchBanner();
    socket.emit('rematch_response', {
      accept: true,
      opponentId: fromId,
      originalGameId: currentGame?.id,
    });
    clearBoard();
  };

  // Wire decline
  $('rematch-banner-decline').onclick = () => {
    hideRematchBanner();
    socket.emit('rematch_response', {
      accept: false,
      opponentId: fromId,
      originalGameId: currentGame?.id,
    });
  };
}

function hideRematchBanner() {
  $('rematch-banner').style.display = 'none';
}

socket.on('rematch_declined', () => {
  hideRematchBanner();
  showToast('Opponent declined the rematch.', 'error');
  $('rematch-waiting').style.display = 'none';
  // Re-enable rematch button so they can go to lobby
  $('btn-rematch').disabled = false;
  $('btn-rematch').innerHTML = '<i class="ph-bold ph-arrows-clockwise"></i> Rematch';
});

// Rematch restarts game (game_start event handled above)

// ── HTML escape helper
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Connection events
socket.on('connect_error', () => {
  showToast('Cannot connect to server...', 'error', 5000);
});

socket.on('disconnect', () => {
  showToast('Disconnected from server.', 'error', 5000);
});
