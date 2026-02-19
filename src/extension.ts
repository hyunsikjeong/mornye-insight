import * as vscode from 'vscode';
import * as path from 'path';
import { generateDot, generateGraphFromNode, DotResult, findSymForSelection, graphCache } from './graphGenerator';
import { getWebviewContent } from './webview';

let activePanel: vscode.WebviewPanel | undefined;
let activeRequestId = 0;
let lastDot = '';
let debounceTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "ds-insight" is now active!');

    // Cache Invalidation Listener
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'rust') {
                graphCache.invalidate(e.document.uri);
            }
        })
    );

    const showGraph = async () => {
        if (activePanel) {
            activePanel.reveal(vscode.ViewColumn.Two);
        } else {
            activePanel = vscode.window.createWebviewPanel(
                'dsInsight',
                'Data Structure Insight',
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true, // Preserve state when hidden
                    localResourceRoots: [
                        vscode.Uri.joinPath(context.extensionUri, 'media'),
                        vscode.Uri.joinPath(context.extensionUri, 'out')
                    ]
                }
            );

            activePanel.onDidDispose(() => {
                activePanel = undefined;
            }, null, context.subscriptions);

            activePanel.webview.onDidReceiveMessage(message => {
                switch (message.command) {
                    case 'openFile':
                        openFile(message.uri, message.line);
                        break;
                    case 'refresh':
                        updateGraph();
                        break;
                }
            }, undefined, context.subscriptions);

            activePanel.onDidChangeViewState(e => {
                if (e.webviewPanel.visible && lastDot) {
                    activePanel?.webview.postMessage({ command: 'update', dot: lastDot });
                }
            }, null, context.subscriptions);
        }

        activePanel.webview.html = getWebviewContent(activePanel.webview, context.extensionUri);

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await updateGraph();
        } else {
            await updateGraph(true);
        }
    };

    const updateGraph = async (forceGlobal: boolean = false) => {
        if (!activePanel) return;
        const panel = activePanel;
        const requestId = ++activeRequestId;

        const logger = (msg: string) => {
            console.log(`[Extension] ${msg}`);
            panel.webview.postMessage({ command: 'log', text: msg });
        };

        try {
            const editor = vscode.window.activeTextEditor;
            let result: DotResult = { dot: '', nodeIds: new Set() };

            if (editor && !forceGlobal) {
                let attempt = 0;
                const maxAttempts = 5;

                while (attempt < maxAttempts) {
                    if (requestId !== activeRequestId) return;

                    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                        'vscode.executeDocumentSymbolProvider',
                        editor.document.uri
                    );

                    const sym = symbols ? findSymForSelection(symbols, editor.selection.active) : undefined;

                    if (symbols && !sym) {
                        // Cursor not inside a type — silently keep showing last graph.
                        return;
                    }

                    let crawlUri = editor.document.uri;
                    let crawlPos = editor.selection.active;

                    if (sym) {
                        const isType = isTypeSymbol(sym.kind);
                        if (!isType) {
                            const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                                'vscode.executeDefinitionProvider', editor.document.uri, editor.selection.active
                            );
                            if (defs && defs.length > 0) {
                                const def = defs[0];
                                crawlUri = 'targetUri' in def ? def.targetUri : def.uri;
                                crawlPos = ('targetSelectionRange' in def ? def.targetSelectionRange?.start : undefined)
                                    ?? ('targetRange' in def ? def.targetRange?.start : undefined)
                                    ?? (def as vscode.Location).range?.start
                                    ?? crawlPos;
                            }
                        }
                    }

                    logger(`Analyzing ${sym?.name || 'context'}...`);
                    result = await generateGraphFromNode(crawlUri, crawlPos, logger);

                    if (result.nodeIds.size > 0) break;
                    if (symbols && result.nodeIds.size === 0) break;

                    logger("Waiting for Language Server to warm up...");
                    if (attempt === 0) {
                        panel.webview.postMessage({ command: 'status', text: 'Waiting for Language Server...' });
                    }

                    await new Promise(r => setTimeout(r, 1500));
                    attempt++;
                }

                if (result.nodeIds.size === 0 && requestId === activeRequestId) {
                    // No data found — silently keep showing last graph.
                    return;
                }

            } else {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders) return;

                const supportedExtensions = ['.ts', '.js', '.py', '.java', '.cs', '.cpp', '.h', '.hpp', '.c', '.go', '.rs'];
                const blobPattern = `**/*.{${supportedExtensions.map(e => e.replace('.', '')).join(',')}}`;
                const files = await vscode.workspace.findFiles(blobPattern, '**/node_modules/**');
                const extCounts = new Map<string, number>();
                for (const file of files) {
                    const ext = path.extname(file.fsPath);
                    if (ext) extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
                }

                if (extCounts.size === 0) {
                    panel.webview.postMessage({ command: 'status', text: '⚠️ No supported source files found.' });
                    return;
                }

                const sortedExts = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]);
                const items = sortedExts.map(([ext, count]) => ({ label: ext, description: `${count} files`, picked: ext === sortedExts[0][0] }));
                const selected = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: "Select languages" });
                if (selected && requestId === activeRequestId) {
                    const res = await generateDot(workspaceFolders[0].uri, selected.map(i => i.label), logger);
                    result = res;
                }
            }

            logger(`Crawl done: ${result.nodeIds.size} nodes, dot length: ${result.dot.length}, requestId ok: ${requestId === activeRequestId}`);
            logger(`--- DOT START ---\n${result.dot}\n--- DOT END ---`);
            if (result.dot && requestId === activeRequestId) {
                lastDot = result.dot;
                panel.webview.postMessage({ command: 'update', dot: result.dot });
            }
        } catch (error: any) {
            logger(`Error: ${error.message}`);
        }
    };

    context.subscriptions.push(vscode.commands.registerCommand('ds-insight.showGraph', showGraph));

    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
        if (activePanel && e.textEditor === vscode.window.activeTextEditor) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                updateGraph();
            }, 700);

        }
    }));
}

function isTypeSymbol(kind: vscode.SymbolKind): boolean {
    return kind === vscode.SymbolKind.Class ||
        kind === vscode.SymbolKind.Interface ||
        kind === vscode.SymbolKind.Struct ||
        kind === vscode.SymbolKind.Enum;
}

function openFile(uriStr: string, line: number) {
    const uri = vscode.Uri.parse(uriStr);
    vscode.workspace.openTextDocument(uri).then(doc => {
        vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
    });
}

export function deactivate() { }
