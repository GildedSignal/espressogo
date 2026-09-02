import { SIZE, at, emptyBoard, tryMove } from './game.js';
import { CourtyardAudio } from './audio.js';
import { attachEngines } from './engines.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'];
const PLACEMENT_VARIATION_ENABLED = true;
const AUTOPLAY_MOVE_DELAY_MS = 620;
// Measured from the actual raster slab: the hand-made grid is not perfectly
// uniform, so interaction positions follow its detected lines exactly.
const GRID_X = [0, 12.544, 25.088, 37.632, 50.176, 62.720, 75.264, 87.573, 100];
const GRID_Y = [0, 12.398, 24.795, 37.544, 49.942, 62.222, 74.854, 87.368, 100];
const otherColor = (color) => (color === 'black' ? 'white' : 'black');

const boardElement = document.querySelector('#board');
const turnStatus = document.querySelector('#turn-status');
const thinking = document.querySelector('#thinking');
const passButton = document.querySelector('#pass');
const resignButton = document.querySelector('#resign');
const soundButton = document.querySelector('#sound-toggle');
const soundMix = document.querySelector('#sound-mix');
const blackCaptures = document.querySelector('#black-captures');
const whiteCaptures = document.querySelector('#white-captures');
const colorButtons = [...document.querySelectorAll('[data-color]')];
const choiceStones = [...document.querySelectorAll('.choice-stone')];
const opponentTrigger = document.querySelector('#opponent-trigger');
const opponentList = document.querySelector('#opponent-list');
const autoplayControls = document.querySelector('#autoplay-controls');
const engineSeats = [...document.querySelectorAll('.engine-seat')];
const engineList = document.querySelector('#engine-list');
const engineNote = document.querySelector('#engine-note');
const howToPlay = document.querySelector('#how-to-play');
const audio = new CourtyardAudio();

let board = emptyBoard();
let turn = 'black';
let playerColor = 'black';
let captures = { black: 0, white: 0 };
let passes = 0;
let koMove = -1;
let moveHistory = [];
let finished = false;
let focusedIndex = at(4, 4);
let hoveredIndex = null;
const opponents = new Map([['espresso', { label: 'Espresso', adapter: null }]]);
const selectedOpponents = { black: 'espresso', white: 'espresso' };
let waitingForOpponent = false;
let selfPlay = false;
let autoplay = false;
let placedStoneDetails = new Map();
let placementSerial = 0;
let gameRevision = 0;
let pendingOpponentTimer = null;

function normalSample() {
  const a = Math.max(Number.MIN_VALUE, Math.random());
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * Math.random());
}

function limitedNormal(standardDeviation, limit) {
  return Math.max(-limit, Math.min(limit, normalSample() * standardDeviation));
}

function makeStoneDetails() {
  if (!PLACEMENT_VARIATION_ENABLED) {
    return { placementId: ++placementSerial, x: 0, y: 0, rotation: 0, scale: 1, brightness: 1, contrast: 1, warmth: 0, impact: 1 };
  }
  return {
    placementId: ++placementSerial,
    x: limitedNormal(0.78, 1.65),
    y: limitedNormal(0.78, 1.65),
    rotation: limitedNormal(2.4, 5),
    scale: 1 + limitedNormal(0.028, 0.06),
    brightness: 1 + limitedNormal(0.035, 0.07),
    contrast: 1 + limitedNormal(0.03, 0.06),
    warmth: Math.max(0, limitedNormal(0.025, 0.06)),
    impact: 1 + limitedNormal(0.055, 0.11),
  };
}

function applyStoneDetails(stoneElement, details) {
  stoneElement.style.setProperty('--stone-x', `${details.x.toFixed(2)}px`);
  stoneElement.style.setProperty('--stone-y', `${details.y.toFixed(2)}px`);
  stoneElement.style.setProperty('--stone-rotation', `${details.rotation.toFixed(2)}deg`);
  stoneElement.style.setProperty('--stone-scale', details.scale.toFixed(3));
  stoneElement.style.setProperty('--stone-brightness', details.brightness.toFixed(3));
  stoneElement.style.setProperty('--stone-contrast', details.contrast.toFixed(3));
  stoneElement.style.setProperty('--stone-warmth', details.warmth.toFixed(3));
}

