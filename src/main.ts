import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { KnowledgeGraph } from "./graph/knowledge-graph";
import { VaultIndexer } from "./indexer/vault-indexer";
import { RippleEngine } from "./engine/ripple-engine";
import { RippleSearchModal } from "./ui/search-modal";
import { RippleHeatmapView, HEATMAP_VIEW_TYPE } from "./ui/heatmap-view";
import { RippleUpdateBadge } from "./ui/update-badge";
import { RippleConfig, DEFAULT_RIPPLE_CONFIG, SearchResult } from "./types";

export default class ObsidianRipplePlugin extends Plugin {
  private graph: KnowledgeGraph = new KnowledgeGraph();
  private indexer!: VaultIndexer;
  private engine!: RippleEngine;
  private updateBadge: RippleUpdateBadge | null = null;

  async onload(): Promise<void> {
    this.indexer = new VaultIndexer(this.app.vault, this.graph);
    this.engine = new RippleEngine(this.graph, this.loadConfig());

    // ── Commands ──────────────────────────────────────────

    this.addCommand({
      id: "ripple-search",
      name: "Search",
      callback: () => this.openSearch(),
    });

    this.addCommand({
      id: "ripple-open-heatmap",
      name: "Open heatmap",
      callback: () => this.openHeatmap(),
    });

    // ── Ribbon ────────────────────────────────────────────

    this.addRibbonIcon("git-branch", "Ripple Search", () => this.openSearch());

    // ── Views ─────────────────────────────────────────────

    this.registerView(
      HEATMAP_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new RippleHeatmapView(leaf, this.graph, this.engine)
    );

    // ── Status bar badge ──────────────────────────────────

    this.updateBadge = new RippleUpdateBadge(this.addStatusBarItem());

    // ── File watchers ─────────────────────────────────────

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.indexer.onFileCreated(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.indexer.onFileModified(file).then(() => {
            // Propagate update signal.
            const hints = this.engine.propagateUpdate(file.path);
            this.updateBadge?.setHints(hints);
          });
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.indexer.onFileDeleted(file);
      })
    );

    // ── Initial indexing ──────────────────────────────────

    await this.indexer.fullIndex();
    console.log(`[Ripple] Plugin loaded. ${this.graph.nodeCount} notes indexed.`);
  }

  onunload(): void {
    this.graph.clear();
    console.log("[Ripple] Plugin unloaded.");
  }

  // ── Settings ────────────────────────────────────────────

  private loadConfig(): Partial<RippleConfig> {
    // In v0.1, use defaults. Settings tab is a v0.2 feature.
    return { ...DEFAULT_RIPPLE_CONFIG };
  }

  private lastSearchResult: SearchResult | null = null;

  // ── UI helpers ──────────────────────────────────────────

  private openSearch(): void {
    const modal = new RippleSearchModal(
      this.app,
      (query: string) => {
        this.lastSearchResult = this.engine.search(query);
        return this.lastSearchResult;
      },
      () => this.openHeatmap()
    );
    modal.open();
  }

  private async openHeatmap(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(HEATMAP_VIEW_TYPE)[0];
    if (!leaf) {
      const newLeaf = workspace.getRightLeaf(false);
      if (!newLeaf) return;
      await newLeaf.setViewState({ type: HEATMAP_VIEW_TYPE, active: true });
      leaf = newLeaf;
    }
    workspace.revealLeaf(leaf);

    // Pass search result to heatmap if available.
    if (this.lastSearchResult) {
      const view = leaf.view as RippleHeatmapView;
      view.setSearchResult(this.lastSearchResult);
    }
  }
}
