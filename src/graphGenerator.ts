import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

interface GraphNode {
    id: string;
    label: string;
    kind: vscode.SymbolKind;
    isAbstract: boolean;
    uri: vscode.Uri;
    range: vscode.Range;
    children: vscode.DocumentSymbol[];
    fields: string[];
    outgoingEdges?: GraphEdge[]; // Cached outgoing edges for full expansion
}

interface GraphEdge {
    from: string;
    to: string;
    fromField?: string;  // Port name — edge originates from this field
    type: 'inheritance' | 'composition' | 'implementation';
    label?: string;
}

export interface DotResult {
    dot: string;
    nodeIds: Set<string>;
}

const RESERVED_TYPES = new Set(['u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'f32', 'f64', 'bool', 'char', 'str', 'String', 'Box', 'Option', 'Vec', '()']);

// Helper to escape characters for Graphviz HTML labels
function escapeHtml(str: string): string {
    return str.replace(/[&<>"']/g, function (m) {
        switch (m) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return m;
        }
    });
}
// ─── Caching ──────────────────────────────────────────────────────────────────

class GraphCacheManager {
    // Raw Cache: Node ID -> GraphNode (contains fields and resolved outgoing edges)
    private rawCache = new Map<string, GraphNode>();

    // Graph Cache: Root Node ID -> Computed DOT string
    private graphCache = new Map<string, DotResult>();

    getRaw(id: string): GraphNode | undefined {
        return this.rawCache.get(id);
    }

    setRaw(id: string, node: GraphNode) {
        this.rawCache.set(id, node);
    }

    getGraph(rootId: string): DotResult | undefined {
        return this.graphCache.get(rootId);
    }

    setGraph(rootId: string, result: DotResult) {
        this.graphCache.set(rootId, result);
    }

    invalidate(uri: vscode.Uri) {
        const uriStr = uri.toString();
        // 1. Invalidate Raw Cache for this file
        for (const [id, node] of this.rawCache) {
            // Check if node belongs to this URI (ID starts with uriStr or node.uri matches)
            if (node.uri.toString() === uriStr) {
                this.rawCache.delete(id);
            }
        }

        // 2. Invalidate Graph Cache (Conservative: clear all, or check dependencies)
        // For correctness, any change might affect graphs. Clearing all is safest/simplest for now.
        // Optimization: Could track which graphs depend on which URIs.
        this.graphCache.clear();
        logger(`Cache invalidated for ${uriStr}`);
    }
}

export const graphCache = new GraphCacheManager();
let logger: (msg: string) => void = () => { }; // Global logger ref



export async function generateDot(rootUri: vscode.Uri, extensions: string[], logFn: (msg: string) => void): Promise<DotResult> {
    logger = logFn;
    logger(`Starting full workspace scan for ${extensions.join(', ')}...`);
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    const blobPattern = `**/*.{${extensions.map(e => e.replace('.', '')).join(',')}}`;
    const files = await vscode.workspace.findFiles(blobPattern, '**/node_modules/**');

    for (const file of files) {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            file
        );
        if (symbols) {
            await processSymbols(symbols, file, nodes);
        }
    }

    for (const node of nodes.values()) {
        await resolveRelationships(node, nodes, edges);
    }

    return {
        dot: buildDot(nodes, edges),
        nodeIds: new Set(nodes.keys())
    };
}

export async function generateGraphFromNode(uri: vscode.Uri, position: vscode.Position, logFn: (msg: string) => void): Promise<DotResult> {
    logger = logFn;
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<string>();

    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
    );

    if (symbols) {
        // Resolve to the containing type if a member is selected
        const targetSymChain = findSymChain(symbols, position);
        const targetSym = targetSymChain[targetSymChain.length - 1];

        if (targetSym && isTypeSymbol(targetSym.kind)) {
            const rootId = getTypeUniqueId(targetSymChain, uri);

            // 1. Check Graph Cache
            const cachedDot = graphCache.getGraph(rootId);
            if (cachedDot) {
                logger(`Graph Cache Hit: ${rootId}`);
                return cachedDot;
            }

            logger(`Root discovered: ${targetSym.name} (ID: ${rootId})`);
            await crawlRelationships(targetSymChain, uri, nodes, edges, visited, logger);

            const result = {
                dot: buildDot(nodes, edges),
                nodeIds: new Set(nodes.keys())
            };
            // Cache the result
            graphCache.setGraph(rootId, result);
            return result;
            logger(`No type symbol found at ${position.line}:${position.character}`);
        }
    }

    return {
        dot: buildDot(nodes, edges),
        nodeIds: new Set(nodes.keys())
    };
}

