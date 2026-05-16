figma.showUI(__html__, { width: 280, height: 500 });

const X_TOLERANCE = 1;
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
  canSelectAll: boolean;
  canAddColLeft: boolean;
  canAddColRight: boolean;
  canAddRowUp: boolean;
  canAddRowDown: boolean;
};

type Classification = {
  mode: "none" | "row" | "column" | "all" | "both";
  rowIndices: number[];
  colIndices: number[];
  totalRows: number;
  totalCols: number;
};

type TableContext = {
  cell: SceneNode;
  row: SceneNode & ChildrenMixin;
  body: BaseNode & ChildrenMixin;
};

type BodyAnalysis = {
  isTable: boolean;
  allRows: SceneNode[];
  visibleRows: SceneNode[];
  columnXs: number[];
};

// ---------- visibility ----------

function isVisible(node: BaseNode): boolean {
  return !("visible" in node) || (node as SceneNode).visible !== false;
}

function visibleChildren(node: SceneNode & ChildrenMixin): SceneNode[] {
  const out: SceneNode[] = [];
  for (const c of node.children) {
    if (isVisible(c)) out.push(c as SceneNode);
  }
  return out;
}

// ---------- single-pass body analysis ----------

const EMPTY_ANALYSIS: BodyAnalysis = { isTable: false, allRows: [], visibleRows: [], columnXs: [] };

// За один проход по body.children собираем: список рядов (все/видимые), позиции
// столбцов, флаг "это таблица". Один box-call на ячейку.
function analyzeBody(body: BaseNode): BodyAnalysis {
  if (!("children" in body)) return EMPTY_ANALYSIS;
  const b = body as BaseNode & ChildrenMixin;
  if (b.children.length < MIN_ROWS_FOR_TABLE) return EMPTY_ANALYSIS;

  type RowData = {
    row: SceneNode;
    allXs: Set<number>;
    visibleXs: Set<number>;
    visibleXActual: Map<number, number>;
    rowVisible: boolean;
    y: number;
  };
  const rowDataList: RowData[] = [];

  for (const c of b.children) {
    if (!("children" in c)) continue;
    const rowVisible = isVisible(c);
    const allXs = new Set<number>();
    const visibleXs = new Set<number>();
    const visibleXActual = new Map<number, number>();
    let rowY = 0;
    const rowBox = (c as SceneNode).absoluteBoundingBox;
    if (rowBox) rowY = rowBox.y;
    for (const cell of (c as SceneNode & ChildrenMixin).children) {
      const box = cell.absoluteBoundingBox;
      if (!box) continue;
      const rounded = Math.round(box.x);
      allXs.add(rounded);
      if (isVisible(cell)) {
        visibleXs.add(rounded);
        if (!visibleXActual.has(rounded)) visibleXActual.set(rounded, box.x);
      }
    }
    if (allXs.size > 0) {
      rowDataList.push({ row: c as SceneNode, allXs, visibleXs, visibleXActual, rowVisible, y: rowY });
    }
  }

  if (rowDataList.length < MIN_ROWS_FOR_TABLE) return EMPTY_ANALYSIS;

  // Подсчёт alignment по всем рядам — отсев нетаблиц
  const allXCount = new Map<number, number>();
  for (const rd of rowDataList) {
    for (const x of rd.allXs) allXCount.set(x, (allXCount.get(x) || 0) + 1);
  }
  const allRealCols = new Set<number>();
  for (const [x, c] of allXCount) if (c >= 2) allRealCols.add(x);
  if (allRealCols.size < MIN_ALIGNED_COLS_FOR_TABLE) return EMPTY_ANALYSIS;

  // allRows: ряды с ≥1 X в реальном столбце
  const allRows: SceneNode[] = [];
  for (const rd of rowDataList) {
    for (const x of rd.allXs) {
      if (allRealCols.has(x)) { allRows.push(rd.row); break; }
    }
  }
  allRows.sort((a, b) => {
    const aData = rowDataList.find((r) => r.row.id === a.id);
    const bData = rowDataList.find((r) => r.row.id === b.id);
    return (aData?.y ?? 0) - (bData?.y ?? 0);
  });

  // Видимые ряды: rowVisible + есть видимая ячейка в реальном видимом столбце
  const visibleRDs = rowDataList.filter((rd) => rd.rowVisible);
  const visXCount = new Map<number, number>();
  for (const rd of visibleRDs) {
    for (const x of rd.visibleXs) visXCount.set(x, (visXCount.get(x) || 0) + 1);
  }
  const visRealCols = new Set<number>();
  for (const [x, c] of visXCount) if (c >= 2) visRealCols.add(x);

  const visibleRows: SceneNode[] = [];
  const visibleXActualMap = new Map<number, number>();
  for (const rd of visibleRDs) {
    let any = false;
    for (const x of rd.visibleXs) {
      if (visRealCols.has(x)) {
        any = true;
        if (!visibleXActualMap.has(x)) {
          visibleXActualMap.set(x, rd.visibleXActual.get(x)!);
        }
      }
    }
    if (any) visibleRows.push(rd.row);
  }
  visibleRows.sort((a, b) => {
    const aData = rowDataList.find((r) => r.row.id === a.id);
    const bData = rowDataList.find((r) => r.row.id === b.id);
    return (aData?.y ?? 0) - (bData?.y ?? 0);
  });

  const columnXs = [...visibleXActualMap.values()].sort((a, b) => a - b);

  return { isTable: true, allRows, visibleRows, columnXs };
}

