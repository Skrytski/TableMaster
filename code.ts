figma.showUI(__html__, { width: 280, height: 700 });

const MIN_ROWS_FOR_TABLE = 2;
const MIN_ALIGNED_COLS_FOR_TABLE = 2;
const STORAGE_KEY_INCLUDE_HEADER = "includeHeader";

type Response = { ok: boolean; message: string };
type NavState = {
  canPrevCol: boolean;
  canNextCol: boolean;
  canPrevRow: boolean;
  canNextRow: boolean;
  canExpColLeft: boolean;
  canExpColRight: boolean;
  canExpRowUp: boolean;
  canExpRowDown: boolean;
  canShrinkColLeft: boolean;
  canShrinkColRight: boolean;
  canShrinkRowUp: boolean;
  canShrinkRowDown: boolean;
  canSelectAll: boolean;
  canClearSelection: boolean;
  canAddColLeft: boolean;
  canAddColRight: boolean;
  canAddRowUp: boolean;
  canAddRowDown: boolean;
  canMoveColLeft: boolean;
  canMoveColRight: boolean;
  canMoveRowUp: boolean;
  canMoveRowDown: boolean;
};

// «Якорь» — память о том, какие ряды/столбцы пользователь подразумевал
// последним действием. Сохраняется через цепочки nav, чтобы при смене оси
// можно было вернуться к исходному столбцу/ряду.
type AnchorState = {
  rowIdxs: number[]; // sorted asc
  colIdxs: number[]; // sorted asc
  axis: "row" | "column" | null;
};

type Classification = {
  mode: "none" | "row" | "column" | "all" | "both";
  rowPositions: number[]; // позиции в visibleRowIdxs
  colPositions: number[]; // позиции в visibleColIdxs
  totalRows: number;
  totalCols: number;
};

type TableType = "stack" | "grid";

type LogicalCell = {
  node: SceneNode;
  rowIdx: number; // stack: индекс ряда (0..N-1); grid: gridRowAnchorIndex
  colIdx: number; // stack: позиция X в sortedXs; grid: gridColumnAnchorIndex
  visible: boolean;
};

type TableModel = {
  type: TableType;
  body: BaseNode & ChildrenMixin;
  cells: LogicalCell[];
  cellByNodeId: Map<string, LogicalCell>;
  visibleRowIdxs: number[];   // sorted asc
  allRowIdxs: number[];        // sorted asc
  visibleColIdxs: number[];   // sorted asc
  allColIdxs: number[];        // sorted asc
  rowNodeByIdx: Map<number, SceneNode & ChildrenMixin>; // stack only
  headerRowIdx: number; // = visibleRowIdxs[0] если есть
  // Преднасчитанные индексы видимых ячеек — чтобы classifySelection и другие
  // operations не сканировали model.cells заново на каждом обращении.
  visibleColsByRow: Map<number, Set<number>>;
  visibleRowsByCol: Map<number, Set<number>>;
};

type TableContext = {
  cell: SceneNode;
  logical: LogicalCell;
  model: TableModel;
};

// ---------- visibility ----------

function isVisible(node: BaseNode): boolean {
  return !("visible" in node) || (node as SceneNode).visible !== false;
}

// ---------- type detection ----------

function isGridBody(node: BaseNode): boolean {
  if (!("layoutMode" in node)) return false;
  return (node as FrameNode).layoutMode === "GRID";
}

// ---------- model: GRID ----------

function computeGridModel(body: BaseNode & ChildrenMixin): TableModel | null {
  const cells: LogicalCell[] = [];
  const cellByNodeId = new Map<string, LogicalCell>();

  for (const c of body.children) {
    const sc = c as SceneNode;
    const rowIdx = (sc as unknown as { gridRowAnchorIndex?: number }).gridRowAnchorIndex;
    const colIdx = (sc as unknown as { gridColumnAnchorIndex?: number }).gridColumnAnchorIndex;
    if (typeof rowIdx !== "number" || typeof colIdx !== "number") continue;
    const lc: LogicalCell = { node: sc, rowIdx, colIdx, visible: isVisible(sc) };
    cells.push(lc);
    cellByNodeId.set(sc.id, lc);
  }

  if (cells.length === 0) return null;

  const allRowSet = new Set<number>();
  const allColSet = new Set<number>();
  const visRowSet = new Set<number>();
  const visColSet = new Set<number>();
  for (const lc of cells) {
    allRowSet.add(lc.rowIdx);
    allColSet.add(lc.colIdx);
    if (lc.visible) {
      visRowSet.add(lc.rowIdx);
      visColSet.add(lc.colIdx);
    }
  }
  const allRowIdxs = [...allRowSet].sort((a, b) => a - b);
  const allColIdxs = [...allColSet].sort((a, b) => a - b);
  const visibleRowIdxs = [...visRowSet].sort((a, b) => a - b);
  const visibleColIdxs = [...visColSet].sort((a, b) => a - b);

  if (allRowIdxs.length < MIN_ROWS_FOR_TABLE || allColIdxs.length < MIN_ALIGNED_COLS_FOR_TABLE) return null;

  const { visibleColsByRow, visibleRowsByCol } = buildVisibilityMaps(cells);

  return {
    type: "grid",
    body,
    cells,
    cellByNodeId,
    visibleRowIdxs,
    allRowIdxs,
    visibleColIdxs,
    allColIdxs,
    rowNodeByIdx: new Map(),
    headerRowIdx: visibleRowIdxs.length > 0 ? visibleRowIdxs[0] : 0,
    visibleColsByRow,
    visibleRowsByCol,
  };
}

// ---------- model: STACK ----------