function coordinate(index) {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  return `${LETTERS[col]}${SIZE - row}`;
}

function isPlayerTurn() {
  return !finished && !waitingForOpponent && controllerFor(turn) === 'human';
}

function controllerFor(color) {
  if (selfPlay) return 'human';
  if (autoplay) return selectedOpponents[color];
  return color === playerColor ? 'human' : selectedOpponents[color];
}

function opponentLabel(id) {
  const opponent = opponents.get(id);
  return opponent?.adapter?.displayLabel || opponent?.label || 'AI';
}

function announce(message) {
  turnStatus.textContent = message;
}

function currentTurnLabel() {
  return `${turn[0].toUpperCase()}${turn.slice(1)} to play.`;
}

function pendingMessage() {
  return `${currentTurnLabel()} Waiting for ${opponentLabel(controllerFor(turn))}.`;
}

function renderCoordinates() {
  const top = document.querySelector('.coordinates-top');
  const left = document.querySelector('.coordinates-left');
  if (top) top.replaceChildren(...LETTERS.map((letter) => {
    const label = document.createElement('span'); label.textContent = letter; return label;
  }));
  if (left) left.replaceChildren(...Array.from({ length: SIZE }, (_, row) => {
    const label = document.createElement('span'); label.textContent = String(SIZE - row); return label;
  }));
}

function cellLabel(index) {
  const stone = board[index];
  const availability = !stone && isPlayerTurn() ? 'empty; press Enter to place a stone' : stone ? `${stone} stone` : 'empty';
  return `${coordinate(index)}, ${availability}`;
}

function renderBoard() {
  const cells = [];
  for (let index = 0; index < SIZE * SIZE; index += 1) {
    const cell = document.createElement('button');
    const stone = board[index];
    const row = Math.floor(index / SIZE);
    const col = index % SIZE;
    cell.type = 'button';
    cell.className = 'intersection';
    cell.dataset.index = String(index);
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    cell.style.setProperty('--x', `${GRID_X[col]}%`);
    cell.style.setProperty('--y', `${GRID_Y[row]}%`);
    cell.tabIndex = index === focusedIndex ? 0 : -1;
    cell.setAttribute('aria-label', cellLabel(index));
    cell.setAttribute('aria-disabled', String(!isPlayerTurn() || Boolean(stone)));
    if (stone) {
      const stoneElement = document.createElement('span');
      stoneElement.className = `stone ${stone}`;
      const details = placedStoneDetails.get(index) || makeStoneDetails();
      placedStoneDetails.set(index, details);
      applyStoneDetails(stoneElement, details);
      stoneElement.setAttribute('aria-hidden', 'true');
      cell.append(stoneElement);
    } else if (index === hoveredIndex && isPlayerTurn()) {
      const ghost = document.createElement('span');
      ghost.className = `stone ghost ${turn}`;
      ghost.setAttribute('aria-hidden', 'true');
      cell.append(ghost);
    }
    cells.push(cell);
  }
  boardElement.replaceChildren(...cells);
  boardElement.setAttribute('aria-disabled', String(!isPlayerTurn()));
}

