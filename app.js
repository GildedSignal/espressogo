import {
  GoModelWorkerClient,
  createGameState,
  encodeStudentFeatures,
  getAreaScore,
  getAutomaticallyDeadMoves,
  isGameOver,
  playMove,
  removeDeadStones,
  selectHighestLegalMove,
} from "./dist/index.js";

const BOARD_SIZE = 9;
const BOARD_AREA = 81;
const PASS_MOVE = 81;
const BLACK = 1;
const WHITE = -1;
const MOVE_CAP = 120;
const COLUMNS = "ABCDEFGHJ";

// Engine knobs from Julien Mac play.html (B), wired here to B dist worker (C glue).
const ENGINES = {
  policy: {
    label: "Moka GitHub",
    backend: "reference",
    ponder: false,
    simulations: 0,
    rootD4: false,
    search: false,
  },
  baseline: {
    label: "Moka web",
    backend: "reference",
    ponder: false,
    simulations: 56,
    rootD4: true,
    search: true,
  },
  improved: {
    label: "Espresso",
    backend: "int8",
    ponder: true,
    simulations: 64,
    rootD4: false,
    search: true,
  },
};

const element = (id) => document.querySelector(`#${id}`);
const setupElement = element("setup");
const passButton = element("pass");
const resignButton = element("resign");
const engineBadge = element("engine-badge");
const statusElement = element("status");
const statsElement = element("stats");
const capturesElement = element("captures");
const evalBlackElement = element("eval-black");
const evalNumElement = element("eval-num");

const moveLabel = (move) =>
  move === PASS_MOVE ? "pass" : `${COLUMNS[move % BOARD_SIZE]}${BOARD_SIZE - Math.floor(move / BOARD_SIZE)}`;
const colorName = (color) => (color === BLACK ? "Black" : "White");

const MARGIN = 34;
const SPACING = (400 - MARGIN * 2) / (BOARD_SIZE - 1);
const STARS = [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]];
const at = (index) => MARGIN + index * SPACING;
const svgNode = (name, attributes) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

const createBoard = (root) => {
  const defs = svgNode("defs", {});
  const stoneGradient = (id, inner, outer, cx, cy) => {
    const gradient = svgNode("radialGradient", { id, cx, cy, r: "0.75" });
    gradient.append(
      svgNode("stop", { offset: "0%", "stop-color": inner }),
      svgNode("stop", { offset: "100%", "stop-color": outer }),
    );
    return gradient;
  };
  const limestone = svgNode("linearGradient", { id: "limestone", x1: "0", y1: "0", x2: "0", y2: "1" });
  limestone.append(
    svgNode("stop", { offset: "0%", "stop-color": "#f6f3ea" }),
    svgNode("stop", { offset: "55%", "stop-color": "#efece3" }),
    svgNode("stop", { offset: "100%", "stop-color": "#e4dfd2" }),
  );
  defs.append(
    limestone,
    stoneGradient("black-s", "#5a6574", "#2c3642", "36%", "30%"),
    stoneGradient("white-s", "#fffaf0", "#e8e0d2", "36%", "30%"),
  );
  const wood = svgNode("rect", { x: 0, y: 0, width: 400, height: 400, rx: 3, fill: "url(#limestone)" });
  const grid = svgNode("g", { stroke: "#4a5560", "stroke-width": 0.95, fill: "none" });
  for (let i = 0; i < BOARD_SIZE; i += 1) {
    grid.append(
      svgNode("line", { x1: at(0), y1: at(i), x2: at(BOARD_SIZE - 1), y2: at(i) }),
      svgNode("line", { x1: at(i), y1: at(0), x2: at(i), y2: at(BOARD_SIZE - 1) }),
    );
  }
  const stars = svgNode("g", { fill: "#4a5560" });
  for (const [r, c] of STARS) stars.append(svgNode("circle", { cx: at(c), cy: at(r), r: 2.2 }));
  const coords = svgNode("g", {});
  for (let i = 0; i < BOARD_SIZE; i += 1) {
    const col = svgNode("text", { x: at(i), y: 18, "text-anchor": "middle", "font-size": 10.5, fill: "#3a3f46" });
    col.textContent = COLUMNS[i];
    const row = svgNode("text", { x: 13, y: at(i) + 3.5, "text-anchor": "middle", "font-size": 10.5, fill: "#3a3f46" });
    row.textContent = String(BOARD_SIZE - i);
    coords.append(col, row);
  }
  const stones = svgNode("g", {});
  root.replaceChildren(defs, wood, grid, stars, coords, stones);
  return (state, lastMove) => {
    const layer = document.createDocumentFragment();
    for (let move = 0; move < BOARD_AREA; move += 1) {
      const color = state.board[move];
      if (color === 0) continue;
      layer.append(
        svgNode("circle", {
          cx: at(move % BOARD_SIZE),
          cy: at(Math.floor(move / BOARD_SIZE)),
          r: SPACING * 0.465,
          fill: color === BLACK ? "url(#black-s)" : "url(#white-s)",
          stroke: color === BLACK ? "#1c222a" : "#c9c2b6",
          "stroke-width": 0.8,
        }),
      );
    }
    if (lastMove !== null && lastMove !== PASS_MOVE && state.board[lastMove] !== 0) {
      layer.append(
        svgNode("circle", {
          cx: at(lastMove % BOARD_SIZE),
          cy: at(Math.floor(lastMove / BOARD_SIZE)),
          r: SPACING * 0.15,
          fill: state.board[lastMove] === BLACK ? "#f6f1e6" : "#2a3038",
        }),
      );
    }
    stones.replaceChildren(layer);
  };
};

