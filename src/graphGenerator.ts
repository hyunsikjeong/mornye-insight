import * as vscode from "vscode";
import { GraphNode, DotResult, TypeReference } from "./types";
import { LanguageHandler, HandlerRegistry } from "./languageHandler";

class GraphCacheManager {
    private rawCache = new Map<string, Promise<GraphNode | undefined>>();
    private graphCache = new Map<string, DotResult>();
    private dependencies = new Map<string, Set<string>>();

    getRaw(id: string): Promise<GraphNode | undefined> | undefined {
        return this.rawCache.get(id);
    }

    setRaw(id: string, promise: Promise<GraphNode | undefined>) {
        this.rawCache.set(id, promise);
    }

    deleteRaw(id: string) {
        this.rawCache.delete(id);
    }

    getGraph(rootId: string): DotResult | undefined {
        return this.graphCache.get(rootId);
    }

    setGraph(rootId: string, result: DotResult, dependentUris: Set<string>) {
        this.graphCache.set(rootId, result);
        for (const uri of dependentUris) {
            if (!this.dependencies.has(uri)) {
                this.dependencies.set(uri, new Set());
            }
            this.dependencies.get(uri)!.add(rootId);
        }
    }

    invalidate(uri: vscode.Uri) {
        const uriStr = uri.toString();
        const prefix = uriStr + "#";

        for (const id of this.rawCache.keys()) {
            if (id.startsWith(prefix)) {
                this.rawCache.delete(id);
            }
        }

        const affectedRoots = this.dependencies.get(uriStr);
        if (affectedRoots) {
            for (const rootId of affectedRoots) {
                this.graphCache.delete(rootId);
            }
            this.dependencies.delete(uriStr);
        }
    }

    invalidateForRetry(uri: vscode.Uri) {
        const prefix = uri.toString() + "#";

        for (const id of this.rawCache.keys()) {
            if (id.startsWith(prefix)) {
                this.rawCache.delete(id);
            }
        }

        for (const rootId of this.graphCache.keys()) {
            if (rootId.startsWith(prefix)) {
                this.graphCache.delete(rootId);
            }
        }
    }
}

export const graphCache = new GraphCacheManager();

let handlerRegistry: HandlerRegistry | undefined;

export function setHandlerRegistry(registry: HandlerRegistry) {
    handlerRegistry = registry;
}

async function resolveFromCache(id: string, localGraph: Map<string, GraphNode>): Promise<boolean> {
    const added = new Set<string>();

    async function resolve(currentId: string): Promise<boolean> {
        if (localGraph.has(currentId)) return true;

        const cached = graphCache.getRaw(currentId);
        if (!cached) return false;

        const node = await cached;
        if (!node) return false;

        localGraph.set(currentId, node);
        added.add(currentId);

        for (const edge of node.edges) {
            if (!(await resolve(edge.to))) {
                return false;
            }
        }
        return true;
    }

    if (await resolve(id)) {
        return true;
    } else {
        for (const addedId of added) {
            localGraph.delete(addedId);
        }
        return false;
    }
}

function escapeHtml(str: string): string {
    return str.replace(/[&<>"']/g, function (m) {
        switch (m) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            case "'":
                return "&apos;";
            default:
                return m;
        }
    });
}

function getHandler(languageId: string): LanguageHandler {
    if (!handlerRegistry) {
        throw new Error("HandlerRegistry not initialized");
    }
    return handlerRegistry.getHandler(languageId);
}

async function getFirstTypeSymbolOnPos(
    uri: vscode.Uri,
    pos: vscode.Position,
    handler: LanguageHandler,
): Promise<vscode.DocumentSymbol | undefined> {
    let symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
    );

    if (!symbols) {
        return;
    }

    while (symbols && symbols.length > 0) {
        let foundMatch = false;

        for (const s of symbols) {
            if (s.range.contains(pos)) {
                if (handler.isTypeSymbol(s)) {
                    return s;
                }

                if (s.children.length > 0) {
                    symbols = s.children;
                    foundMatch = true;
                    break;
                }

                return;
            }
        }

        if (!foundMatch) {
            break;
        }
    }

    return;
}