// ---------- table context discovery ----------

function findTableContext(seed: SceneNode): { ctx: TableContext; analysis: BodyAnalysis } | null {
  let current: BaseNode = seed;
  let safety = 50;
  while (safety-- > 0) {
    const possibleRow: (BaseNode & ChildrenMixin) | null = current.parent;
    if (!possibleRow) return null;
    const possibleBody: (BaseNode & ChildrenMixin) | null = possibleRow.parent;
    if (!possibleBody) return null;
    const analysis = analyzeBody(possibleBody);
    if (analysis.isTable && "children" in possibleRow) {
      // possibleRow должен быть среди реальных рядов
      let found = false;
      for (const r of analysis.allRows) {
        if (r.id === possibleRow.id) { found = true; break; }
      }
      if (found) {
        return {
          ctx: {
            cell: current as SceneNode,
            row: possibleRow as SceneNode & ChildrenMixin,
            body: possibleBody,
          },
          analysis,
        };
      }
    }
    current = possibleRow;
  }
  return null;
}

// ---------- cache ----------

let cacheCtx: TableContext | null = null;
let cacheBodyId: string | null = null;
let cacheAllRows: SceneNode[] = [];
let cacheVisibleRows: SceneNode[] = [];
let cacheAllRowIds: Set<string> = new Set();
let cacheColumnXs: number[] = [];
let cacheHeaderId: string | null = null;

function refreshCache() {
  const sel = figma.currentPage.selection;
  const result = sel.length > 0 ? findTableContext(sel[0]) : null;
  if (result) {
    cacheCtx = result.ctx;
    cacheBodyId = result.ctx.body.id;
    cacheAllRows = result.analysis.allRows;
    cacheVisibleRows = result.analysis.visibleRows;
    cacheAllRowIds = new Set(cacheAllRows.map((r) => r.id));
    cacheColumnXs = result.analysis.columnXs;
    cacheHeaderId = cacheVisibleRows.length > 0 ? cacheVisibleRows[0].id : null;
  } else {
    cacheCtx = null;
    cacheBodyId = null;
    cacheAllRows = [];
    cacheVisibleRows = [];
    cacheAllRowIds = new Set();
    cacheColumnXs = [];
    cacheHeaderId = null;
  }
}

function getContext(): TableContext | null {
  return cacheCtx;
}

function getVisibleRows(body: BaseNode & ChildrenMixin): SceneNode[] {
  if (cacheBodyId === body.id) return cacheVisibleRows;
  return analyzeBody(body).visibleRows;
}

function getAllRows(body: BaseNode & ChildrenMixin): SceneNode[] {
  if (cacheBodyId === body.id) return cacheAllRows;
  return analyzeBody(body).allRows;
}

function getColumnXs(body: BaseNode & ChildrenMixin): number[] {
  if (cacheBodyId === body.id) return cacheColumnXs;
  return analyzeBody(body).columnXs;
}