const cloneState = (state) => ({
  board: state.board.slice(),
  consecutivePassCount: state.consecutivePassCount,
  koMove: state.koMove,
  moveCount: state.moveCount,
  moveHistory: [...state.moveHistory],
  nextColor: state.nextColor,
});

const createEngine = async (config) => {
  const worker = new Worker(new URL("./dist/worker.js", import.meta.url), { type: "module" });
  const client = new GoModelWorkerClient(worker);
  const options = {
    backend: config.backend,
    manifestUrl: new URL("./model/go-model.json", import.meta.url).href,
    weightsUrl: new URL("./model/go-model.bin", import.meta.url).href,
  };
  if (config.search) {
    options.searchWasmUrl = new URL("./model/moka-search.wasm", import.meta.url).href;
  }
  if (config.backend === "int8") {
    options.int8ManifestUrl = new URL("./model/moka-int8.json", import.meta.url).href;
    options.int8WeightsUrl = new URL("./model/moka-int8.bin", import.meta.url).href;
    options.int8WasmUrl = new URL("./model/moka-int8.wasm", import.meta.url).href;
  }
  const status = await client.initialize(options);
  return {
    config,
    client,
    status,
    dispose: () => client.dispose(),
    reset: () => client.reset(),
    startPonder: () => (config.ponder ? client.startPonder() : Promise.resolve()),
    async move(state) {
      if (!config.search) {
        const started = performance.now();
        const inference = await client.infer(encodeStudentFeatures(cloneState(state)));
        return {
          move: selectHighestLegalMove(state, inference.policyLogits),
          simulations: 1,
          elapsedMs: performance.now() - started,
          reusedTree: false,
          winnerLocked: false,
          value: inference.value,
        };
      }
      return client.selectMove(state, {
        budgetMs: 8000,
        simulationBudget: config.simulations,
        rootD4: config.rootD4,
      });
    },
  };
};

const drawBoard = createBoard(element("board"));
const game = {
  state: createGameState(),
  shown: null,
  humanColor: BLACK,
  engine: null,
  config: null,
  busy: false,
  started: false,
  finished: false,
  lastMove: null,
  captures: { [BLACK]: 0, [WHITE]: 0 },
  ponder: { hits: 0, total: 0 },
};