// Find the EXACT symbol chain at pos
function findSymChain(syms: vscode.DocumentSymbol[], pos: vscode.Position, chain: vscode.DocumentSymbol[] = []): vscode.DocumentSymbol[] {
    for (const s of syms) {
        if (s.range.contains(pos)) {
            const newChain = [...chain, s];
            const childrenResult = findSymChain(s.children, pos, newChain);
            if (childrenResult.length > newChain.length) return childrenResult;
            return newChain;
        }
    }
    return chain;
}

// Special version for selection: if on field/prop, return parent type
export function findSymForSelection(syms: vscode.DocumentSymbol[], pos: vscode.Position, parent?: vscode.DocumentSymbol): vscode.DocumentSymbol | undefined {
    for (const s of syms) {
        if (s.range.contains(pos)) {
            const child = findSymForSelection(s.children, pos, s);
            if (child) return child;

            if (parent && isTypeSymbol(parent.kind) && (s.kind === vscode.SymbolKind.Field || s.kind === vscode.SymbolKind.Property)) {
                return parent;
            }
            return s;
        }
    }
    return undefined;
}

async function crawlRelationships(
    symbolChain: vscode.DocumentSymbol[],
    uri: vscode.Uri,
    allNodes: Map<string, GraphNode>,
    edges: GraphEdge[],
    visited: Set<string>,
    logger: (msg: string) => void
) {
    const symbol = symbolChain[symbolChain.length - 1];
    const id = getTypeUniqueId(symbolChain, uri);

    if (visited.has(id)) return;
    visited.add(id);

    // 2. Check Raw Cache
    const cachedNode = graphCache.getRaw(id);
    if (cachedNode) {
        logger(`Raw Cache Hit: ${id}`);
        allNodes.set(id, cachedNode);

        // Use cached outgoing edges for full expansion
        if (cachedNode.outgoingEdges) {
            // Check if we can satisfy everything from cache
            const missingTargets = cachedNode.outgoingEdges.filter(e => !graphCache.getRaw(e.to));

            if (missingTargets.length === 0) {
                // All children are cached! We can skip LSP!
                for (const edge of cachedNode.outgoingEdges) {
                    // Ensure unique edges
                    if (!edges.some(e => e.from === edge.from && e.to === edge.to && e.fromField === edge.fromField)) {
                        edges.push(edge);
                    }

                    const targetNode = graphCache.getRaw(edge.to);
                    if (targetNode) {
                        allNodes.set(edge.to, targetNode);
                        await expandFromCache(targetNode, allNodes, edges, visited, logger);
                    }
                }
                return;
            }
            logger(`Raw Cache Partial Hit: ${id} (missing dependencies, re-resolving)`);
        }
    }


    const node: GraphNode = {
        id,
        label: symbol.name,
        kind: symbol.kind,
        isAbstract: false,
        uri,
        range: symbol.range,
        children: symbol.children,
        fields: symbol.children
            .filter(c => c.kind === vscode.SymbolKind.Property || c.kind === vscode.SymbolKind.Field)
            .map(c => `${c.name}${c.detail ? ': ' + c.detail : ''}`)
    };
    allNodes.set(id, node);

    logger(`Analyzing ${symbol.name}...`);

    // Track edges created in this scope to cache them later
    const localEdges: GraphEdge[] = [];

    for (const child of symbol.children) {
        if (child.kind === vscode.SymbolKind.Property || child.kind === vscode.SymbolKind.Field) {
            const typeStr = child.detail || '';
            const { isWrapper, innerType, wrapperName } = unwrapType(typeStr);
            const targetName = isWrapper ? innerType : typeStr;

            if (targetName && !RESERVED_TYPES.has(targetName)) {
                logger(`  -> Resolving field ${child.name}: ${typeStr}`);
                try {
                    // 1. Try Type Definition (Best for complex types)
                    let defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                        'vscode.executeTypeDefinitionProvider', uri, child.selectionRange.start
                    );

                    // 2. Fallback to Definition
                    if (!defs || defs.length === 0) {
                        defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                            'vscode.executeDefinitionProvider', uri, child.selectionRange.start
                        );
                    }

                    if (defs && defs.length > 0) {
                        const def = defs[0];
                        const targetUri = 'targetUri' in def ? def.targetUri : def.uri;
                        const targetPos = 'targetSelectionRange' in def
                            ? (def.targetSelectionRange?.start || def.targetRange.start)
                            : (def as vscode.Location).range.start;

                        // CRITICAL: Only proceed if the target definition is inside the current workspace AND not ignored.
                        // We use minimatch to check against files.exclude and search.exclude patterns locally.
                        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);

                        // Helper for Generic Wrapper Resolution (A<B>)
                        const tryExpandWrapper = async () => {
                            if (isWrapper && innerType) {
                                logger(`    ? Wrapper '${wrapperName}' is external/excluded. Searching workspace for inner type: '${innerType}'...`);

                                const symbolResults = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                                    'vscode.executeWorkspaceSymbolProvider', innerType
                                );

                                if (symbolResults && symbolResults.length > 0) {
                                    // Filter for exact name match and type-like symbols
                                    const targetSymInfo = symbolResults.find(s =>
                                        s.name === innerType && isTypeSymbol(s.kind)
                                    );

                                    if (targetSymInfo) {
                                        logger(`    ! Found inner type '${innerType}' in workspace: ${targetSymInfo.location.uri.fsPath}`);

                                        const innerUri = targetSymInfo.location.uri;

                                        // Check if *this* file is excluded (just in case)
                                        const innerFolder = vscode.workspace.getWorkspaceFolder(innerUri);
                                        const innerRelative = vscode.workspace.asRelativePath(innerUri, false);
                                        const excludePatterns = loadExcludePatterns();
                                        const innerExcluded = !innerFolder || excludePatterns.some(p => minimatch(innerRelative, p, { dot: true }));

                                        if (!innerExcluded) {
                                            const innerDocSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                                                'vscode.executeDocumentSymbolProvider', innerUri
                                            );

                                            if (innerDocSymbols) {
                                                const innerPos = targetSymInfo.location.range.start;
                                                const innerChain = findSymChain(innerDocSymbols, innerPos);
                                                const innerSym = innerChain[innerChain.length - 1];

                                                if (innerSym && isTypeSymbol(innerSym.kind)) {
                                                    const targetId = getTypeUniqueId(innerChain, innerUri);

                                                    // FIX: Always create edge even if visited (DAG support)
                                                    const newEdge: GraphEdge = {
                                                        from: id,
                                                        to: targetId,
                                                        fromField: child.name,
                                                        type: 'composition',
                                                        label: wrapperName
                                                    };
                                                    edges.push(newEdge);
                                                    localEdges.push(newEdge);

                                                    if (!visited.has(targetId)) {
                                                        await crawlRelationships(innerChain, innerUri, allNodes, edges, visited, logger);
                                                    }
                                                }
                                            }
                                        }
                                    } else {
                                        logger(`    x Inner type '${innerType}' not found in workspace symbols.`);
                                    }
                                }
                            }
                        };

                        if (!workspaceFolder) {
                            logger(`    - Skipping external definition: ${targetUri.fsPath}`);
                            await tryExpandWrapper();
                            continue;
                        }

                        const relativePath = vscode.workspace.asRelativePath(targetUri, false);
                        const excludePatterns = loadExcludePatterns();
                        const isExcluded = excludePatterns.some(pattern => minimatch(relativePath, pattern, { dot: true }));


                        if (isExcluded) {
                            logger(`    - Skipping excluded file: ${relativePath}`);
                            await tryExpandWrapper();
                            continue;
                        }

                        const defSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                            'vscode.executeDocumentSymbolProvider', targetUri
                        );

                        if (defSymbols) {
                            const defChain = findSymChain(defSymbols, targetPos);
                            const defSym = defChain[defChain.length - 1];

                            if (defSym && isTypeSymbol(defSym.kind)) {
                                const targetId = getTypeUniqueId(defChain, targetUri);

                                // FIX: Always create edge even if visited (DAG support)
                                const newEdge: GraphEdge = {
                                    from: id,
                                    to: targetId,
                                    fromField: child.name,
                                    type: 'composition',
                                    label: isWrapper ? wrapperName : undefined
                                };
                                edges.push(newEdge);
                                localEdges.push(newEdge);

                                if (!visited.has(targetId)) {
                                    await crawlRelationships(defChain, targetUri, allNodes, edges, visited, logger);
                                }
                            } else {
                                logger(`    x Resolved to non-type symbol: ${defSym?.name || 'unknown'}`);
                            }
                        }
                    } else {
                        logger(`    - Primitive or no definition found for ${targetName}`);
                    }
                } catch (err: any) {
                    logger(`    ! Error resolving ${child.name}: ${err.message}`);
                }
            }
            // Save to Raw Cache (including resolved edges)
            node.outgoingEdges = localEdges;
            graphCache.setRaw(id, node);
        }
    }
}

