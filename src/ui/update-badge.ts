import { Notice } from "obsidian";
import { UpdateHint } from "../types";

/**
 * Status bar item showing count of notes that may need cascading update review.
 */
export class RippleUpdateBadge {
  private statusBarItem: HTMLElement;
  private hints: UpdateHint[] = [];

  constructor(statusBarItem: HTMLElement) {
    this.statusBarItem = statusBarItem;
    this.render();
  }

  setHints(hints: UpdateHint[]): void {
    this.hints = hints;
    this.render();
  }

  clear(): void {
    this.hints = [];
    this.render();
  }

  get count(): number {
    return this.hints.length;
  }

  private render(): void {
    if (this.hints.length === 0) {
      this.statusBarItem.setText("");
      this.statusBarItem.removeClass("ripple-update-badge-active");
      return;
    }

    this.statusBarItem.setText(`↻ ${this.hints.length} note${this.hints.length !== 1 ? "s" : ""} may need review`);
    this.statusBarItem.addClass("ripple-update-badge-active");
    this.statusBarItem.setAttr("aria-label", "Click to view affected notes");

    this.statusBarItem.onClickEvent(() => {
      const lines = this.hints.map(
        h => `${h.title} (${(h.activation * 100).toFixed(0)}%)`
      );
      new Notice(
        `Notes that may need update after recent change:\n\n${lines.join("\n")}`,
        8000
      );
    });
  }
}