const selectedEngineKey = () => document.querySelector("input[name=engine]:checked")?.value ?? "improved";
const isHumanTurn = () => game.started && !game.finished && !game.busy && game.state.nextColor === game.humanColor;
const setStatus = (text, tone = "") => {
  statusElement.textContent = text;
  statusElement.className = tone;
};
const setStats = (text) => {
  statsElement.textContent = text;
};
const setEvalBar = (blackValue) => {
  if (!Number.isFinite(blackValue)) {
    evalBlackElement.style.height = "50%";
    evalNumElement.textContent = "—";
    return;
  }
  const pct = Math.max(3, Math.min(97, ((blackValue + 1) / 2) * 100));
  evalBlackElement.style.height = `${pct}%`;
  evalNumElement.textContent = `${Math.round(((blackValue + 1) / 2) * 100)}`;
};
const refreshEval = async (hintValue) => {
  if (!game.engine || game.finished) return;
  try {
    let current = hintValue;
    if (!Number.isFinite(current)) {
      const inference = await game.engine.client.infer(encodeStudentFeatures(cloneState(game.state)));
      current = inference.value;
    }
    const blackValue = game.state.nextColor === BLACK ? current : -current;
    setEvalBar(blackValue);
  } catch {
    /* keep last bar */
  }
};
const render = () => {
  drawBoard(game.shown ?? game.state, game.lastMove);
  element("board").classList.toggle("live", !game.finished && !game.busy);
  capturesElement.textContent = `${game.state.moveCount}/${MOVE_CAP} · captures ${game.captures[BLACK]}–${game.captures[WHITE]}`;
  const you = document.querySelector("#you-cap");
  const opp = document.querySelector("#opp-cap");
  const turn = document.querySelector("#turn-label");
  const blackCap = document.querySelector("#black-cap");
  const whiteCap = document.querySelector("#white-cap");
  if (blackCap && whiteCap) {
    blackCap.textContent = String(game.captures[BLACK] ?? 0);
    whiteCap.textContent = String(game.captures[WHITE] ?? 0);
  }
  document.querySelector("#seat-black")?.classList.toggle("on", game.humanColor === BLACK);
  document.querySelector("#seat-white")?.classList.toggle("on", game.humanColor === WHITE);
  if (turn) {
    if (!game.started || game.finished) turn.textContent = "";
    else if (!isHumanTurn()) turn.textContent = "Thinking…";
    else turn.textContent = game.config?.ponder ? "Your turn · pondering" : "Your turn";
  }
};
const updateControls = () => {
  passButton.disabled = !isHumanTurn();
  resignButton.disabled = !game.started || game.finished;
  setupElement.disabled = game.started && !game.finished;
  document.body.classList.toggle("playing", game.started && !game.finished);
};
const countStones = (board, color) => {
  let total = 0;
  for (let i = 0; i < BOARD_AREA; i += 1) if (board[i] === color) total += 1;
  return total;
};
const applyMove = (move) => {
  const mover = game.state.nextColor;
  const before = countStones(game.state.board, -mover);
  const next = playMove(game.state, move);
  if (!next) return false;
  game.captures[mover] += before - countStones(next.board, -mover);
  game.state = next;
  game.shown = null;
  game.lastMove = move;
  return true;
};
const finishGame = (resigned = false) => {
  game.finished = true;
  if (resigned) {
    setStatus(`You resigned. ${game.config.label} wins.`, "warn");
  } else if (game.state.consecutivePassCount < 2 && game.state.moveCount >= MOVE_CAP) {
    setStatus("Move cap reached — no result.", "warn");
  } else {
    const adjudicated = removeDeadStones(game.state, getAutomaticallyDeadMoves(game.state));
    game.shown = adjudicated;
    const blackLead = getAreaScore(adjudicated);
    if (blackLead === 0) setStatus("Draw.", "warn");
    else {
      const winner = blackLead > 0 ? BLACK : WHITE;
      const youWon = winner === game.humanColor;
      setStatus(
        `${colorName(winner)} wins by ${Math.abs(blackLead)}. ${youWon ? "You beat" : "You lost to"} ${game.config.label}.`,
        youWon ? "good" : "",
      );
    }
  }
  render();
  updateControls();
};
const startPondering = () => {
  if (!game.config?.ponder || game.finished || !isHumanTurn()) return;
  game.engine?.startPonder().catch(() => {});
};
const mokaTurn = async () => {
  const engine = game.engine;
  game.busy = true;
  updateControls();
  setStatus(`${game.config.label} is thinking…`);
  render();
  try {
    const result = await engine.move(game.state);
    if (game.engine !== engine || game.finished) return;
    if (!applyMove(result.move)) throw new Error(`illegal engine move ${result.move}`);
    game.busy = false;
    if (result.reusedTree) {
      game.ponder.total += 1;
      game.ponder.hits += 1;
    } else if (game.config.ponder && game.state.moveCount > 1) {
      game.ponder.total += 1;
    }
    const parts = [`${result.elapsedMs.toFixed(0)} ms`, `${result.simulations} sims`];
    if (result.reusedTree) parts.push("tree reused");
    if (result.winnerLocked) parts.push("winner lock");
    if (game.config.ponder && game.ponder.total) parts.push(`ponder reuse ${game.ponder.hits}/${game.ponder.total}`);
    setStats(parts.join(" · "));
    await refreshEval(result.value);
    render();
    if (isGameOver(game.state)) {
      finishGame();
      return;
    }
    setStatus(`Played ${moveLabel(result.move)}.`);
    updateControls();
    startPondering();
  } catch (error) {
    if (game.engine !== engine) return;
    game.busy = false;
    game.finished = true;
    setStatus(`Engine error: ${error.message}`, "warn");
    updateControls();
    render();
  }
};
const humanMove = async (move) => {
  if (game.finished) newGame();
  if (!game.started) {
    if (game.busy) return;
    if (game.humanColor === WHITE) return;
    await startGame();
    if (!game.started || game.finished || game.humanColor === WHITE) return;
  }
  if (!isHumanTurn()) return;
  if (!applyMove(move)) {
    setStatus(`${moveLabel(move)} is not legal.`, "warn");
    return;
  }
  await refreshEval();
  render();
  updateControls();
  if (isGameOver(game.state)) {
    finishGame();
    return;
  }
  await mokaTurn();
};
const startGame = async () => {
  const engineKey = selectedEngineKey();
  const config = ENGINES[engineKey];
  if (!game.engine || game.config?.label !== config.label || game.config.backend !== config.backend) {
    game.engine?.dispose();
    game.engine = null;
  }
  game.config = config;
  game.state = createGameState();
  game.shown = null;
  game.humanColor = game.humanColor === WHITE ? WHITE : BLACK;
  game.busy = true;
  game.started = true;
  game.finished = false;
  game.lastMove = null;
  game.captures = { [BLACK]: 0, [WHITE]: 0 };
  game.ponder = { hits: 0, total: 0 };
  setStats("");
  setEvalBar(NaN);
  render();
  updateControls();
  engineBadge.className = "badge";
  engineBadge.textContent = "loading…";
  setStatus(`Loading ${config.label}…`);
  try {
    if (!game.engine) game.engine = await createEngine(config);
    const kernel = game.engine.status.wasmKernel || game.engine.status.backend;
    engineBadge.className = "badge on";
    engineBadge.textContent = `${config.label} · ${kernel}`;
    game.busy = false;
    updateControls();
    await refreshEval();
    if (game.humanColor === WHITE) await mokaTurn();
    else {
      setStatus("Your turn.");
      render();
      startPondering();
    }
  } catch (error) {
    game.busy = false;
    game.started = false;
    engineBadge.textContent = "failed";
    setStatus(`Could not load: ${error.message}`, "warn");
    updateControls();
  }
};
const chooseSeat = (color) => {
  if (game.finished) newGame();
  if (game.started && !game.finished) return;
  game.humanColor = color;
  render();
  if (color === WHITE && !game.started) void startGame();
};
const newGame = () => {
  game.state = createGameState();
  game.shown = null;
  game.busy = false;
  game.started = false;
  game.finished = false;
  game.lastMove = null;
  game.captures = { [BLACK]: 0, [WHITE]: 0 };
  engineBadge.className = "badge";
  engineBadge.textContent = "no engine loaded";
  setStatus("");
  setStats("");
  setEvalBar(NaN);
  render();
  updateControls();
};

element("board").addEventListener("click", (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 400;
  const y = ((event.clientY - rect.top) / rect.height) * 400;
  const column = Math.round((x - MARGIN) / SPACING);
  const row = Math.round((y - MARGIN) / SPACING);
  if (column < 0 || column >= BOARD_SIZE || row < 0 || row >= BOARD_SIZE) return;
  void humanMove(row * BOARD_SIZE + column);
});
passButton.addEventListener("click", () => void humanMove(PASS_MOVE));
resignButton.addEventListener("click", () => finishGame(true));
document.querySelector("#seat-black").addEventListener("click", () => chooseSeat(BLACK));
document.querySelector("#seat-white").addEventListener("click", () => chooseSeat(WHITE));
render();
updateControls();
void (async () => {
  try {
    if (game.engine) return;
    const config = ENGINES[selectedEngineKey()];
    game.config = config;
    game.engine = await createEngine(config);
  } catch {
    /* first stone will retry */
  }
})();