function computeStackModel(body: BaseNode & ChildrenMixin): TableModel | null {
  type RowCandidate = {
    rowNode: SceneNode & ChildrenMixin;
    rowVisible: boolean;
    rowY: number;
    cells: { node: SceneNode; x: number; visible: boolean }[];
  };

  const candidates: RowCandidate[] = [];
  for (const c of body.children) {
    if (!("children" in c)) continue;
    const rowBox = c.absoluteBoundingBox;
    if (!rowBox) continue;
    const cells: RowCandidate["cells"] = [];
    for (const cell of (c as SceneNode & ChildrenMixin).children) {
      const b = cell.absoluteBoundingBox;
      if (!b) continue;
      cells.push({ node: cell as SceneNode, x: b.x, visible: isVisible(cell) });
    }
    if (cells.length === 0) continue;
    candidates.push({
      rowNode: c as SceneNode & ChildrenMixin,
      rowVisible: isVisible(c),
      rowY: rowBox.y,
      cells,
    });
  }

  if (candidates.length < MIN_ROWS_FOR_TABLE) return null;

  // Alignment: X положения, повторяющиеся в ≥2 рядах
  const xCount = new Map<number, number>();
  for (const cand of candidates) {
    const seen = new Set<number>();
    for (const c of cand.cells) {
      const r = Math.round(c.x);
      if (!seen.has(r)) {
        seen.add(r);
        xCount.set(r, (xCount.get(r) || 0) + 1);
      }
    }
  }
  const realColRounded = new Set<number>();
  for (const [rx, count] of xCount) if (count >= 2) realColRounded.add(rx);
  if (realColRounded.size < MIN_ALIGNED_COLS_FOR_TABLE) return null;

  // Только ряды, где есть хотя бы 1 ячейка в реальном столбце
  const validRows = candidates.filter((c) =>
    c.cells.some((cell) => realColRounded.has(Math.round(cell.x))),
  );
  if (validRows.length < MIN_ROWS_FOR_TABLE) return null;

  validRows.sort((a, b) => a.rowY - b.rowY);

  // Уникальные X (используем actual X из первого встреченного для каждого rounded)
  const xByRounded = new Map<number, number>();
  for (const cand of validRows) {
    for (const cell of cand.cells) {
      const r = Math.round(cell.x);
      if (realColRounded.has(r) && !xByRounded.has(r)) {
        xByRounded.set(r, cell.x);
      }
    }
  }
  const sortedXs = [...xByRounded.values()].sort((a, b) => a - b);
  const colIdxByRounded = new Map<number, number>();
  for (let i = 0; i < sortedXs.length; i++) {
    colIdxByRounded.set(Math.round(sortedXs[i]), i);
  }

  // Построение LogicalCell
  const cells: LogicalCell[] = [];
  const cellByNodeId = new Map<string, LogicalCell>();
  const rowNodeByIdx = new Map<number, SceneNode & ChildrenMixin>();

  for (let rowIdx = 0; rowIdx < validRows.length; rowIdx++) {
    const cand = validRows[rowIdx];
    rowNodeByIdx.set(rowIdx, cand.rowNode);
    for (const cell of cand.cells) {
      const colIdx = colIdxByRounded.get(Math.round(cell.x));
      if (colIdx === undefined) continue;
      const lc: LogicalCell = {
        node: cell.node,
        rowIdx,
        colIdx,
        visible: cand.rowVisible && cell.visible,
      };
      cells.push(lc);
      cellByNodeId.set(cell.node.id, lc);
    }
  }

  const allRowIdxs: number[] = [];
  for (let i = 0; i < validRows.length; i++) allRowIdxs.push(i);

  const visRowSet = new Set<number>();
  for (const lc of cells) if (lc.visible) visRowSet.add(lc.rowIdx);
  const visibleRowIdxs = [...visRowSet].sort((a, b) => a - b);

  const allColIdxs: number[] = [];
  for (let i = 0; i < sortedXs.length; i++) allColIdxs.push(i);

  const visColSet = new Set<number>();
  for (const lc of cells) if (lc.visible) visColSet.add(lc.colIdx);
  const visibleColIdxs = [...visColSet].sort((a, b) => a - b);

  const { visibleColsByRow, visibleRowsByCol } = buildVisibilityMaps(cells);

  return {
    type: "stack",
    body,
    cells,
    cellByNodeId,
    visibleRowIdxs,
    allRowIdxs,
    visibleColIdxs,
    allColIdxs,
    rowNodeByIdx,
    headerRowIdx: visibleRowIdxs.length > 0 ? visibleRowIdxs[0] : 0,
    visibleColsByRow,
    visibleRowsByCol,
  };
}

// Один проход по cells — две карты для всех последующих запросов по rows/cols.
function buildVisibilityMaps(cells: LogicalCell[]): {
  visibleColsByRow: Map<number, Set<number>>;
  visibleRowsByCol: Map<number, Set<number>>;
} {
  const visibleColsByRow = new Map<number, Set<number>>();
  const visibleRowsByCol = new Map<number, Set<number>>();
  for (const lc of cells) {
    if (!lc.visible) continue;
    let colsInRow = visibleColsByRow.get(lc.rowIdx);
    if (!colsInRow) { colsInRow = new Set(); visibleColsByRow.set(lc.rowIdx, colsInRow); }
    colsInRow.add(lc.colIdx);
    let rowsInCol = visibleRowsByCol.get(lc.colIdx);
    if (!rowsInCol) { rowsInCol = new Set(); visibleRowsByCol.set(lc.colIdx, rowsInCol); }
    rowsInCol.add(lc.rowIdx);
  }
  return { visibleColsByRow, visibleRowsByCol };
}

// ---------- model cache ----------

// Кешируем дорогую сборку модели по body.id. Один селекшен-цикл может
// тригерить десяток вызовов findTableContext/buildStackModel; без кеша
// каждый клик пересчитывает выравнивания N раз. Кеш сбрасывается при
// selectionchange и после структурных мутаций (add/move).
const modelCache = new Map<string, TableModel | null>();

function buildGridModel(body: BaseNode & ChildrenMixin): TableModel | null {
  const key = "g:" + body.id;
  if (modelCache.has(key)) return modelCache.get(key)!;
  const m = computeGridModel(body);
  modelCache.set(key, m);
  return m;
}

function buildStackModel(body: BaseNode & ChildrenMixin): TableModel | null {
  const key = "s:" + body.id;
  if (modelCache.has(key)) return modelCache.get(key)!;
  const m = computeStackModel(body);
  modelCache.set(key, m);
  return m;
}

function invalidateModelCache(): void {
  modelCache.clear();
  effectiveSelCache = null;
}

// ---------- row container detection ----------

// Если node — это контейнер строки stack-таблицы, возвращает её ячейки.
// Иначе null. Работает только для stack-таблиц (у grid нет row-контейнеров).
// Перебираем все children (не только первый) — на случай, если первый ребёнок
// строки это не cell, а фоновая плашка/иконка.
function getRowCellsIfRowContainer(node: SceneNode): SceneNode[] | null {
  if (!("children" in node)) return null;
  const childMixin = node as SceneNode & ChildrenMixin;
  if (childMixin.children.length === 0) return null;

  for (const child of childMixin.children) {
    const ctx = findTableContext(child as SceneNode);
    if (!ctx) continue;
    // Grid не имеет row-контейнеров — выходим сразу, не пытаемся другие дети.
    if (ctx.model.type !== "stack") return null;
    // Если ребёнок резолвится в нашу же ноду как cell — значит наша нода
    // сама и есть ячейка таблицы, а не row-контейнер.
    if (ctx.cell.id === node.id) return null;
    const lc = ctx.model.cellByNodeId.get(ctx.cell.id);
    if (!lc) continue;
    const rowNode = ctx.model.rowNodeByIdx.get(lc.rowIdx);
    if (!rowNode || rowNode.id !== node.id) continue;
    return cellsAtRow(ctx.model, lc.rowIdx, true);
  }
  return null;
}

// "Эффективное выделение": возвращает ячейки, на которые ссылается текущее
// Figma-выделение. Row-контейнеры виртуально разворачиваются в свои ячейки.
// САМО выделение в Figma не меняется — это только внутренняя интерпретация.
// Мемоизировано по signature текущего selection: вызов ~5-6 раз за цикл
// (refreshCache, refreshAnchor, classify, computeNavState и т.д.), без
// кеша каждый раз пересчитывался бы один и тот же ответ.
let effectiveSelCache: { sig: string; result: SceneNode[] } | null = null;

function effectiveSelection(): SceneNode[] {
  const sel = figma.currentPage.selection;
  const sig = sel.length + ":" + sel.map((n) => n.id).join("|");
  if (effectiveSelCache !== null && effectiveSelCache.sig === sig) {
    return effectiveSelCache.result;
  }
  let changed = false;
  const seen = new Set<string>();
  const result: SceneNode[] = [];
  for (const n of sel) {
    if (seen.has(n.id)) continue;
    const rowCells = getRowCellsIfRowContainer(n);
    if (rowCells && rowCells.length > 0) {
      changed = true;
      for (const c of rowCells) {
        if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
      }
    } else {
      seen.add(n.id);
      result.push(n);
    }
  }
  const final = changed ? result : sel.slice();
  effectiveSelCache = { sig, result: final };
  return final;
}

// ---------- find table context ----------

function findTableContext(seed: SceneNode): TableContext | null {
  let current: BaseNode = seed;
  let safety = 50;
  while (safety-- > 0) {
    const parent: (BaseNode & ChildrenMixin) | null = current.parent;
    if (!parent) return null;

    // Попытка: parent — это grid-body, current — прямая ячейка
    if (isGridBody(parent)) {
      const model = buildGridModel(parent);
      if (model) {
        const lc = model.cellByNodeId.get(current.id);
        if (lc) return { cell: current as SceneNode, logical: lc, model };
      }
    } else {
      // Попытка: parent.parent — stack-body, parent — ряд, current — ячейка
      const gp: (BaseNode & ChildrenMixin) | null = parent.parent;
      if (gp && !isGridBody(gp)) {
        const model = buildStackModel(gp);
        if (model) {
          const lc = model.cellByNodeId.get(current.id);
          if (lc) return { cell: current as SceneNode, logical: lc, model };
        }
      }
    }

    current = parent;
  }
  return null;
}