function getHeaderId(body: BaseNode & ChildrenMixin): string | null {
  if (cacheBodyId === body.id) return cacheHeaderId;
  const vr = analyzeBody(body).visibleRows;
  return vr.length > 0 ? vr[0].id : null;
}

function isHeaderRow(row: BaseNode | null, body: BaseNode & ChildrenMixin): boolean {
  if (!row) return false;
  const headerId = getHeaderId(body);
  return headerId !== null && row.id === headerId;
}

// Быстрый поиск ячейки через закэшированные rowIds. Если узел не в кэше — fallback.
function findCell(node: SceneNode): SceneNode | null {
  if (cacheCtx) {
    let current: BaseNode = node;
    let safety = 50;
    while (current.parent && safety-- > 0) {
      if (cacheAllRowIds.has(current.parent.id)) return current as SceneNode;
      current = current.parent;
      if (current.id === cacheCtx.body.id) return null;
    }
  }
  const result = findTableContext(node);
  return result ? result.ctx.cell : null;
}

// ---------- selection helpers ----------

function colIndexOf(xs: number[], x: number): number {
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(xs[i] - x) < X_TOLERANCE) return i;
  }
  return -1;
}

function selectCellsAtX(body: BaseNode & ChildrenMixin, targetX: number, includeHeader: boolean): SceneNode[] {
  const result: SceneNode[] = [];
  const rows = getVisibleRows(body);
  const headerId = rows.length > 0 ? rows[0].id : null;
  for (const row of rows) {
    if (!includeHeader && row.id === headerId) continue;
    if (!("children" in row)) continue;
    for (const candidate of (row as SceneNode & ChildrenMixin).children) {
      if (!isVisible(candidate)) continue;
      const cBox = candidate.absoluteBoundingBox;
      if (!cBox) continue;
      if (Math.abs(cBox.x - targetX) < X_TOLERANCE) {
        result.push(candidate as SceneNode);
      }
    }
  }
  return result;
}

function findCursors(indices: number[], total: number): { left: number; right: number } {
  if (indices.length === 0 || indices.length === total) return { left: 0, right: 0 };
  let maxGap = -1;
  let maxAt = 0;
  for (let i = 0; i < indices.length; i++) {
    const nxt = (i + 1) % indices.length;
    const gap = nxt === 0 ? (indices[0] + total) - indices[i] - 1 : indices[nxt] - indices[i] - 1;
    if (gap > maxGap) {
      maxGap = gap;
      maxAt = i;
    }
  }
  return {
    right: indices[maxAt],
    left: indices[(maxAt + 1) % indices.length],
  };
}

// ---------- classification ----------

function classifySelection(): Classification {
  const empty: Classification = {
    mode: "none", rowIndices: [], colIndices: [], totalRows: 0, totalCols: 0,
  };
  const sel = figma.currentPage.selection;
  if (sel.length === 0 || !cacheCtx) return empty;

  const universeRows = cacheVisibleRows;
  const rowIdToIdx = new Map<string, number>();
  universeRows.forEach((r, i) => rowIdToIdx.set(r.id, i));

  const xs = cacheColumnXs;

  const byParent = new Map<string, Set<number>>();
  const byX = new Map<number, Set<string>>();
  for (const n of sel) {
    if (!isVisible(n)) continue;
    const p = n.parent;
    if (!p || !rowIdToIdx.has(p.id)) return empty;
    const box = n.absoluteBoundingBox;
    if (!box) return empty;
    const xIdx = colIndexOf(xs, box.x);
    if (xIdx < 0) return empty;

    if (!byParent.has(p.id)) byParent.set(p.id, new Set());
    byParent.get(p.id)!.add(xIdx);

    if (!byX.has(xIdx)) byX.set(xIdx, new Set());
    byX.get(xIdx)!.add(p.id);
  }

  if (byParent.size === 0) return empty;

  let fullRow = true;
  for (const [pid, xIdxs] of byParent) {
    const row = universeRows.find((r) => r.id === pid);
    if (!row || !("children" in row)) { fullRow = false; break; }
    const rowXs = new Set<number>();
    for (const cell of (row as SceneNode & ChildrenMixin).children) {
      if (!isVisible(cell)) continue;
      const b = cell.absoluteBoundingBox;
      if (b) {
        const xi = colIndexOf(xs, b.x);
        if (xi >= 0) rowXs.add(xi);
      }
    }
    if (xIdxs.size !== rowXs.size) { fullRow = false; break; }
  }

  const touchedParents = new Set(byParent.keys());
  let fullCol = true;
  for (const [, parentIds] of byX) {
    if (parentIds.size !== touchedParents.size) { fullCol = false; break; }
    let allMatch = true;
    for (const pid of touchedParents) {
      if (!parentIds.has(pid)) { allMatch = false; break; }
    }
    if (!allMatch) { fullCol = false; break; }
  }

  const colIndices = [...byX.keys()].sort((a, b) => a - b);
  const rowIndices = [...byParent.keys()].map((id) => rowIdToIdx.get(id)!).sort((a, b) => a - b);

  let mode: Classification["mode"] = "none";
  const isRow = fullRow && byParent.size >= 1;
  const isCol = fullCol && byParent.size >= 2 && byX.size >= 1;

  if (isRow && isCol) {
    if (rowIndices.length === universeRows.length && colIndices.length === xs.length) {
      mode = "all";
    } else if (universeRows.length === 0 || xs.length === 0) {
      mode = "both";
    } else {
      const rowSat = rowIndices.length / universeRows.length;
      const colSat = colIndices.length / xs.length;
      if (colSat > rowSat) mode = "row";
      else if (rowSat > colSat) mode = "column";
      else mode = "both";
    }
  } else if (isRow) {
    mode = "row";
  } else if (isCol) {
    mode = "column";
  }

  return { mode, rowIndices, colIndices, totalRows: universeRows.length, totalCols: xs.length };
}