function render() {
  renderBoard();
  blackCaptures.textContent = String(captures.black);
  whiteCaptures.textContent = String(captures.white);
  colorButtons.forEach((button) => {
    const selected = button.dataset.color === playerColor;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  passButton.disabled = !isPlayerTurn();
  resignButton.disabled = finished || waitingForOpponent;
  soundButton.setAttribute('aria-pressed', String(audio.enabled));
  soundButton.setAttribute('aria-label', audio.enabled ? 'Disable sound' : 'Enable sound');
  soundButton.textContent = audio.enabled ? 'Sound on' : 'Sound off';
  soundMix.hidden = !audio.enabled;
  autoplayControls.hidden = !autoplay;
  engineSeats.forEach((seat) => {
    const color = seat.dataset.seat;
    seat.childNodes[0].textContent = `${color[0].toUpperCase()}${color.slice(1)} · ${opponentLabel(selectedOpponents[color])} `;
  });
  if (engineNote) {
    const unavailable = ['black', 'white'].filter((color) => !opponents.get(selectedOpponents[color])?.adapter);
    engineNote.textContent = unavailable.length ? 'Attach an engine to begin autoplay.' : 'Autoplay is running.';
  }
  syncSoundControls();
}

function syncSoundControls() {
  const settings = audio.getSettings();
  const controls = {
    master: settings.masterVolume,
    stones: (settings.actionVolumes['place-black'] + settings.actionVolumes['place-white']) / 2,
    ambience: settings.actionVolumes.ambience,
  };
  soundMix?.querySelectorAll('input[data-volume]').forEach((input) => {
    input.value = String(controls[input.dataset.volume]);
  });
}

function reset({ color = playerColor } = {}) {
  gameRevision += 1;
  if (pendingOpponentTimer !== null) window.clearTimeout(pendingOpponentTimer);
  pendingOpponentTimer = null;
  board = emptyBoard();
  turn = 'black';
  playerColor = color;
  captures = { black: 0, white: 0 };
  passes = 0;
  koMove = -1;
  moveHistory = [];
  finished = false;
  waitingForOpponent = false;
  hoveredIndex = null;
  focusedIndex = at(4, 4);
  placedStoneDetails = new Map();
  placementSerial = 0;
  thinking.hidden = true;
  announce(isPlayerTurn() ? currentTurnLabel() : pendingMessage());
  render();
  requestOpponentMove();
}

function finish(message) {
  gameRevision += 1;
  if (pendingOpponentTimer !== null) window.clearTimeout(pendingOpponentTimer);
  pendingOpponentTimer = null;
  finished = true;
  waitingForOpponent = false;
  hoveredIndex = null;
  thinking.hidden = true;
  announce(message);
  render();
}

function applyMove(index, color, { distant = false } = {}) {
  if (finished || color !== turn || !Number.isInteger(index) || index < 0 || index >= SIZE * SIZE) return false;
  const result = tryMove(board, index, color, { koMove });
  if (!result.legal) return false;
  board = result.board;
  const placement = makeStoneDetails();
  placedStoneDetails.set(index, placement);
  result.captured.forEach((captured) => placedStoneDetails.delete(captured));
  captures[color] += result.captured.length;
  passes = 0;
  koMove = result.koMove;
  moveHistory.push(index);
  hoveredIndex = null;
  if (!distant) {
    audio.place({ color, row: Math.floor(index / SIZE), col: index % SIZE, distant, impact: placement.impact });
    if (result.captured.length) audio.capture(result.captured.length);
  }
  turn = otherColor(color);
  announce(currentTurnLabel());
  render();
  requestOpponentMove();
  return true;
}

function applyPass(color) {
  if (finished || color !== turn) return false;
  passes += 1;
  koMove = -1;
  moveHistory.push(SIZE * SIZE);
  if (passes >= 2) {
    finish('Two consecutive passes. The game is finished.');
    return true;
  }
  turn = otherColor(color);
  announce(`${color[0].toUpperCase()}${color.slice(1)} passed. ${currentTurnLabel()}`);
  render();
  requestOpponentMove();
  return true;
}

/**
 * Attach an actual opponent later with either { requestMove(state) } or a
 * function accepting state. It may resolve to an intersection index, an object
 * like { index: 42 }, or { pass: true }. The default is deliberately inert.
 */
function requestOpponentMove() {
  const opponentId = controllerFor(turn);
  if (finished || opponentId === 'human' || waitingForOpponent) return;
  const selected = opponents.get(opponentId);
  const adapter = selected?.adapter;
  const requestMove = typeof adapter === 'function' ? adapter : adapter?.requestMove;
  if (typeof requestMove !== 'function') {
    thinking.hidden = true;
    announce(pendingMessage());
    render();
    return;
  }
  waitingForOpponent = true;
  thinking.hidden = false;
  announce(`${currentTurnLabel()} ${opponentLabel(opponentId)} is thinking…`);
  render();
  const revision = gameRevision;
  const runRequest = () => {
    pendingOpponentTimer = null;
    if (revision !== gameRevision || finished || controllerFor(turn) !== opponentId) return;
    const state = getState();
    Promise.resolve(requestMove(state)).then((move) => {
      if (revision !== gameRevision || finished || controllerFor(turn) !== opponentId) return;
      waitingForOpponent = false;
      thinking.hidden = true;
      if (move?.pass) applyPass(turn);
      else if (!applyMove(Number.isInteger(move) ? move : move?.index, turn, { distant: true })) {
        announce(`${currentTurnLabel()} ${opponentLabel(opponentId)} returned no legal move.`);
        render();
      }
    }).catch(() => {
      if (revision !== gameRevision) return;
      waitingForOpponent = false;
      thinking.hidden = true;
      announce(`${currentTurnLabel()} ${opponentLabel(opponentId)} is unavailable.`);
      render();
    });
  };
  // Autoplay remains interruptible: one move at a time with enough air to
  // read the game, rather than a worker-to-worker waterfall.
  if (autoplay) pendingOpponentTimer = window.setTimeout(runRequest, AUTOPLAY_MOVE_DELAY_MS);
  else runRequest();
}

function getState() {
  return Object.freeze({
    board: [...board], turn, playerColor, captures: { ...captures }, passes, koMove, moveHistory: [...moveHistory], finished, autoplay,
    size: SIZE,
  });
}

function isLegalPlayerMove(index) {
  return isPlayerTurn() && board[index] === null && tryMove(board, index, playerColor, { koMove }).legal;
}

function chooseIndexFromPointer(event) {
  const box = boardElement.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const x = ((event.clientX - box.left) / box.width) * 100;
  const y = ((event.clientY - box.top) / box.height) * 100;
  const nearestIndex = (points, value) => points.reduce((best, point, index) => (
    Math.abs(point - value) < Math.abs(points[best] - value) ? index : best
  ), 0);
  const col = nearestIndex(GRID_X, x);
  const row = nearestIndex(GRID_Y, y);
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return null;
  return at(row, col);
}

function setFocus(index) {
  focusedIndex = index;
  render();
  boardElement.querySelector(`[data-index="${index}"]`)?.focus();
}

function tryPlayerMove(index) {
  if (!isPlayerTurn()) return;
  const movingColor = turn;
  if (!applyMove(index, movingColor)) {
    announce(`${coordinate(index)} is not a legal move.`);
  }
}

boardElement.addEventListener('pointermove', (event) => {
  const index = chooseIndexFromPointer(event);
  if (index === hoveredIndex) return;
  hoveredIndex = index !== null && isLegalPlayerMove(index) ? index : null;
  renderBoard();
});
boardElement.addEventListener('pointerleave', () => {
  if (hoveredIndex === null) return;
  hoveredIndex = null;
  renderBoard();
});
boardElement.addEventListener('click', (event) => {
  const index = chooseIndexFromPointer(event);
  if (Number.isInteger(index)) tryPlayerMove(index);
});
boardElement.addEventListener('keydown', (event) => {
  const origin = Number(event.target.closest('[data-index]')?.dataset.index);
  if (!Number.isInteger(origin)) return;
  const row = Math.floor(origin / SIZE), col = origin % SIZE;
  const delta = { ArrowUp: -SIZE, ArrowDown: SIZE, ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (delta !== undefined) {
    event.preventDefault();
    const nextRow = row + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0);
    const nextCol = col + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0);
    if (nextRow >= 0 && nextRow < SIZE && nextCol >= 0 && nextCol < SIZE) setFocus(origin + delta);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    tryPlayerMove(origin);
  }
});

passButton.addEventListener('click', () => {
  if (isPlayerTurn() && applyPass(turn)) audio.pass();
});
resignButton.addEventListener('click', () => {
  if (finished || waitingForOpponent) return;
  audio.resign();
  finish(`${playerColor[0].toUpperCase()}${playerColor.slice(1)} resigned.`);
  window.setTimeout(() => {
    audio.cleanBoard();
    reset({ color: playerColor });
  }, 280);
});
colorButtons.forEach((button) => button.addEventListener('click', () => reset({ color: button.dataset.color })));
soundButton.addEventListener('click', async () => { await audio.setEnabled(!audio.enabled); render(); });
soundMix?.addEventListener('input', (event) => {
  const input = event.target.closest('input[data-volume]');
  if (!input) return;
  if (input.dataset.volume === 'master') audio.setMasterVolume(input.value);
  if (input.dataset.volume === 'stones') {
    audio.setActionVolume('place-black', input.value);
    audio.setActionVolume('place-white', input.value);
  }
  if (input.dataset.volume === 'ambience') audio.setActionVolume('ambience', input.value);
});

opponentTrigger?.addEventListener('click', () => {
  const open = opponentList.hidden;
  opponentList.hidden = !open;
  opponentTrigger.setAttribute('aria-expanded', String(open));
});
opponentList?.addEventListener('click', (event) => {
  const option = event.target.closest('button[data-opponent]');
  if (!option) return;
  selfPlay = option.dataset.opponent === 'yourself';
  autoplay = option.dataset.opponent === 'autoplay';
  if (!selfPlay && !autoplay) {
    selectedOpponents.black = option.dataset.opponent;
    selectedOpponents.white = option.dataset.opponent;
  }
  opponentTrigger.childNodes[0].textContent = `${option.textContent} `;
  opponentList.hidden = true;
  opponentTrigger.setAttribute('aria-expanded', 'false');
  reset();
});

function closeEngineList() {
  engineList.hidden = true;
  engineSeats.forEach((seat) => seat.setAttribute('aria-expanded', 'false'));
}

function showEngineList(seat) {
  const seatColor = seat.dataset.seat;
  engineList.replaceChildren(...[...opponents].map(([id, entry]) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.role = 'menuitem';
    option.dataset.engine = id;
    option.dataset.seat = seatColor;
    option.textContent = entry.label;
    return option;
  }));
  engineList.hidden = false;
  engineSeats.forEach((button) => button.setAttribute('aria-expanded', String(button === seat)));
}