// ---------- cache ----------

let cacheCtx: TableContext | null = null;
let anchorState: AnchorState | null = null;
// Если плагин сам менял selection — запоминаем какие id выставили,
// чтобы при последующем selectionchange не сбрасывать anchorState.
let lastPluginSelectionIds: Set<string> | null = null;
// Если пользователь выделил row-контейнер, первое нажатие на action-кнопку
// (nav/expand/shrink/add/move) не выполняет действие, а переводит выделение
// Figma на ячейки этой строки. Следующее нажатие — уже сама операция.
let pendingContainerCells: SceneNode[] | null = null;

function refreshCache(): void {
  const sel = effectiveSelection();
  cacheCtx = sel.length > 0 ? findTableContext(sel[0]) : null;
}

function setPluginSelection(nodes: readonly SceneNode[]): void {
  lastPluginSelectionIds = new Set(nodes.map((n) => n.id));
  figma.currentPage.selection = [...nodes];
}

// Восстановить anchorState из текущего выделения. Вызывается при изменениях
// выделения, которые сделал не плагин (т.е. пользователь сам кликнул).
function refreshAnchorFromSelection(): void {
  if (!cacheCtx) {
    anchorState = null;
    return;
  }
  const model = cacheCtx.model;
  const sel = effectiveSelection();

  const lcs: LogicalCell[] = [];
  for (const n of sel) {
    if (!isVisible(n)) continue;
    const lc = model.cellByNodeId.get(n.id);
    if (lc && lc.visible) lcs.push(lc);
  }
  if (lcs.length === 0) {
    anchorState = null;
    return;
  }

  const rowSet = new Set<number>();
  const colSet = new Set<number>();
  for (const lc of lcs) {
    rowSet.add(lc.rowIdx);
    colSet.add(lc.colIdx);
  }
  const rowIdxs = [...rowSet].sort((a, b) => a - b);
  const colIdxs = [...colSet].sort((a, b) => a - b);

  const cls = classifySelection();
  let axis: "row" | "column" | null = null;
  if (cls.mode === "row") axis = "row";
  else if (cls.mode === "column") axis = "column";

  anchorState = { rowIdxs, colIdxs, axis };
}

// ---------- selection helpers ----------

function cellsAtRow(model: TableModel, rowIdx: number, onlyVisible: boolean): SceneNode[] {
  const result: SceneNode[] = [];
  for (const lc of model.cells) {
    if (lc.rowIdx !== rowIdx) continue;
    if (onlyVisible && !lc.visible) continue;
    result.push(lc.node);
  }
  return result;
}

function cellsAtCol(model: TableModel, colIdx: number, onlyVisible: boolean, includeHeader: boolean): SceneNode[] {
  const result: SceneNode[] = [];
  for (const lc of model.cells) {
    if (lc.colIdx !== colIdx) continue;
    if (onlyVisible && !lc.visible) continue;
    if (!includeHeader && lc.rowIdx === model.headerRowIdx) continue;
    result.push(lc.node);
  }
  return result;
}

function findCursors(positions: number[], total: number): { left: number; right: number } {
  if (positions.length === 0 || positions.length === total) return { left: 0, right: 0 };
  let maxGap = -1;
  let maxAt = 0;
  for (let i = 0; i < positions.length; i++) {
    const nxt = (i + 1) % positions.length;
    const gap = nxt === 0 ? (positions[0] + total) - positions[i] - 1 : positions[nxt] - positions[i] - 1;
    if (gap > maxGap) { maxGap = gap; maxAt = i; }
  }
  return { right: positions[maxAt], left: positions[(maxAt + 1) % positions.length] };
}

// ---------- classification ----------

function classifySelection(): Classification {
  const empty: Classification = {
    mode: "none", rowPositions: [], colPositions: [], totalRows: 0, totalCols: 0,
  };
  const sel = effectiveSelection();
  if (sel.length === 0 || !cacheCtx) return empty;
  const model = cacheCtx.model;

  // Группируем выбранные ячейки по rowIdx и colIdx за один проход.
  const selColsByRow = new Map<number, Set<number>>();
  const selRowsByCol = new Map<number, Set<number>>();
  let cellCount = 0;
  for (const n of sel) {
    if (!isVisible(n)) continue;
    const lc = model.cellByNodeId.get(n.id);
    if (!lc || !lc.visible) return empty;
    let cols = selColsByRow.get(lc.rowIdx);
    if (!cols) { cols = new Set(); selColsByRow.set(lc.rowIdx, cols); }
    cols.add(lc.colIdx);
    let rows = selRowsByCol.get(lc.colIdx);
    if (!rows) { rows = new Set(); selRowsByCol.set(lc.colIdx, rows); }
    rows.add(lc.rowIdx);
    cellCount++;
  }
  if (cellCount === 0) return empty;

  const touchedRowIdxs = [...selColsByRow.keys()];
  const touchedColIdxs = [...selRowsByCol.keys()];

  // fullRow: каждая затронутая строка полностью покрыта выделением.
  let fullRow = true;
  for (const rIdx of touchedRowIdxs) {
    const visCols = model.visibleColsByRow.get(rIdx);
    const selCols = selColsByRow.get(rIdx);
    if (!visCols || !selCols || visCols.size !== selCols.size) { fullRow = false; break; }
  }

  // fullCol: каждый затронутый столбец покрывает все одни и те же затронутые строки.
  let fullCol = true;
  const touchedRowCount = touchedRowIdxs.length;
  for (const cIdx of touchedColIdxs) {
    const rowsInCol = selRowsByCol.get(cIdx);
    if (!rowsInCol || rowsInCol.size !== touchedRowCount) { fullCol = false; break; }
    for (const r of touchedRowIdxs) {
      if (!rowsInCol.has(r)) { fullCol = false; break; }
    }
    if (!fullCol) break;
  }

  // Позиции (индексы) → позиции в видимом списке.
  const rowPosOf = new Map<number, number>();
  model.visibleRowIdxs.forEach((idx, i) => rowPosOf.set(idx, i));
  const colPosOf = new Map<number, number>();
  model.visibleColIdxs.forEach((idx, i) => colPosOf.set(idx, i));
  const rowPositions: number[] = [];
  for (const r of touchedRowIdxs) {
    const p = rowPosOf.get(r);
    if (p === undefined) return empty;
    rowPositions.push(p);
  }
  rowPositions.sort((a, b) => a - b);
  const colPositions: number[] = [];
  for (const c of touchedColIdxs) {
    const p = colPosOf.get(c);
    if (p === undefined) return empty;
    colPositions.push(p);
  }
  colPositions.sort((a, b) => a - b);

  const totalRows = model.visibleRowIdxs.length;
  const totalCols = model.visibleColIdxs.length;
  const mode = pickMode(fullRow, fullCol, touchedRowIdxs.length, touchedColIdxs.length, rowPositions.length, colPositions.length, totalRows, totalCols);

  return { mode, rowPositions, colPositions, totalRows, totalCols };
}

function pickMode(
  fullRow: boolean, fullCol: boolean,
  touchedRows: number, touchedCols: number,
  rowsSelected: number, colsSelected: number,
  totalRows: number, totalCols: number,
): Classification["mode"] {
  const isRow = fullRow && touchedRows >= 1;
  const isCol = fullCol && touchedRows >= 2 && touchedCols >= 1;
  if (isRow && isCol) {
    if (rowsSelected === totalRows && colsSelected === totalCols) return "all";
    if (totalRows === 0 || totalCols === 0) return "both";
    const rowSat = rowsSelected / totalRows;
    const colSat = colsSelected / totalCols;
    if (colSat > rowSat) return "row";
    if (rowSat > colSat) return "column";
    return "both";
  }
  if (isRow) return "row";
  if (isCol) return "column";
  return "none";
}

