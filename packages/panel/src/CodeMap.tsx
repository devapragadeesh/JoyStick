import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import expandCollapse, { type ExpandCollapseApi } from "cytoscape-expand-collapse";
import dagre from "cytoscape-dagre";
import type { BlastRadiusNote, CodeGraph, CodeGraphMeta } from "@joystick/shared";
import { dirNodeId, dirOf, filesInDir, nodeDetail, toCompoundElements, type NodeDetail } from "./codeMapLayout.js";
import { useSelection } from "./selection.js";

cytoscape.use(expandCollapse);
cytoscape.use(dagre);

// Top-down rank layout instead of cose's force-directed scatter — reads as
// a tree/hierarchy the way a directory+import structure actually is,
// rather than an unstructured cloud. Only used for the one-time initial
// layout and the initial collapse-everything pass; the per-directory
// children reveal on expand (below) stays its own small bounded grid,
// untouched — that's the mechanism Part 3 already fixed to never re-fit or
// reposition the rest of the graph.
const TREE_LAYOUT = {
  name: "dagre",
  rankDir: "TB",
  // Directory labels sit above their node and can be wider than the node
  // itself — nodeSep wide enough to keep adjacent labels from colliding at
  // the same rank, confirmed live (default spacing overlapped labels for
  // several same-rank top-level directories).
  nodeSep: 110,
  rankSep: 90,
  animate: false,
  fit: true,
  padding: 30,
} as cytoscape.LayoutOptions;

/**
 * The static architecture map: file-level import edges only.
 *
 * Labeled "Import graph" throughout, deliberately — Phase 2 ships EXTRACTED
 * import edges and nothing else. No call graph, no symbol resolution, no
 * INFERRED edges (dropped before this ever reaches the sidecar's API, not
 * merely hidden here).
 */

