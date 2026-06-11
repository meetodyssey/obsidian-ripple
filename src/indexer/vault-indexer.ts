import { Vault, TFile, CachedMetadata, parseFrontMatterEntry, normalizePath } from "obsidian";
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
  private idToPath: Map<string, string> = new Map();
  private pathToIds: Map<string, string[]> = new Map();

  constructor(vault: Vault, graph: KnowledgeGraph) {
    this.vault = vault;
    this.graph = graph;
  }

  // ── Full re-index ─────────────────────────────────────────

  async fullIndex(): Promise<void> {
    this.graph.clear();
    this.idToPath.clear();
    this.pathToIds.clear();
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
      this.addTextReferenceEdges(note);
      this.addStructuralEdges(note);
    }

    // Phase 3: compute backlinks (populated during edge addition).
    console.log(`[Ripple] Indexed ${this.graph.nodeCount} notes.`);
  }

  // ── Incremental updates ───────────────────────────────────

  async onFileCreated(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    this.unregisterStableIds(file.path);
    const note = await this.parseNote(file);
    if (!note) return;
    // Remove stale edges from any previous state.
    this.graph.removeNode(note.path);
    this.graph.addNode(note);
    this.addWikilinkEdges(note);
    this.addTextReferenceEdges(note);
    this.addStructuralEdges(note);
  }

  async onFileModified(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    this.unregisterStableIds(file.path);
    const note = await this.parseNote(file);
    if (!note) return;
    // Remove old edges, then re-add.
    this.graph.removeEdgesFrom(note.path);
    this.graph.removeNode(note.path);
    this.graph.addNode(note);
    this.addWikilinkEdges(note);
    this.addTextReferenceEdges(note);
    this.addStructuralEdges(note);
  }

  onFileDeleted(file: TFile): void {
    if (file.extension !== "md") return;
    this.unregisterStableIds(file.path);
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
    const textRefs = this.extractTextRefs(content);
    this.registerStableIds(file.path, file.basename, content);

    return {
      path: file.path,
      title: file.basename,
      snippet: content.slice(0, SNIPPET_MAX).replace(/\n/g, " "),
      outlinks,
      backlinks: [], // computed during edge addition
      tags,
      headings,
      textRefs,
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
      const targetPath = this.resolveWikilink(linkTarget, note.path);
      if (targetPath && this.graph.hasNode(targetPath)) {
        this.graph.addEdge(note.path, targetPath, 0.7, anchor);
      }
    }
  }

  private addTextReferenceEdges(note: VaultNote): void {
    for (const ref of note.textRefs) {
      const targetPath = this.resolveStableId(ref);
      if (targetPath && targetPath !== note.path && this.graph.hasNode(targetPath)) {
        this.graph.addEdge(note.path, targetPath, 0.45);
      }
    }
  }

  private addStructuralEdges(note: VaultNote): void {
    // Odyssey knowledgebase convention: individual discussion records are source
    // facts under discussion/YYYY/MM/, and discussion/README.md is their archive
    // index. This relationship is structural even when the record itself does
    // not link back to the index.
    if (/^discussion\/\d{4}\/\d{2}\//.test(note.path)) {
      const archiveIndex = "discussion/README.md";
      if (this.graph.hasNode(archiveIndex)) {
        this.graph.addEdge(note.path, archiveIndex, 0.58);
      }
    }
  }

  /**
   * Resolve a [[wikilink]] basename to a full vault path.
   * Handles: exact match, case-insensitive match, and nested paths.
   */
  private resolveWikilink(basename: string, sourcePath?: string): string | null {
    const normalizedTarget = normalizePath(basename);
    const candidates = this.pathCandidates(normalizedTarget, sourcePath);
    for (const candidate of candidates) {
      if (this.graph.hasNode(candidate)) return candidate;
    }

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
    const asPath = normalizedTarget.endsWith(".md") ? normalizedTarget : `${normalizedTarget}.md`;
    if (this.graph.hasNode(asPath)) return asPath;
    // Partial path match.
    const suffix = stripLeadingParentSegments(asPath);
    for (const node of this.graph.getAllNodes()) {
      if (node.path.endsWith(`/${asPath}`) || node.path === asPath || node.path.endsWith(`/${suffix}`) || node.path === suffix) {
        return node.path;
      }
    }
    return null;
  }

  private pathCandidates(target: string, sourcePath?: string): string[] {
    const withExt = target.endsWith(".md") ? target : `${target}.md`;
    const out = new Set<string>([withExt]);
    if (sourcePath) {
      const sourceDir = sourcePath.split("/").slice(0, -1).join("/");
      if (sourceDir) out.add(normalizePath(`${sourceDir}/${withExt}`));
    }
    return [...out];
  }

  private extractTextRefs(content: string): string[] {
    const refs = new Set<string>();
    for (const match of content.matchAll(/\bdiscussion-\d+\b/gi)) refs.add(match[0]);
    for (const match of content.matchAll(/\bADR-\d{3}\b/gi)) refs.add(match[0]);
    return [...refs];
  }

  private registerStableIds(path: string, title: string, content: string): void {
    const ids = new Set<string>();
    const fmId = content.match(/^id:\s*([A-Za-z0-9_-]+)/m)?.[1];
    if (fmId) ids.add(fmId);
    const adrId = title.match(/^(ADR-\d{3})\b/i)?.[1];
    if (adrId) ids.add(adrId);
    const discussionId = title.match(/\b(\d{4}-\d{2}-\d{2})-(\d+)\b/)?.[2];
    if (discussionId) ids.add(`discussion-${Number(discussionId)}`);

    const normalized = [...ids].map(id => id.toLowerCase());
    this.pathToIds.set(path, normalized);
    for (const id of normalized) this.idToPath.set(id, path);
  }

  private unregisterStableIds(path: string): void {
    const ids = this.pathToIds.get(path) ?? [];
    for (const id of ids) {
      if (this.idToPath.get(id) === path) this.idToPath.delete(id);
    }
    this.pathToIds.delete(path);
  }

  private resolveStableId(ref: string): string | null {
    return this.idToPath.get(ref.toLowerCase()) ?? null;
  }
}

function stripLeadingParentSegments(path: string): string {
  let current = normalizePath(path);
  while (current.startsWith("../")) current = current.slice(3);
  while (current.startsWith("./")) current = current.slice(2);
  return current;
}
