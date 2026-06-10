import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { SearchResult, LayoutPosition } from "../types";
import { KnowledgeGraph } from "../graph/knowledge-graph";
import { RippleEngine } from "../engine/ripple-engine";

export const HEATMAP_VIEW_TYPE = "ripple-heatmap-view";

interface HeatmapTheme {
  bg: string;
  grid: string;
  edge: string;
  node: string;
  nodeInactive: string;
  text: string;
  textFaint: string;
}

/**
 * Canvas-based heatmap view.
 * Shows the vault note graph with activation coloring and propagation animation.
 */
export class RippleHeatmapView extends ItemView {
  private graph: KnowledgeGraph;
  private engine: RippleEngine;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private layout: Map<string, LayoutPosition> = new Map();
  private searchResult: SearchResult | null = null;
  private animFrameId: number | null = null;
  private animSnapshotIdx = 0;
  private animating = false;

  private readonly BASE_RADIUS = 8;
  private readonly MAX_RADIUS = 22;
  /** Node hit areas populated during render, for click-to-open. */
  private nodeHitAreas: Array<{ x: number; y: number; radius: number; path: string; anchor?: string }> = [];

  // ── Zoom / pan state ─────────────────────────────────
  private transform = { offsetX: 0, offsetY: 0, scale: 1 };
  private dragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragOffset = { x: 0, y: 0 };
  private dragNode: {
    path: string;
    nodeStartX: number;
    nodeStartY: number;
    graphStartX: number;
    graphStartY: number;
  } | null = null;
  private cleanupFns: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, graph: KnowledgeGraph, engine: RippleEngine) {
    super(leaf);
    this.graph = graph;
    this.engine = engine;
  }

  getViewType(): string {
    return HEATMAP_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Ripple Heatmap";
  }

  getIcon(): string {
    return "git-branch";
  }

  // ── Lifecycle ────────────────────────────────────────────

  async onOpen(): Promise<void> {
    this.cleanupEventHandlers();

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.height = "100%";

    // Controls bar.
    const controls = container.createDiv({ cls: "ripple-heatmap-controls" });
    const searchInput = controls.createEl("input", {
      type: "text",
      placeholder: "Search to activate nodes…",
      cls: "ripple-heatmap-search",
    });
    const playBtn = controls.createEl("button", {
      text: "▶ Replay",
      cls: "ripple-heatmap-btn",
    });
    const resetBtn = controls.createEl("button", {
      text: "⟲ Reset",
      cls: "ripple-heatmap-btn",
    });
    const zoomOutBtn = controls.createEl("button", {
      text: "−",
      cls: "ripple-heatmap-btn",
    });
    const zoomInBtn = controls.createEl("button", {
      text: "+",
      cls: "ripple-heatmap-btn",
    });
    const thresholdSlider = controls.createEl("input", {
      type: "range",
      cls: "ripple-heatmap-slider",
    }) as HTMLInputElement;
    thresholdSlider.min = "0";
    thresholdSlider.max = "100";
    thresholdSlider.value = "10";

    // Canvas.
    const canvasContainer = container.createDiv({ cls: "ripple-heatmap-canvas-container" });
    this.canvas = canvasContainer.createEl("canvas");
    this.canvas.width = canvasContainer.clientWidth || 800;
    this.canvas.height = canvasContainer.clientHeight || 600;
    this.ctx = this.canvas.getContext("2d");

    // Compute layout once (reuse on re-render).
    this.computeLayout();

    // Event handlers.
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const query = (e.target as HTMLInputElement).value;
        if (query.trim()) {
          this.searchResult = this.engine.search(query);
          this.fitToSearchResult(this.searchResult);
          this.startAnimation();
        }
      }
    });

    playBtn.addEventListener("click", () => {
      if (this.searchResult) {
        this.startAnimation();
      }
    });

    resetBtn.addEventListener("click", () => {
      this.transform = { offsetX: 0, offsetY: 0, scale: 1 };
      this.render(parseInt(thresholdSlider.value, 10) / 100);
    });

    zoomInBtn.addEventListener("click", () => {
      this.transform.scale = Math.min(5, this.transform.scale * 1.3);
      this.render(parseInt(thresholdSlider.value, 10) / 100);
    });
    zoomOutBtn.addEventListener("click", () => {
      this.transform.scale = Math.max(0.1, this.transform.scale * 0.7);
      this.render(parseInt(thresholdSlider.value, 10) / 100);
    });

    thresholdSlider.addEventListener("input", () => {
      this.render(parseInt(thresholdSlider.value, 10) / 100);
    });

    let dragMoved = false;
    let lastMouseDown: { clientX: number; clientY: number } | null = null;
    // ── Mouse: pan + click on canvas ────────────────────
    this.addDomListener(this.canvas, "mousedown", (e) => {
      dragMoved = false;
      lastMouseDown = { clientX: e.clientX, clientY: e.clientY };
      this.dragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragOffset = { x: this.transform.offsetX, y: this.transform.offsetY };
      const graphPoint = this.clientToGraph(e.clientX, e.clientY);
      const hit = graphPoint ? this.hitTestNode(graphPoint.x, graphPoint.y) : null;
      const pos = hit ? this.layout.get(hit.path) : null;
      this.dragNode = hit && pos ? {
        path: hit.path,
        nodeStartX: pos.x,
        nodeStartY: pos.y,
        graphStartX: graphPoint!.x,
        graphStartY: graphPoint!.y,
      } : null;
    });
    this.addDomListener(window, "mousemove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
      if (!dragMoved) return;
      if (this.dragNode) {
        const graphPoint = this.clientToGraph(e.clientX, e.clientY);
        if (!graphPoint) return;
        this.layout.set(this.dragNode.path, {
          x: this.dragNode.nodeStartX + graphPoint.x - this.dragNode.graphStartX,
          y: this.dragNode.nodeStartY + graphPoint.y - this.dragNode.graphStartY,
        });
      } else {
        this.transform.offsetX = this.dragOffset.x + dx;
        this.transform.offsetY = this.dragOffset.y + dy;
      }
      this.render(parseInt(thresholdSlider.value, 10) / 100);
    });
    this.addDomListener(window, "mouseup", async () => {
      this.dragging = false;
      this.dragNode = null;
      const wasDrag = dragMoved;
      if (wasDrag || !lastMouseDown) return;
      // It was a click (no movement) — open the note.
      const e = lastMouseDown;
      lastMouseDown = null;
      const graphPoint = this.clientToGraph(e.clientX, e.clientY);
      if (!graphPoint) return;
      const hit = this.hitTestNode(graphPoint.x, graphPoint.y);
      if (hit) await this.openFileOnce(hit.path);
    });

    // Initial render (all nodes cold).
    this.render(0.1);

    // Resize handler.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.canvas && canvasContainer) {
        this.canvas.width = canvasContainer.clientWidth || 800;
        this.canvas.height = canvasContainer.clientHeight || 600;
        this.computeLayout();
        if (this.searchResult) {
          this.fitToSearchResult(this.searchResult);
        }
        this.render(parseInt(thresholdSlider.value, 10) / 100);
      }
    });
    this.resizeObserver.observe(canvasContainer);
  }

  async onClose(): Promise<void> {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.cleanupEventHandlers();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  // ── Public API ───────────────────────────────────────────

  setSearchResult(result: SearchResult): void {
    this.searchResult = result;
    this.fitToSearchResult(result);
    this.startAnimation();
  }

  triggerSearch(query: string): void {
    this.searchResult = this.engine.search(query);
    this.fitToSearchResult(this.searchResult);
    this.startAnimation();
  }

  private addDomListener<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    handler: (event: WindowEventMap[K]) => void
  ): void;
  private addDomListener<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void;
  private addDomListener(
    target: Window | HTMLElement,
    type: string,
    handler: EventListener
  ): void {
    target.addEventListener(type, handler);
    this.cleanupFns.push(() => target.removeEventListener(type, handler));
  }

  private cleanupEventHandlers(): void {
    for (const cleanup of this.cleanupFns.splice(0)) {
      cleanup();
    }
    this.dragging = false;
  }

  private async openFileOnce(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const existing = this.app.workspace
      .getLeavesOfType("markdown")
      .find((leaf) => (leaf.view as any)?.file?.path === path);

    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }

    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private clientToGraph(clientX: number, clientY: number): LayoutPosition | null {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const sx = (clientX - rect.left) * scaleX;
    const sy = (clientY - rect.top) * scaleY;
    return {
      x: (sx - this.transform.offsetX) / this.transform.scale,
      y: (sy - this.transform.offsetY) / this.transform.scale,
    };
  }

  private hitTestNode(x: number, y: number): { path: string; anchor?: string } | null {
    for (let i = this.nodeHitAreas.length - 1; i >= 0; i--) {
      const area = this.nodeHitAreas[i];
      const dx = x - area.x;
      const dy = y - area.y;
      if (dx * dx + dy * dy <= area.radius * area.radius) {
        return { path: area.path, anchor: area.anchor };
      }
    }
    return null;
  }

  private fitToSearchResult(result: SearchResult): void {
    if (!this.canvas || this.layout.size === 0) return;

    const focusIds = new Set<string>(result.entryIds);
    for (const [path, activation] of Object.entries(result.activationMap)) {
      if (activation > 0.05) {
        focusIds.add(path);
      }
    }

    const positions = Array.from(focusIds)
      .map((id) => this.layout.get(id))
      .filter((pos): pos is LayoutPosition => Boolean(pos));

    if (positions.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pos of positions) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x);
      maxY = Math.max(maxY, pos.y);
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const padding = 80;
    const availableWidth = Math.max(120, this.canvas.width - padding * 2);
    const availableHeight = Math.max(120, this.canvas.height - padding * 2);
    const boundsWidth = Math.max(1, maxX - minX);
    const boundsHeight = Math.max(1, maxY - minY);
    const fitScale = Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight);
    const scale = Math.max(0.35, Math.min(2.2, fitScale));

    this.transform = {
      scale,
      offsetX: this.canvas.width / 2 - centerX * scale,
      offsetY: this.canvas.height / 2 - centerY * scale,
    };
  }

  // ── Stable overview layout ────────────────────────────────

  private computeLayout(): void {
    const cw = this.canvas?.width || 800;
    const ch = this.canvas?.height || 600;
    const cx = cw / 2;
    const cy = ch / 2;
    const rx = Math.max(80, cw * 0.44);
    const ry = Math.max(80, ch * 0.38);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const degree = new Map<string, number>();
    for (const edge of this.graph.getAllEdges()) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const notes = [...this.graph.getAllNodes()].sort((a, b) => {
      const byDegree = (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0);
      if (byDegree !== 0) return byDegree;
      return a.path.localeCompare(b.path);
    });
    this.layout.clear();
    const denom = Math.max(1, notes.length - 1);
    notes.forEach((note, i) => {
      if (i === 0) {
        this.layout.set(note.path, { x: cx, y: cy });
        return;
      }
      const t = i / denom;
      const angle = i * golden;
      const radius = Math.sqrt(t);
      const degreeNudge = Math.min(0.18, (degree.get(note.path) ?? 0) / Math.max(1, this.graph.getAllEdges().length));
      this.layout.set(note.path, {
        x: cx + Math.cos(angle) * rx * Math.max(0.14, radius - degreeNudge),
        y: cy + Math.sin(angle) * ry * Math.max(0.14, radius - degreeNudge),
      });
    });

    this.normalizeLayout(cw, ch);
  }

  private normalizeLayout(width: number, height: number): void {
    if (this.layout.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pos of this.layout.values()) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x);
      maxY = Math.max(maxY, pos.y);
    }
    if (!Number.isFinite(minX)) return;
    const padding = 56;
    const graphW = Math.max(1, maxX - minX);
    const graphH = Math.max(1, maxY - minY);
    const scale = Math.min((width - padding * 2) / graphW, (height - padding * 2) / graphH);
    if (!Number.isFinite(scale) || scale <= 0) return;
    const usedW = graphW * scale;
    const usedH = graphH * scale;
    const offsetX = (width - usedW) / 2 - minX * scale;
    const offsetY = (height - usedH) / 2 - minY * scale;
    for (const [id, pos] of this.layout) {
      this.layout.set(id, {
        x: pos.x * scale + offsetX,
        y: pos.y * scale + offsetY,
      });
    }
  }

  // ── Rendering ────────────────────────────────────────────

  private cssVar(name: string, fallback: string): string {
    const host = this.canvas ?? this.containerEl;
    return getComputedStyle(host).getPropertyValue(name).trim() || fallback;
  }

  private theme(): HeatmapTheme {
    return {
      bg: this.cssVar("--background-primary", "#1e1e2e"),
      grid: this.cssVar("--background-modifier-border", "#343945"),
      edge: this.cssVar("--text-faint", "#858b96"),
      node: this.cssVar("--interactive-accent", "#8b8fd4"),
      nodeInactive: this.cssVar("--text-faint", "#858b96"),
      text: this.cssVar("--text-normal", "#e0e0e0"),
      textFaint: this.cssVar("--text-faint", "#aaa"),
    };
  }

  private colorWithAlpha(color: string, alpha: number): string {
    if (color.startsWith("#")) {
      const hex = color.slice(1);
      const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
      const n = Number.parseInt(full, 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    if (color.startsWith("rgb(")) {
      return color.replace("rgb", "rgba").replace(")", `, ${alpha})`);
    }
    return color;
  }

  private render(minActivation: number): void {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const theme = this.theme();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    const grid = 48 * this.transform.scale;
    if (grid > 18) {
      const startX = ((this.transform.offsetX % grid) + grid) % grid;
      const startY = ((this.transform.offsetY % grid) + grid) % grid;
      for (let x = startX; x < w; x += grid) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = startY; y < h; y += grid) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Clear hit areas — repopulated below.
    this.nodeHitAreas = [];

    // Apply zoom/pan transform.
    ctx.save();
    ctx.setTransform(this.transform.scale, 0, 0, this.transform.scale, this.transform.offsetX, this.transform.offsetY);

    // Build node list with activation data.
    const activationMap = this.searchResult?.activationMap ?? {};
    const activeNodes = new Set(Object.keys(activationMap));
    const hasActivation = Object.keys(activationMap).length > 0;
    const degree = new Map<string, number>();
    for (const edge of this.graph.getAllEdges()) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    // Draw edges first.
    for (const edge of this.graph.getAllEdges()) {
      const src = this.layout.get(edge.source);
      const tgt = this.layout.get(edge.target);
      if (!src || !tgt) continue;

      const srcActive = activationMap[edge.source] ?? 0;
      const tgtActive = activationMap[edge.target] ?? 0;
      const isActivated = hasActivation && (srcActive > 0.05 || tgtActive > 0.05);
      const edgeAlpha = isActivated ? Math.max(srcActive, tgtActive) * 0.55 + 0.08 : edge.weight < 0.5 ? 0.035 : 0.18;

      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.strokeStyle = this.colorWithAlpha(theme.edge, edgeAlpha);
      ctx.lineWidth = edge.weight < 0.5 ? 0.45 / this.transform.scale : 0.75 / this.transform.scale;
      ctx.stroke();
    }

    // Draw nodes.
    for (const note of this.graph.getAllNodes()) {
      const pos = this.layout.get(note.path);
      if (!pos) continue;

      const activation = activationMap[note.path] ?? 0;
      if (activation < minActivation && !activeNodes.has(note.path)) {
        // Dim inactive nodes.
        ctx.fillStyle = theme.nodeInactive;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 4.8 / this.transform.scale, 0, Math.PI * 2);
        ctx.fill();
        // Still record hit area so cold nodes remain clickable.
        this.nodeHitAreas.push({ x: pos.x, y: pos.y, radius: 10 / this.transform.scale, path: note.path, anchor: this.bestAnchorFor(note.path) });
        continue;
      }

      const color = hasActivation && activation <= 0 ? theme.nodeInactive : hasActivation ? this.activationColor(activation) : theme.node;
      const screenRadius = hasActivation
        ? this.BASE_RADIUS + activation * (this.MAX_RADIUS - this.BASE_RADIUS)
        : 4.8;
      const radius = screenRadius / this.transform.scale;

      // Record hit area (even cold nodes get a small clickable radius).
      const inAnchor = this.bestAnchorFor(note.path);
      this.nodeHitAreas.push({ x: pos.x, y: pos.y, radius: Math.max(radius, 10 / this.transform.scale), path: note.path, anchor: inAnchor });

      // Glow for activated nodes.
      if (activation > 0.1 || !hasActivation) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 5 / this.transform.scale, 0, Math.PI * 2);
        ctx.fillStyle = this.colorWithAlpha(color, activation > 0.1 ? 0.16 : 0.1);
        ctx.fill();
      }

      // Node body.
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Border for entry nodes.
      if (this.searchResult?.entryIds.includes(note.path)) {
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 2 / this.transform.scale;
        ctx.stroke();
      }

      // Label (activated or highly connected nodes).
      if (activation > 0.2 || this.searchResult?.entryIds.includes(note.path) || (!hasActivation && (degree.get(note.path) ?? 0) >= 8)) {
        ctx.fillStyle = theme.text;
        ctx.font = `${Math.max(9, 10 / this.transform.scale + activation * 4)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.shadowColor = this.colorWithAlpha(theme.bg, 0.75);
        ctx.shadowBlur = 5 / this.transform.scale;
        ctx.fillText(note.title.slice(0, 20), pos.x, pos.y + radius + 12 / this.transform.scale);
        ctx.shadowBlur = 0;
      }
    }

    // Restore transform so legend is in screen space.
    ctx.restore();

    // Legend (screen space).
    this.drawLegend(ctx, w, theme);
  }

  // ── Animation ────────────────────────────────────────────

  private startAnimation(): void {
    if (!this.searchResult || this.searchResult.waveLog.length === 0) return;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
    this.animSnapshotIdx = 0;
    this.animating = true;
    this.animateFrame();
  }

  private animateFrame(): void {
    if (!this.searchResult || !this.animating) return;

    const snapshots = this.searchResult.waveLog;
    if (this.animSnapshotIdx >= snapshots.length) {
      this.animating = false;
      this.render(0.1);
      return;
    }

    // Build a virtual search result with the snapshot's activation map.
    const snapshot = snapshots[this.animSnapshotIdx];
    const snapshotResult: SearchResult = {
      ...this.searchResult,
      activationMap: snapshot.activations,
    };
    const savedResult = this.searchResult;
    this.searchResult = snapshotResult;
    this.render(0.05);

    // Highlight active nodes for this frame.
    if (this.ctx && this.canvas) {
      const ctx = this.ctx;
      const theme = this.theme();
      ctx.save();
      ctx.setTransform(this.transform.scale, 0, 0, this.transform.scale, this.transform.offsetX, this.transform.offsetY);
      for (const nodeId of snapshot.activeNodes) {
        const pos = this.layout.get(nodeId);
        if (!pos) continue;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, (this.MAX_RADIUS + 6) / this.transform.scale, 0, Math.PI * 2);
        ctx.strokeStyle = this.colorWithAlpha(theme.text, 0.6);
        ctx.lineWidth = 2 / this.transform.scale;
        ctx.stroke();
      }
      ctx.restore();
    }

    this.animSnapshotIdx++;
    this.animFrameId = requestAnimationFrame(() => {
      this.searchResult = savedResult;
      this.animateFrame();
    });
  }

  // ── Color ────────────────────────────────────────────────

  private activationColor(activation: number): string {
    // Cold blue (0) → green (0.5) → hot red (1.0).
    if (activation < 0.01) return "rgb(58, 58, 74)";
    const t = Math.min(activation, 1.0);
    // Piecewise: blue→green for [0, 0.6], green→yellow→red for [0.6, 1.0].
    if (t < 0.6) {
      const s = t / 0.6;
      const r = Math.round(52 + s * (46 - 52));    // 52→46
      const g = Math.round(152 + s * (204 - 152)); // 152→204
      const b = Math.round(219 - s * (219 - 113));  // 219→113
      return `rgb(${r}, ${g}, ${b})`;
    } else {
      const s = (t - 0.6) / 0.4;
      const r = Math.round(46 + s * (231 - 46));   // 46→231
      const g = Math.round(204 - s * (204 - 76));   // 204→76
      const b = Math.round(113 - s * (113 - 60));    // 113→60
      return `rgb(${r}, ${g}, ${b})`;
    }
  }

  private bestAnchorFor(nodePath: string): string | undefined {
    for (const edge of this.graph.getAllEdges()) {
      if (edge.target === nodePath && edge.anchor) return edge.anchor;
    }
    return undefined;
  }

  private drawLegend(ctx: CanvasRenderingContext2D, w: number, theme: HeatmapTheme): void {
    const x = w - 140;
    const y = 20;
    ctx.font = "10px sans-serif";
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const color = this.activationColor(t);
      ctx.fillStyle = color;
      ctx.fillRect(x + i * 12, y, 10, 12);
    }
    ctx.fillStyle = theme.textFaint;
    ctx.textAlign = "center";
    ctx.fillText("0%", x + 0, y + 24);
    ctx.fillText("100%", x + 110, y + 24);
  }
}
