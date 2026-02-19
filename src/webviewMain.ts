// webviewMain.ts
// Graphviz SVG is used as-is (viewBox, #graph0 transform, etc. untouched).
// D3 zoom operates on a wrapper <g> around SVG content — standard pattern.
// Initial fit is handled by the browser's native viewBox scaling.

import type { WebviewApi } from 'vscode-webview';

// ─── Message types ────────────────────────────────────────────────────────────

type ExtensionMessage =
    | { command: 'update'; dot: string }
    | { command: 'status'; text: string }
    | { command: 'log'; text: string }
    | { command: 'focusNode'; nodeId: string };

// ─── Minimal D3 typings ──────────────────────────────────────────────────────

declare const d3: {
    zoom(): D3Zoom;
    zoomIdentity: D3Transform;
    select(el: Element | string): D3Sel;
    selectAll(sel: string): D3Sel;
};

interface D3Zoom {
    scaleExtent(e: [number, number]): D3Zoom;
    on(type: string, fn: (event: { transform: D3Transform }) => void): D3Zoom;
    transform(sel: D3Sel, t: D3Transform): void;
}

interface D3Transform {
    k: number; x: number; y: number;
    translate(x: number, y: number): D3Transform;
    scale(k: number): D3Transform;
}

interface D3Sel {
    empty(): boolean;
    node(): Element | null;
    select(s: string): D3Sel;
    selectAll(s: string): D3Sel;
    attr(name: string, val?: string | null): D3Sel;
    style(name: string, val?: string | null): D3Sel;
    on(type: string, fn: ((event: Event) => void) | null): D3Sel;
    call(fn: D3Zoom | ((s: D3Sel, t: D3Transform) => void), arg?: D3Transform): D3Sel;
    filter(fn: (this: Element) => boolean): D3Sel;
    text(): string;
    transition(): D3Trans;
}

interface D3Trans {
    duration(ms: number): D3Trans;
    call(fn: (s: D3Sel, t: D3Transform) => void, arg: D3Transform): D3Trans;
}

// ─── Graphviz ─────────────────────────────────────────────────────────────────

interface GraphvizModule { Graphviz: { load(): Promise<GvInstance> }; }
interface GvInstance { layout(dot: string, fmt: string, engine: string): string; }

// ─── State ────────────────────────────────────────────────────────────────────

const vscodeApi: WebviewApi<unknown> = acquireVsCodeApi();
let gviz: GvInstance | null = null;
let pendingDot: string | null = null;
let zoomBehavior: D3Zoom | null = null;
let lastRenderedDot: string | null = null;

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg: string): void {
    console.log('[ds]', msg);
    const el = document.getElementById('logs');
    if (!el) return;
    if (el.style.display === 'none') el.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = '> ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderGraph(dot: string): void {
    if (!gviz) { pendingDot = dot; return; }
    if (!dot.trim()) return;
    if (dot === lastRenderedDot) { log('Same DOT, skipping re-render'); return; }
    lastRenderedDot = dot;

    const container = document.getElementById('graph');
    if (!container) return;

    try {
        log(`Rendering (${dot.length} chars)…`);
        const svgText = gviz.layout(dot, 'svg', 'dot');

        // Inject the Graphviz SVG completely as-is.
        container.innerHTML = svgText;

        const svgEl = container.querySelector('svg') as SVGSVGElement | null;
        if (!svgEl) { log('ERROR: no <svg> in output'); return; }

        // Let the SVG fill the container. The viewBox (set by Graphviz) tells the
        // browser how to scale the content — this gives us a perfect initial fit
        // with zero JS math.
        svgEl.style.width = '100%';
        svgEl.style.height = '100%';

        // Wrap all SVG children in a <g id="zoom-layer"> for D3 pan/zoom.
        // This NEVER touches #graph0 or any Graphviz-internal structure.
        const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        wrapper.id = 'zoom-layer';
        while (svgEl.firstChild) wrapper.appendChild(svgEl.firstChild);
        svgEl.appendChild(wrapper);

        // Attach D3 zoom.
        const svgSel = d3.select(svgEl);
        const wrapperSel = d3.select(wrapper);

        const zoom = d3.zoom()
            .scaleExtent([0.1, 10])
            .on('zoom', (event) => {
                wrapperSel.attr('transform', `${event.transform}`);
            });

        svgSel.call(zoom);
        zoomBehavior = zoom;

        // Cursor feedback
        svgEl.style.cursor = 'grab';
        svgEl.addEventListener('mousedown', () => { svgEl.style.cursor = 'grabbing'; });
        svgEl.addEventListener('mouseup', () => { svgEl.style.cursor = 'grab'; });

        // Anchor clicks → open file in editor
        svgEl.querySelectorAll('a').forEach(anchor => {
            anchor.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const href = anchor.getAttribute('xlink:href') ?? anchor.getAttribute('href');
                if (href) {
                    const [uri, lineStr] = href.split('#');
                    vscodeApi.postMessage({ command: 'openFile', uri, line: parseInt(lineStr, 10) || 0 });
                }
            });
        });

        log('Graph rendered.');
    } catch (e: unknown) {
        log('Render error: ' + (e instanceof Error ? e.message : String(e)));
    }
}

