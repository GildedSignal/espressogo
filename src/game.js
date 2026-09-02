export const SIZE = 9;
export const emptyBoard = () => Array(SIZE * SIZE).fill(null);
export const at = (row, col) => row * SIZE + col;
export const neighbors = (index) => {
  const row = Math.floor(index / SIZE), col = index % SIZE, result = [];
  if (row) result.push(at(row - 1, col));
  if (row < SIZE - 1) result.push(at(row + 1, col));
  if (col) result.push(at(row, col - 1));
  if (col < SIZE - 1) result.push(at(row, col + 1));
  return result;
};
export function groupAndLiberties(board, origin) {
  const color = board[origin], group = new Set([origin]), liberties = new Set(), queue = [origin];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const neighbor of neighbors(queue[cursor])) {
      if (board[neighbor] === color && !group.has(neighbor)) { group.add(neighbor); queue.push(neighbor); }
      if (board[neighbor] === null) liberties.add(neighbor);
    }
  }
  return { group, liberties };
}
export function tryMove(board, index, color, { koMove = -1 } = {}) {
  if (board[index] !== null || index === koMove) return { legal: false, board, captured: [], koMove };
  const next = [...board]; next[index] = color;
  const captured = [];
  for (const neighbor of neighbors(index)) {
    if (next[neighbor] && next[neighbor] !== color) {
      const group = groupAndLiberties(next, neighbor);
      if (!group.liberties.size) for (const stone of group.group) { next[stone] = null; captured.push(stone); }
    }
  }
  const ownGroup = groupAndLiberties(next, index);
  if (!ownGroup.liberties.size) return { legal: false, board, captured: [], koMove };
  const nextKoMove = captured.length === 1 && ownGroup.group.size === 1 && ownGroup.liberties.size === 1
    ? captured[0]
    : -1;
  return { legal: true, board: next, captured, koMove: nextKoMove };
}

// A compact Chinese-style area count for the completed autoplay match. Empty
// regions surrounded by exactly one colour belong to that colour; unsettled
// regions stay neutral. The game UI does not have a dead-stone adjudication
// phase, so this is deliberately an end-of-game estimate rather than a claim
// of tournament scoring precision.
export function scoreArea(board, { komi = 7 } = {}) {
  let black = 0;
  let white = komi;
  const seen = new Set();

  board.forEach((stone) => {
    if (stone === 'black') black += 1;
    if (stone === 'white') white += 1;
  });

  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== null || seen.has(index)) continue;
    const region = [index];
    const borders = new Set();
    seen.add(index);
    for (let cursor = 0; cursor < region.length; cursor += 1) {
      for (const neighbor of neighbors(region[cursor])) {
        if (board[neighbor] === null && !seen.has(neighbor)) {
          seen.add(neighbor);
          region.push(neighbor);
        } else if (board[neighbor]) {
          borders.add(board[neighbor]);
        }
      }
    }
    if (borders.size === 1) {
      if (borders.has('black')) black += region.length;
      if (borders.has('white')) white += region.length;
    }
  }

  return {
    black,
    white,
    komi,
    winner: black === white ? null : black > white ? 'black' : 'white',
  };
}
