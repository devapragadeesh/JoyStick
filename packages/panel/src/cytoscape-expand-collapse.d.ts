/**
 * cytoscape-expand-collapse ships no types (last released as a plain UMD
 * bundle). This declares only the surface joystick actually calls — see
 * https://github.com/iVis-at-Bilkent/cytoscape.js-expand-collapse for the
 * full API if more of it is ever needed.
 */
declare module "cytoscape-expand-collapse" {
  import type { Core, NodeCollection, EdgeCollection, LayoutOptions } from "cytoscape";

  interface ExpandCollapseOptions {
    layoutBy?: LayoutOptions | null;
    fisheye?: boolean;
    animate?: boolean;
    animationDuration?: number;
    undoable?: boolean;
    cueEnabled?: boolean;
    edgeTypeInfo?: string;
    groupEdgesOfSameTypeOnCollapse?: boolean;
    allowNestedEdgeCollapse?: boolean;
  }

  export interface ExpandCollapseApi {
    collapse(nodes: NodeCollection, options?: ExpandCollapseOptions): void;
    expand(nodes: NodeCollection, options?: ExpandCollapseOptions): void;
    collapseRecursively(nodes: NodeCollection, options?: ExpandCollapseOptions): void;
    expandRecursively(nodes: NodeCollection, options?: ExpandCollapseOptions): void;
    collapseAll(options?: ExpandCollapseOptions): void;
    expandAll(options?: ExpandCollapseOptions): void;
    isExpandable(node: cytoscape.NodeSingular): boolean;
    isCollapsible(node: cytoscape.NodeSingular): boolean;
    collapseEdgesBetweenNodes(nodes: NodeCollection, options?: ExpandCollapseOptions): void;
    collapseAllEdges(options?: ExpandCollapseOptions): void;
  }

  const register: (cy: typeof import("cytoscape")) => void;
  export default register;
}

declare namespace cytoscape {
  interface Core {
    expandCollapse(
      options?: import("cytoscape-expand-collapse").ExpandCollapseOptions | "get",
    ): import("cytoscape-expand-collapse").ExpandCollapseApi;
  }
}