// ---------- actions ----------

function selectRow(): Response {
  const ctx = getContext();
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  if (!isVisible(ctx.row)) return { ok: false, message: "Строка скрыта" };
  const cells = visibleChildren(ctx.row);
  if (cells.length === 0) return { ok: false, message: "В строке нет видимых ячеек" };
  figma.currentPage.selection = cells;
  return { ok: true, message: `Выделена строка: ${cells.length} ячеек` };
}

function selectColumn(includeHeader: boolean): Response {
  const ctx = getContext();
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  const box = ctx.cell.absoluteBoundingBox;
  if (!box) return { ok: false, message: "У ячейки нет координат" };
  const result = selectCellsAtX(ctx.body, box.x, includeHeader);
  if (result.length === 0) return { ok: false, message: "В столбце ничего не найдено" };
  figma.currentPage.selection = result;
  return { ok: true, message: `Выделен столбец: ${result.length} ячеек` };
}

function selectAll(includeHeader: boolean): Response {
  const ctx = getContext();
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  const rows = getVisibleRows(ctx.body);
  const headerId = rows.length > 0 ? rows[0].id : null;
  const result: SceneNode[] = [];
  for (const row of rows) {
    if (!includeHeader && row.id === headerId) continue;
    if (!("children" in row)) continue;
    for (const cell of (row as SceneNode & ChildrenMixin).children) {
      if (!isVisible(cell)) continue;
      result.push(cell as SceneNode);
    }
  }
  if (result.length === 0) return { ok: false, message: "Нет видимых ячеек" };
  figma.currentPage.selection = result;
  return { ok: true, message: `Все ячейки: ${result.length}` };
}

function navigate(mode: "column" | "row", direction: "prev" | "next", includeHeader: boolean): Response {
  const ctx = getContext();
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  const cls = classifySelection();
  const step = direction === "next" ? 1 : -1;

  if (mode === "column") {
    const xs = getColumnXs(ctx.body);
    if (xs.length === 0) return { ok: false, message: "Нет столбцов" };
    const cur = cls.colIndices;
    if (cur.length === 0 || cls.mode === "row") return { ok: false, message: "Выделите столбец" };
    const newIdx = cur.map((i) => (((i + step) % xs.length) + xs.length) % xs.length);
    const seen = new Set<string>();
    const result: SceneNode[] = [];
    for (const idx of newIdx) {
      const cells = selectCellsAtX(ctx.body, xs[idx], includeHeader);
      for (const c of cells) {
        if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
      }
    }
    if (result.length === 0) return { ok: false, message: "Пусто" };
    figma.currentPage.selection = result;
    return { ok: true, message: `Столбец сдвинут: ${result.length} ячеек` };
  }

  const rows = getVisibleRows(ctx.body);
  if (rows.length === 0) return { ok: false, message: "Нет строк" };
  const cur = cls.rowIndices;
  if (cur.length === 0 || cls.mode === "column") return { ok: false, message: "Выделите строку" };
  const newIdx = cur.map((i) => (((i + step) % rows.length) + rows.length) % rows.length);
  const seen = new Set<string>();
  const result: SceneNode[] = [];
  for (const idx of newIdx) {
    const row = rows[idx] as SceneNode & ChildrenMixin;
    for (const c of visibleChildren(row)) {
      if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
    }
  }
  if (result.length === 0) return { ok: false, message: "Пусто" };
  figma.currentPage.selection = result;
  return { ok: true, message: `Строка сдвинута: ${result.length} ячеек` };
}