// ---------- actions: read/select ----------

function selectRow(): Response {
  const ctx = cacheCtx;
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  const cells = cellsAtRow(ctx.model, ctx.logical.rowIdx, true);
  if (cells.length === 0) return { ok: false, message: "В строке нет видимых ячеек" };
  anchorState = {
    rowIdxs: [ctx.logical.rowIdx],
    colIdxs: [ctx.logical.colIdx],
    axis: "row",
  };
  setPluginSelection(cells);
  return { ok: true, message: `Выделена строка: ${cells.length} ячеек` };
}

function selectColumn(includeHeader: boolean): Response {
  const ctx = cacheCtx;
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  const cells = cellsAtCol(ctx.model, ctx.logical.colIdx, true, includeHeader);
  if (cells.length === 0) return { ok: false, message: "В столбце ничего не найдено" };
  anchorState = {
    rowIdxs: [ctx.logical.rowIdx],
    colIdxs: [ctx.logical.colIdx],
    axis: "column",
  };
  setPluginSelection(cells);
  return { ok: true, message: `Выделен столбец: ${cells.length} ячеек` };
}

function selectAll(includeHeader: boolean): Response {
  const ctx = cacheCtx;
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  const result: SceneNode[] = [];
  for (const lc of ctx.model.cells) {
    if (!lc.visible) continue;
    if (!includeHeader && lc.rowIdx === ctx.model.headerRowIdx) continue;
    result.push(lc.node);
  }
  if (result.length === 0) return { ok: false, message: "Нет видимых ячеек" };
  anchorState = {
    rowIdxs: [...ctx.model.visibleRowIdxs],
    colIdxs: [...ctx.model.visibleColIdxs],
    axis: null,
  };
  setPluginSelection(result);
  return { ok: true, message: `Все ячейки: ${result.length}` };
}

// ---------- actions: navigate ----------

// Новая логика nav: первое нажатие в новой оси — трансформация выделения
// (без сдвига) на основе anchorState; последующие нажатия в той же оси —
// сдвиг. Между переключениями оси сохраняется память о rowIdxs/colIdxs,
// чтобы возврат к оси шёл к исходным позициям.
function navigate(mode: "column" | "row", direction: "prev" | "next", includeHeader: boolean): Response {
  if (!cacheCtx || !anchorState) return { ok: false, message: "Это не похоже на таблицу" };
  const model = cacheCtx.model;
  const visIdxs = mode === "row" ? model.visibleRowIdxs : model.visibleColIdxs;
  if (visIdxs.length === 0) {
    return { ok: false, message: mode === "row" ? "Нет строк" : "Нет столбцов" };
  }

  applyAxisNav(mode, direction, includeHeader, model);

  const result = buildAxisSelection(mode, model, includeHeader);
  if (result.length === 0) return { ok: false, message: "Нет ячеек" };
  setPluginSelection(result);

  const idxs = mode === "row" ? anchorState.rowIdxs : anchorState.colIdxs;
  const noun = mode === "row" ? "Ряд" : "Столбц";
  const suffix = idxs.length > 1 ? "ы" : "";
  return { ok: true, message: `${noun}${suffix}: ${result.length} ячеек` };
}

// Обновляет anchorState.{row|col}Idxs и axis для одной оси.
// Первое нажатие в новой оси — трансформация (без сдвига).
// Последующие — сдвиг с wrap-around.
function applyAxisNav(
  axis: "row" | "column",
  direction: "prev" | "next",
  includeHeader: boolean,
  model: TableModel,
): void {
  if (!anchorState) return;
  const step = direction === "next" ? 1 : -1;
  const visIdxs = axis === "row" ? model.visibleRowIdxs : model.visibleColIdxs;
  const total = visIdxs.length;
  const currentIdxs = axis === "row" ? anchorState.rowIdxs : anchorState.colIdxs;

  let newIdxs: number[];
  if (anchorState.axis !== axis) {
    // Трансформация
    let target = [...currentIdxs];
    // Спец-кейс для row: если anchor сидит только на header и тоггл выключен —
    // переезжаем на соседнюю не-header строку.
    if (axis === "row" && !includeHeader && target.length > 0
        && target.every((r) => r === model.headerRowIdx)) {
      const posOf = positionMap(visIdxs);
      const hPos = posOf.get(model.headerRowIdx);
      if (hPos !== undefined) {
        let attempts = total;
        let p = hPos;
        while (attempts-- > 0) {
          p = ((p + step) % total + total) % total;
          if (visIdxs[p] !== model.headerRowIdx) {
            target = [visIdxs[p]];
            break;
          }
        }
      }
    }
    newIdxs = target;
    anchorState.axis = axis;
  } else {
    // Сдвиг
    const posOf = positionMap(visIdxs);
    const newSet = new Set<number>();
    for (const idx of currentIdxs) {
      const pos = posOf.get(idx);
      if (pos === undefined) continue;
      const newPos = ((pos + step) % total + total) % total;
      newSet.add(visIdxs[newPos]);
    }
    newIdxs = [...newSet].sort((a, b) => a - b);
  }

  if (axis === "row") anchorState.rowIdxs = newIdxs;
  else anchorState.colIdxs = newIdxs;
}

// Собирает выделение из anchorState под текущую ось.
function buildAxisSelection(
  axis: "row" | "column", model: TableModel, includeHeader: boolean,
): SceneNode[] {
  if (!anchorState) return [];
  const idxs = axis === "row" ? anchorState.rowIdxs : anchorState.colIdxs;
  const seen = new Set<string>();
  const result: SceneNode[] = [];
  for (const idx of idxs) {
    const cells = axis === "row"
      ? cellsAtRow(model, idx, true)
      : cellsAtCol(model, idx, true, includeHeader);
    for (const c of cells) {
      if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
    }
  }
  return result;
}

function positionMap(idxs: number[]): Map<number, number> {
  const m = new Map<number, number>();
  idxs.forEach((idx, i) => m.set(idx, i));
  return m;
}

// ---------- actions: shrink ----------

function shrink(mode: "column" | "row", direction: "prev" | "next", includeHeader: boolean): Response {
  if (!cacheCtx || !anchorState) return { ok: false, message: "Это не похоже на таблицу" };
  const model = cacheCtx.model;

  if (mode === "column") {
    if (anchorState.axis === "row") return { ok: false, message: "Нельзя сузить столбцы у строки" };
    if (anchorState.colIdxs.length < 2) return { ok: false, message: "Не из чего сужать" };
    anchorState.colIdxs = trimEdge(anchorState.colIdxs, direction);
  } else {
    if (anchorState.axis === "column") return { ok: false, message: "Нельзя сузить строки у столбца" };
    if (anchorState.rowIdxs.length < 2) return { ok: false, message: "Не из чего сужать" };
    anchorState.rowIdxs = trimEdge(anchorState.rowIdxs, direction);
  }

  const result = anchorState.axis === "row" || anchorState.axis === "column"
    ? buildAxisSelection(anchorState.axis, model, includeHeader)
    : buildRectSelection(model);

  if (result.length === 0) return { ok: false, message: "Пусто после сужения" };
  setPluginSelection(result);
  return { ok: true, message: `Сужено: ${result.length} ячеек` };
}

function trimEdge(idxs: number[], direction: "prev" | "next"): number[] {
  const sorted = [...idxs].sort((a, b) => a - b);
  if (direction === "prev") sorted.shift();
  else sorted.pop();
  return sorted;
}