export function useCodeGraph(): { graph: CodeGraph | null; meta: CodeGraphMeta | null; loading: boolean } {
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [meta, setMeta] = useState<CodeGraphMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const lastExtractedAt = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/codegraph");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { meta: CodeGraphMeta | null; nodes: CodeGraph["nodes"]; edges: CodeGraph["edges"] };
        if (cancelled) return;

        // A fresh object reference from an unchanged poll would otherwise
        // re-trigger layout on every tick, visibly shuffling node positions
        // under the cursor — found taking Phase 2's verification screenshots.
        if (data.meta?.extracted_at === lastExtractedAt.current) return;
        lastExtractedAt.current = data.meta?.extracted_at ?? null;

        setMeta(data.meta);
        setGraph(
          data.meta
            ? { nodes: data.nodes, edges: data.edges, extractedAt: data.meta.extracted_at, builtAtCommit: data.meta.built_at_commit }
            : null,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void poll();
    const timer = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { graph, meta, loading };
}

// Node labels are file/directory paths, so they get the same monospace
// treatment as any other path in the panel — set here rather than in CSS
// since cytoscape renders labels to its own canvas, outside the DOM.
const LABEL_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const STYLE: cytoscape.StylesheetJsonBlock[] = [
  {
    selector: "node",
    style: {
      "background-color": "#6ea8fe",
      label: "data(label)",
      color: "#d6d8de",
      "font-family": LABEL_FONT,
      "font-size": 10,
      "text-valign": "bottom",
      "text-margin-y": 4,
      width: 20,
      height: 20,
    },
  },
  {
    selector: "node[type='dir']",
    style: {
      "background-color": "#22242c",
      "background-opacity": 0.6,
      "border-width": 1.5,
      "border-color": "#c792ea",
      shape: "round-rectangle",
      label: "data(label)",
      "text-valign": "top",
      "text-margin-y": -6,
      "font-family": LABEL_FONT,
      "font-size": 11,
      color: "#c792ea",
      padding: "18px",
      // The label renders above the node's own box (text-valign/margin
      // above), which by default isn't part of the node's hit area —
      // confirmed live: clicking directly on a directory's name did
      // nothing, requiring a second click actually on the box below it.
      // text-events makes the rendered label itself dispatch the node's
      // tap events too, so clicking the name — the most obvious thing to
      // click — works on the first try.
      "text-events": "yes",
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "#3a3d4a",
      "target-arrow-color": "#3a3d4a",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      opacity: 0.7,
      // Dashed rather than solid so the flow animation below has a visible
      // pattern to move — a solid line with an animated offset has nothing
      // to show motion with.
      "line-style": "dashed",
      "line-dash-pattern": [6, 4],
      "line-dash-offset": 0,
    },
  },
  { selector: ".faded", style: { opacity: 0.1 } },
  {
    selector: ".highlighted",
    style: { "background-color": "#7ee0a8", "line-color": "#7ee0a8", "target-arrow-color": "#7ee0a8", opacity: 1 },
  },
  {
    selector: ".picked",
    style: { "border-width": 3, "border-color": "#ffc857" },
  },
  // Phase 3: blast-radius pulse. Deliberately a different color family (red/
  // orange) from both the green neighbor-highlight and the amber multi-select
  // outline, so "this is what just rippled from an edit" never reads as "this
  // is what you selected."
  {
    selector: ".blast-changed",
    style: {
      "background-color": "#ff6b6b",
      "border-width": 3,
      "border-color": "#ff6b6b",
      "z-index": 20,
    },
  },
  {
    selector: ".blast-affected",
    style: {
      "background-color": "#ffa94d",
      "border-width": 2,
      "border-color": "#ffa94d",
      "line-color": "#ffa94d",
      "target-arrow-color": "#ffa94d",
      opacity: 1,
      "z-index": 15,
    },
  },
  {
    selector: ".blast-changed-dir, .blast-affected-dir",
    style: {
      "border-width": 3,
      "border-color": "#ff6b6b",
      color: "#ffa94d",
      "font-weight": "bold",
    },
  },
];

/**
 * Apply (or clear) a blast-radius pulse to whatever's currently live in
 * cytoscape. A plain function, not a hook, deliberately: it has to run both
 * from a React effect (when the pulse itself changes) AND from the directory
 * tap handler right after an expand/collapse — expanding a directory reveals
 * node ids that didn't exist in cy a moment ago, and nothing about a pulse
 * "changing" would otherwise tell React to re-run this. A directory node
 * whose children are collapsed away (so an affected file's own node doesn't
 * exist in cy right now) gets a badge on the directory itself instead — the
 * point of 3.3 is that a ripple is never silently invisible just because the
 * user hasn't expanded the right folder, and once they do, the actual
 * affected files inside light up too, not just the badge that sent them there.
 */
function applyBlastPulse(cy: Core, pulseNote: BlastRadiusNote | null): void {
  cy.nodes().forEach((n) => {
    if (n.data("type") === "dir" && (n.hasClass("blast-changed-dir") || n.hasClass("blast-affected-dir"))) {
      n.data("label", `${n.data("dirPath")}/`);
    }
  });
  cy.elements().removeClass("blast-changed blast-affected blast-changed-dir blast-affected-dir");

  if (!pulseNote || !pulseNote.inGraph) return;

  const changedNode = cy.getElementById(pulseNote.filePath);
  if (changedNode.nonempty()) {
    changedNode.addClass("blast-changed");
  } else {
    const dirNode = cy.getElementById(dirNodeId(dirOf(pulseNote.filePath)));
    if (dirNode.nonempty()) {
      dirNode.addClass("blast-changed-dir");
      dirNode.data("label", `${dirNode.data("dirPath")}/ · changed file inside`);
    }
  }

  const dirBadgeCounts = new Map<string, number>();
  for (const affected of pulseNote.affected) {
    const n = cy.getElementById(affected.filePath);
    if (n.nonempty()) {
      n.addClass("blast-affected");
    } else {
      const dirId = dirNodeId(dirOf(affected.filePath));
      dirBadgeCounts.set(dirId, (dirBadgeCounts.get(dirId) ?? 0) + 1);
    }
  }
  for (const [dirId, count] of dirBadgeCounts) {
    const dirNode = cy.getElementById(dirId);
    if (dirNode.nonempty()) {
      dirNode.addClass("blast-affected-dir");
      dirNode.data("label", `${dirNode.data("dirPath")}/ · ${count} affected`);
    }
  }
}

export function CodeMap({ blastRadius }: { blastRadius?: Map<string, BlastRadiusNote> }) {
  const { graph, meta, loading } = useCodeGraph();
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const { selected, toggle, replace, add } = useSelection();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const ecRef = useRef<ExpandCollapseApi | null>(null);
  // A ref alone can't drive the "load elements" effect below: that effect
  // must re-run whenever cytoscape is (re)mounted, not only when the graph
  // data changes, or a remount (e.g. React StrictMode's dev double-invoke)
  // leaves a freshly created, still-empty cy instance on screen forever.
  const [cy, setCy] = useState<Core | null>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const elements = useMemo(() => (graph ? toCompoundElements(graph) : []), [graph]);

  // Mount cytoscape + the expand-collapse extension once.
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: STYLE,
      wheelSensitivity: 0.2,
      // Marquee/box-select as an alternative to shift-click for building a
      // multi-select (B.1). Held on cytoscape's own selection model purely as
      // the gesture's data source, synced into the app's own selection state
      // below rather than driving anything visually itself.
      boxSelectionEnabled: true,
    });
    cyRef.current = cy;
    setCy(cy);

    // groupEdgesOfSameTypeOnCollapse rolls every "imports" edge between two
    // (now-collapsed) directories into one edge, rather than leaving one
    // parallel edge per underlying file-to-file import — that grouping is
    // what makes a collapsed directory's external relationships legible
    // instead of a rat's nest.
    //
    // layoutBy: null deliberately — with a layout configured, the extension
    // re-runs it on the WHOLE graph after every single expand/collapse
    // (confirmed live: one directory's expand scattered all 8 top-level
    // nodes across a ~3000px-wide area). Its own built-in restore instead
    // moves a node's children back in by the delta between its current
    // position and its stored pre-collapse position, which is what actually
    // keeps everything else in place — the goal of "expand in place" to
    // begin with.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ecRef.current = cy.expandCollapse({
      layoutBy: null,
      // Defaults to true — the extension itself pans/zooms the viewport to
      // keep the expanding/collapsing node comfortably framed, independent
      // of anything we call. Confirmed live: with this left on, expanding
      // one directory visibly shifted every OTHER, unrelated node's screen
      // position (a camera pan, not a real repositioning) — exactly the
      // "everything else pushes away" effect the no-cy.fit() fix above
      // doesn't touch, since that only covers fit calls this code makes.
      fisheye: false,
      animate: !reducedMotion,
      animationDuration: 250,
      undoable: false,
      // The extension's own +/- cue button (top-left corner of an expanded
      // node) has its own internal click handling, separate from our tap
      // handler below — a click on it can fire both, racing two
      // expand/collapse calls against each other. Reported live: clicking
      // the cue pushed the box down instead of closing it. Our tap handler
      // (node body, and the label via text-events above) already toggles
      // reliably on its own, so the redundant, race-prone trigger is off
      // rather than something to reconcile.
      cueEnabled: false,
      groupEdgesOfSameTypeOnCollapse: true,
      edgeTypeInfo: "edgeType",
    });

    cy.on("tap", "node", (evt) => {
      const node = evt.target;
      const id = node.id() as string;
      const isDir = node.data("type") === "dir";
      const g = graphRef.current;
      if (!g) return;

      if (isDir) {
        // Expand/collapse in place — native compound-node operation, not a
        // view swap. The rest of the graph stays visible and connected.
        // Deliberately the "Recursively" variants, not plain expand()/
        // collapse(): in cytoscape-expand-collapse@4.1.1 on cytoscape@3.34,
        // single-node expand()/collapse() silently no-op (expandGivenNodes'
        // 1-element fast path never restores the node's removed children —
        // confirmed by stepping through it live), while expandRecursively/
        // collapseRecursively take a different, working code path.
        // Harmless here since this compound model is only one level deep.
        const api = ecRef.current!;
        if (api.isExpandable(node)) {
          api.expandRecursively(node);
          // With layoutBy:null, revealed children pop back to wherever the
          // one-time full-graph layout (at mount) put them — which, for a
          // ~60-node graph, can still be far from their own parent even with
          // a hierarchical (dagre) layout, since collapsed children were
          // never part of that layout pass to begin with. Re-laying out just this node's
          // children in a small grid pinned to the parent's current
          // position keeps the directory's contents next to it instead of
          // scattered across the map.
          const children = node.children();
          const side = 40 + Math.ceil(Math.sqrt(children.length)) * 45;
          const { x, y } = node.position();
          children
            .layout({
              name: "grid",
              fit: false,
              avoidOverlap: true,
              boundingBox: { x1: x - side, y1: y - side, x2: x + side, y2: y + side },
            } as cytoscape.LayoutOptions)
            .run();
        } else if (api.isCollapsible(node)) {
          api.collapseRecursively(node);
          // groupEdgesOfSameTypeOnCollapse (set on the constructor above)
          // is never actually consulted by collapse()/collapseRecursively()
          // — it only takes effect through the separate collapseAllEdges/
          // collapseEdgesBetweenNodes calls (confirmed live: without this,
          // 20 file-level edges between two collapsed directories stayed
          // 20 separate overlapping edges instead of rolling up to 1).
          api.collapseAllEdges({ groupEdgesOfSameTypeOnCollapse: true, edgeTypeInfo: "edgeType" });
        }
        // Deliberately no cy.fit() here: fitting to ALL currently-visible
        // elements after every expand/collapse re-zooms/re-pans the WHOLE
        // viewport around whatever just got bigger — which is what made
        // unrelated, already-visible parts of the graph look "minimized"
        // (confirmed live: expanding one directory shrank everything else).
        // The child grid layout above already keeps new nodes near their
        // parent's current position, so the user's own pan/zoom is left
        // alone; if the parent itself is on screen, its children land on
        // screen too.
        // Expand/collapse changes which node ids exist in cy without pulseNote
        // itself changing, so the React effect that normally applies the pulse
        // won't re-run on its own — reapply here so expanding the directory a
        // badge pointed at actually reveals which files inside it lit up.
        applyBlastPulse(cy, pulseNoteRef.current);
        setDetail(nodeDetail(g, id, true, node.data("dirPath")));
        return;
      }

      // Plain click selects only this node; shift-click adds/removes it from
      // a growing multi-select — the standard graph-tool convention, and what
      // B.1 asks for explicitly.
      if (evt.originalEvent?.shiftKey) toggle(id);
      else replace(id);
      setDetail(nodeDetail(g, id, false));
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) setDetail(null);
    });

    cy.on("boxend", () => {
      const boxed = cy.$(":selected").filter('[type = "file"]');
      boxed.forEach((n) => add(n.id()));
      cy.$(":selected").unselect(); // data already synced; don't keep cytoscape's own selection state too
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
      ecRef.current = null;
      setCy(null);
    };
  }, [toggle, replace, add]);

  // Load/refresh elements. All directories start collapsed, matching Phase
  // 2's default view; expand state itself is preserved across an unrelated
  // data refresh where possible since elements are replaced wholesale only
  // when the underlying graph actually changed (see useCodeGraph's guard).
  // Depends on `cy` itself (not just `elements`) so a remounted cy instance
  // — one that hasn't had these elements added yet — gets populated too.
  useEffect(() => {
    const api = ecRef.current;
    if (!cy || !api || elements.length === 0) return;
    cy.elements().remove();
    cy.add(elements);
    cy.layout(TREE_LAYOUT).run();
    // A per-call options object passed to collapseAll REPLACES the whole
    // config for that call rather than merging with the constructor's
    // defaults above — so every option the extension needs to function
    // (undoable: false in particular; true requires the separate
    // cytoscape-undo-redo extension, which isn't installed, and silently
    // no-ops all expand/collapse afterward) has to be repeated here too.
    // fit:true (vs the constructor's fit:false) is the one deliberate
    // difference: this initial collapse-everything pass should settle the
    // viewport; later single-directory collapses should not yank it.
    api.collapseAll({
      animate: false,
      undoable: false,
      cueEnabled: false,
      fisheye: false,
      groupEdgesOfSameTypeOnCollapse: true,
      edgeTypeInfo: "edgeType",
      layoutBy: TREE_LAYOUT,
    });
    // See the tap handler below: groupEdgesOfSameTypeOnCollapse only takes
    // effect through this separate call, never automatically from collapse.
    api.collapseAllEdges({ groupEdgesOfSameTypeOnCollapse: true, edgeTypeInfo: "edgeType" });
    setDetail(null);
  }, [cy, elements]);

  // "Water flow" cue: continuously advance the dashed edges' offset so
  // motion reads as moving from source to target — the same direction the
  // arrowhead already points. A plain rAF loop rather than a cytoscape
  // animation: this has to run indefinitely and touch every edge each
  // frame, which is what style updates in a loop are for; cy's own
  // animate() API is built for one-shot/looping transitions on a known end
  // state, not an unbounded value. Skipped entirely under reduced motion,
  // not just shortened — a static dashed line still reads fine without it.
  useEffect(() => {
    if (!cy) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf: number;
    let offset = 0;
    const tick = () => {
      offset -= 0.5;
      cy.edges().style("line-dash-offset", offset);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cy]);

  // Multi-select highlight (B.1's "visible highlight state distinct from
  // neighbor-highlight") is layered independently of any node's own
  // click-to-detail state below.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("picked");
    for (const id of selected) {
      const n = cy.getElementById(id);
      if (n.nonempty()) n.addClass("picked");
    }
  }, [selected]);

  // Neighbor highlight on the currently detailed file node. Queried live
  // against cytoscape's own connectedEdges/opposite-endpoint API so it
  // automatically reflects whatever is visible right now — a collapsed
  // neighbor already resolved to its directory node by the extension.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("highlighted faded");
    if (!detail || detail.kind !== "file" || !detail.filePath) return;

    const node = cy.getElementById(detail.filePath);
    if (node.empty()) return; // currently hidden inside a collapsed directory

    const neighborhood = node.closedNeighborhood();
    cy.elements().forEach((el) => {
      el.addClass(neighborhood.contains(el) ? "highlighted" : "faded");
    });
  }, [detail]);

  // Track the newest blast-radius note and pulse it for a few seconds, then
  // clear — "reacted to a live edit" has to read as transient, not as a
  // second permanent selection state sitting on top of the graph forever.
  const [pulseNote, setPulseNote] = useState<BlastRadiusNote | null>(null);
  const lastPulsedKey = useRef<string | null>(null);
  // Read by the directory tap handler below, which is mounted once and would
  // otherwise close over pulseNote's initial (null) value forever.
  const pulseNoteRef = useRef<BlastRadiusNote | null>(null);
  pulseNoteRef.current = pulseNote;

  useEffect(() => {
    if (!blastRadius || blastRadius.size === 0) return;
    let newest: BlastRadiusNote | null = null;
    for (const note of blastRadius.values()) {
      if (!newest || note.createdAtMs > newest.createdAtMs) newest = note;
    }
    if (!newest) return;
    const key = `${newest.toolUseId}:${newest.createdAtMs}`;
    if (key === lastPulsedKey.current) return;
    lastPulsedKey.current = key;
    setPulseNote(newest);
    const t = setTimeout(() => setPulseNote(null), 5000);
    return () => clearTimeout(t);
  }, [blastRadius]);

  // Apply the pulse to whatever's currently live in cytoscape. A directory
  // node whose children are collapsed away (so an affected file's own node
  // doesn't exist in cy right now) gets a badge on the directory itself
  // instead — the point of 3.3 is that a ripple is never silently invisible
  // just because the user hasn't expanded the right folder.
  // Depends on `cy`/`elements`, not just `pulseNote`: the "load elements"
  // effect above rebuilds the whole graph (cy.elements().remove(); cy.add(...))
  // whenever a fresh poll resolves, which silently wipes any classes this
  // effect applied earlier — confirmed live: switching to this tab reliably
  // lost the pulse because useCodeGraph's first poll after remount always
  // rebuilds once, racing ahead of (and clobbering) this effect's own run.
  // Re-running here whenever the graph reloads reapplies the still-active
  // pulse instead of leaving it silently gone.
  useEffect(() => {
    if (!cy) return;
    applyBlastPulse(cy, pulseNote);
  }, [pulseNote, cy, elements]);

  return (
    <div className="codemap">
      <div className="codemap-toolbar">
        <span className="codemap-title">Import graph</span>
        <span className="muted">extracted imports only · no call graph</span>
        {meta && (
          <span className="muted">
            {meta.node_count} files · {meta.edge_count} imports · {meta.dropped_inferred_count} inferred edges
            dropped
          </span>
        )}
        {selected.length > 0 && <span className="codemap-selection-count">{selected.length} selected</span>}
      </div>

      {loading && <p className="muted codemap-status">Loading…</p>}
      {!loading && !graph && (
        <p className="muted codemap-status">
          No import graph yet. It builds automatically in the background on session start.
        </p>
      )}

      {pulseNote && (
        <p className="codemap-blast-banner">
          {pulseNote.summary}
          {pulseNote.testCoverageNote && <span className="muted"> · {pulseNote.testCoverageNote}</span>}
        </p>
      )}

      <div ref={containerRef} className="codemap-canvas" />

      {detail && <NodeDetailPanel detail={detail} graph={graph} selected={selected} onAdd={add} />}

      {!detail && graph && (
        <p className="muted codemap-hint">
          Click a directory to expand it in place. Click a file to select it and see its neighbors.
        </p>
      )}
    </div>
  );
}