// ─── Focus node ───────────────────────────────────────────────────────────────

function focusNode(nodeId: string): void {
    const svgEl = document.querySelector('#graph svg') as SVGSVGElement | null;
    if (!svgEl || !zoomBehavior) return;

    const rawId = nodeId.replace(/"/g, '');

    // Reset all node highlights
    svgEl.querySelectorAll('.node polygon').forEach(p =>
        (p as SVGElement).setAttribute('stroke', '#569cd6'));

    // Find target node
    let targetG: SVGGElement | null = null;
    svgEl.querySelectorAll('.node').forEach(node => {
        const title = node.querySelector('title')?.textContent?.replace(/"/g, '') ?? '';
        if (title === rawId) {
            targetG = node as SVGGElement;
            node.querySelector('polygon')?.setAttribute('stroke', '#ffcc00');
        }
    });

    if (!targetG) return;

    // Center on target node
    const bbox = (targetG as SVGGElement).getBBox();
    const svgRect = svgEl.getBoundingClientRect();
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    const scale = 1;
    const tx = svgRect.width / 2 - cx * scale;
    const ty = svgRect.height / 2 - cy * scale;

    d3.select(svgEl).transition().duration(400).call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

function setupButtons(): void {
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.onclick = () => vscodeApi.postMessage({ command: 'refresh' });

    if (!document.getElementById('centerBtn')) {
        const btn = document.createElement('button');
        btn.id = 'centerBtn';
        btn.textContent = 'Center';
        btn.style.cssText = 'position:absolute;top:10px;right:80px;z-index:300;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;border-radius:2px;';
        btn.onclick = () => {
            const svgEl = document.querySelector('#graph svg');
            if (svgEl && zoomBehavior) {
                d3.select(svgEl).transition().duration(400).call(
                    zoomBehavior.transform, d3.zoomIdentity
                );
            }
        };
        document.body.appendChild(btn);
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.onerror = (msg, _src, line) => log(`Error: ${msg} (line ${line})`);
log('Script started.');
setupButtons();

const hpccUri = document.body.dataset.hpccUri;
if (!hpccUri) {
    log('ERROR: data-hpcc-uri missing on <body>');
} else {
    (import(hpccUri) as Promise<GraphvizModule>)
        .then(m => m.Graphviz.load())
        .then(instance => {
            gviz = instance;
            log('Graphviz ready.');
            document.getElementById('loading')!.style.display = 'none';
            if (pendingDot) { renderGraph(pendingDot); pendingDot = null; }
        })
        .catch((e: unknown) => log('Graphviz load failed: ' + String(e)));
}

// ─── Message handler ──────────────────────────────────────────────────────────

window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as ExtensionMessage;
    switch (msg.command) {
        case 'update':
            document.getElementById('loading')!.style.display = 'none';
            renderGraph(msg.dot);
            break;
        case 'status': {
            const el = document.getElementById('loading')!;
            el.style.display = 'block';
            el.textContent = msg.text;
            break;
        }
        case 'log':
            log(msg.text);
            break;
        case 'focusNode':
            focusNode(msg.nodeId);
            break;
    }
});