function toggleHeader(includeHeader: boolean): Response {
  void figma.clientStorage.setAsync(STORAGE_KEY_INCLUDE_HEADER, includeHeader);

  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    return { ok: true, message: `Заголовок: ${includeHeader ? "включён" : "выключен"}` };
  }
  const ctx = getContext();
  if (!ctx) {
    return { ok: true, message: `Заголовок: ${includeHeader ? "включён" : "выключен"}` };
  }

  const rows = getVisibleRows(ctx.body);
  if (rows.length === 0) {
    return { ok: true, message: "В таблице нет рядов" };
  }
  const headerRow = rows[0] as SceneNode & ChildrenMixin;
  const headerIds = new Set<string>();
  for (const c of headerRow.children) headerIds.add(c.id);

  if (!includeHeader) {
    const filtered = sel.filter((n) => !headerIds.has(n.id));
    figma.currentPage.selection = filtered;
    return { ok: true, message: `Заголовок убран: ${filtered.length} ячеек` };
  }

  const xs: number[] = [];
  const seenX = new Set<number>();
  for (const n of sel) {
    if (!isVisible(n)) continue;
    const b = n.absoluteBoundingBox;
    if (!b) continue;
    const rounded = Math.round(b.x);
    if (!seenX.has(rounded)) { seenX.add(rounded); xs.push(b.x); }
  }

  const toAdd: SceneNode[] = [];
  for (const cell of headerRow.children) {
    if (!isVisible(cell)) continue;
    const b = cell.absoluteBoundingBox;
    if (!b) continue;
    if (xs.some((x) => Math.abs(b.x - x) < X_TOLERANCE)) {
      toAdd.push(cell as SceneNode);
    }
  }

  const seenIds = new Set(sel.map((n) => n.id));
  const result: SceneNode[] = [...sel];
  for (const c of toAdd) {
    if (!seenIds.has(c.id)) result.push(c);
  }
  figma.currentPage.selection = result;
  return { ok: true, message: `Заголовок добавлен: ${result.length} ячеек` };
}

function expand(mode: "column" | "row", direction: "prev" | "next", includeHeader: boolean): Response {
  const ctx = getContext();
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };
  const cls = classifySelection();

  if (mode === "column") {
    if (cls.mode !== "column" && cls.mode !== "both") return { ok: false, message: "Выделите столбец" };
    const xs = getColumnXs(ctx.body);
    if (cls.colIndices.length >= xs.length) return { ok: false, message: "Все столбцы выделены" };
    const cursors = findCursors(cls.colIndices, xs.length);
    const newIdx = direction === "next"
      ? (cursors.right + 1) % xs.length
      : (cursors.left - 1 + xs.length) % xs.length;
    const existing = figma.currentPage.selection;
    const newCells = selectCellsAtX(ctx.body, xs[newIdx], includeHeader);
    const seen = new Set(existing.map((n) => n.id));
    const result: SceneNode[] = [...existing];
    for (const c of newCells) {
      if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
    }
    figma.currentPage.selection = result;
    return { ok: true, message: `Добавлен столбец: ${result.length} ячеек` };
  }

  if (cls.mode !== "row" && cls.mode !== "both") return { ok: false, message: "Выделите строку" };
  const rows = getVisibleRows(ctx.body);
  if (cls.rowIndices.length >= rows.length) return { ok: false, message: "Все строки выделены" };
  const cursors = findCursors(cls.rowIndices, rows.length);
  const newIdx = direction === "next"
    ? (cursors.right + 1) % rows.length
    : (cursors.left - 1 + rows.length) % rows.length;
  const existing = figma.currentPage.selection;
  const newRow = rows[newIdx] as SceneNode & ChildrenMixin;
  const seen = new Set(existing.map((n) => n.id));
  const result: SceneNode[] = [...existing];
  for (const c of visibleChildren(newRow)) {
    if (!seen.has(c.id)) { seen.add(c.id); result.push(c); }
  }
  figma.currentPage.selection = result;
  return { ok: true, message: `Добавлена строка: ${result.length} ячеек` };
}