// Прямоугольное выделение из anchor.rowIdxs × anchor.colIdxs (видимые ячейки).
function buildRectSelection(model: TableModel): SceneNode[] {
  if (!anchorState) return [];
  const rowSet = new Set(anchorState.rowIdxs);
  const colSet = new Set(anchorState.colIdxs);
  const seen = new Set<string>();
  const result: SceneNode[] = [];
  for (const lc of model.cells) {
    if (!lc.visible) continue;
    if (!rowSet.has(lc.rowIdx) || !colSet.has(lc.colIdx)) continue;
    if (!seen.has(lc.node.id)) { seen.add(lc.node.id); result.push(lc.node); }
  }
  return result;
}

// ---------- actions: clear selection ----------

function clearSelection(): Response {
  anchorState = null;
  setPluginSelection([]);
  return { ok: true, message: "Выделение снято" };
}

// ---------- actions: expand ----------

function expand(mode: "column" | "row", direction: "prev" | "next", includeHeader: boolean): Response {
  const ctx = cacheCtx;
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  const cls = classifySelection();
  const model = ctx.model;

  if (mode === "column") {
    if (cls.mode !== "column" && cls.mode !== "both") return { ok: false, message: "Выделите столбец" };
    const totalCols = model.visibleColIdxs.length;
    if (cls.colPositions.length >= totalCols) return { ok: false, message: "Все столбцы выделены" };
    const cursors = findCursors(cls.colPositions, totalCols);
    const newPos = direction === "next"
      ? (cursors.right + 1) % totalCols
      : (cursors.left - 1 + totalCols) % totalCols;
    const colIdx = model.visibleColIdxs[newPos];
    const existing = figma.currentPage.selection;
    const newCells = cellsAtCol(model, colIdx, true, includeHeader);
    const seen = new Set(existing.map((n) => n.id));
    const result: SceneNode[] = [...existing];
    for (const c of newCells) {
      if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
    }
    if (anchorState) {
      const colSet = new Set(anchorState.colIdxs);
      colSet.add(colIdx);
      anchorState.colIdxs = [...colSet].sort((a, b) => a - b);
    }
    setPluginSelection(result);
    return { ok: true, message: `Добавлен столбец: ${result.length} ячеек` };
  }

  // row
  if (cls.mode !== "row" && cls.mode !== "both") return { ok: false, message: "Выделите строку" };
  const totalRows = model.visibleRowIdxs.length;
  if (cls.rowPositions.length >= totalRows) return { ok: false, message: "Все строки выделены" };
  const cursors = findCursors(cls.rowPositions, totalRows);
  const newPos = direction === "next"
    ? (cursors.right + 1) % totalRows
    : (cursors.left - 1 + totalRows) % totalRows;
  const rowIdx = model.visibleRowIdxs[newPos];
  const existing = figma.currentPage.selection;
  const newCells = cellsAtRow(model, rowIdx, true);
  const seen = new Set(existing.map((n) => n.id));
  const result: SceneNode[] = [...existing];
  for (const c of newCells) {
    if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
  }
  if (anchorState) {
    const rowSet = new Set(anchorState.rowIdxs);
    rowSet.add(rowIdx);
    anchorState.rowIdxs = [...rowSet].sort((a, b) => a - b);
  }
  setPluginSelection(result);
  return { ok: true, message: `Добавлена строка: ${result.length} ячеек` };
}

// ---------- actions: toggle header ----------

function toggleHeader(includeHeader: boolean): Response {
  void figma.clientStorage.setAsync(STORAGE_KEY_INCLUDE_HEADER, includeHeader);

  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    return { ok: true, message: `Заголовок: ${includeHeader ? "включён" : "выключен"}` };
  }
  const ctx = cacheCtx;
  if (!ctx) {
    return { ok: true, message: `Заголовок: ${includeHeader ? "включён" : "выключен"}` };
  }
  const model = ctx.model;
  if (model.visibleRowIdxs.length === 0) {
    return { ok: true, message: "В таблице нет рядов" };
  }

  const headerCells = cellsAtRow(model, model.headerRowIdx, true);
  const headerIds = new Set(headerCells.map((n) => n.id));

  if (!includeHeader) {
    const filtered = sel.filter((n) => !headerIds.has(n.id));
    setPluginSelection(filtered);
    return { ok: true, message: `Заголовок убран: ${filtered.length} ячеек` };
  }

  // Добавить header-ячейки для каждого столбца, представленного в выделении
  const colIdxsInSel = new Set<number>();
  for (const n of sel) {
    const lc = model.cellByNodeId.get(n.id);
    if (lc) colIdxsInSel.add(lc.colIdx);
  }
  const toAdd: SceneNode[] = [];
  for (const c of headerCells) {
    const lc = model.cellByNodeId.get(c.id);
    if (lc && colIdxsInSel.has(lc.colIdx)) toAdd.push(c);
  }
  const seenIds = new Set(sel.map((n) => n.id));
  const result: SceneNode[] = [...sel];
  for (const c of toAdd) {
    if (!seenIds.has(c.id)) result.push(c);
  }
  setPluginSelection(result);
  return { ok: true, message: `Заголовок добавлен: ${result.length} ячеек` };
}

// ---------- actions: structural — addColumn ----------

function addColumnStack(model: TableModel, anchorColIdx: number, direction: "prev" | "next"): SceneNode[] {
  const newCells: SceneNode[] = [];
  for (const rowIdx of model.allRowIdxs) {
    const rc = model.rowNodeByIdx.get(rowIdx);
    if (!rc) continue;
    const anchorCell = model.cells.find((lc) => lc.rowIdx === rowIdx && lc.colIdx === anchorColIdx);
    if (!anchorCell) continue;
    let anchorIdxInRow = -1;
    for (let i = 0; i < rc.children.length; i++) {
      if (rc.children[i].id === anchorCell.node.id) { anchorIdxInRow = i; break; }
    }
    if (anchorIdxInRow < 0) continue;
    const clone = anchorCell.node.clone();
    const insertIdx = direction === "next" ? anchorIdxInRow + 1 : anchorIdxInRow;
    rc.insertChild(insertIdx, clone);
    newCells.push(clone);
  }
  return newCells;
}

// Для GridAutoTracks="ROWS": setGridChildPosition запрещён, но insertChild и
// gridColumnCount разрешены. Вставляем клоны в нужные позиции массива детей,
// рассчитанные так, чтобы после изменения gridColumnCount раскладка совпала.
// Порядок: сначала вставки (с конца, чтобы индексы не съезжали), затем +gridColumnCount.
function addColumnGrid(model: TableModel, anchorColIdx: number, direction: "prev" | "next"): SceneNode[] {
  const body = model.body as FrameNode;
  const C = body.gridColumnCount;
  const newColIdx = direction === "next" ? anchorColIdx + 1 : anchorColIdx;
  const N = model.allRowIdxs.length;

  const cellByPos = new Map<string, SceneNode>();
  for (const lc of model.cells) cellByPos.set(`${lc.rowIdx},${lc.colIdx}`, lc.node);

  const clones: (SceneNode | null)[] = [];
  for (let r = 0; r < N; r++) {
    const src = cellByPos.get(`${r},${anchorColIdx}`);
    clones.push(src ? src.clone() : null);
  }

  // Вставляем с конца, чтобы предыдущие индексы оставались валидными
  for (let r = N - 1; r >= 0; r--) {
    const clone = clones[r];
    if (clone) body.insertChild(r * C + newColIdx, clone);
  }

  body.gridColumnCount = C + 1;

  return clones.filter((c): c is SceneNode => c !== null);
}

