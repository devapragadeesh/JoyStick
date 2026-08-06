import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import expandCollapse, { type ExpandCollapseApi } from "cytoscape-expand-collapse";
import type { CodeGraph, CodeGraphMeta } from "@joystick/shared";
import { nodeDetail, toCompoundElements, type NodeDetail } from "./codeMapLayout.js";
import { useSelection } from "./selection.js";

cytoscape.use(expandCollapse);

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

const STYLE: cytoscape.StylesheetJsonBlock[] = [
  {
    selector: "node",
    style: {
      "background-color": "#6ea8fe",
      label: "data(label)",
      color: "#d6d8de",
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
      "font-size": 11,
      color: "#c792ea",
      padding: "18px",
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
];

export function CodeMap() {
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
    ecRef.current = cy.expandCollapse({
      layoutBy: null,
      animate: true,
      animationDuration: 250,
      undoable: false,
      cueEnabled: true,
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
          // ~60-node cose layout, can be thousands of px from their own
          // parent (confirmed live). Re-laying out just this node's
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
        // A directory's contents can still land outside the current
        // viewport (e.g. it's off to one side after an earlier pan), so
        // re-fit to everything now visible.
        cy.fit(undefined, 30);
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
    cy.layout({ name: "cose", animate: false, padding: 30 } as cytoscape.LayoutOptions).run();
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
      cueEnabled: true,
      groupEdgesOfSameTypeOnCollapse: true,
      edgeTypeInfo: "edgeType",
      layoutBy: { name: "cose", animate: false, randomize: false, fit: true, padding: 30 } as cytoscape.LayoutOptions,
    });
    // See the tap handler below: groupEdgesOfSameTypeOnCollapse only takes
    // effect through this separate call, never automatically from collapse.
    api.collapseAllEdges({ groupEdgesOfSameTypeOnCollapse: true, edgeTypeInfo: "edgeType" });
    setDetail(null);
  }, [cy, elements]);

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

      <div ref={containerRef} className="codemap-canvas" />

      {detail && <NodeDetailPanel detail={detail} />}

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
function NodeDetailPanel({ detail }: { detail: NodeDetail }) {
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
    </div>
  );
}
