import {
  RippleConfig,
  DEFAULT_RIPPLE_CONFIG,
  ActivationState,
  RankedResult,
  UpdateHint,
  SearchResult,
  WaveSnapshot,
  PropagationMode,
  VaultNote,
} from "../types";
import { KnowledgeGraph } from "../graph/knowledge-graph";

/**
 * Core ripple propagation engine.
 * Pure logic — no Obsidian API dependencies.
 */
export class RippleEngine {
  private graph: KnowledgeGraph;
  private config: RippleConfig;

  constructor(graph: KnowledgeGraph, config?: Partial<RippleConfig>) {
    this.graph = graph;
    this.config = { ...DEFAULT_RIPPLE_CONFIG, ...config };
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Full ripple search: entry discovery → propagation → ranked results.
   */
  search(query: string): SearchResult {
    const activation: Record<string, number> = {};
    const traces: Record<string, string[][]> = {};
    const visitCount: Record<string, number> = {};
    const waveLog: WaveSnapshot[] = [];
    const hopMap: Record<string, number> = {};

    // Step 1: entry discovery.
    const entryIds = this.findEntries(query);
    console.log(`[Ripple] Search "${query}": ${entryIds.length} entries, ${this.graph.getAllEdges().length} edges`);

    for (const eid of entryIds) {
      activation[eid] = this.config.initialIntensity;
      traces[eid] = [["QUERY", eid]];
      hopMap[eid] = 0;
    }

    // Step 2-3: ripple propagation.
    let currentWave: Array<{ strength: number; nodeId: string }> = entryIds.map(
      id => ({ strength: this.config.initialIntensity, nodeId: id })
    );

    for (let depth = 0; depth < this.config.maxDepth; depth++) {
      if (currentWave.length === 0) break;

      // Record snapshot for heatmap animation.
      waveLog.push({
        depth,
        activations: { ...activation },
        activeNodes: currentWave.map(w => w.nodeId),
      });

      const nextWave: Array<{ strength: number; nodeId: string }> = [];

      for (const { strength, nodeId } of currentWave) {
        const neighbors = this.graph.getSearchNeighbors(nodeId);

        for (const neighborId of neighbors) {
          if (entryIds.includes(neighborId)) continue;

          // Edge may be nodeId→neighborId (outlink) or neighborId→nodeId (backlink).
          const edgeWeight = this.graph.getEdgeWeight(nodeId, neighborId)
                          || this.graph.getEdgeWeight(neighborId, nodeId);
          if (edgeWeight === 0) continue;

          // Habituation.
          const n = visitCount[neighborId] ?? 0;
          const h = 1.0 / (1.0 + this.config.habituationAlpha * n);

          // Scope attenuation.
          const scopeMult = this.computeScopeMultiplier(neighborId);

          // Propagated strength.
          const propagated = strength * edgeWeight * h * scopeMult * this.config.decay;

          if (propagated < this.config.minActivation) continue;

          // Accumulate activation (multi-path superposition).
          const prev = activation[neighborId] ?? 0;
          activation[neighborId] = prev + propagated;

          // Trace path.
          if (!traces[neighborId]) traces[neighborId] = [];
          const parentTraces = traces[nodeId] ?? [];
          for (const pt of parentTraces) {
            traces[neighborId].push([...pt, neighborId]);
          }

          // Track hop count.
          hopMap[neighborId] = Math.min(hopMap[neighborId] ?? Infinity, depth + 1);

          visitCount[neighborId] = n + 1;
          nextWave.push({ strength: propagated, nodeId: neighborId });
        }
      }

      currentWave = nextWave;
    }

    // Final snapshot.
    waveLog.push({
      depth: this.config.maxDepth,
      activations: { ...activation },
      activeNodes: [],
    });

    // Step 4: rank results.
    const ranked: RankedResult[] = [];
    for (const [notePath, act] of Object.entries(activation)) {
      if (act < this.config.minActivation) continue;
      const node = this.graph.getNode(notePath);
      if (!node) continue;
      const paths = traces[notePath] ?? [];
      const bestPath = this.pickBestPath(paths);
      ranked.push({
        notePath,
        title: node.title,
        snippet: node.snippet,
        activation: Math.min(act, 1.0),
        path: bestPath,
        hopCount: hopMap[notePath] ?? 0,
      });
    }

    ranked.sort((a, b) => b.activation - a.activation);
    const propNodes = ranked.filter(r => !entryIds.includes(r.notePath));
    if (propNodes.length > 0) {
      console.log(`[Ripple] ${ranked.length} results, ${propNodes.length} propagated (top: ${propNodes[0].title} ${(propNodes[0].activation*100).toFixed(0)}%)`);
    } else {
      console.log(`[Ripple] ${ranked.length} results, 0 propagated — check if wikilinks resolve to edges`);
    }
    const topResults = ranked.slice(0, this.config.maxResults);

    return {
      rankedResults: topResults,
      waveLog,
      entryIds,
      activationMap: activation,
    };
  }

  /**
   * Update propagation: triggered when a note is saved.
   * Returns notes that may need cascading update review.
   */
  propagateUpdate(changedNotePath: string): UpdateHint[] {
    const activation: Record<string, number> = {};
    const visitCount: Record<string, number> = {};
    const node = this.graph.getNode(changedNotePath);
    if (!node) return [];

    // Start from changed note's backlinks (who links to me?).
    const backlinks = this.graph.getUpdateNeighbors(changedNotePath);
    if (backlinks.length === 0) return [];

    let currentWave: Array<{ strength: number; nodeId: string }> = backlinks.map(
      id => ({ strength: 1.0, nodeId: id })
    );

    for (let depth = 0; depth < this.config.maxDepth; depth++) {
      if (currentWave.length === 0) break;

      const nextWave: Array<{ strength: number; nodeId: string }> = [];

      for (const { strength, nodeId } of currentWave) {
        const n = visitCount[nodeId] ?? 0;
        const h = 1.0 / (1.0 + this.config.habituationAlpha * n);
        const propagated = strength * 0.7 * h * this.config.decay;

        if (propagated < this.config.updateSignalThreshold) continue;

        const prev = activation[nodeId] ?? 0;
        activation[nodeId] = prev + propagated;
        visitCount[nodeId] = n + 1;

        // Continue along backlinks (recursive: who links to the linker?).
        const deeper = this.graph.getUpdateNeighbors(nodeId);
        for (const d of deeper) {
          if (d === changedNotePath) continue;
          nextWave.push({ strength: propagated, nodeId: d });
        }
      }

      currentWave = nextWave;
    }

    // Rank and return.
    const hints: UpdateHint[] = [];
    for (const [notePath, act] of Object.entries(activation)) {
      if (act < this.config.updateSignalThreshold) continue;
      const n = this.graph.getNode(notePath);
      if (!n) continue;
      hints.push({ notePath, title: n.title, activation: Math.min(act, 1.0) });
    }

    hints.sort((a, b) => b.activation - a.activation);
    return hints;
  }

  // ── Entry discovery ──────────────────────────────────────

  private findEntries(query: string): string[] {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    interface EntryCandidate { path: string; score: number; reasons: string[]; }
    // Phase 1: title + headings + tags (high signal).
    const primary: EntryCandidate[] = [];
    // Phase 2: body snippet fallback (low signal, used only if primary has < 3 results).
    const fallback: EntryCandidate[] = [];

    for (const node of this.graph.getAllNodes()) {
      const titleLow = node.title.toLowerCase();
      const snippetLow = node.snippet.toLowerCase();
      const headingsLow = node.headings.map(h => h.toLowerCase());
      const tagsLow = node.tags.map(t => t.toLowerCase());

      const hasPrimary = terms.every(term =>
        titleLow.includes(term) ||
        headingsLow.some(h => h.includes(term)) ||
        tagsLow.some(t => t.includes(term))
      );
      const hasFallback = !hasPrimary && terms.every(term => snippetLow.includes(term));
      if (!hasPrimary && !hasFallback) continue;

      let score = 0;
      const reasons: string[] = [];

      // Title match (highest weight).
      for (const term of terms) {
        if (titleLow.includes(term)) {
          score += 10;
          if (titleLow === term) score += 20;
          reasons.push("title");
        }
      }

      // Heading match.
      for (const h of headingsLow) {
        for (const term of terms) {
          if (h.includes(term)) { score += 5; reasons.push(`heading:"${h.slice(0, 30)}"`); }
        }
      }

      // Tag match.
      for (const t of tagsLow) {
        for (const term of terms) {
          if (t.includes(term)) { score += 3; reasons.push(`tag:${t}`); }
        }
      }

      // Snippet match (low weight, used only as fallback).
      if (hasFallback) {
        for (const term of terms) {
          if (snippetLow.includes(term)) score += 1;
        }
      }

      const entry = { path: node.path, score, reasons };
      if (hasPrimary) {
        primary.push(entry);
      } else {
        fallback.push(entry);
      }
    }

    primary.sort((a, b) => b.score - a.score);
    fallback.sort((a, b) => b.score - a.score);

    // Prefer title/heading/tag entries; add snippet fallback only if < 3.
    const merged = primary.length >= 3 ? primary : [...primary, ...fallback];
    const top = merged.slice(0, 5);
    for (const e of top) {
      const node = this.graph.getNode(e.path);
      console.log(`[Ripple] Entry: ${node?.title ?? e.path} (${e.score}) ← ${e.reasons.join(", ")}`);
    }
    return top.map(s => s.path);
  }

  // ── Scope attenuation ────────────────────────────────────

  private computeScopeMultiplier(nodeId: string): number {
    if (!this.config.scopeFilter || this.config.scopeFilter.length === 0) {
      return 1.0;
    }
    const inScope = this.config.scopeFilter.some(prefix => nodeId.startsWith(prefix));
    return inScope ? 1.0 : 1.0 - this.config.scopeBeta;
  }

  // ── Path selection ───────────────────────────────────────

  private pickBestPath(paths: string[][]): string[] {
    if (paths.length === 0) return [];
    // Prefer shortest path; break ties by first-found.
    let best = paths[0];
    for (const p of paths) {
      if (p.length < best.length) best = p;
    }
    return best;
  }
}