export async function generateGraph(
    uri: vscode.Uri,
    pos: vscode.Position,
): Promise<DotResult | undefined> {
    if (!(await isValidSourceFile(uri))) return;

    const document = await vscode.workspace.openTextDocument(uri);
    const handler = getHandler(document.languageId);

    const symbol = await getFirstTypeSymbolOnPos(uri, pos, handler);
    if (!symbol) return;

    const rootId = `${uri.toString()}#${symbol.name}`;

    const cachedGraph = graphCache.getGraph(rootId);
    if (cachedGraph) return cachedGraph;

    const graph = new Map<string, GraphNode>();

    const ret = await generateNodeFromSymbol(uri, symbol, graph, handler);

    if (!ret) return;

    const dot = buildDot(graph);
    const result = {
        dot,
        nodeIds: new Set(graph.keys()),
    };

    const dependentUris = new Set<string>();
    for (const node of graph.values()) {
        dependentUris.add(node.uri.toString());
    }

    graphCache.setGraph(rootId, result, dependentUris);
    return result;
}

async function generateNodeFromPos(
    uri: vscode.Uri,
    pos: vscode.Position,
    graph: Map<string, GraphNode>,
    handler: LanguageHandler,
): Promise<GraphNode | undefined> {
    if (!(await isValidSourceFile(uri))) return;

    const symbol = await getFirstTypeSymbolOnPos(uri, pos, handler);
    if (!symbol) return;

    return await generateNodeFromSymbol(uri, symbol, graph, handler);
}

async function generateNodeFromSymbol(
    uri: vscode.Uri,
    symbol: vscode.DocumentSymbol,
    graph: Map<string, GraphNode>,
    handler: LanguageHandler,
): Promise<GraphNode | undefined> {
    const id = `${uri.toString()}#${symbol.name}`;
    if (graph.has(id)) return graph.get(id);

    if (await resolveFromCache(id, graph)) return graph.get(id);

    const category = handler.getTypeCategory(symbol);
    if (!category) return undefined;

    let resolveRaw!: (node: GraphNode | undefined) => void;
    let rejectRaw!: (error: unknown) => void;
    const promise = new Promise<GraphNode | undefined>((resolve, reject) => {
        resolveRaw = resolve;
        rejectRaw = reject;
    });
    graphCache.setRaw(id, promise);

    let result: GraphNode | undefined;
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        const node: GraphNode = { id, uri, symbol, fields: [], edges: [] };
        graph.set(id, node);

        if (category === "typeAlias") {
            node.fields.push(["def", symbol.detail ?? ""]);
            const refs = await handler.extractTypeReferences(
                document,
                new vscode.Range(symbol.selectionRange.end, symbol.range.end),
            );
            for (const ref of refs) {
                await resolveTypeReference(uri, ref, node, "def", graph, handler);
            }
        } else {
            const fields = await handler.extractFields(document, symbol);
            for (const field of fields) {
                node.fields.push([field.name, field.typeText]);
                const refs = await handler.extractTypeReferences(document, field.typeRange);
                for (const ref of refs) {
                    await resolveTypeReference(uri, ref, node, field.name, graph, handler);
                }
            }
        }

        result = node;
    } catch (e) {
        graphCache.deleteRaw(id);
        rejectRaw(e);
        throw e;
    }

    resolveRaw(result);
    return result;
}

async function resolveTypeReference(
    uri: vscode.Uri,
    ref: TypeReference,
    parentNode: GraphNode,
    fromField: string,
    graph: Map<string, GraphNode>,
    handler: LanguageHandler,
): Promise<void> {
    const midPos = new vscode.Position(
        ref.range.start.line,
        Math.floor((ref.range.start.character + ref.range.end.character) / 2),
    );
    const defs = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
    >("vscode.executeDefinitionProvider", uri, midPos);

    if (!defs || defs.length === 0) return;

    const def = defs[0];
    const targetUri = "targetUri" in def ? def.targetUri : def.uri;
    const targetRange = "targetRange" in def ? def.targetRange : def.range;

    const targetNode = await generateNodeFromPos(
        targetUri,
        targetRange.start,
        graph,
        handler,
    );
    if (targetNode && targetNode.id !== parentNode.id) {
        if (!parentNode.edges.some((e) => e.to === targetNode.id && e.fromField === fromField)) {
            parentNode.edges.push({
                to: targetNode.id,
                fromField,
                type: "composition",
            });
        }
    }
}