// Helper to expand purely from cache
async function expandFromCache(
    node: GraphNode,
    allNodes: Map<string, GraphNode>,
    edges: GraphEdge[],
    visited: Set<string>,
    logger: (msg: string) => void
) {
    if (!node.outgoingEdges) return;

    for (const edge of node.outgoingEdges) {
        if (!edges.some(e => e.from === edge.from && e.to === edge.to && e.fromField === edge.fromField)) {
            edges.push(edge);
        }

        if (visited.has(edge.to)) continue;
        visited.add(edge.to);

        const targetNode = graphCache.getRaw(edge.to);
        if (targetNode) {
            allNodes.set(edge.to, targetNode);
            // Recurse
            await expandFromCache(targetNode, allNodes, edges, visited, logger);
        }
    }
}

async function processSymbols(symbols: vscode.DocumentSymbol[], uri: vscode.Uri, nodes: Map<string, GraphNode>, parentChain: vscode.DocumentSymbol[] = []) {
    for (const sym of symbols) {
        const chain = [...parentChain, sym];
        if (isTypeSymbol(sym.kind)) {
            const id = getTypeUniqueId(chain, uri);
            nodes.set(id, {
                id,
                label: sym.name,
                kind: sym.kind,
                isAbstract: false,
                uri,
                range: sym.range,
                children: sym.children,
                fields: sym.children
                    .filter(c => c.kind === vscode.SymbolKind.Property || c.kind === vscode.SymbolKind.Field)
                    .map(c => `${c.name}${c.detail ? ': ' + c.detail : ''}`)
            });
        }
        if (sym.children.length > 0) {
            await processSymbols(sym.children, uri, nodes, chain);
        }
    }
}

