import {
  GoModelWorkerClient,
  encodeStudentFeatures,
  selectHighestLegalMove,
} from "../dist/index.js";

const PASS = 81;
const BLACK = 1;
const WHITE = -1;

const ENGINES = {
  espresso: {
    label: "Espresso",
    backend: "int8",
    ponder: true,
    simulations: 64,
    rootD4: false,
    search: true,
  },
  "moka-web": {
    label: "Moka web",
    backend: "reference",
    ponder: false,
    simulations: 56,
    rootD4: true,
    search: true,
  },
  "moka-github": {
    label: "Moka GitHub",
    backend: "reference",
    ponder: false,
    simulations: 0,
    rootD4: false,
    search: false,
  },
};

const toMokaState = (ui) => {
  const board = new Int8Array(81);
  for (let i = 0; i < 81; i += 1) {
    const stone = ui.board[i];
    board[i] = stone === "black" ? BLACK : stone === "white" ? WHITE : 0;
  }
  return {
    board,
    consecutivePassCount: ui.passes ?? 0,
    koMove: Number.isInteger(ui.koMove) ? ui.koMove : -1,
    moveCount: ui.board.reduce((n, stone) => n + (stone ? 1 : 0), 0) + (ui.passes ?? 0),
    moveHistory: Array.isArray(ui.moveHistory) ? [...ui.moveHistory] : [],
    nextColor: ui.turn === "black" ? BLACK : WHITE,
  };
};

const AUTOPLAY_OPENINGS = [40, 20, 24, 56, 60, 38, 42, 22, 58];

function autoplayOpening(uiState) {
  if (!uiState.autoplay || uiState.moveHistory?.length) return null;
  const legal = AUTOPLAY_OPENINGS.filter((index) => uiState.board[index] === null);
  if (!legal.length) return null;
  return { index: legal[Math.floor(Math.random() * legal.length)] };
}

const cloneState = (state) => ({
  board: state.board.slice(),
  consecutivePassCount: state.consecutivePassCount,
  koMove: state.koMove,
  moveCount: state.moveCount,
  moveHistory: [...state.moveHistory],
  nextColor: state.nextColor,
});

const createInitializedEngine = async (config) => {
  const worker = new Worker(new URL("../dist/worker.js", import.meta.url), { type: "module" });
  const client = new GoModelWorkerClient(worker);
  try {
    const options = {
      backend: config.backend,
      manifestUrl: new URL("../model/go-model.json", import.meta.url).href,
      weightsUrl: new URL("../model/go-model.bin", import.meta.url).href,
    };
    if (config.search) {
      options.searchWasmUrl = new URL("../model/moka-search.wasm", import.meta.url).href;
    }
    if (config.backend === "int8") {
      options.int8ManifestUrl = new URL("../model/moka-int8.json", import.meta.url).href;
      options.int8WeightsUrl = new URL("../model/moka-int8.bin", import.meta.url).href;
      options.int8WasmUrl = new URL("../model/moka-int8.wasm", import.meta.url).href;
    }
    await client.initialize(options);
    return {
      async requestMove(uiState) {
        const state = toMokaState(uiState);
        if (!config.search) {
          const inference = await client.infer(encodeStudentFeatures(cloneState(state)));
          const move = selectHighestLegalMove(state, inference.policyLogits);
          return move === PASS ? { pass: true } : { index: move };
        }
        const result = await client.selectMove(state, {
          budgetMs: 8000,
          simulationBudget: config.simulations,
          rootD4: config.rootD4,
        });
        if (config.ponder) client.startPonder().catch(() => {});
        return result.move === PASS ? { pass: true } : { index: result.move };
      },
    };
  } catch (error) {
    client.dispose();
    throw error;
  }
};

const createEngine = async (config) => {
  try {
    return { adapter: await createInitializedEngine(config), displayLabel: config.label };
  } catch (error) {
    if (config.backend !== "int8") throw error;
    // GitHub Pages cannot configure COEP/COOP. The current INT8 worker does
    // not need them, but retain a working opponent if that changes. The
    // fallback names itself as the reference engine; it is never Espresso.
    console.warn("Espresso INT8 backend unavailable; using Moka web reference.", error);
    return {
      adapter: await createInitializedEngine({ ...config, backend: "reference" }),
      displayLabel: "Moka web (reference)",
    };
  }
};

const createLazyEngine = (config) => {
  let engine;
  let loading;
  let displayLabel = config.label;
  const load = () => {
    if (!loading) {
      loading = createEngine(config).then(({ adapter, displayLabel: resolvedLabel }) => {
        engine = adapter;
        displayLabel = resolvedLabel;
        return adapter;
      }).catch((error) => {
        // Allow an explicit retry after a transient fetch or worker failure.
        loading = undefined;
        throw error;
      });
    }
    return loading;
  };
  return {
    get displayLabel() { return displayLabel; },
    requestMove: async (state) => autoplayOpening(state) ?? (engine ?? await load()).requestMove(state),
  };
};

export async function attachEngines(game) {
  for (const [id, config] of Object.entries(ENGINES)) {
    // Register immediately so the opponent menu remains complete. Worker,
    // model, and WASM bytes load only when this engine is asked for a move.
    game.registerOpponent(id, { label: config.label, adapter: createLazyEngine(config) });
  }
}
