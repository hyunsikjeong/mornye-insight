import * as vscode from 'vscode';

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const d3Uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'd3.min.js'));
    const hpccWasmUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'hpcc-wasm.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webviewMain.js'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource}; img-src data: ${webview.cspSource} https:; connect-src ${webview.cspSource} https:; worker-src blob:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Data Structure Insight</title>
    <script src="${d3Uri}"></script>
    <style>
        body { margin: 0; padding: 0; overflow: hidden; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
        #graph { width: 100vw; height: 100vh; }
        #loading {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            font-size: 24px; color: var(--vscode-descriptionForeground);
            z-index: 100; pointer-events: none;
            font-family: var(--vscode-font-family);
        }
        #logs {
            position: absolute; bottom: 0; left: 0; right: 0; height: 120px;
            background: rgba(0,0,0,0.85); color: #00ff88; font-family: monospace;
            overflow-y: auto; padding: 8px 10px; z-index: 200; font-size: 11px;
            display: block;
            border-top: 1px solid #333;
        }
        #refreshBtn {
            position: absolute; top: 10px; right: 10px; z-index: 300;
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; cursor: pointer; border-radius: 2px;
        }
        .node text { fill: var(--vscode-editor-foreground); }
        .edge path { opacity: 0.8; }
    </style>
</head>
<body data-hpcc-uri="${hpccWasmUri}">
    <div id="loading">Loading...</div>
    <div id="logs">Waiting for logs...</div>
    <button id="refreshBtn">Refresh</button>
    <div id="graph"></div>

    <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
