import * as vscode from "vscode";
import { TypeReference, FieldInfo } from "./types";

export interface LanguageHandler {
    readonly languageIds: readonly string[];

    isTypeSymbol(symbol: vscode.DocumentSymbol): boolean;

    getTypeCategory(
        symbol: vscode.DocumentSymbol,
    ): "struct" | "enum" | "typeAlias" | "class" | "interface" | null;

    extractTypeReferences(
        document: vscode.TextDocument,
        range: vscode.Range,
    ): Promise<TypeReference[]>;

    extractFields(
        document: vscode.TextDocument,
        symbol: vscode.DocumentSymbol,
    ): Promise<FieldInfo[]>;

    dispose?(): void;
}

export class HandlerRegistry {
    private handlers = new Map<string, LanguageHandler>();
    private fallback: LanguageHandler;

    constructor(fallback: LanguageHandler) {
        this.fallback = fallback;
    }

    register(handler: LanguageHandler): void {
        for (const langId of handler.languageIds) {
            this.handlers.set(langId, handler);
        }
    }

    getHandler(languageId: string): LanguageHandler {
        return this.handlers.get(languageId) ?? this.fallback;
    }

    dispose(): void {
        const seen = new Set<LanguageHandler>();
        for (const handler of this.handlers.values()) {
            if (!seen.has(handler)) {
                seen.add(handler);
                handler.dispose?.();
            }
        }
        this.fallback.dispose?.();
    }
}