/**
 * On-select detail, matching the existing expand-on-click detail pattern
 * (Step.tsx's `.step-body`) rather than inventing a new one: a bordered box
 * revealing the full path and metadata a collapsed/truncated label omits.
 */
function NodeDetailPanel({
  detail,
  graph,
  selected,
  onAdd,
}: {
  detail: NodeDetail;
  graph: CodeGraph | null;
  selected: string[];
  onAdd: (filePath: string) => void;
}) {
  const dirFiles = detail.kind === "dir" && detail.dirPath && graph ? filesInDir(graph, detail.dirPath) : [];
  const unselectedCount = dirFiles.filter((f) => !selected.includes(f)).length;

  return (
    <div className="codemap-detail">
      {detail.kind === "file" ? (
        <p className="step-context">
          <span className="step-context-label">file</span>
          <code>{detail.filePath}</code>
        </p>
      ) : (
        <p className="step-context">
          <span className="step-context-label">directory</span>
          <code>{detail.dirPath}/</code>
          <span className="muted"> · {detail.fileCount} files</span>
        </p>
      )}
      <p className="muted codemap-detail-counts">
        imports {detail.importsCount} · imported by {detail.importedByCount}
      </p>
      {detail.kind === "dir" && dirFiles.length > 0 && (
        <button
          className="codemap-add-context"
          disabled={unselectedCount === 0}
          onClick={() => dirFiles.forEach(onAdd)}
        >
          {unselectedCount === 0
            ? "all files in this folder are in Ask context"
            : `add ${unselectedCount} file${unselectedCount === 1 ? "" : "s"} to Ask context`}
        </button>
      )}
    </div>
  );
}