async function isValidSourceFile(uri: vscode.Uri): Promise<boolean> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
        return false;
    }

    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, relativePath),
        null,
        1,
    );

    return found.length > 0;
}

function buildDot(nodes: Map<string, GraphNode>): string {
    let dot = `digraph G {
  rankdir=LR;
  bgcolor="transparent";
  node [fontname="Helvetica", fontsize=11];
  edge [color="#569cd6", fontcolor="#888888", fontsize=9, penwidth=1.5];
`;

    for (const node of nodes.values()) {
        const escapedTitle = escapeHtml(node.symbol.name);

        let fieldRows = "";
        if (node.fields.length > 0) {
            fieldRows = node.fields
                .map((f) => {
                    const fieldName = f[0].trim();
                    const fieldDef = f[1];

                    const displayStr =
                        node.symbol.kind === vscode.SymbolKind.Enum
                            ? `${fieldName}${fieldDef}`
                            : node.symbol.kind === vscode.SymbolKind.TypeParameter ||
                                node.symbol.kind === vscode.SymbolKind.Operator
                              ? `${fieldDef}`
                              : `${fieldName}: ${fieldDef}`;

                    return `<TR><TD ALIGN="LEFT" BORDER="1" SIDES="B" COLOR="#444444" PORT="${escapeHtml(fieldName)}"><FONT FACE="Helvetica" POINT-SIZE="10" COLOR="#cccccc">${escapeHtml(displayStr)}</FONT></TD></TR>`;
                })
                .join("");
        }

        let shape = "none";
        let borderColor = "#569cd6";
        let headerColor = "#374151";
        let titleHtml = `<B>${escapedTitle}</B>`;
        let extraNodeAttrs = "";

        if (node.symbol.kind === vscode.SymbolKind.Struct) {
            titleHtml = `<I>&lt;&lt;struct&gt;&gt;</I><BR/><B>${escapedTitle}</B>`;
        } else if (node.symbol.kind === vscode.SymbolKind.Enum) {
            shape = "folder";
            borderColor = "#d4a017";
            headerColor = "#8a6d0b";
            titleHtml = `<I>&lt;&lt;enum&gt;&gt;</I><BR/><B>${escapedTitle}</B>`;
        } else if (
            node.symbol.kind === vscode.SymbolKind.TypeParameter ||
            node.symbol.kind === vscode.SymbolKind.Operator
        ) {
            shape = "component";
            borderColor = "#d4a017";
            headerColor = "#5c5c5c";
            extraNodeAttrs = 'style="dashed"';
            titleHtml = `<I>&lt;&lt;alias&gt;&gt;</I><BR/><B>${escapedTitle}</B>`;
        }

        const urlAttr = `URL="${node.uri.toString()}#${node.symbol.range.start.line}"`;

        dot += `  "${node.id}" [shape=${shape}, ${urlAttr}${extraNodeAttrs ? ", " + extraNodeAttrs : ""}, label=<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="4" COLOR="${borderColor}" BGCOLOR="#1e1e2e">
  <TR><TD BGCOLOR="${headerColor}" BORDER="1" SIDES="B" CELLPADDING="6"><FONT COLOR="white" POINT-SIZE="11">${titleHtml}</FONT></TD></TR>
  ${fieldRows}
</TABLE>>];\n`;
    }

    for (const fromNode of nodes.values()) {
        for (const edge of fromNode.edges) {
            let attrParts: string[] = [];
            if (edge.type === "inheritance")
                attrParts.push("style=dashed, arrowtail=empty, dir=back");
            else if (edge.type === "composition") attrParts.push("arrowhead=diamond");
            else if (edge.type === "implementation")
                attrParts.push("style=dotted, arrowtail=empty, dir=back");

            const attrs = attrParts.length ? ` [${attrParts.join(", ")}]` : "";
            const fromPort = edge.fromField ? `:"${edge.fromField}"` : "";
            dot += `  "${fromNode.id}"${fromPort} -> "${edge.to}"${attrs};\n`;
        }
    }

    dot += "}";
    return dot;
}