function addColumn(direction: "prev" | "next"): Response {
  const ctx = cacheCtx;
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };

  const sel = figma.currentPage.selection;
  let anchorColIdx: number | null = null;
  for (const n of sel) {
    const lc = ctx.model.cellByNodeId.get(n.id);
    if (!lc) continue;
    if (
      anchorColIdx === null ||
      (direction === "next" && lc.colIdx > anchorColIdx) ||
      (direction === "prev" && lc.colIdx < anchorColIdx)
    ) {
      anchorColIdx = lc.colIdx;
    }
  }
  if (anchorColIdx === null) return { ok: false, message: "Не найден столбец-якорь" };

  const newCells = ctx.model.type === "grid"
    ? addColumnGrid(ctx.model, anchorColIdx, direction)
    : addColumnStack(ctx.model, anchorColIdx, direction);

  if (newCells.length === 0) return { ok: false, message: "Не удалось продублировать" };
  invalidateModelCache(); // структура поменялась — кеш моделей устарел
  setPluginSelection(newCells);
  refreshCache();
  refreshAnchorFromSelection();
  return { ok: true, message: `Добавлен столбец: ${newCells.length} ячеек` };
}

// ---------- actions: structural — addRow ----------

function addRowStack(model: TableModel, anchorRowIdx: number, direction: "prev" | "next"): SceneNode[] {
  const anchorRow = model.rowNodeByIdx.get(anchorRowIdx);
  if (!anchorRow) return [];
  let anchorIdxInBody = -1;
  for (let i = 0; i < model.body.children.length; i++) {
    if (model.body.children[i].id === anchorRow.id) { anchorIdxInBody = i; break; }
  }
  if (anchorIdxInBody < 0) return [];

  const newRow = anchorRow.clone();
  const insertIdx = direction === "next" ? anchorIdxInBody + 1 : anchorIdxInBody;
  model.body.insertChild(insertIdx, newRow);

  if (!("children" in newRow)) return [];
  return [...(newRow as SceneNode & ChildrenMixin).children] as SceneNode[];
}

// Для GridAutoTracks="ROWS" gridRowCount менять запрещено — но рядов всё равно
// добавляется автоматически по факту наличия детей. Просто вставляем C клонов
// подряд по индексу newRowIdx * C — Figma сама создаст новый ряд.
function addRowGrid(model: TableModel, anchorRowIdx: number, direction: "prev" | "next"): SceneNode[] {
  const body = model.body as FrameNode;
  const C = body.gridColumnCount;
  const newRowIdx = direction === "next" ? anchorRowIdx + 1 : anchorRowIdx;

  const cellByCol = new Map<number, SceneNode>();
  for (const lc of model.cells) {
    if (lc.rowIdx === anchorRowIdx) cellByCol.set(lc.colIdx, lc.node);
  }

  const startIdx = newRowIdx * C;
  const newCells: SceneNode[] = [];
  for (let c = 0; c < C; c++) {
    const src = cellByCol.get(c);
    if (!src) continue;
    const clone = src.clone();
    body.insertChild(startIdx + c, clone);
    newCells.push(clone);
  }
  return newCells;
}

function addRow(direction: "prev" | "next"): Response {
  const ctx = cacheCtx;
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };

  const sel = figma.currentPage.selection;
  let anchorRowIdx: number | null = null;
  for (const n of sel) {
    const lc = ctx.model.cellByNodeId.get(n.id);
    if (!lc) continue;
    if (
      anchorRowIdx === null ||
      (direction === "next" && lc.rowIdx > anchorRowIdx) ||
      (direction === "prev" && lc.rowIdx < anchorRowIdx)
    ) {
      anchorRowIdx = lc.rowIdx;
    }
  }
  if (anchorRowIdx === null) return { ok: false, message: "Не найдена строка-якорь" };

  if (anchorRowIdx === ctx.model.headerRowIdx) {
    return { ok: false, message: "Заголовок может быть только один" };
  }

  const newCells = ctx.model.type === "grid"
    ? addRowGrid(ctx.model, anchorRowIdx, direction)
    : addRowStack(ctx.model, anchorRowIdx, direction);

  if (newCells.length === 0) return { ok: false, message: "Не удалось продублировать" };
  invalidateModelCache();
  setPluginSelection(newCells);
  refreshCache();
  refreshAnchorFromSelection();
  return { ok: true, message: `Добавлена строка: ${newCells.length} ячеек` };
}

// ---------- actions: move ----------

// Валидация: блок сплошной (по позициям), есть сосед с учётом wrap и пропуска skipPos.
// Возвращает isWrap — был ли это wrap-случай (с перескоком через край или skipPos).
function validateMoveBlock(
  positions: number[],
  visibleIdxs: number[],
  direction: "prev" | "next",
  skipPos: number | null,
): { ok: false } | { ok: true; blockIdxs: number[]; neighborIdx: number; isWrap: boolean } {
  if (positions.length === 0) return { ok: false };
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return { ok: false };
  }
  const total = visibleIdxs.length;
  if (skipPos !== null && sorted.indexOf(skipPos) >= 0) return { ok: false };
  const usableTotal = skipPos !== null ? total - 1 : total;
  if (sorted.length >= usableTotal) return { ok: false };

  const blockStartPos = sorted[0];
  const blockEndPos = sorted[sorted.length - 1];
  const inBlock = (p: number) => sorted.indexOf(p) >= 0;

  // Сначала пробуем сосед в естественном (не-wrap) направлении
  let naive: number;
  let isWrap: boolean;
  if (direction === "next") {
    naive = blockEndPos + 1;
    isWrap = naive >= total || naive === skipPos;
  } else {
    naive = blockStartPos - 1;
    isWrap = naive < 0 || naive === skipPos;
  }

  let neighborPos: number;
  if (!isWrap) {
    neighborPos = naive;
  } else {
    // Wrap: ищем ближайший допустимый сосед, перескакивая skipPos и блок
    let attempts = total + 1;
    if (direction === "next") {
      neighborPos = (blockEndPos + 1) % total;
      while ((neighborPos === skipPos || inBlock(neighborPos)) && attempts-- > 0) {
        neighborPos = (neighborPos + 1) % total;
      }
    } else {
      neighborPos = (blockStartPos - 1 + total) % total;
      while ((neighborPos === skipPos || inBlock(neighborPos)) && attempts-- > 0) {
        neighborPos = (neighborPos - 1 + total) % total;
      }
    }
    if (attempts < 0) return { ok: false };
  }

  return {
    ok: true,
    blockIdxs: sorted.map((p) => visibleIdxs[p]),
    neighborIdx: visibleIdxs[neighborPos],
    isWrap,
  };
}

// Карта вращения для non-wrap случая: участвуют только block + neighbor.
function buildRotationMap(
  blockIdxs: number[], neighborIdx: number, direction: "prev" | "next",
): Map<number, number> {
  const N = blockIdxs.length;
  const map = new Map<number, number>();
  if (direction === "next") {
    for (let i = 0; i < N - 1; i++) map.set(blockIdxs[i], blockIdxs[i + 1]);
    map.set(blockIdxs[N - 1], neighborIdx);
    map.set(neighborIdx, blockIdxs[0]);
  } else {
    for (let i = 1; i < N; i++) map.set(blockIdxs[i], blockIdxs[i - 1]);
    map.set(blockIdxs[0], neighborIdx);
    map.set(neighborIdx, blockIdxs[N - 1]);
  }
  return map;
}