async function resolveRelationships(sourceNode: GraphNode, allNodes: Map<string, GraphNode>, edges: GraphEdge[]) {
    if (!sourceNode.children) return;

    for (const child of sourceNode.children) {
        if (child.kind === vscode.SymbolKind.Property || child.kind === vscode.SymbolKind.Field) {
            const rawType = child.detail || '';
            const { isWrapper, innerType, wrapperName } = unwrapType(rawType);

            if (isWrapper && innerType) {
                const targetId = findNodeByName(allNodes, innerType);
                if (targetId) {
                    edges.push({ from: sourceNode.id, to: targetId, fromField: child.name, type: 'composition', label: wrapperName });
                    // No continue; — we might also want to link to outer types or multiple generics in future, but for now this is good.
                    // If we found a wrapper target, we are good.
                    continue;
                }
            }

            const targetId = findNodeByName(allNodes, rawType);
            if (targetId) {
                edges.push({ from: sourceNode.id, to: targetId, type: 'composition' });
            }
        }
    }
}

function unwrapType(typeStr: string): { isWrapper: boolean; innerType?: string; wrapperName?: string } {
    const wrappers = new Set(['Vec', 'Option', 'Box', 'Arc', 'Rc', 'RefCell', 'Cell', 'Mutex', 'RwLock', 'Result', 'Unique', 'NonNull']);

    let currentType = typeStr;
    let foundWrapper = false;
    let wrapperName = "";

    // Loop to unwrap nested wrappers like Arc<Vec<T>> -> T
    while (true) {
        // Handle namespaces (::) and bracketed types
        const match = currentType.match(/^([\w:]+)<(.+)>$/);
        if (match) {
            const wrapper = match[1];
            const inner = match[2];
            const wrapperBase = wrapper.split('::').pop() || wrapper;

            if (wrappers.has(wrapperBase)) {
                foundWrapper = true;
                if (wrapperName) wrapperName += `<${wrapperBase}>`; // crude composition notation
                else wrapperName = wrapperBase;

                currentType = inner.trim();

                // If inner type has multiple generic args (e.g. Result<T, E>), take the first one usually
                // This is a heuristic. A better parser would be needed for full rust type support.
                if (currentType.includes(',')) {
                    currentType = currentType.split(',')[0].trim();
                }
                continue;
            }
        }
        break;
    }

    if (foundWrapper) {
        return { isWrapper: true, innerType: currentType, wrapperName };
    }
    return { isWrapper: false };
}

