# Obsidian Ripple

Ripple-powered knowledge graph search for Obsidian vaults. Find notes not just by keyword, but by following `[[wikilinks]]` through activation propagation — and see which notes should be updated together.

## Features

- **Ripple Search** — Activation propagates from keyword-matched entry notes along wikilinks. Results are ranked by relevance, with traceable activation paths showing *why* each note was found.
- **Update Propagation** — When you save a note, ripple signals flow to backlinks. Notes that may need cascading updates are flagged in the status bar.
- **Interactive Heatmap** — Force-directed note graph with activation coloring (cold blue → hot red) and animated propagation visualization.

## Quick Start

1. Install the plugin (copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/obsidian-ripple/`).
2. Enable the plugin in Obsidian settings.
3. Open the command palette and run **Ripple: Search**.
4. Type a query — results appear ranked by ripple activation.
5. Click a result to open the note, or click **Heatmap** to see the activation graph.

## Commands

| Command | Description |
|---|---|
| `Ripple: Search` | Open the ripple search modal |
| `Ripple: Open heatmap` | Open the heatmap view |

## How It Works

### Search

1. **Entry discovery** — Query is matched against note titles, headings, frontmatter tags, and `[[wikilinks]]`. Top matches become entry nodes (activation = 1.0).
2. **Propagation** — Activation spreads along wikilinks in both directions (outlinks + backlinks). Each hop decays by a configurable factor (default 0.5).
3. **Convergence** — Habituation prevents feedback loops; scope filters attenuate out-of-scope nodes.
4. **Results** — Notes are ranked by accumulated activation, with the propagation path shown for each result.

### Update Propagation

When you modify a note, an update signal propagates along backlinks (notes that link *to* the changed note). Notes receiving signal above a threshold are flagged for review in the status bar. One click shows the full list.

### Heatmap

The heatmap is a force-directed graph where:
- **Nodes** are notes, sized and colored by activation level
- **Edges** are wikilinks
- **Animation** replays the ripple propagation frame by frame

## Configuration (v0.2+)

Settings tab coming in v0.2. Current defaults:

| Parameter | Default | Description |
|---|---|---|
| `decay` | 0.5 | Per-hop activation decay |
| `maxDepth` | 3 | Maximum propagation hops |
| `minActivation` | 0.1 | Activation cutoff threshold |
| `habituationAlpha` | 0.5 | Habituation strength |
| `scopeBeta` | 0.7 | Scope filter attenuation |

## Performance

- 1000 notes indexed in < 3 seconds
- Search propagation < 200ms
- Force-directed layout computed once on load, cached
- No network requests — fully offline

## Development

```bash
# Install dependencies
npm install

# Build (development with watch)
npm run dev

# Build (production)
npm run build

# Type check
npm run lint
```

The plugin uses `esbuild` for bundling. The output files (`main.js`, `manifest.json`, `styles.css`) go to the repo root for direct copying into `.obsidian/plugins/obsidian-ripple/`.

## Architecture

```
VaultIndexer  →  KnowledgeGraph (in-memory)  →  RippleEngine
                                                    ↓
                                              SearchModal
                                              HeatmapView
                                              UpdateBadge
```

- **VaultIndexer** — Parses `.md` files, extracts wikilinks, tags, headings. Handles incremental updates on file create/modify/delete.
- **KnowledgeGraph** — In-memory directed graph. No persistence — rebuilt on plugin load.
- **RippleEngine** — Core propagation logic. Pure functions, no Obsidian API dependencies.

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.