function addColumn(direction: "prev" | "next"): Response {
  const ctx = getContext();
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };

  const sel = figma.currentPage.selection;
  let anchorX: number | null = null;
  for (const n of sel) {
    const cell = findCell(n);
    if (!cell) continue;
    const box = cell.absoluteBoundingBox;
    if (!box) continue;
    if (
      anchorX === null ||
      (direction === "next" && box.x > anchorX) ||
      (direction === "prev" && box.x < anchorX)
    ) {
      anchorX = box.x;
    }
  }
  if (anchorX === null) return { ok: false, message: "Не найден столбец-якорь" };

  const allRows = getAllRows(ctx.body);
  const newCells: SceneNode[] = [];
  for (const row of allRows) {
    if (!("children" in row)) continue;
    const rc = row as SceneNode & ChildrenMixin;
    let anchorIdx = -1;
    for (let i = 0; i < rc.children.length; i++) {
      const b = rc.children[i].absoluteBoundingBox;
      if (b && Math.abs(b.x - anchorX) < X_TOLERANCE) { anchorIdx = i; break; }
    }
    if (anchorIdx < 0) continue;
    const source = rc.children[anchorIdx];
    const clone = source.clone();
    const insertIdx = direction === "next" ? anchorIdx + 1 : anchorIdx;
    rc.insertChild(insertIdx, clone);
    newCells.push(clone);
  }

  if (newCells.length === 0) return { ok: false, message: "Не удалось продублировать" };
  figma.currentPage.selection = newCells;
  return { ok: true, message: `Добавлен столбец: ${newCells.length} ячеек` };
}

function addRow(direction: "prev" | "next"): Response {
  const ctx = getContext();
  if (!ctx) return { ok: false, message: "Это не похоже на таблицу" };

  const sel = figma.currentPage.selection;
  let anchorY: number | null = null;
  let anchorRow: (SceneNode & ChildrenMixin) | null = null;
  for (const n of sel) {
    const cell = findCell(n);
    if (!cell || !cell.parent || !("children" in cell.parent)) continue;
    const row = cell.parent as SceneNode & ChildrenMixin;
    const box = row.absoluteBoundingBox;
    if (!box) continue;
    if (
      anchorY === null ||
      (direction === "next" && box.y > anchorY) ||
      (direction === "prev" && box.y < anchorY)
    ) {
      anchorY = box.y;
      anchorRow = row;
    }
  }
  if (!anchorRow) return { ok: false, message: "Не найдена строка-якорь" };
  if (isHeaderRow(anchorRow, ctx.body)) {
    return { ok: false, message: "Заголовок может быть только один" };
  }

  let anchorIdx = -1;
  for (let i = 0; i < ctx.body.children.length; i++) {
    if (ctx.body.children[i].id === anchorRow.id) { anchorIdx = i; break; }
  }
  if (anchorIdx < 0) return { ok: false, message: "Строка не в таблице" };

  const newRow = anchorRow.clone();
  const insertIdx = direction === "next" ? anchorIdx + 1 : anchorIdx;
  ctx.body.insertChild(insertIdx, newRow);

  if (!("children" in newRow)) return { ok: false, message: "Скопированная строка без ячеек" };
  const cells = (newRow as SceneNode & ChildrenMixin).children;
  figma.currentPage.selection = cells as SceneNode[];
  return { ok: true, message: `Добавлена строка: ${cells.length} ячеек` };
}

// ---------- state push ----------