function isIgnoredNode(node: GraphNode): boolean {
    const ignored = new Set(['RawVec', 'RawVecInner', 'NonNull', 'Unique', 'PhantomData', 'Allocator', 'Global', 'Layout']);
    return ignored.has(node.label);
}

function findNodeByName(nodes: Map<string, GraphNode>, name: string): string | undefined {
    for (const node of nodes.values()) {
        if (node.label === name || node.label.endsWith("::" + name)) return node.id;
    }
    return undefined;
}

function isTypeSymbol(kind: vscode.SymbolKind): boolean {
    return kind === vscode.SymbolKind.Class ||
        kind === vscode.SymbolKind.Interface ||
        kind === vscode.SymbolKind.Struct ||
        kind === vscode.SymbolKind.Enum;
}

function getTypeUniqueId(symbolChain: vscode.DocumentSymbol[], uri: vscode.Uri): string {
    // ID: uri#namespace#type
    // We construct the chain: Container -> Member -> Type
    const path = symbolChain.map(s => s.name).join('#');
    return `${uri.toString()}#${path}`;
}

function loadExcludePatterns(): string[] {
    const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') || {};
    const searchExclude = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude') || {};

    // Merge both exclude configs
    const patterns = new Set<string>();

    for (const [pattern, enabled] of Object.entries(filesExclude)) {
        if (enabled) patterns.add(pattern);
    }
    for (const [pattern, enabled] of Object.entries(searchExclude)) {
        if (enabled) patterns.add(pattern);
    }

    return Array.from(patterns);
}

function buildDot(nodes: Map<string, GraphNode>, edges: GraphEdge[]): string {
    let dot = `digraph G {
  rankdir=LR;
  bgcolor="transparent";
  node [fontname="Helvetica", fontsize=11];
  edge [color="#569cd6", fontcolor="#888888", fontsize=9, penwidth=1.5];
`;

    for (const node of nodes.values()) {
        if (isIgnoredNode(node)) continue; // Skip internal Rust allocator types

        const escapedTitle = escapeHtml(node.label);

        let fieldRows = "";
        if (node.fields.length > 0) {
            fieldRows = node.fields.map(f => {
                // Extract field name (before ':') for the PORT attribute
                const fieldName = f.split(':')[0].trim();
                // BORDER="1" SIDES="B" COLOR="#444444" gives a faint bottom border
                return `<TR><TD ALIGN="LEFT" BORDER="1" SIDES="B" COLOR="#444444" PORT="${escapeHtml(fieldName)}"><FONT FACE="Helvetica" POINT-SIZE="10" COLOR="#cccccc">${escapeHtml(f)}</FONT></TD></TR>`;
            }).join("");
        }

        const borderColor = "#569cd6";
        const headerColor = "#374151";

        dot += `  "${node.id}" [shape=none, label=<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="4" COLOR="${borderColor}" BGCOLOR="#1e1e2e">
  <TR><TD BGCOLOR="${headerColor}" BORDER="1" SIDES="B" CELLPADDING="6"><FONT COLOR="white" POINT-SIZE="11"><B>${escapedTitle}</B></FONT></TD></TR>
  ${fieldRows}
</TABLE>>];\n`;
    }

    for (const edge of edges) {
        const fromNode = nodes.get(edge.from);
        const toNode = nodes.get(edge.to);
        if (!fromNode || isIgnoredNode(fromNode) || !toNode || isIgnoredNode(toNode)) continue;

        let attrParts: string[] = [];
        if (edge.type === 'inheritance') attrParts.push('style=dashed, arrowtail=empty, dir=back');
        else if (edge.type === 'composition') attrParts.push('arrowhead=diamond');
        else if (edge.type === 'implementation') attrParts.push('style=dotted, arrowtail=empty, dir=back');
        if (edge.label) attrParts.push(`label="${edge.label}"`);

        const attrs = attrParts.length ? ` [${attrParts.join(', ')}]` : '';
        // Use port syntax if the edge has a fromField
        const fromPort = edge.fromField ? `:"${edge.fromField}"` : '';
        dot += `  "${edge.from}"${fromPort} -> "${edge.to}"${attrs};\n`;
    }
    dot += '}';
    return dot;
}
