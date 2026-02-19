import * as vscode from 'vscode';

interface GraphNode {
    // Unique ID: {uri}#{name}
    id: string;
    // VS Code dependent members
    uri: vscode.Uri;
    symbol: vscode.DocumentSymbol;
    // Fields. Name: Def
    fields: [string, string][];
    edges: GraphEdge[];
}

interface GraphEdge {
    to: string;
    fromField?: string;
    type: 'inheritance' | 'composition' | 'implementation';
}

export interface DotResult {
    dot: string;
    nodeIds: Set<string>;
}

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

function isTypeSymbol(symbol: vscode.DocumentSymbol): boolean {
    const kind = symbol.kind;
    return kind === vscode.SymbolKind.Class ||
        kind === vscode.SymbolKind.Interface ||
        kind === vscode.SymbolKind.Struct ||
        kind === vscode.SymbolKind.Enum ||
        kind === vscode.SymbolKind.TypeParameter ||
        kind === vscode.SymbolKind.Variable ||
        kind === vscode.SymbolKind.Constant || // Sometimes Aliases are Constants
        kind === vscode.SymbolKind.Operator; // TypeAlias often maps to Operator (24) in VSCode/Rust-Analyzer
}

async function getFirstTypeSymbolOnPos(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.DocumentSymbol | undefined> {
    let symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
    );

    if (!symbols) {
        return;
    }

    while (symbols && symbols.length > 0) {
        let foundMatch = false;

        for (const s of symbols) {
            if (s.range.contains(pos)) {
                if (isTypeSymbol(s)) {
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

export async function generateGraph(uri: vscode.Uri, pos: vscode.Position): Promise<DotResult | undefined> {
    const graph = new Map<string, GraphNode>;
    const ret = await generateNodeFromPos(uri, pos, graph);

    if (!ret)
        return;

    const dot = buildDot(graph);

    return {
        dot,
        nodeIds: new Set(graph.keys())
    }
}

async function generateNodeFromPos(uri: vscode.Uri, pos: vscode.Position, graph: Map<string, GraphNode>): Promise<GraphNode | undefined> {
    if (!(await isValidSourceFile(uri)))
        return;

    const symbol = await getFirstTypeSymbolOnPos(uri, pos);
    if (!symbol)
        return;

    const name = `${uri.toString()}#${symbol.name}`;
    if (graph.has(name))
        return graph.get(name);

    // Currently this logic only supports Rust
    // TODO: 1. test on other languages, 2. test on SymbolKind.Class and so on
    switch (symbol.kind) {
        case vscode.SymbolKind.Struct:
            return await generateStructNode(uri, symbol, graph);
        case vscode.SymbolKind.Enum:
            return await generateEnumNode(uri, symbol, graph);
        case vscode.SymbolKind.TypeParameter: // type A = B in Rust. Why???
            return await generateTypeAliasNode(uri, symbol, graph);
        default:
            return;
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
        1
    );

    return found.length > 0;
}

async function getTypeDetailString(uri: vscode.Uri, selectionEnd: vscode.Position, rangeEnd: vscode.Position): Promise<string> {
    const document = await vscode.workspace.openTextDocument(uri);
    const targetRange = new vscode.Range(selectionEnd, rangeEnd);
    const rawText = document.getText(targetRange);

    return rawText.trim();
}

async function generateNodesFromTypeDetail(uri: vscode.Uri, parentId: string, selectionEnd: vscode.Position, rangeEnd: vscode.Position, graph: Map<string, GraphNode>): Promise<GraphNode[]> {
    const document = await vscode.workspace.openTextDocument(uri);

    let pos = document.positionAt(document.offsetAt(selectionEnd) + 1);
    const nodeIds = new Set<string>();
    const ret = [];

    while (pos.isBeforeOrEqual(rangeEnd)) {
        const defs = await vscode.commands.executeCommand<
            (vscode.Location | vscode.LocationLink)[]
        >("vscode.executeDefinitionProvider", uri, pos);

        if (defs && defs.length > 0) {
            // There must be only one defintion.
            const def = defs[0];
            const targetUri = "targetUri" in def ? def.targetUri : def.uri;
            const targetRange = "targetRange" in def ? def.targetRange : def.range;

            const node = await generateNodeFromPos(targetUri, targetRange.start, graph);
            if (node && node.id !== parentId && !nodeIds.has(node.id)) {
                nodeIds.add(node.id);
                ret.push(node);
            }

            if ( "originSelectionRange" in def && def.originSelectionRange ) {
                pos = document.positionAt(document.offsetAt(def.originSelectionRange.end) + 1);
                continue;
            }
        }
        pos = document.positionAt(document.offsetAt(pos) + 1);
    }

    return ret;
}

async function generateStructNode(uri: vscode.Uri, symbol: vscode.DocumentSymbol, graph: Map<string, GraphNode>): Promise<GraphNode | undefined>{
    if (symbol.children.length === 0) {
        // TODO: Support tuple struct
        console.log(`Struct symbol ${symbol.name} does not have children; maybe tuple struct?`);
    }

    const node: GraphNode = {
        id: `${uri.toString()}#${symbol.name}`,
        uri,
        symbol,
        fields: [],
        edges: []
    };
    graph.set(node.id, node);

    for (const child of symbol.children) {
        if (child.kind !== vscode.SymbolKind.Field)
            continue;

        node.fields.push([child.name, child.detail]);
        const childNodes = await generateNodesFromTypeDetail(uri, node.id, child.selectionRange.end, child.range.end, graph);

        for (const childNode of childNodes) {
            const edge: GraphEdge = {
                to: childNode.id,
                fromField: child.name,
                type: "composition"
            };
            node.edges.push(edge);
        }
    }

    return node;
}

async function generateEnumNode(uri: vscode.Uri, symbol: vscode.DocumentSymbol, graph: Map<string, GraphNode>): Promise<GraphNode | undefined> {
    if (symbol.children.length === 0) {
        console.log(`Enum symbol ${symbol.name} does not have children; wtf?`);
    }

    const node: GraphNode = {
        id: `${uri.toString()}#${symbol.name}`,
        uri,
        symbol,
        fields: [],
        edges: []
    };
    graph.set(node.id, node);

    for (const child of symbol.children) {
        if (child.kind !== vscode.SymbolKind.EnumMember)
            continue;

        if (!child.detail)
            node.fields.push([child.name, await getTypeDetailString(uri, child.selectionRange.end, child.range.end)]);
        else
            node.fields.push([child.name, `(${child.detail})`]);

        const childNodes = await generateNodesFromTypeDetail(uri, node.id, child.selectionRange.end, child.range.end, graph);

        for (const childNode of childNodes) {
            const edge: GraphEdge = {
                to: childNode.id,
                fromField: child.name,
                type: "composition"
            };
            node.edges.push(edge);
        }
    }

    return node;
}

async function generateTypeAliasNode(uri: vscode.Uri, symbol: vscode.DocumentSymbol, graph: Map<string, GraphNode>): Promise<GraphNode | undefined> {
    const node: GraphNode = {
        id: `${uri.toString()}#${symbol.name}`,
        uri,
        symbol,
        fields: [["def", symbol.detail]],
        edges: []
    }
    graph.set(node.id, node);

    const childNodes = await generateNodesFromTypeDetail(uri, node.id, symbol.selectionRange.end, symbol.range.end, graph);

    for (const childNode of childNodes) {
        const edge: GraphEdge = {
            to: childNode.id,
            fromField: "def",
            type: "composition"
        };
        node.edges.push(edge);
    }

    return node;
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
            fieldRows = node.fields.map(f => {
                const fieldName = f[0].trim();
                const fieldDef = f[1];
                
                const displayStr = node.symbol.kind === vscode.SymbolKind.Enum 
                    ? `${fieldName}${fieldDef}` 
                    : node.symbol.kind === vscode.SymbolKind.TypeParameter
                    ? `${fieldDef}`
                    : `${fieldName}: ${fieldDef}`;

                return `<TR><TD ALIGN="LEFT" BORDER="1" SIDES="B" COLOR="#444444" PORT="${escapeHtml(fieldName)}"><FONT FACE="Helvetica" POINT-SIZE="10" COLOR="#cccccc">${escapeHtml(displayStr)}</FONT></TD></TR>`;
            }).join("");
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
        } else if (node.symbol.kind === vscode.SymbolKind.TypeParameter) {
            shape = "component";
            borderColor = "#d4a017";
            headerColor = "#5c5c5c";
            extraNodeAttrs = 'style="dashed"';
            titleHtml = `<I>&lt;&lt;alias&gt;&gt;</I><BR/><B>${escapedTitle}</B>`;
        }

        const urlAttr = `URL="${node.uri.toString()}#${node.symbol.range.start.line}"`;

        dot += `  "${node.id}" [shape=${shape}, ${urlAttr}${extraNodeAttrs ? ', ' + extraNodeAttrs : ''}, label=<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="4" COLOR="${borderColor}" BGCOLOR="#1e1e2e">
  <TR><TD BGCOLOR="${headerColor}" BORDER="1" SIDES="B" CELLPADDING="6"><FONT COLOR="white" POINT-SIZE="11">${titleHtml}</FONT></TD></TR>
  ${fieldRows}
</TABLE>>];\n`;
    }

    for (const fromNode of nodes.values()) {
        for (const edge of fromNode.edges) {
            let attrParts: string[] = [];
            if (edge.type === 'inheritance') attrParts.push('style=dashed, arrowtail=empty, dir=back');
            else if (edge.type === 'composition') attrParts.push('arrowhead=diamond');
            else if (edge.type === 'implementation') attrParts.push('style=dotted, arrowtail=empty, dir=back');

            const attrs = attrParts.length ? ` [${attrParts.join(', ')}]` : '';
            const fromPort = edge.fromField ? `:"${edge.fromField}"` : '';
            dot += `  "${fromNode.id}"${fromPort} -> "${edge.to}"${attrs};\n`;
        }
    }
    
    dot += '}';
    return dot;
}