engineSeats.forEach((seat) => seat.addEventListener('click', () => {
  if (engineList.hidden || engineList.dataset.seat !== seat.dataset.seat) {
    engineList.dataset.seat = seat.dataset.seat;
    showEngineList(seat);
  } else closeEngineList();
}));

engineList?.addEventListener('click', (event) => {
  const option = event.target.closest('button[data-engine]');
  if (!option) return;
  selectedOpponents[option.dataset.seat] = option.dataset.engine;
  closeEngineList();
  reset();
});

document.querySelector('a[href="#how-to-play"]')?.addEventListener('click', (event) => {
  event.preventDefault();
  howToPlay?.showModal();
});
howToPlay?.querySelector('.dialog-close')?.addEventListener('click', () => howToPlay.close());

window.EspressoGame = Object.freeze({
  getState,
  play: (index) => applyMove(index, turn, { distant: turn !== playerColor }),
  pass: () => applyPass(turn),
  resign: () => finish(`${turn[0].toUpperCase()}${turn.slice(1)} resigned.`),
  reset,
  setOpponent(adapter) { opponents.get('espresso').adapter = adapter; requestOpponentMove(); },
  registerOpponent(id, { label = id, adapter } = {}) {
    if (!id || typeof id !== 'string') throw new TypeError('An opponent id is required.');
    opponents.set(id, { label, adapter });
    render();
  },
});

renderCoordinates();
choiceStones.forEach((stone) => {
  applyStoneDetails(stone, makeStoneDetails());
});
// Native buttons provide the most dependable keyboard and screen-reader model;
// this is intentionally a labelled control group rather than an ARIA grid.
boardElement.setAttribute('role', 'group');
reset();
attachEngines(window.EspressoGame).catch((error) => {
  console.warn(error);
});
