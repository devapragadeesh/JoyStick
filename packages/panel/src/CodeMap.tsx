import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { CodeGraph, CodeGraphMeta } from "@joystick/shared";
import { allDirectories, buildVisibleGraph, directNeighbors, dirNodeId, type VisEdge } from "./codeMapLayout.js";

/**
 * The static architecture map: file-level import edges only.
 *
 * Labeled "Import graph" throughout, deliberately — Phase 2 ships EXTRACTED
 * import edges and nothing else. No call graph, no symbol resolution, no
 * INFERRED edges (dropped before this ever reaches the sidecar's API, not
 * merely hidden here). Calling this anything closer to "architecture" or
 * "dependencies" would claim more than the data supports.
 */

export function useCodeGraph(): { graph: CodeGraph | null; meta: CodeGraphMeta | null; loading: boolean } {
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [meta, setMeta] = useState<CodeGraphMeta | null>(null);
  const [loading, setLoading] = useState(true);

  // Extraction timestamp of the graph currently held in state, so a poll that
  // returns the same graph can skip setGraph entirely — a fresh object
  // reference from an unchanged poll would otherwise re-trigger layout on
  // every 4s tick, visibly shuffling node positions under the user's cursor.
  const lastExtractedAt = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/codegraph");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { meta: CodeGraphMeta | null; nodes: CodeGraph["nodes"]; edges: CodeGraph["edges"] };
        if (cancelled) return;

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
    // The graph updates asynchronously in the background (debounced
    // re-extraction on edits) with nothing to push a change notification, so
    // this polls rather than waiting on an event that may not come soon.
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
      width: 24,
      height: 24,
    },
  },
  {
    selector: "node[type='dir']",
    style: {
      "background-color": "#c792ea",
      shape: "round-rectangle",
      width: "data(size)",
      height: "data(size)",
      label: "data(label)",
    },
  },
  {
    selector: "edge",
    style: {
      width: "data(width)",
      "line-color": "#3a3d4a",
      "target-arrow-color": "#3a3d4a",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      opacity: 0.7,
    },
  },
  {
    selector: ".faded",
    style: { opacity: 0.12 },
  },
  {
    selector: ".highlighted",
    style: { "background-color": "#7ee0a8", "line-color": "#7ee0a8", "target-arrow-color": "#7ee0a8", opacity: 1 },
  },
];

function toElements(nodes: ReturnType<typeof buildVisibleGraph>["nodes"], edges: VisEdge[]): ElementDefinition[] {
  const nodeEls: ElementDefinition[] = nodes.map((n) => ({
    data:
      n.type === "dir"
        ? { id: n.id, label: `${n.label}/ (${n.fileCount})`, type: "dir", size: 24 + Math.min(24, n.fileCount * 2) }
        : { id: n.id, label: n.label, type: "file" },
  }));
  const edgeEls: ElementDefinition[] = edges.map((e) => ({
    data: { id: e.id, source: e.source, target: e.target, width: Math.min(6, 1 + e.weight) },
  }));
  return [...nodeEls, ...edgeEls];
}

export function CodeMap() {
  const { graph, meta, loading } = useCodeGraph();
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);

  const { nodes, edges } = useMemo(
    () => (graph ? buildVisibleGraph(graph, expandedDirs) : { nodes: [], edges: [] }),
    [graph, expandedDirs],
  );

  // Mount cytoscape once.
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: STYLE,
      wheelSensitivity: 0.2,
    });
    cyRef.current = cy;

    cy.on("tap", "node", (evt) => {
      const id = evt.target.id() as string;
      const node = nodesRef.current.find((n) => n.id === id);
      if (node?.type === "dir") {
        setExpandedDirs((prev) => new Set(prev).add(node.dirPath));
        setSelected(null);
        return;
      }
      setSelected((prev) => (prev === id ? null : id));
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) setSelected(null);
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Keep a ref to the latest node list so the tap handler (bound once) can
  // read current data without re-binding on every graph update.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Re-render elements whenever the visible graph changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().remove();
    cy.add(toElements(nodes, edges));
    cy.layout({ name: "cose", animate: false, padding: 30 } as cytoscape.LayoutOptions).run();
    setSelected(null);
  }, [nodes, edges]);

  // Apply highlight/fade classes when selection changes, without re-laying-out.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("highlighted faded");
    if (!selected) return;

    const neighbors = directNeighbors(edges, selected);
    cy.elements().forEach((el) => {
      const id = el.id();
      const isRelevant =
        id === selected ||
        neighbors.has(id) ||
        (el.isEdge() && (el.data("source") === selected || el.data("target") === selected));
      el.addClass(isRelevant ? "highlighted" : "faded");
    });
  }, [selected, edges]);

  const directories = useMemo(() => (graph ? allDirectories(graph) : []), [graph]);

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
        {expandedDirs.size > 0 && (
          <button className="codemap-collapse-all" onClick={() => setExpandedDirs(new Set())}>
            collapse all
          </button>
        )}
      </div>

      {expandedDirs.size > 0 && (
        <div className="codemap-breadcrumbs">
          {[...expandedDirs].sort().map((d) => (
            <button
              key={d}
              className="codemap-chip"
              onClick={() =>
                setExpandedDirs((prev) => {
                  const next = new Set(prev);
                  next.delete(d);
                  return next;
                })
              }
              title="Click to collapse"
            >
              {d}/ ×
            </button>
          ))}
        </div>
      )}

      {loading && <p className="muted codemap-status">Loading…</p>}
      {!loading && !graph && (
        <p className="muted codemap-status">
          No import graph yet. It builds automatically in the background on session start.
        </p>
      )}
      {!loading && graph && nodes.length === 0 && (
        <p className="muted codemap-status">Graph extracted, but no files matched.</p>
      )}

      <div ref={containerRef} className="codemap-canvas" />

      {directories.length > 0 && expandedDirs.size === 0 && (
        <p className="muted codemap-hint">Click a directory node to expand it.</p>
      )}
    </div>
  );
}

export { dirNodeId };
