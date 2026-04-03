import * as vscode from "vscode";
import { LanguageHandler } from "../languageHandler";
import { TypeReference, FieldInfo } from "../types";

export class GenericHandler implements LanguageHandler {
    readonly languageIds: readonly string[] = [];

    isTypeSymbol(symbol: vscode.DocumentSymbol): boolean {
        const kind = symbol.kind;
        return (
            kind === vscode.SymbolKind.Class ||
            kind === vscode.SymbolKind.Interface ||
            kind === vscode.SymbolKind.Struct ||
            kind === vscode.SymbolKind.Enum ||
            kind === vscode.SymbolKind.TypeParameter ||
            kind === vscode.SymbolKind.Variable ||
            kind === vscode.SymbolKind.Constant ||
            kind === vscode.SymbolKind.Operator
        );
    }

    getTypeCategory(
        symbol: vscode.DocumentSymbol,
    ): "struct" | "enum" | "typeAlias" | "class" | "interface" | null {
        switch (symbol.kind) {
            case vscode.SymbolKind.Struct:
                return "struct";
            case vscode.SymbolKind.Enum:
                return "enum";
            case vscode.SymbolKind.Class:
                return "class";
            case vscode.SymbolKind.Interface:
                return "interface";
            case vscode.SymbolKind.TypeParameter:
            case vscode.SymbolKind.Operator:
            case vscode.SymbolKind.Variable:
            case vscode.SymbolKind.Constant:
                return "typeAlias";
            default:
                return null;
        }
    }

    async extractTypeReferences(
        document: vscode.TextDocument,
        range: vscode.Range,
    ): Promise<TypeReference[]> {
        const refs: TypeReference[] = [];
        let pos = document.positionAt(document.offsetAt(range.start) + 1);

        while (pos.isBeforeOrEqual(range.end)) {
            const defs = await vscode.commands.executeCommand<
                (vscode.Location | vscode.LocationLink)[]
            >("vscode.executeDefinitionProvider", document.uri, pos);

            if (defs && defs.length > 0) {
                const def = defs[0];

                if ("originSelectionRange" in def && def.originSelectionRange) {
                    refs.push({
                        name: document.getText(def.originSelectionRange),
                        range: def.originSelectionRange,
                    });
                    pos = document.positionAt(
                        document.offsetAt(def.originSelectionRange.end) + 1,
                    );
                    continue;
                }
            }
            pos = document.positionAt(document.offsetAt(pos) + 1);
        }
        return refs;
    }

    async extractFields(
        document: vscode.TextDocument,
        symbol: vscode.DocumentSymbol,
    ): Promise<FieldInfo[]> {
        const fields: FieldInfo[] = [];
        for (const child of symbol.children) {
            if (child.kind === vscode.SymbolKind.Field) {
                fields.push({
                    name: child.name,
                    typeText: child.detail ?? "",
                    typeRange: new vscode.Range(child.selectionRange.end, child.range.end),
                });
            } else if (child.kind === vscode.SymbolKind.EnumMember) {
                const rawText = document
                    .getText(new vscode.Range(child.selectionRange.end, child.range.end))
                    .trim();
                fields.push({
                    name: child.name,
                    typeText: child.detail ? `(${child.detail})` : rawText,
                    typeRange: new vscode.Range(child.selectionRange.end, child.range.end),
                });
            }
        }
        return fields;
    }
}
