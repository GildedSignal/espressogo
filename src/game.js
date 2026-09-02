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
export function tryMove(board, index, color) {
  if (board[index] !== null) return { legal: false, board, captured: [] };
  const next = [...board]; next[index] = color;
  const captured = [];
  for (const neighbor of neighbors(index)) {
    if (next[neighbor] && next[neighbor] !== color) {
      const group = groupAndLiberties(next, neighbor);
      if (!group.liberties.size) for (const stone of group.group) { next[stone] = null; captured.push(stone); }
    }
  }
  if (!groupAndLiberties(next, index).liberties.size) return { legal: false, board, captured: [] };
  return { legal: true, board: next, captured };
}
