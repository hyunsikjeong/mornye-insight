import * as vscode from 'vscode';
import { generateGraph, graphCache } from './graphGenerator';
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
            graphCache.invalidate(e.document.uri);
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
                        if (vscode.window.activeTextEditor) {
                            graphCache.invalidate(vscode.window.activeTextEditor.document.uri);
                        }
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

        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            let attempt = 0;
            const maxAttempts = 6;
            let lastDotLength = -1;

            while (attempt < maxAttempts) {
                if (requestId !== activeRequestId) return;

                const result = await generateGraph(editor.document.uri, editor.selection.active);

                if (requestId !== activeRequestId) return;

                if (result && result.dot) {
                    if (result.dot.length > lastDotLength) {
                        lastDot = result.dot;
                        panel.webview.postMessage({ command: 'update', dot: result.dot });
                        lastDotLength = result.dot.length;
                        
                        graphCache.invalidate(editor.document.uri);
                    } else {
                        break;
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
                attempt++;
            }

        } catch (error: any) {
            panel.webview.postMessage({ command: 'log', text: `Error: ${error.message}` });
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