// Карта вращения для WRAP случая: блок ЦЕЛИКОМ телепортируется на противоположный край цикла,
// остальные ячейки сдвигаются на N позиций в обратном направлении чтобы заполнить освободившееся место.
// Это сохраняет contigous-ность блока (важно для multi-block move).
function buildWrapRotationMap(
  cycleIdxs: number[], // все idx в цикле, отсортированные по возрастанию
  blockIdxs: number[], // contiguous блок (subset of cycleIdxs), отсортированный
  direction: "prev" | "next",
): Map<number, number> {
  const map = new Map<number, number>();
  const T = cycleIdxs.length;
  const N = blockIdxs.length;
  if (T === 0 || N === 0 || N >= T) return map;

  if (direction === "prev") {
    // Wrap "prev" возможен только когда блок в начале цикла (cycle positions 0..N-1).
    // Блок едет на конец (cycle positions T-N..T-1).
    // Не-блок (cycle positions N..T-1) сдвигается налево на N (на cycle positions 0..T-N-1).
    for (let i = 0; i < N; i++) {
      map.set(cycleIdxs[i], cycleIdxs[T - N + i]);
    }
    for (let i = 0; i < T - N; i++) {
      map.set(cycleIdxs[N + i], cycleIdxs[i]);
    }
  } else {
    // Wrap "next" возможен только когда блок в конце цикла (cycle positions T-N..T-1).
    // Блок едет в начало (cycle positions 0..N-1).
    // Не-блок (cycle positions 0..T-N-1) сдвигается направо на N (на cycle positions N..T-1).
    for (let i = 0; i < N; i++) {
      map.set(cycleIdxs[T - N + i], cycleIdxs[i]);
    }
    for (let i = 0; i < T - N; i++) {
      map.set(cycleIdxs[i], cycleIdxs[N + i]);
    }
  }
  return map;
}

// Перемещение child внутри того же родителя в Figma имеет "insert + remove" семантику:
// если target > currentIdx, после удаления старой позиции узел оказывается на target-1.
// Компенсируем этот off-by-one инкрементом target.
function moveWithinParent(
  parent: ChildrenMixin, target: number, child: SceneNode, currentIdx: number,
): void {
  if (currentIdx === target) return;
  const adjusted = currentIdx < target ? target + 1 : target;
  parent.insertChild(adjusted, child);
}

function moveColumnStack(model: TableModel, rotation: Map<number, number>): boolean {
  const involved = new Set<number>([...rotation.keys()]);
  const sortedTargets = [...involved].sort((a, b) => a - b);

  for (const rowIdx of model.allRowIdxs) {
    const rowNode = model.rowNodeByIdx.get(rowIdx);
    if (!rowNode) continue;
    const cellBySource = new Map<number, SceneNode>();
    for (const lc of model.cells) {
      if (lc.rowIdx === rowIdx && involved.has(lc.colIdx)) cellBySource.set(lc.colIdx, lc.node);
    }
    for (const target of sortedTargets) {
      let source: number | undefined;
      for (const [s, t] of rotation) if (t === target) { source = s; break; }
      if (source === undefined) continue;
      const cell = cellBySource.get(source);
      if (!cell) continue;
      let currentIdx = -1;
      for (let i = 0; i < rowNode.children.length; i++) {
        if (rowNode.children[i].id === cell.id) { currentIdx = i; break; }
      }
      moveWithinParent(rowNode, target, cell, currentIdx);
    }
  }
  return true;
}

function moveColumn(direction: "prev" | "next"): Response {
  const ctx = cacheCtx;
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  if (ctx.model.type === "grid") {
    return { ok: false, message: "Перемещение в grid-таблицах пока не поддерживается" };
  }
  const cls = classifySelection();
  if (cls.mode !== "column") return { ok: false, message: "Выделите столбец" };
  const validate = validateMoveBlock(cls.colPositions, ctx.model.visibleColIdxs, direction, null);
  if (!validate.ok) return { ok: false, message: "Нельзя двигать" };

  const rotation = validate.isWrap
    ? buildWrapRotationMap(ctx.model.visibleColIdxs, validate.blockIdxs, direction)
    : buildRotationMap(validate.blockIdxs, validate.neighborIdx, direction);

  const ok = moveColumnStack(ctx.model, rotation);

  if (!ok) return { ok: false, message: "Не удалось переместить" };
  invalidateModelCache();
  refreshCache();
  refreshAnchorFromSelection();
  return { ok: true, message: `Столбец перемещён ${direction === "next" ? "вправо" : "влево"}` };
}

function moveRowStack(model: TableModel, rotation: Map<number, number>): boolean {
  const involved = new Set<number>([...rotation.keys()]);
  const sortedTargets = [...involved].sort((a, b) => a - b);
  const body = model.body;

  const rowBySource = new Map<number, SceneNode & ChildrenMixin>();
  for (const idx of involved) {
    const rn = model.rowNodeByIdx.get(idx);
    if (rn) rowBySource.set(idx, rn);
  }

  for (const target of sortedTargets) {
    let source: number | undefined;
    for (const [s, t] of rotation) if (t === target) { source = s; break; }
    if (source === undefined) continue;
    const row = rowBySource.get(source);
    if (!row) continue;
    let currentIdx = -1;
    for (let i = 0; i < body.children.length; i++) {
      if (body.children[i].id === row.id) { currentIdx = i; break; }
    }
    moveWithinParent(body, target, row, currentIdx);
  }
  return true;
}

function moveRow(direction: "prev" | "next"): Response {
  const ctx = cacheCtx;
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  if (ctx.model.type === "grid") {
    return { ok: false, message: "Перемещение в grid-таблицах пока не поддерживается" };
  }
  const cls = classifySelection();
  if (cls.mode !== "row") return { ok: false, message: "Выделите строку" };

  const headerPos = ctx.model.visibleRowIdxs.indexOf(ctx.model.headerRowIdx);
  const skipPos = headerPos >= 0 ? headerPos : null;

  const validate = validateMoveBlock(cls.rowPositions, ctx.model.visibleRowIdxs, direction, skipPos);
  if (!validate.ok) return { ok: false, message: "Нельзя двигать" };

  let rotation: Map<number, number>;
  if (validate.isWrap) {
    // При wrap — блок целиком телепортируется на противоположный край цикла (видимые ряды без Header).
    const cycleIdxs = ctx.model.visibleRowIdxs.filter((idx) => idx !== ctx.model.headerRowIdx);
    rotation = buildWrapRotationMap(cycleIdxs, validate.blockIdxs, direction);
  } else {
    rotation = buildRotationMap(validate.blockIdxs, validate.neighborIdx, direction);
  }

  const ok = moveRowStack(ctx.model, rotation);

  if (!ok) return { ok: false, message: "Не удалось переместить" };
  invalidateModelCache();
  refreshCache();
  refreshAnchorFromSelection();
  return { ok: true, message: `Строка перемещена ${direction === "next" ? "вниз" : "вверх"}` };
}

// ---------- state push ----------

