import { ItemView, WorkspaceLeaf } from "obsidian";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  SimulationNodeDatum,
  SimulationLinkDatum,
} from "d3-force";
import { SearchResult, LayoutPosition } from "../types";
import { KnowledgeGraph } from "../graph/knowledge-graph";
import { RippleEngine } from "../engine/ripple-engine";

export const HEATMAP_VIEW_TYPE = "ripple-heatmap-view";

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  title: string;
}

interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  weight: number;
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
    this.canvas.addEventListener("mousedown", (e) => {
      dragMoved = false;
      lastMouseDown = { clientX: e.clientX, clientY: e.clientY };
      this.dragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragOffset = { x: this.transform.offsetX, y: this.transform.offsetY };
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
      if (!dragMoved) return;
      this.transform.offsetX = this.dragOffset.x + dx;
      this.transform.offsetY = this.dragOffset.y + dy;
      this.render(parseInt(thresholdSlider.value, 10) / 100);
    });
    window.addEventListener("mouseup", () => {
      this.dragging = false;
      const wasDrag = dragMoved;
      if (wasDrag || !lastMouseDown) return;
      // It was a click (no movement) — open the note.
      const e = lastMouseDown;
      const rect = this.canvas!.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
      const scaleX = this.canvas!.width / rect.width;
      const scaleY = this.canvas!.height / rect.height;
      const sx = (e.clientX - rect.left) * scaleX;
      const sy = (e.clientY - rect.top) * scaleY;
      const mx = (sx - this.transform.offsetX) / this.transform.scale;
      const my = (sy - this.transform.offsetY) / this.transform.scale;
      for (let i = this.nodeHitAreas.length - 1; i >= 0; i--) {
        const area = this.nodeHitAreas[i];
        const dx = mx - area.x;
        const dy = my - area.y;
        if (dx * dx + dy * dy <= (area.radius / this.transform.scale) * (area.radius / this.transform.scale)) {
          const linkText = area.anchor ? area.path + area.anchor : area.path;
          this.app.workspace.openLinkText(linkText, "", "tab");
          return;
        }
      }
    });

    // Initial render (all nodes cold).
    this.render(0.1);

    // Resize handler.
    const observer = new ResizeObserver(() => {
      if (this.canvas && canvasContainer) {
        this.canvas.width = canvasContainer.clientWidth || 800;
        this.canvas.height = canvasContainer.clientHeight || 600;
        this.render(parseInt(thresholdSlider.value, 10) / 100);
      }
    });
    observer.observe(canvasContainer);
  }

  async onClose(): Promise<void> {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
  }

  // ── Public API ───────────────────────────────────────────

  setSearchResult(result: SearchResult): void {
    this.searchResult = result;
    this.startAnimation();
  }

  triggerSearch(query: string): void {
    this.searchResult = this.engine.search(query);
    this.startAnimation();
  }

  // ── Force-directed layout ────────────────────────────────

  private computeLayout(): void {
    const nodes: LayoutNode[] = [];
    const links: LayoutLink[] = [];
    const nodeMap = new Map<string, LayoutNode>();

    for (const note of this.graph.getAllNodes()) {
      const node: LayoutNode = { id: note.path, title: note.title };
      nodes.push(node);
      nodeMap.set(note.path, node);
    }

    for (const edge of this.graph.getAllEdges()) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (source && target) {
        links.push({ source, target, weight: edge.weight });
      }
    }

    if (nodes.length === 0) return;

    const cw = this.canvas?.width || 800;
    const ch = this.canvas?.height || 600;

    const sim = forceSimulation<LayoutNode>(nodes)
      .force("link", forceLink<LayoutNode, LayoutLink>(links).distance(d => 120 / (d.weight * 2)).strength(0.3))
      .force("charge", forceManyBody().strength(-80))
      .force("center", forceCenter(cw / 2, ch / 2))
      .force("collide", forceCollide(this.BASE_RADIUS + 4))
      .stop();

    // Run simulation synchronously (small graphs < 5000 nodes are fast).
    for (let i = 0; i < 100; i++) sim.tick();

    // Find bounding box and center the layout.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x); maxY = Math.max(maxY, node.y);
    }
    const offsetX = cw / 2 - (minX + maxX) / 2;
    const offsetY = ch / 2 - (minY + maxY) / 2;

    for (const node of nodes) {
      this.layout.set(node.id, { x: (node.x ?? 0) + offsetX, y: (node.y ?? 0) + offsetY });
    }
  }

  // ── Rendering ────────────────────────────────────────────

  private render(minActivation: number): void {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1e1e2e";
    ctx.fillRect(0, 0, w, h);

    // Clear hit areas — repopulated below.
    this.nodeHitAreas = [];

    // Apply zoom/pan transform.
    ctx.save();
    ctx.setTransform(this.transform.scale, 0, 0, this.transform.scale, this.transform.offsetX, this.transform.offsetY);

    // Build node list with activation data.
    const activationMap = this.searchResult?.activationMap ?? {};
    const activeNodes = new Set(Object.keys(activationMap));

    // Draw edges first.
    ctx.strokeStyle = "rgba(100, 100, 120, 0.3)";
    ctx.lineWidth = 0.5;
    for (const edge of this.graph.getAllEdges()) {
      const src = this.layout.get(edge.source);
      const tgt = this.layout.get(edge.target);
      if (!src || !tgt) continue;

      const srcActive = activationMap[edge.source] ?? 0;
      const tgtActive = activationMap[edge.target] ?? 0;
      const edgeAlpha = Math.max(srcActive, tgtActive) * 0.6 + 0.15;

      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.strokeStyle = `rgba(150, 150, 170, ${edgeAlpha})`;
      ctx.stroke();
    }

    // Draw nodes.
    for (const note of this.graph.getAllNodes()) {
      const pos = this.layout.get(note.path);
      if (!pos) continue;

      const activation = activationMap[note.path] ?? 0;
      if (activation < minActivation && !activeNodes.has(note.path)) {
        // Dim inactive nodes.
        ctx.fillStyle = "#3a3a4a";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, this.BASE_RADIUS * 0.6, 0, Math.PI * 2);
        ctx.fill();
        // Still record hit area so cold nodes remain clickable.
        this.nodeHitAreas.push({ x: pos.x, y: pos.y, radius: 6, path: note.path, anchor: this.bestAnchorFor(note.path) });
        continue;
      }

      const color = this.activationColor(activation);
      const radius = this.BASE_RADIUS + activation * (this.MAX_RADIUS - this.BASE_RADIUS);

      // Record hit area (even cold nodes get a small clickable radius).
      const inAnchor = this.bestAnchorFor(note.path);
      this.nodeHitAreas.push({ x: pos.x, y: pos.y, radius: Math.max(radius, 6), path: note.path, anchor: inAnchor });

      // Glow for activated nodes.
      if (activation > 0.1) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = color.replace("1)", `${0.15})`).replace("rgb", "rgba");
        ctx.fill();
      }

      // Node body.
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Border for entry nodes.
      if (this.searchResult?.entryIds.includes(note.path)) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Label (only for activated or large nodes).
      if (activation > 0.2 || radius > 12) {
        ctx.fillStyle = "#e0e0e0";
        ctx.font = `${10 + activation * 4}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(note.title.slice(0, 20), pos.x, pos.y + radius + 12);
      }
    }

    // Restore transform so legend is in screen space.
    ctx.restore();

    // Legend (screen space).
    this.drawLegend(ctx, w);
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
      for (const nodeId of snapshot.activeNodes) {
        const pos = this.layout.get(nodeId);
        if (!pos) continue;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, this.MAX_RADIUS + 6, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
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

  private drawLegend(ctx: CanvasRenderingContext2D, w: number): void {
    const x = w - 140;
    const y = 20;
    ctx.font = "10px sans-serif";
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const color = this.activationColor(t);
      ctx.fillStyle = color;
      ctx.fillRect(x + i * 12, y, 10, 12);
    }
    ctx.fillStyle = "#aaa";
    ctx.textAlign = "center";
    ctx.fillText("0%", x + 0, y + 24);
    ctx.fillText("100%", x + 110, y + 24);
  }
}
