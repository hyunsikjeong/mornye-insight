import * as vscode from 'vscode';
// import * as path from 'path';
import { generateGraph, DotResult } from './graphGenerator';
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
                // graphCache.invalidate(e.document.uri);
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
        }
    };

    const updateGraph = async () => {
        if (!activePanel) return;
        const panel = activePanel;
        const requestId = ++activeRequestId;

        const logger = (msg: string) => {
            console.log(`[Extension] ${msg}`);
            panel.webview.postMessage({ command: 'log', text: msg });
        };

        try {
            const editor = vscode.window.activeTextEditor;
            let result: DotResult | undefined = { dot: '', nodeIds: new Set() };

            if (editor) {
                let attempt = 0;
                const maxAttempts = 5;

                while (attempt < maxAttempts) {
                    if (requestId !== activeRequestId) return;

                    result = await generateGraph(editor.document.uri, editor.selection.active);
                    if (result && result.nodeIds.size > 0) break;

                    logger("Waiting for Language Server to warm up...");
                    if (attempt === 0) {
                        panel.webview.postMessage({ command: 'status', text: 'Waiting for Language Server...' });
                    }

                    await new Promise(r => setTimeout(r, 1500));
                    attempt++;
                }

                if (result && result.nodeIds.size === 0 && requestId === activeRequestId) {
                    // No data found — silently keep showing last graph.
                    return;
                }
            }
            if (result)
                logger(`Crawl done: ${result.nodeIds.size} nodes, dot length: ${result.dot.length}, requestId ok: ${requestId === activeRequestId}`);
            if (result && result.dot && requestId === activeRequestId) {
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

function openFile(uriStr: string, line: number) {
    const uri = vscode.Uri.parse(uriStr);
    vscode.workspace.openTextDocument(uri).then(doc => {
        vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
    });
}

export function deactivate() { }
