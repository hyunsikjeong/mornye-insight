import * as vscode from "vscode";

export interface GraphNode {
    // Unique ID: {uri}#{name}
    id: string;
    // VS Code dependent members
    uri: vscode.Uri;
    symbol: vscode.DocumentSymbol;
    // Fields. Name: Def
    fields: [string, string][];
    edges: GraphEdge[];
}

export interface GraphEdge {
    to: string;
    fromField?: string;
    type: "inheritance" | "composition" | "implementation";
}

export interface DotResult {
    dot: string;
    nodeIds: Set<string>;
}

export interface TypeReference {
    name: string;
    range: vscode.Range;
}

export interface FieldInfo {
    name: string;
    typeText: string;
    typeRange: vscode.Range;
}