function computeNavState(): NavState {
  const cls = classifySelection();
  const state: NavState = {
    canPrevCol: false, canNextCol: false,
    canPrevRow: false, canNextRow: false,
    canExpColLeft: false, canExpColRight: false,
    canExpRowUp: false, canExpRowDown: false,
    canSelectAll: false,
    canAddColLeft: false, canAddColRight: false,
    canAddRowUp: false, canAddRowDown: false,
  };

  const sel = figma.currentPage.selection;
  const ctx = getContext();
  const hasCell = ctx !== null;

  if (hasCell) state.canSelectAll = true;

  const checkHeader = (row: BaseNode | null): boolean =>
    ctx !== null && isHeaderRow(row, ctx.body);

  const findEdgeRows = (): { top: SceneNode | null; bottom: SceneNode | null } => {
    let top: SceneNode | null = null;
    let bottom: SceneNode | null = null;
    let topY = Infinity;
    let bottomY = -Infinity;
    for (const n of sel) {
      if (!isVisible(n)) continue;
      const c = findCell(n);
      if (!c || !c.parent || !("children" in c.parent)) continue;
      const row = c.parent as SceneNode;
      const box = row.absoluteBoundingBox;
      if (!box) continue;
      if (box.y < topY) { topY = box.y; top = row; }
      if (box.y > bottomY) { bottomY = box.y; bottom = row; }
    }
    return { top, bottom };
  };

  if (cls.mode === "none") {
    if (hasCell && sel.length === 1 && isVisible(sel[0])) {
      const cell = findCell(sel[0])!;
      const inHeader = checkHeader(cell.parent);
      state.canAddColLeft = true;
      state.canAddColRight = true;
      state.canAddRowUp = !inHeader;
      state.canAddRowDown = !inHeader;
    }
    return state;
  }

  if (cls.mode === "all") return state;

  const colActive = (cls.mode === "column" || cls.mode === "both") && cls.colIndices.length < cls.totalCols;
  const rowActive = (cls.mode === "row" || cls.mode === "both") && cls.rowIndices.length < cls.totalRows;

  if (colActive) {
    state.canPrevCol = true;
    state.canNextCol = true;
    state.canExpColLeft = true;
    state.canExpColRight = true;
  }
  if (rowActive) {
    state.canPrevRow = true;
    state.canNextRow = true;
    state.canExpRowUp = true;
    state.canExpRowDown = true;
  }

  if (cls.mode === "column") {
    state.canAddColLeft = true;
    state.canAddColRight = true;
  } else if (cls.mode === "row") {
    const edges = findEdgeRows();
    state.canAddRowUp = edges.top !== null && !checkHeader(edges.top);
    state.canAddRowDown = edges.bottom !== null && !checkHeader(edges.bottom);
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
  refreshCache();
  pushNavState();
  pushStatusFromSelection();
});

figma.ui.onmessage = async (msg: { type: string; includeHeader?: boolean; mode?: "column" | "row"; direction?: "prev" | "next" }) => {
  let response: Response | undefined;

  if (msg.type === "init") {
    const stored = await figma.clientStorage.getAsync(STORAGE_KEY_INCLUDE_HEADER);
    const value = stored === undefined ? true : Boolean(stored);
    figma.ui.postMessage({ type: "init-state", includeHeader: value });
    refreshCache();
    pushNavState();
    pushStatusFromSelection();
    return;
  }

  if (msg.type === "select-row") {
    response = selectRow();
  } else if (msg.type === "select-column") {
    response = selectColumn(msg.includeHeader === true);
  } else if (msg.type === "select-all") {
    response = selectAll(msg.includeHeader === true);
  } else if (msg.type === "nav" && msg.mode && msg.direction) {
    response = navigate(msg.mode, msg.direction, msg.includeHeader === true);
  } else if (msg.type === "expand" && msg.mode && msg.direction) {
    response = expand(msg.mode, msg.direction, msg.includeHeader === true);
  } else if (msg.type === "toggle-header") {
    response = toggleHeader(msg.includeHeader === true);
  } else if (msg.type === "add" && msg.mode && msg.direction) {
    response = msg.mode === "column" ? addColumn(msg.direction) : addRow(msg.direction);
  }

  if (response) {
    pushNavState();
    figma.ui.postMessage({ type: "status", ok: response.ok, message: response.message });
  }
};
