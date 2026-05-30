import { VaultNote, GraphEdge } from "../types";

/**
 * In-memory directed graph of vault notes.
 * No persistence — rebuilt on every plugin load.
 */
export class KnowledgeGraph {
  /** All notes keyed by path. */
  private nodes: Map<string, VaultNote> = new Map();

  /** Outgoing edges keyed by source path. */
  private outEdges: Map<string, GraphEdge[]> = new Map();

  /** Backlinks keyed by target path. */
  private backlinks: Map<string, string[]> = new Map();

  // ── Node operations ───────────────────────────────────────

  addNode(note: VaultNote): void {
    this.nodes.set(note.path, note);
    if (!this.outEdges.has(note.path)) {
      this.outEdges.set(note.path, []);
    }
  }

  removeNode(path: string): void {
    this.nodes.delete(path);
    this.outEdges.delete(path);
    // Remove backlinks pointing to this node.
    for (const [, sources] of this.backlinks) {
      const idx = sources.indexOf(path);
      if (idx !== -1) sources.splice(idx, 1);
    }
    this.backlinks.delete(path);
  }

  getNode(path: string): VaultNote | undefined {
    return this.nodes.get(path);
  }

  hasNode(path: string): boolean {
    return this.nodes.has(path);
  }

  getAllNodes(): VaultNote[] {
    return [...this.nodes.values()];
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  // ── Edge operations ───────────────────────────────────────

  addEdge(source: string, target: string, weight: number, anchor?: string): void {
    if (!this.nodes.has(source) || !this.nodes.has(target)) return;
    const edges = this.outEdges.get(source)!;
    // Avoid duplicates.
    const existing = edges.find(e => e.source === source && e.target === target);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      if (anchor && !existing.anchor) existing.anchor = anchor;
      return;
    }
    edges.push({ source, target, weight, anchor });
    // Maintain backlinks index.
    if (!this.backlinks.has(target)) {
      this.backlinks.set(target, []);
    }
    if (!this.backlinks.get(target)!.includes(source)) {
      this.backlinks.get(target)!.push(source);
    }
  }

  removeEdgesFrom(source: string): void {
    const edges = this.outEdges.get(source);
    if (!edges) return;
    for (const e of edges) {
      const bl = this.backlinks.get(e.target);
      if (bl) {
        const idx = bl.indexOf(source);
        if (idx !== -1) bl.splice(idx, 1);
      }
    }
    this.outEdges.set(source, []);
  }

  // ── Traversal ─────────────────────────────────────────────

  /**
   * Get neighbors for search propagation (bidirectional).
   */
  getSearchNeighbors(nodeId: string): string[] {
    const out = this.outEdges.get(nodeId)?.map(e => e.target) ?? [];
    const back = this.backlinks.get(nodeId) ?? [];
    return [...new Set([...out, ...back])];
  }

  /**
   * Get neighbors for update propagation (backlinks only).
   * "I changed B → who links to B that might be affected?"
   */
  getUpdateNeighbors(nodeId: string): string[] {
    return this.backlinks.get(nodeId) ?? [];
  }

  /**
   * Get the edge weight between two nodes, if an edge exists.
   */
  getEdgeWeight(source: string, target: string): number {
    const edges = this.outEdges.get(source);
    if (!edges) return 0;
    const edge = edges.find(e => e.target === target);
    return edge?.weight ?? 0;
  }

  /**
   * Get all outgoing edges for a node.
   */
  getOutEdges(nodeId: string): GraphEdge[] {
    return this.outEdges.get(nodeId) ?? [];
  }

  /**
   * Get all edges in the graph (for heatmap rendering).
   */
  getAllEdges(): GraphEdge[] {
    const all: GraphEdge[] = [];
    for (const [, edges] of this.outEdges) {
      all.push(...edges);
    }
    return all;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  clear(): void {
    this.nodes.clear();
    this.outEdges.clear();
    this.backlinks.clear();
  }
}