function computeNavState(): NavState {
  const cls = classifySelection();
  const state: NavState = {
    canPrevCol: false, canNextCol: false,
    canPrevRow: false, canNextRow: false,
    canExpColLeft: false, canExpColRight: false,
    canExpRowUp: false, canExpRowDown: false,
    canShrinkColLeft: false, canShrinkColRight: false,
    canShrinkRowUp: false, canShrinkRowDown: false,
    canSelectAll: false,
    canClearSelection: false,
    canAddColLeft: false, canAddColRight: false,
    canAddRowUp: false, canAddRowDown: false,
    canMoveColLeft: false, canMoveColRight: false,
    canMoveRowUp: false, canMoveRowDown: false,
  };

  const figmaSel = figma.currentPage.selection;
  const sel = effectiveSelection();
  const ctx = cacheCtx;
  const hasCell = ctx !== null;

  if (hasCell) state.canSelectAll = true;
  if (figmaSel.length > 0) state.canClearSelection = true;

  // Move-кнопки только для stack-таблиц.
  const isGrid = ctx !== null && ctx.model.type === "grid";

  const isHeaderRowIdx = (rowIdx: number): boolean => ctx !== null && rowIdx === ctx.model.headerRowIdx;

  const findEdgeRowIdxs = (): { top: number | null; bottom: number | null } => {
    let top: number | null = null;
    let bottom: number | null = null;
    if (!ctx) return { top, bottom };
    for (const n of sel) {
      if (!isVisible(n)) continue;
      const lc = ctx.model.cellByNodeId.get(n.id);
      if (!lc) continue;
      if (top === null || lc.rowIdx < top) top = lc.rowIdx;
      if (bottom === null || lc.rowIdx > bottom) bottom = lc.rowIdx;
    }
    return { top, bottom };
  };

  // Nav: активны если есть anchor и это не "all" режим.
  if (hasCell && anchorState && cls.mode !== "all") {
    state.canPrevCol = true;
    state.canNextCol = true;
    state.canPrevRow = true;
    state.canNextRow = true;
  }

  // Shrink: активны если в anchor минимум 2 ряда/столбца И ось селекции допускает.
  // Для axis="row" (выделена полная строка) shrink-col не имеет смысла — у строки
  // нет «горизонтального края» который можно было бы обрезать без потери понятия
  // «выделена строка». Симметрично для axis="column".
  if (anchorState) {
    const axis = anchorState.axis;
    if (anchorState.colIdxs.length >= 2 && axis !== "row") {
      state.canShrinkColLeft = true;
      state.canShrinkColRight = true;
    }
    if (anchorState.rowIdxs.length >= 2 && axis !== "column") {
      state.canShrinkRowUp = true;
      state.canShrinkRowDown = true;
    }
  }

  // Expand / Add / Move — старая логика на классификации.
  if (cls.mode === "none") {
    if (hasCell && sel.length === 1 && isVisible(sel[0])) {
      const lc = ctx!.model.cellByNodeId.get(sel[0].id);
      if (lc) {
        const inHeader = isHeaderRowIdx(lc.rowIdx);
        state.canAddColLeft = true;
        state.canAddColRight = true;
        state.canAddRowUp = !inHeader;
        state.canAddRowDown = !inHeader;
      }
    }
    return state;
  }

  if (cls.mode === "all") return state;

  const colActive = (cls.mode === "column" || cls.mode === "both") && cls.colPositions.length < cls.totalCols;
  const rowActive = (cls.mode === "row" || cls.mode === "both") && cls.rowPositions.length < cls.totalRows;

  if (colActive) {
    state.canExpColLeft = true;
    state.canExpColRight = true;
  }
  if (rowActive) {
    state.canExpRowUp = true;
    state.canExpRowDown = true;
  }

  if (cls.mode === "column") {
    state.canAddColLeft = true;
    state.canAddColRight = true;
    if (!isGrid) {
      const leftVal = validateMoveBlock(cls.colPositions, ctx!.model.visibleColIdxs, "prev", null);
      const rightVal = validateMoveBlock(cls.colPositions, ctx!.model.visibleColIdxs, "next", null);
      state.canMoveColLeft = leftVal.ok;
      state.canMoveColRight = rightVal.ok;
    }
  } else if (cls.mode === "row") {
    const edges = findEdgeRowIdxs();
    state.canAddRowUp = edges.top !== null && !isHeaderRowIdx(edges.top);
    state.canAddRowDown = edges.bottom !== null && !isHeaderRowIdx(edges.bottom);
    if (ctx && !isGrid) {
      const headerPos = ctx.model.visibleRowIdxs.indexOf(ctx.model.headerRowIdx);
      const skipPos = headerPos >= 0 ? headerPos : null;
      const upVal = validateMoveBlock(cls.rowPositions, ctx.model.visibleRowIdxs, "prev", skipPos);
      const downVal = validateMoveBlock(cls.rowPositions, ctx.model.visibleRowIdxs, "next", skipPos);
      state.canMoveRowUp = upVal.ok;
      state.canMoveRowDown = downVal.ok;
    }
  }

  return state;
}

function pushNavState() {
  figma.ui.postMessage({ type: "nav-state", ...computeNavState() });
}

function pushStatusFromSelection() {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    figma.ui.postMessage({ type: "status", ok: true, message: "Выделите ячейку таблицы" });
  } else if (!cacheCtx) {
    figma.ui.postMessage({ type: "status", ok: false, message: "Это не похоже на таблицу" });
  }
}

figma.on("selectionchange", () => {
  // На каждый selectionchange — сбрасываем модель-кеш. Внутри одного
  // хендлера effectiveSelection/findTableContext дёргаются 5-6 раз;
  // без кеша каждый из них пересчитывает buildStackModel заново.
  invalidateModelCache();

  const currentIds = figma.currentPage.selection.map((n) => n.id);
  const isOurChange = matchesLastPluginSelection(currentIds);
  lastPluginSelectionIds = null;

  refreshCache();
  if (!isOurChange) {
    refreshAnchorFromSelection();
    // Если effective-selection отличается от figma-выделения, значит юзер выделил
    // row-контейнер. Запоминаем cells для двухшагового коммита по action-кнопке.
    const eff = effectiveSelection();
    pendingContainerCells = idsDiffer(eff.map((n) => n.id), currentIds) ? eff : null;
  }
  pushNavState();
  pushStatusFromSelection();
});

function matchesLastPluginSelection(currentIds: string[]): boolean {
  if (lastPluginSelectionIds === null || currentIds.length !== lastPluginSelectionIds.size) return false;
  return currentIds.every((id) => lastPluginSelectionIds!.has(id));
}

function idsDiffer(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const setA = new Set(a);
  for (const id of b) if (!setA.has(id)) return true;
  return false;
}

type UiMessage = {
  type: string;
  includeHeader?: boolean;
  mode?: "column" | "row";
  direction?: "prev" | "next";
};

// Action-кнопки секций (двухшаговые при выделенном row-контейнере).
const TWO_STEP_ACTIONS = new Set(["nav", "expand", "shrink", "add", "move"]);

// Маппинг msg.type → обработчик. Возвращает Response или undefined (если
// сообщение незнакомое).
const ACTIONS: { [k: string]: (m: UiMessage) => Response } = {
  "select-row": () => selectRow(),
  "select-column": (m) => selectColumn(m.includeHeader === true),
  "select-all": (m) => selectAll(m.includeHeader === true),
  "clear-selection": () => clearSelection(),
  "toggle-header": (m) => toggleHeader(m.includeHeader === true),
  "nav": (m) => navigate(m.mode!, m.direction!, m.includeHeader === true),
  "expand": (m) => expand(m.mode!, m.direction!, m.includeHeader === true),
  "shrink": (m) => shrink(m.mode!, m.direction!, m.includeHeader === true),
  "add": (m) => m.mode === "column" ? addColumn(m.direction!) : addRow(m.direction!),
  "move": (m) => m.mode === "column" ? moveColumn(m.direction!) : moveRow(m.direction!),
};

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === "init") {
    const stored = await figma.clientStorage.getAsync(STORAGE_KEY_INCLUDE_HEADER);
    figma.ui.postMessage({ type: "init-state", includeHeader: stored === undefined ? true : Boolean(stored) });
    refreshCache();
    refreshAnchorFromSelection();
    pushNavState();
    pushStatusFromSelection();
    return;
  }

  // Двухшаговый коммит для row-контейнеров: первое нажатие переводит figma-выделение
  // на ячейки, сам action не выполняется. Следующее нажатие — уже action.
  if (TWO_STEP_ACTIONS.has(msg.type) && pendingContainerCells !== null) {
    const cells = pendingContainerCells;
    pendingContainerCells = null;
    setPluginSelection(cells);
    refreshCache();
    refreshAnchorFromSelection();
    pushNavState();
    figma.ui.postMessage({ type: "status", ok: true, message: `Выделены ячейки: ${cells.length}` });
    return;
  }

  const handler = ACTIONS[msg.type];
  const response = handler ? handler(msg) : undefined;

  if (response) {
    pushNavState();
    figma.ui.postMessage({ type: "status", ok: response.ok, message: response.message });
  }
};
