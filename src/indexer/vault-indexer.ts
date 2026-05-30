import { Vault, TFile, CachedMetadata, parseFrontMatterEntry } from "obsidian";
import { VaultNote } from "../types";
import { KnowledgeGraph } from "../graph/knowledge-graph";

/** Max snippet length. */
const SNIPPET_MAX = 200;

/** Regex to extract H1/H2 headings from markdown. */
const HEADING_RE = /^#{1,2}\s+(.+)$/gm;

/** Regex to extract inline #tags (excluding those inside code blocks). */
const INLINE_TAG_RE = /(?<!\S)#([a-zA-Z\u4e00-\u9fff][\w\u4e00-\u9fff/-]*)/g;

/**
 * Parses the Obsidian vault and builds a KnowledgeGraph.
 * Re-indexes on plugin load; incrementally updates on file changes.
 */
export class VaultIndexer {
  private vault: Vault;
  private graph: KnowledgeGraph;

  constructor(vault: Vault, graph: KnowledgeGraph) {
    this.vault = vault;
    this.graph = graph;
  }

  // ── Full re-index ─────────────────────────────────────────

  async fullIndex(): Promise<void> {
    this.graph.clear();
    let markdownFiles = this.vault.getMarkdownFiles();
    for (let retry = 0; retry < 6 && markdownFiles.length === 0; retry++) {
      await new Promise(r => setTimeout(r, 1000));
      markdownFiles = this.vault.getMarkdownFiles();
    }
    console.log(`[Ripple] Vault: ${markdownFiles.length} .md files`);
    const notes: VaultNote[] = [];

    for (const file of markdownFiles) {
      const note = await this.parseNote(file);
      if (note) notes.push(note);
    }

    // Phase 1: add all nodes.
    for (const note of notes) {
      this.graph.addNode(note);
    }

    // Phase 2: resolve wikilinks and add edges.
    for (const note of notes) {
      this.addWikilinkEdges(note);
    }

    // Phase 3: compute backlinks (populated during edge addition).
    console.log(`[Ripple] Indexed ${this.graph.nodeCount} notes.`);
  }

  // ── Incremental updates ───────────────────────────────────

  async onFileCreated(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    const note = await this.parseNote(file);
    if (!note) return;
    // Remove stale edges from any previous state.
    this.graph.removeNode(note.path);
    this.graph.addNode(note);
    this.addWikilinkEdges(note);
  }

  async onFileModified(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    const note = await this.parseNote(file);
    if (!note) return;
    // Remove old edges, then re-add.
    this.graph.removeEdgesFrom(note.path);
    this.graph.removeNode(note.path);
    this.graph.addNode(note);
    this.addWikilinkEdges(note);
  }

  onFileDeleted(file: TFile): void {
    if (file.extension !== "md") return;
    this.graph.removeNode(file.path);
  }

  // ── Parsing ──────────────────────────────────────────────

  private async parseNote(file: TFile): Promise<VaultNote | null> {
    const content = await this.vault.cachedRead(file);
    const cache = this.vault.getAbstractFileByPath(file.path) instanceof TFile
      ? null // We use the content directly, cache is supplementary.
      : null;

    const outlinks = this.extractOutlinks(content, file);
    const tags = this.extractTags(content, file);
    const headings = this.extractHeadings(content);

    return {
      path: file.path,
      title: file.basename,
      snippet: content.slice(0, SNIPPET_MAX).replace(/\n/g, " "),
      outlinks,
      backlinks: [], // computed during edge addition
      tags,
      headings,
      mtime: file.stat.mtime,
    };
  }

  // ── Wikilink extraction ───────────────────────────────────

  private extractOutlinks(content: string, _file: TFile): string[] {
    // Match [[link]], [[link|alias]], and [[link#heading]] patterns.
    const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = wikiRe.exec(content)) !== null) {
      const target = match[1].trim();
      if (target && !links.includes(target)) {
        links.push(target);
      }
    }
    return links;
  }

  // ── Tag extraction ────────────────────────────────────────

  private extractTags(content: string, file: TFile): string[] {
    const tags: string[] = [];

    // Frontmatter tags.
    const cache = this.vault.getAbstractFileByPath(file.path);
    // Obsidian metadataCache for structured access.
    // Fallback: simple frontmatter parsing.
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const tagLine = fm.match(/^tags:\s*(.+)$/m);
      if (tagLine) {
        // Supports both YAML list and inline array.
        const raw = tagLine[1];
        // YAML list form: `tags:\n  - foo\n  - bar`
        const listItems = fm.match(/^\s+-\s+(.+)$/gm);
        if (listItems) {
          for (const item of listItems) {
            const tag = item.replace(/^\s+-\s+/, "").trim();
            if (tag) tags.push(tag.replace(/^#/, ""));
          }
        } else {
          // Inline form: `tags: [foo, bar]` or `tags: foo, bar`
          raw.replace(/[\[\]'"]/g, "").split(",").forEach(t => {
            const trimmed = t.trim().replace(/^#/, "");
            if (trimmed) tags.push(trimmed);
          });
        }
      }
    }

    // Inline #tags.
    let m: RegExpExecArray | null;
    while ((m = INLINE_TAG_RE.exec(content)) !== null) {
      const tag = m[1];
      if (tag && !tags.includes(tag)) {
        tags.push(tag);
      }
    }

    return tags;
  }

  // ── Heading extraction ────────────────────────────────────

  private extractHeadings(content: string): string[] {
    const headings: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = HEADING_RE.exec(content)) !== null) {
      const h = m[1].trim();
      if (h) headings.push(h);
    }
    return headings;
  }

  // ── Edge building ─────────────────────────────────────────

  private addWikilinkEdges(note: VaultNote): void {
    for (const rawLink of note.outlinks) {
      // Split anchor from target: [[Note#heading]] → target=Note, anchor=#heading
      const hashIdx = rawLink.indexOf("#");
      const linkTarget = hashIdx >= 0 ? rawLink.slice(0, hashIdx) : rawLink;
      const anchor = hashIdx >= 0 ? rawLink.slice(hashIdx) : undefined;
      const targetPath = this.resolveWikilink(linkTarget);
      if (targetPath && this.graph.hasNode(targetPath)) {
        this.graph.addEdge(note.path, targetPath, 0.7, anchor);
      }
    }
  }

  /**
   * Resolve a [[wikilink]] basename to a full vault path.
   * Handles: exact match, case-insensitive match, and nested paths.
   */
  private resolveWikilink(basename: string): string | null {
    // Exact match first.
    for (const node of this.graph.getAllNodes()) {
      if (node.title === basename) return node.path;
    }
    // Case-insensitive fallback.
    const lower = basename.toLowerCase();
    for (const node of this.graph.getAllNodes()) {
      if (node.title.toLowerCase() === lower) return node.path;
    }
    // Title prefix match (e.g. [[ADR-009]] → ADR-009-memory-extractor.md).
    for (const node of this.graph.getAllNodes()) {
      if (node.title.toLowerCase().startsWith(lower)) return node.path;
    }
    // Try matching by path (e.g. "folder/note" → "folder/note.md").
    const asPath = basename.endsWith(".md") ? basename : `${basename}.md`;
    if (this.graph.hasNode(asPath)) return asPath;
    // Partial path match.
    for (const node of this.graph.getAllNodes()) {
      if (node.path.endsWith(`/${basename}.md`) || node.path === `${basename}.md`) {
        return node.path;
      }
    }
    return null;
  }
}
