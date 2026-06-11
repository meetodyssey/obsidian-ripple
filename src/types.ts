// ── Vault note model ──────────────────────────────────────────

export interface VaultNote {
  /** Path relative to vault root (e.g. "folder/My Note.md"). */
  path: string;
  /** Filename without extension. */
  title: string;
  /** First 200 characters for result previews. */
  snippet: string;
  /** [[wikilink]] targets resolved to note paths. */
  outlinks: string[];
  /** Computed: notes that link TO this note. */
  backlinks: string[];
  /** Frontmatter tags + inline #tags. */
  tags: string[];
  /** H1 / H2 headings for entry matching. */
  headings: string[];
  /** Stable textual references such as discussion-82 or ADR-016. */
  textRefs: string[];
  /** Last-modified timestamp (ms). */
  mtime: number;
}

// ── Graph model ───────────────────────────────────────────────

export interface GraphEdge {
  source: string;    // note path
  target: string;    // note path
  weight: number;    // 0.7 for wikilinks, 0.35 for tag overlap, 0.3 for heading match
  anchor?: string;   // e.g. "#heading" or "#^block" from [[target#heading]]
}

// ── Ripple engine ─────────────────────────────────────────────

export interface RippleConfig {
  /** Initial activation for entry nodes. */
  initialIntensity: number;
  /** Per-hop decay multiplier. */
  decay: number;
  /** Maximum propagation hops. */
  maxDepth: number;
  /** Activation cutoff — nodes below this are pruned. */
  minActivation: number;
  /** Habituation strength α in h(n) = 1 / (1 + α × n). */
  habituationAlpha: number;
  /** Scope attenuation β — notes outside scope get × (1 - β). */
  scopeBeta: number;
  /** Max ranked results to return. */
  maxResults: number;
  /** Min activation to flag "needs update" after update propagation. */
  updateSignalThreshold: number;
  /** Optional folder scope filter (e.g. ["docs/", "projects/"]). */
  scopeFilter?: string[];
}

export const DEFAULT_RIPPLE_CONFIG: RippleConfig = {
  initialIntensity: 1.0,
  decay: 0.5,
  maxDepth: 3,
  minActivation: 0.1,
  habituationAlpha: 0.5,
  scopeBeta: 0.7,
  maxResults: 20,
  updateSignalThreshold: 0.3,
};

export interface ActivationState {
  /** Accumulated activation level [0, 1]. */
  activation: number;
  /** Activation trace (note paths from entry to this node). */
  path: string[];
  /** Shortest hop distance from any entry. */
  hopCount: number;
}

export interface RankedResult {
  notePath: string;
  title: string;
  snippet: string;
  activation: number;
  path: string[];
  hopCount: number;
}

export interface UpdateHint {
  notePath: string;
  title: string;
  activation: number;
}

// ── Propagation strategy ──────────────────────────────────────

export type PropagationMode = "search" | "update";

// ── Heatmap ───────────────────────────────────────────────────

export interface LayoutPosition {
  x: number;
  y: number;
}

export interface HeatmapNode {
  notePath: string;
  title: string;
  activation: number;
  x: number;
  y: number;
  radius: number;
  color: string;
}

export interface HeatmapEdge {
  source: string;
  target: string;
  weight: number;
}

export interface WaveSnapshot {
  depth: number;
  activations: Record<string, number>;
  activeNodes: string[];
}

// ── Search result ─────────────────────────────────────────────

export interface SearchResult {
  rankedResults: RankedResult[];
  waveLog: WaveSnapshot[];
  entryIds: string[];
  activationMap: Record<string, number>;
}
