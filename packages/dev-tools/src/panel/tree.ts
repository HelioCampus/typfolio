import { continued, headingLevel, type PdfStructureElement, type PdfStructurePage } from '../structure.js';

/** An element where the panel shows it. Its path, such as `2.0.3`, is its page and the child index at each level. */
export interface TreeNode {
  element: PdfStructureElement;
  path: string;
  page: number;
  parent?: TreeNode;
  children: TreeNode[];
  /** For a table that goes on from the previous page, that page. */
  continues?: number;
}

export interface TreeIndex {
  pages: { page: number; nodes: TreeNode[] }[];
  byPath: Map<string, TreeNode>;
  byElement: Map<PdfStructureElement, TreeNode>;
  counts: { headings: number; tables: number; figures: number };
}

export function indexPages(pages: readonly PdfStructurePage[]): TreeIndex {
  const byPath = new Map<string, TreeNode>();
  const byElement = new Map<PdfStructureElement, TreeNode>();
  const counts = { headings: 0, tables: 0, figures: 0 };
  let carried = new Set<PdfStructureElement>();
  const build = (element: PdfStructureElement, path: string, page: number, parent?: TreeNode): TreeNode => {
    const node: TreeNode = { element, path, page, parent, children: [] };
    node.children = element.children.map((child, index) => build(child, `${path}.${index}`, page, node));
    byPath.set(path, node);
    byElement.set(element, node);
    // A table over a page break is one table, in parts on each page: the rest of it is counted once.
    if (element.role === 'Table' && carried.has(element)) node.continues = page - 1;
    else if (headingLevel(element.role) !== undefined) counts.headings += 1;
    else if (element.role === 'Table') counts.tables += 1;
    else if (element.role === 'Figure') counts.figures += 1;
    return node;
  };
  return {
    pages: pages.map(({ page, elements }, index) => {
      carried = index === 0 ? new Set() : continued(pages[index - 1].elements, elements);
      return { page, nodes: elements.map((element, position) => build(element, `${page}.${position}`, page)) };
    }),
    byPath,
    byElement,
    counts,
  };
}

export const ancestors = (node: TreeNode): TreeNode[] => node.parent ? [...ancestors(node.parent), node.parent] : [];

/**
 * The elements a filter finds, and the paths to show for them: their ancestors. An element is found by its role,
 * its alt text, or its text when none of its children is found by theirs, since a parent's text holds all of theirs.
 */
export function filterTree(index: TreeIndex, query: string): { found: Set<string>; shown: Set<string> } | undefined {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return undefined;
  const found = new Set<string>();
  const shown = new Set<string>();
  // Whether the node or one of its children was found by its text.
  const visit = (node: TreeNode): boolean => {
    const byChildren = node.children.map(visit).some(Boolean);
    const { role, text, alt } = node.element;
    const byText = text.toLowerCase().includes(wanted);
    if (role.toLowerCase() === wanted || alt?.toLowerCase().includes(wanted) || (byText && !byChildren)) {
      found.add(node.path);
      for (const path of [node, ...ancestors(node)].map(each => each.path)) shown.add(path);
    }
    return byText;
  };
  for (const { nodes } of index.pages) nodes.forEach(visit);
  return { found, shown };
}
