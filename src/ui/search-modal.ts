import { App, SuggestModal, TFile, WorkspaceLeaf } from "obsidian";
import { SearchResult, RankedResult } from "../types";

/**
 * Fuzzy-search modal for ripple search.
 * Triggered via command palette "Ripple: Search".
 */
export class RippleSearchModal extends SuggestModal<RankedResult> {
  private onSearch: (query: string) => SearchResult;
  private onOpenHeatmap: () => void;
  private lastResult: SearchResult | null = null;

  constructor(
    app: App,
    onSearch: (query: string) => SearchResult,
    onOpenHeatmap: () => void
  ) {
    super(app);
    this.onSearch = onSearch;
    this.onOpenHeatmap = onOpenHeatmap;
    this.setPlaceholder("Ripple search — query keywords, tags, or note titles…");
  }

  getSuggestions(query: string): RankedResult[] {
    if (!query.trim()) {
      this.lastResult = null;
      return [];
    }
    const result = this.onSearch(query);
    this.lastResult = result;
    return result.rankedResults;
  }

  renderSuggestion(item: RankedResult, el: HTMLElement): void {
    el.empty();

    // Activation bar — color-coded by activation level.
    const barContainer = el.createDiv({ cls: "ripple-search-bar-bg" });
    const bar = barContainer.createDiv({ cls: "ripple-search-bar-fill" });
    bar.style.width = `${Math.round(item.activation * 100)}%`;
    bar.style.backgroundColor = this.activationToColor(item.activation);

    // Title + score row.
    const row = el.createDiv({ cls: "ripple-search-row" });
    row.createSpan({ cls: "ripple-search-title", text: item.title });
    row.createSpan({
      cls: "ripple-search-score",
      text: `${(item.activation * 100).toFixed(0)}%`,
    });

    // Path breadcrumb.
    const pathStr = item.path
      .filter(p => p !== "QUERY")
      .map(p => this.shortenPath(p))
      .join(" → ");
    if (pathStr) {
      el.createDiv({ cls: "ripple-search-path", text: pathStr });
    }
  }

  async onChooseSuggestion(item: RankedResult): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(item.notePath);
    if (file instanceof TFile) {
      await this.openFileOnce(file);
    }
  }

  private async openFileOnce(file: TFile): Promise<void> {
    const existing = this.findOpenLeaf(file.path);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }

    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private findOpenLeaf(path: string): WorkspaceLeaf | null {
    return (
      this.app.workspace
        .getLeavesOfType("markdown")
        .find((leaf) => (leaf.view as any)?.file?.path === path) ?? null
    );
  }

  // Add heatmap button to modal header.
  onOpen(): void {
    super.onOpen();
    // Append a heatmap button after the input.
    const modalEl = (this as any).modalEl as HTMLElement | undefined;
    if (modalEl) {
      const btnContainer = modalEl.createDiv({ cls: "ripple-search-actions" });
      const heatmapBtn = btnContainer.createEl("button", {
        cls: "ripple-search-heatmap-btn",
        text: "Heatmap",
      });
      heatmapBtn.addEventListener("click", () => {
        this.close();
        this.onOpenHeatmap();
      });
    }
  }

  private shortenPath(p: string): string {
    const parts = p.split("/");
    return (parts[parts.length - 1] ?? p).replace(/\.md$/, "");
  }

  private activationToColor(act: number): string {
    // Blue (cold) → green → yellow → red (hot).
    if (act < 0.1) return "#3a3a4a";
    if (act < 0.6) {
      const s = act / 0.6;
      const r = Math.round(52 + s * (46 - 52));
      const g = Math.round(152 + s * (204 - 152));
      const b = Math.round(219 - s * (219 - 113));
      return `rgb(${r},${g},${b})`;
    }
    const s = (act - 0.6) / 0.4;
    const r = Math.round(46 + s * (231 - 46));
    const g = Math.round(204 - s * (204 - 76));
    const b = Math.round(113 - s * (113 - 60));
    return `rgb(${r},${g},${b})`;
  }
}
