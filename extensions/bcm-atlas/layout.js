window.BcmLayout = (() => { const exports = {};
"use strict";
/**
 * bcm-layout.ts — fixed-leaf hierarchical rectangle packing, reference v1.0.0
 *
 * Dependency-free TypeScript. No DOM, framework, network, filesystem, global cache,
 * nondeterministic state or import-time work. Suitable for browser/Web Worker/Node usage.
 * Compile with a modern TypeScript compiler, target ES2020 (or later), strict=true.
 * You may copy, modify and incorporate this generated reference into your apps.
 * Provided as-is, without warranty. It is not copied from a third-party library.
 *
 * QUICK START
 * ----------
 * import { layoutBcm, validateBcmLayout, type BcmNode } from './bcm-layout';
 * const tree: BcmNode = {
 *   id: 'bank', name: 'Bank', children: [
 *     { id: 'customers', name: 'Customers', children: [
 *       { id: 'onboard', name: 'Onboarding' },
 *       { id: 'service', name: 'Servicing' },
 *       { id: 'consent', name: 'Consent management' },
 *     ] },
 *     { id: 'payments', name: 'Payments' },
 *   ],
 * };
 * const map = layoutBcm(tree, {
 *   mode: 'compact',                 // default: 'ordered'
 *   objective: 'frame', aspectRatio: 16 / 9,
 *   leafWidth: 160, leafHeight: 56, padding: 8, headerHeight: 24, gap: 8,
 * });
 * const byId = new Map(map.nodes.map(n => [n.id, n]));
 * // map.nodes contains parents before descendants, in INPUT traversal order.
 * // Absolute drawing: use n.x/n.y/n.width/n.height.
 * // Nested groups: use n.localX/n.localY, not n.x/n.y a second time.
 * // map.width/height is the actual root, not the target-aspect containing frame.
 *
 * ADAPT AN EXISTING MODEL (no schema changes or mutation required)
 * -------------------------------------------------------------
 * interface Capability { key: string; title: string; sub?: Capability[] }
 * const result = layoutBcm<Capability>(capabilityRoot, { mode: 'ordered' }, {
 *   id: n => n.key, label: n => n.title, children: n => n.sub,
 * });
 * // Accessors must be deterministic and must not mutate their input.
 * // A readonly array of roots ALWAYS gets a synthetic parent, even length one.
 * // [] throws. A node with no children (including children: []) is a leaf.
 * // To exclude hidden/collapsed nodes, filter them in the children accessor.
 * // A collapsed internal capability thereby becomes a normal fixed-size leaf.
 *
 * ALGORITHM AND GUARANTEES
 * ------------------------
 * Each subtree retains a bounded width/height Pareto frontier together with the
 * actual placements producing those shapes. Its parent chooses amongst these
 * alternatives instead of accepting one prematurely chosen local rectangle.
 *
 * 'ordered': consecutive, top-aligned shelves; dynamic programming chooses row
 * breaks and child shapes for sampled widths. Direct siblings preserve row-major
 * input order (sort their top-left corners by y, then x). This does not impose a
 * global scan order on all descendants. Recommended for semantically ordered BCMs.
 *
 * 'compact': integrates ordered shelves, horizontal/vertical slicing, and
 * shape-selecting MaxRects at EACH subtree. It may change spatial sibling order.
 * An independent complete ordered pass supplies an incumbent. Final selection
 * cannot have a worse geometric objective than that ordered pass with identical
 * options. This is NOT the seven-engine portfolio from the earlier research lab.
 *
 * This is a practical, adapted implementation of the lab's recommended family,
 * not a bit-for-bit port or an exact solver. Caps, width sampling, bounded row
 * windows, restricted slicing and greedy MaxRects prevent any global optimality
 * claim. Changing effort can change retained shapes and occasionally worsen a
 * result. Keep previous feasible incumbents separately when doing anytime search.
 * Identical inputs/options give identical outputs; edit-to-edit stability is NOT
 * guaranteed. There is no measured or invented scalar 'beauty score'.
 *
 * GEOMETRY / OBJECTIVES
 * ---------------------
 * Leaves have EXACT leafWidth x leafHeight, never rotate, and never stretch.
 * A parent's content starts at (padding, padding + headerHeight). The title band
 * occupies headerHeight; padding already provides the top and bottom inset.
 * At least gap separates each sibling pair along one separating axis. No diagonal
 * Euclidean-distance interpretation is intended. Borders must be drawn INSIDE
 * these boxes; CSS box-sizing:border-box, and SVG clip/inset strokes as needed.
 * All dimensions must be multiples of gridSize (default 8), within floating-point
 * tolerance. They are checked, not silently resized to an arbitrary pixel grid. Set gridSize:1 or 0.5 for other exact dimensions.
 * Calculations use integer grid units; outputs use your original units (e.g. px).
 * Uniform view zoom is allowed; changing individual leaf sizes after layout is not.
 *
 * objective:'area' minimises root W*H; ties prefer the target frame, then width.
 * objective:'frame' minimises max(W*W/r, H*H*r), r=aspectRatio; ties prefer root
 * area, then width. The actual root is not stretched to match r. Returned frame
 * dimensions describe the smallest top-left-anchored containing frame with ratio r.
 * No viewport hard limit is implied: fit/zoom/scroll is the renderer's concern.
 * Leaf coverage does NOT double-count parents. Structural shells, content residuals
 * (including required gutters), and leaf area partition the actual root area.
 *
 * RENDERING / INTEGRATION
 * -----------------------
 * SVG/Canvas: draw parents before children. Use an SVG viewBox of
 * `0 0 ${result.width} ${result.height}`; draw only inside returned rectangles.
 * In an HTML renderer, absolutely position the flat node list in one relative
 * container, OR use local coordinates with truly nested containers, not both.
 * For React Flow or similar engines, use parentId plus local coordinates, explicit
 * width/height and disabled auto-layout/auto-resize. Map API names in your adapter.
 * Never confuse input childIds order with spatial order in compact mode.
 * Labels are data, not markup: use textContent/framework escaping, never innerHTML.
 * This engine does not measure text. Wrap/clip leaf labels to fixed cards; reserve
 * headerHeight for parent titles, and use tooltips/detail views for long names.
 * Geometry cannot make thousands of labels readable at once: add zoom/drill-down.
 *
 * A synthetic root has the ordinary frame unless configured otherwise:
 *   syntheticRoot: { label:'Landscape', padding:0, headerHeight:0 }
 * It remains in result.nodes, flagged synthetic=true; the renderer may skip it.
 * Original source objects/metadata are not returned: rejoin using stable ids.
 * The output is JSON-serialisable and contains no source-object references.
 *
 * PERFORMANCE / ADAPTATION
 * ------------------------
 * Run compact layouts off the main UI thread for large trees. This API is synchronous;
 * worker termination provides hard cancellation. There are no timing-based exits.
 * Increase frontierLimit/widthSamples for exploration, not a guarantee of improvement.
 * maxRowLength limits shelf-DP windows. Horizontal/vertical strip fallbacks remain.
 * Above slicingMaxChildren or maxRectsMaxChildren, that family is skipped, never
 * allowed to drop capabilities. Large-but-allowed slices use balanced cuts.
 * Flat equal-leaf groups enumerate distinct grid shapes without quadratic duplicate
 * column trials. General high-fan-out trees still need workload-specific profiling.
 * Deterministic search counters expose restrictions; no latency guarantee is claimed.
 * With k siblings, row window L, frontier F and S width samples, straightforward row
 * construction is worst-case O(k*L^3*F*log(F)); shelf DP is O(S*k*L*log(L*F)).
 * Slicing and MaxRects add bounded but nontrivial search; validation can be O(k^2).
 * Cache immutable subtree frontiers only after adding geometry/order/options to the
 * cache key. No cross-call cache, incremental repair, pinned positions, arbitrary
 * leaf sizes, exact certificates or text measurement is implemented here.
 *
 * VALIDATION AND SELF-TEST
 * ------------------------
 * Layouts are validated by default; validation:'none' skips only the independent
 * output check, not input checks. validateBcmLayout(result) also checks edited/
 * deserialised typed layouts (not a schema parser for arbitrary untrusted JSON).
 * It cannot infer source nodes deleted from both the
 * geometry AND metadata; the generator separately checks source membership.
 * runBcmLayoutSelfTests() executes deterministic tests; nothing runs on import.
 * Compilation example:
 *   tsc bcm-layout.ts --target ES2020 --module commonjs --strict \
 *     --noUncheckedIndexedAccess --exactOptionalPropertyTypes --outDir out
 *   node -e "console.log(require('./out/bcm-layout.js').runBcmLayoutSelfTests())"
 *
 * DEVELOPMENT VERIFICATION — 10 September 2026
 * --------------------------------------------
 * Compiled with TypeScript 5.8.3, strict + noUncheckedIndexedAccess +
 * exactOptionalPropertyTypes + noUnusedLocals/Parameters, with ES2020-only libs.
 * CommonJS and isolated/verbatim ES modules both compiled successfully.
 * Node 22.16.0: all 10 embedded self-test groups passed. Additional independent
 * checks validated 284 layouts: 23 lab datasets x 2 modes x 4 objectives, plus
 * 100 seeded trees with varied dimensions/geometry/search limits. These included
 * the 1,700-leaf model and 32,954 leaf instances in total, without violations.
 * Additional flat-grid enumeration comparisons and a 5,000-leaf case passed.
 * Chromium 144: embedded tests passed; the showcase output matched Node exactly.
 * Node worker-thread output also matched. Browser Web Worker integration remains
 * unverified: worker startup failed in the restricted browser test environment.
 * No production framework, Teams sandbox or cross-browser integration is certified.
 *
 * CONCEPTUAL REFERENCES (not external runtime dependencies)
 * -------------------------------------------------------
 * Stockmeyer, slicing-floorplan shape alternatives:
 * https://research.ibm.com/publications/optimal-orientations-of-cells-in-slicing-floorplan-designs
 * Bederson, Shneiderman & Wattenberg, Ordered and Quantum Treemaps:
 * https://www.cs.umd.edu/~ben/papers/Bederson2002Ordered.pdf
 * Jylanki, RectangleBinPack / MaxRects:
 * https://github.com/juj/RectangleBinPack
 * These references do not certify the optimality of this bounded implementation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BcmLayoutError = void 0;
exports.layoutBcm = layoutBcm;
exports.validateBcmLayout = validateBcmLayout;
exports.runBcmLayoutSelfTests = runBcmLayoutSelfTests;
class BcmLayoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BcmLayoutError';
    }
}
exports.BcmLayoutError = BcmLayoutError;
function fail(message) { throw new BcmLayoutError(message); }
function validId(id, field) {
    if (typeof id !== 'string' || id.trim().length === 0)
        fail(`${field} must be a nonempty string.`);
}
function integer(value, min, max, field) {
    if (!Number.isInteger(value) || value < min || value > max)
        fail(`${field} must be an integer in ${min}..${max}.`);
    return value;
}
function quantise(value, grid, field, positive = false) {
    if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0))
        fail(`${field} must be finite and ${positive ? 'positive' : 'nonnegative'}.`);
    const q = value / grid, u = Math.round(q);
    if (!Number.isSafeInteger(u) || Math.abs(q - u) > 1e-7 || (positive && u < 1))
        fail(`${field} (${value}) must be an exact multiple of gridSize (${grid}); choose a smaller gridSize.`);
    return u;
}
function resolveOptions(input) {
    const mode = input.mode ?? 'ordered', objective = input.objective ?? 'frame';
    const validation = input.validation ?? 'full', gridSize = input.gridSize ?? 8;
    if (mode !== 'ordered' && mode !== 'compact')
        fail('mode must be ordered or compact.');
    if (objective !== 'area' && objective !== 'frame')
        fail('objective must be area or frame.');
    if (validation !== 'full' && validation !== 'none')
        fail('validation must be full or none.');
    if (!Number.isFinite(gridSize) || gridSize <= 0 || !Number.isFinite(gridSize ** 2) || gridSize ** 2 === 0)
        fail('gridSize must be positive with finite, nonzero squared area.');
    const aspectRatio = input.aspectRatio ?? 16 / 9;
    if (!Number.isFinite(aspectRatio) || aspectRatio < 1e-6 || aspectRatio > 1e6)
        fail('aspectRatio must be finite and in 0.000001..1000000.');
    const leafWidth = input.leafWidth ?? 160, leafHeight = input.leafHeight ?? 56;
    const padding = input.padding ?? 8, headerHeight = input.headerHeight ?? 24, gap = input.gap ?? 8;
    const syntheticRoot = {
        id: input.syntheticRoot?.id ?? null,
        label: input.syntheticRoot?.label ?? 'Capability landscape',
        padding: input.syntheticRoot?.padding ?? padding,
        headerHeight: input.syntheticRoot?.headerHeight ?? headerHeight,
    };
    if (syntheticRoot.id !== null)
        validId(syntheticRoot.id, 'syntheticRoot.id');
    if (typeof syntheticRoot.label !== 'string')
        fail('syntheticRoot.label must be a string.');
    quantise(leafWidth, gridSize, 'leafWidth', true);
    quantise(leafHeight, gridSize, 'leafHeight', true);
    for (const [field, value] of [
        ['padding', padding], ['headerHeight', headerHeight], ['gap', gap],
        ['syntheticRoot.padding', syntheticRoot.padding], ['syntheticRoot.headerHeight', syntheticRoot.headerHeight],
    ])
        quantise(value, gridSize, field);
    const frontierLimit = integer(input.frontierLimit ?? 40, 4, 128, 'frontierLimit');
    return {
        mode, objective, aspectRatio, leafWidth, leafHeight, padding, headerHeight, gap, gridSize,
        frontierLimit,
        widthSamples: integer(input.widthSamples ?? 120, 2, 512, 'widthSamples'),
        maxRowLength: integer(input.maxRowLength ?? 24, 1, 128, 'maxRowLength'),
        sliceFrontierLimit: integer(input.sliceFrontierLimit ?? 24, 4, 128, 'sliceFrontierLimit'),
        exhaustiveSliceChildren: integer(input.exhaustiveSliceChildren ?? 9, 2, 12, 'exhaustiveSliceChildren'),
        slicingMaxChildren: integer(input.slicingMaxChildren ?? 128, 2, 1024, 'slicingMaxChildren'),
        maxRectsMaxChildren: integer(input.maxRectsMaxChildren ?? 64, 2, 1024, 'maxRectsMaxChildren'),
        maxRectsSeeds: integer(input.maxRectsSeeds ?? 12, 1, 64, 'maxRectsSeeds'),
        maxFreeRectangles: integer(input.maxFreeRectangles ?? 256, 16, 4096, 'maxFreeRectangles'),
        maxNodes: integer(input.maxNodes ?? 20000, 1, 1000000, 'maxNodes'),
        maxDepth: integer(input.maxDepth ?? 256, 1, 512, 'maxDepth'),
        validation, syntheticRoot,
    };
}
function normalise(input, adapter, ctx) {
    const ids = new Set(), visited = new WeakSet(), active = new WeakSet();
    const o = ctx.o;
    let count = 0, leaves = 0, maxDepth = 0;
    function convert(source, depth, siblingIndex) {
        if (depth > o.maxDepth)
            fail(`Tree exceeds maxDepth=${o.maxDepth}.`);
        if (source === null || typeof source !== 'object' || Array.isArray(source))
            fail('Every capability must be a non-null object (not an array).');
        if (active.has(source))
            fail('Cycle detected in capability hierarchy.');
        if (visited.has(source))
            fail('Shared node detected: the input must be a tree, not a DAG.');
        visited.add(source);
        active.add(source);
        const id = adapter.id(source);
        validId(id, 'Node id');
        if (ids.has(id))
            fail(`Duplicate capability id: ${id}`);
        ids.add(id);
        count++;
        if (count > o.maxNodes)
            fail(`Tree exceeds maxNodes=${o.maxNodes}.`);
        const label = adapter.label ? adapter.label(source) : id;
        if (typeof label !== 'string')
            fail(`Label for ${id} must be a string.`);
        const children = adapter.children(source) ?? [];
        if (!Array.isArray(children))
            fail(`Children of ${id} must be an array, null or undefined.`);
        maxDepth = Math.max(maxDepth, depth);
        const node = { id, label, children: [], synthetic: false, depth, siblingIndex,
            p: Math.round(o.padding / o.gridSize), t: Math.round(o.headerHeight / o.gridSize) };
        for (let i = 0; i < children.length; i++)
            node.children.push(convert(children[i], depth + 1, i));
        if (node.children.length === 0)
            leaves++;
        active.delete(source);
        return node;
    }
    let root;
    if (Array.isArray(input)) {
        if (input.length === 0)
            fail('An empty forest has no capabilities to lay out.');
        count = 1; // synthetic root is part of the output and node budget
        const children = [];
        for (let i = 0; i < input.length; i++)
            children.push(convert(input[i], 1, i));
        let id = o.syntheticRoot.id ?? '__bcm_root__';
        if (o.syntheticRoot.id !== null && ids.has(id))
            fail(`Synthetic root id collides with a capability: ${id}`);
        for (let suffix = 1; ids.has(id); suffix++)
            id = `__bcm_root__:${suffix}`;
        root = { id, label: o.syntheticRoot.label, children, synthetic: true, depth: 0, siblingIndex: 0,
            p: Math.round(o.syntheticRoot.padding / o.gridSize), t: Math.round(o.syntheticRoot.headerHeight / o.gridSize) };
    }
    else
        root = convert(input, 0, 0);
    ctx.stats.inputNodeCount = count;
    ctx.stats.inputLeafCount = leaves;
    ctx.stats.inputMaxDepth = maxDepth;
    // Conservative sums bound every generated slicing/shelf/packing dimension.
    function bound(n) {
        if (n.children.length === 0)
            return { w: ctx.lw, h: ctx.lh };
        let w = 2 * n.p + (n.children.length - 1) * ctx.gap;
        let h = 2 * n.p + n.t + (n.children.length - 1) * ctx.gap;
        for (const c of n.children) {
            const b = bound(c);
            w += b.w;
            h += b.h;
        }
        if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h))
            fail('Geometry exceeds safe integer dimensions.');
        return { w, h };
    }
    const b = bound(root), pixelBound = Math.max(b.w, b.h) * o.gridSize;
    if (!Number.isSafeInteger(Math.max(b.w, b.h) ** 2) || !Number.isFinite(pixelBound * pixelBound * Math.max(o.aspectRatio, 1 / o.aspectRatio)))
        fail('Geometry is too large for reliable numeric area calculations.');
    return root;
}
function area(d) { return d.w * d.h; }
function frameArea(d, r) { return Math.max(d.w * d.w / r, d.h * d.h * r); }
function objective(d, o) {
    return o.objective === 'area' ? area(d) : frameArea(d, o.aspectRatio);
}
function compare(a, b, o) {
    return objective(a, o) - objective(b, o)
        || (o.objective === 'area' ? frameArea(a, o.aspectRatio) - frameArea(b, o.aspectRatio) : area(a) - area(b))
        || a.w - b.w || a.h - b.h;
}
function best(plans, o) {
    if (plans.length === 0)
        fail('Internal error: empty candidate set.');
    let winner = plans[0];
    for (let i = 1; i < plans.length; i++)
        if (compare(plans[i], winner, o) < 0)
            winner = plans[i];
    return winner;
}
function pareto(plans) {
    // Stable sort resolves identical dimensions by deterministic generation order.
    const sorted = [...plans].sort((a, b) => a.w - b.w || a.h - b.h);
    const out = [];
    let smallestHeight = Infinity;
    for (const p of sorted)
        if (p.h < smallestHeight) {
            out.push(p);
            smallestHeight = p.h;
        }
    return out; // widths strictly increase; heights strictly decrease
}
function frontier(plans, cap, ctx) {
    const keep = pareto(plans);
    if (keep.length <= cap)
        return keep;
    ctx.stats.frontierTruncations++;
    if (cap === 1)
        return [best(keep, ctx.o)];
    const selected = new Set();
    const add = (p) => { if (selected.size < cap)
        selected.add(p); };
    // Always protect this request's objective, rather than only hard-coded displays.
    add(best(keep, ctx.o));
    add(keep[0]);
    add(keep[keep.length - 1]);
    let minArea = keep[0];
    for (const p of keep)
        if (area(p) < area(minArea))
            minArea = p;
    add(minArea);
    for (const r of [1, 16 / 9, 4 / 3, 0.5, 4, 0.25, 8, 0.75, 2.5]) {
        let p = keep[0];
        for (const q of keep)
            if (frameArea(q, r) < frameArea(p, r))
                p = q;
        add(p);
    }
    for (let i = 0; i < cap; i++)
        add(keep[Math.round(i * (keep.length - 1) / (cap - 1))]);
    for (const p of [...keep].sort((a, b) => area(a) - area(b) || a.w - b.w))
        add(p);
    return keep.filter(p => selected.has(p));
}
function leaf(node, ctx) {
    ctx.stats.shapesCreated++;
    return { node, w: ctx.lw, h: ctx.lh, items: [], method: 'leaf' };
}
function enclose(node, items, method, ctx) {
    if (items.length === 0)
        fail('Internal error: cannot frame an empty internal node.');
    let w = 0, h = 0;
    for (const item of items) {
        w = Math.max(w, item.x + item.plan.w);
        h = Math.max(h, item.y + item.plan.h);
    }
    ctx.stats.shapesCreated++;
    return { node, w: w + node.p, h: h + node.p, items, method };
}
// ============================================================================
// Ordered shape-aware shelves and flat equal-leaf grids.
// ============================================================================
function flatCandidates(node, children, ctx) {
    const n = children.length, forms = [];
    // For equal row counts only the smallest column count can be nondominated.
    // Jump directly between distinct ceil(n/columns) values: O(sqrt(n)) forms.
    for (let columns = 1; columns <= n;) {
        const rows = Math.ceil(n / columns);
        forms.push({ columns, w: columns * ctx.lw + (columns - 1) * ctx.gap + 2 * node.p,
            h: rows * ctx.lh + (rows - 1) * ctx.gap + 2 * node.p + node.t });
        if (rows === 1)
            break;
        columns = Math.floor((n - 1) / (rows - 1)) + 1;
    }
    // Filter dimensions BEFORE allocating child placements: O(n*frontierLimit)
    // placement storage rather than O(n*sqrt(n)) for a large flat group.
    return frontier(forms, ctx.o.frontierLimit, ctx).map(({ columns }) => {
        const items = children.map((plan, i) => ({ plan,
            x: node.p + (i % columns) * (ctx.lw + ctx.gap),
            y: node.p + node.t + Math.floor(i / columns) * (ctx.lh + ctx.gap),
        }));
        return enclose(node, items, 'grid', ctx);
    });
}
/** On a Pareto frontier, binary-search the narrowest plan with h <= H. */
function narrowestAtHeight(options, H) {
    let lo = 0, hi = options.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (options[mid].h <= H)
            hi = mid;
        else
            lo = mid + 1;
    }
    return options[lo];
}
/** On a row frontier, the last feasible width has the smallest height. */
function rowAtWidth(options, W) {
    let lo = 0, hi = options.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (options[mid].w <= W)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo === 0 ? undefined : options[lo - 1];
}
function shelfCandidates(node, choices, ctx) {
    const n = choices.length, L = Math.min(n, ctx.o.maxRowLength);
    if (L < n)
        ctx.stats.restrictedShelfNodes++;
    // byEnd[j][length-1] is the frontier for children [j-length, j).
    const byEnd = Array.from({ length: n + 1 }, () => []);
    const allWidths = new Set();
    for (let start = 0; start < n; start++) {
        const heights = new Set();
        for (let end = start + 1; end <= Math.min(n, start + L); end++) {
            for (const p of choices[end - 1])
                heights.add(p.h);
            const candidates = [];
            for (const H of [...heights].sort((a, b) => a - b)) {
                const plans = [];
                let w = 0, h = 0;
                for (let k = start; k < end; k++) {
                    const p = narrowestAtHeight(choices[k], H);
                    if (!p)
                        break;
                    plans.push(p);
                    w += p.w;
                    h = Math.max(h, p.h);
                }
                if (plans.length === end - start)
                    candidates.push({ w: w + ctx.gap * (plans.length - 1), h, plans });
            }
            const rows = pareto(candidates);
            byEnd[end][end - start - 1] = rows;
            for (const row of rows)
                allWidths.add(row.w);
            ctx.stats.rowWindows++;
        }
    }
    let widths = [...allWidths].sort((a, b) => a - b);
    if (widths.length > ctx.o.widthSamples) {
        const count = ctx.o.widthSamples, full = widths;
        widths = Array.from({ length: count }, (_, i) => full[Math.round(i * (full.length - 1) / (count - 1))]);
        ctx.stats.widthSampleTruncations++;
    }
    const out = [];
    for (const W of widths) {
        ctx.stats.widthsTried++;
        const dp = new Float64Array(n + 1);
        dp.fill(Infinity);
        dp[0] = -ctx.gap;
        const previous = new Array(n + 1);
        for (let end = 1; end <= n; end++) {
            // Earlier start wins an exact tie (deterministic); no secondary row-count objective.
            for (let start = Math.max(0, end - L); start < end; start++) {
                if (dp[start] === Infinity)
                    continue;
                const row = rowAtWidth(byEnd[end][end - start - 1], W);
                if (!row)
                    continue;
                const h = dp[start] + ctx.gap + row.h;
                if (h < dp[end]) {
                    dp[end] = h;
                    previous[end] = { start, row };
                }
            }
        }
        if (!previous[n])
            continue;
        const rows = [];
        for (let end = n; end > 0;) {
            const step = previous[end];
            rows.push(step.row);
            end = step.start;
        }
        const items = [];
        let y = node.p + node.t;
        for (let i = rows.length - 1; i >= 0; i--) {
            let x = node.p;
            const row = rows[i];
            for (const plan of row.plans) {
                items.push({ plan, x, y });
                x += plan.w + ctx.gap;
            }
            y += row.h + ctx.gap;
        }
        out.push(enclose(node, items, 'ordered-shelves', ctx));
    }
    // Feasible extreme-aspect fallbacks survive restricted row windows.
    let x = node.p, y = node.p + node.t;
    const horizontal = [], vertical = [];
    for (const options of choices) {
        const wide = options[options.length - 1], narrow = options[0];
        horizontal.push({ plan: wide, x, y: node.p + node.t });
        x += wide.w + ctx.gap;
        vertical.push({ plan: narrow, x: node.p, y });
        y += narrow.h + ctx.gap;
    }
    out.push(enclose(node, horizontal, 'horizontal-strip', ctx), enclose(node, vertical, 'vertical-strip', ctx));
    return frontier(out, ctx.o.frontierLimit, ctx);
}
// ============================================================================
// Mixed slicing. Blocks are temporary groups, NEVER extra capabilities.
// ============================================================================
function slicingCandidates(node, choices, base, ctx) {
    const n = choices.length;
    if (n > ctx.o.slicingMaxChildren) {
        ctx.stats.skippedSlicingNodes++;
        return [...base];
    }
    const exhaustive = n <= ctx.o.exhaustiveSliceChildren;
    if (!exhaustive)
        ctx.stats.balancedSlicingNodes++;
    const cap = Math.min(ctx.o.frontierLimit, ctx.o.sliceFrontierLimit);
    const memo = new Map();
    function blocks(start, end) {
        const key = `${start}:${end}`, cached = memo.get(key);
        if (cached)
            return cached;
        let result;
        if (end - start === 1) {
            result = choices[start].map(plan => ({ w: plan.w, h: plan.h, items: [{ plan, x: 0, y: 0 }] }));
        }
        else {
            const out = [];
            const first = exhaustive ? start + 1 : start + Math.floor((end - start) / 2);
            const last = exhaustive ? end - 1 : first;
            for (let cut = first; cut <= last; cut++) {
                for (const a of blocks(start, cut))
                    for (const b of blocks(cut, end)) {
                        out.push({ w: a.w + ctx.gap + b.w, h: Math.max(a.h, b.h),
                            items: [...a.items, ...b.items.map(v => ({ plan: v.plan, x: v.x + a.w + ctx.gap, y: v.y }))] });
                        out.push({ w: Math.max(a.w, b.w), h: a.h + ctx.gap + b.h,
                            items: [...a.items, ...b.items.map(v => ({ plan: v.plan, x: v.x, y: v.y + a.h + ctx.gap }))] });
                        ctx.stats.shapesCreated += 2;
                    }
            }
            result = frontier(out, cap, ctx);
        }
        memo.set(key, result);
        return result;
    }
    const out = blocks(0, n).map(b => enclose(node, b.items.map(v => ({ plan: v.plan, x: v.x + node.p, y: v.y + node.p + node.t })), 'slicing', ctx));
    return frontier([...base, ...out], ctx.o.frontierLimit, ctx);
}
function intersects(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function inside(a, b) {
    return b.x <= a.x && b.y <= a.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
}
function lexLess(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i])
            return true;
        if (a[i] > b[i])
            return false;
    }
    return false;
}
function packMaxRects(node, choices, W, H, mode, order, ctx) {
    // Inflate items to the right/bottom by gap and extend the bin by gap as well.
    // Inflated rectangles are disjoint exactly when original boxes have the required
    // horizontal OR vertical gutter. Rotation is deliberately absent.
    let free = [{ x: 0, y: 0, w: W + ctx.gap, h: H + ctx.gap }];
    const keys = choices.map(options => {
        let v = Infinity;
        for (const p of options)
            v = Math.min(v, order === 'area' ? area(p) : Math.max(p.w, p.h));
        return v;
    });
    const sequence = choices.map((_, i) => i).sort((a, b) => keys[b] - keys[a] || a - b);
    const placed = [];
    for (const index of sequence) {
        let winner;
        for (const plan of choices[index])
            for (const f of free) {
                const w = plan.w + ctx.gap, h = plan.h + ctx.gap;
                if (w > f.w || h > f.h)
                    continue;
                const ss = Math.min(f.w - w, f.h - h), ls = Math.max(f.w - w, f.h - h);
                const score = mode === 'bssf' ? [ss, ls, f.y, f.x, area(plan)]
                    : mode === 'baf' ? [area(f) - w * h, ss, f.y, f.x, area(plan)]
                        : [f.y + h, f.x, ss, area(plan)];
                if (!winner || lexLess(score, winner.score))
                    winner = { score, plan, used: { x: f.x, y: f.y, w, h } };
            }
        if (!winner)
            return null;
        const { plan, used: u } = winner;
        placed.push({ plan, x: u.x + node.p, y: u.y + node.p + node.t });
        const split = [];
        for (const f of free) {
            if (!intersects(f, u)) {
                split.push(f);
                continue;
            }
            if (u.x > f.x)
                split.push({ x: f.x, y: f.y, w: u.x - f.x, h: f.h });
            if (u.x + u.w < f.x + f.w)
                split.push({ x: u.x + u.w, y: f.y, w: f.x + f.w - u.x - u.w, h: f.h });
            if (u.y > f.y)
                split.push({ x: f.x, y: f.y, w: f.w, h: u.y - f.y });
            if (u.y + u.h < f.y + f.h)
                split.push({ x: f.x, y: u.y + u.h, w: f.w, h: f.y + f.h - u.y - u.h });
        }
        const unique = new Map();
        for (const f of split)
            if (f.w > 0 && f.h > 0)
                unique.set(`${f.x},${f.y},${f.w},${f.h}`, f);
        const candidates = [...unique.values()];
        // Overlapping FREE rectangles are intentional; prune only duplicates/containment.
        free = candidates.filter((f, i) => !candidates.some((g, j) => i !== j && inside(f, g)));
        if (free.length > ctx.o.maxFreeRectangles) {
            ctx.stats.maxRectsFreeListAborts++;
            return null; // discard this attempt, not capabilities
        }
    }
    return placed;
}
function maxRectsCandidates(node, choices, base, ctx) {
    if (choices.length > ctx.o.maxRectsMaxChildren) {
        ctx.stats.skippedMaxRectsNodes++;
        return [...base];
    }
    const seeds = frontier(base, ctx.o.maxRectsSeeds, ctx), bins = new Map();
    for (const seed of seeds) {
        const w = seed.w - 2 * node.p, h = seed.h - 2 * node.p - node.t;
        for (const f of [0.8, 0.9, 0.96, 1]) {
            const H = Math.max(1, Math.floor(h * f));
            bins.set(`${w}:${H}`, { w, h: H });
        }
    }
    const out = [...base];
    for (const bin of [...bins.values()].sort((a, b) => a.w - b.w || a.h - b.h)) {
        for (const [mode, order] of [['bssf', 'area'], ['baf', 'side'], ['bottom-left', 'area']]) {
            ctx.stats.maxRectsAttempts++;
            const items = packMaxRects(node, choices, bin.w, bin.h, mode, order, ctx);
            if (items) {
                ctx.stats.maxRectsSuccesses++;
                out.push(enclose(node, items, `maxrects-${mode}`, ctx));
            }
        }
    }
    return frontier(out, ctx.o.frontierLimit, ctx);
}
// ============================================================================
// Composition, output and area accounting.
// ============================================================================
function buildPass(root, engine, ctx, ordered) {
    const cache = new Map();
    function visit(n) {
        let result;
        if (n.children.length === 0)
            result = ordered?.get(n) ?? [leaf(n, ctx)];
        else {
            const choices = n.children.map(visit);
            if (n.children.length === 1) {
                result = frontier(choices[0].map(plan => enclose(n, [{ plan, x: n.p, y: n.p + n.t }], 'single-child', ctx)), ctx.o.frontierLimit, ctx);
            }
            else if (n.children.every(c => c.children.length === 0)) {
                result = ordered?.get(n) ?? flatCandidates(n, choices.map(p => p[0]), ctx);
            }
            else {
                result = shelfCandidates(n, choices, ctx);
                if (engine === 'hybrid') {
                    result = slicingCandidates(n, choices, result, ctx);
                    result = maxRectsCandidates(n, choices, result, ctx);
                    // Valid ordered subtree alternatives can also inform compact ancestors.
                    result = frontier([...result, ...(ordered?.get(n) ?? [])], ctx.o.frontierLimit, ctx);
                }
            }
        }
        cache.set(n, result);
        return result;
    }
    visit(root);
    ctx.stats.passes++;
    return cache;
}
function emit(root, ctx) {
    const nodes = [], ids = new Set(), u = ctx.o.gridSize;
    function visit(plan, x, y, localX, localY, parentId) {
        const n = plan.node, isLeaf = n.children.length === 0;
        if (ids.has(n.id))
            fail(`Internal error: duplicate emitted node ${n.id}`);
        ids.add(n.id);
        const p = isLeaf ? 0 : n.p, t = isLeaf ? 0 : n.t;
        const headerRect = isLeaf ? null : { x: (x + p) * u, y: (y + p) * u, width: (plan.w - 2 * p) * u, height: t * u };
        const contentRect = isLeaf ? null : { x: (x + p) * u, y: (y + p + t) * u,
            width: (plan.w - 2 * p) * u, height: (plan.h - 2 * p - t) * u };
        nodes.push({ id: n.id, label: n.label, parentId, depth: n.depth, siblingIndex: n.siblingIndex,
            childIds: n.children.map(c => c.id), isLeaf, synthetic: n.synthetic,
            x: x * u, y: y * u, width: plan.w * u, height: plan.h * u, localX: localX * u, localY: localY * u,
            padding: p * u, headerHeight: t * u, headerRect, contentRect, placement: plan.method });
        const byId = new Map(plan.items.map(item => [item.plan.node.id, item]));
        if (byId.size !== n.children.length || plan.items.length !== n.children.length)
            fail(`Internal error: invalid child membership at ${n.id}`);
        // Emit in original hierarchy order, irrespective of spatial placement order.
        for (const child of n.children) {
            const item = byId.get(child.id);
            if (!item || item.plan.node !== child)
                fail(`Internal error: missing/wrong child ${child.id}`);
            visit(item.plan, x + item.x, y + item.y, item.x, item.y, n.id);
        }
    }
    visit(root, 0, 0, 0, 0, null);
    if (nodes.length !== ctx.stats.inputNodeCount)
        fail('Internal error: source/output node count mismatch.');
    return nodes;
}
function measure(root, ctx) {
    let structural = 0, residual = 0;
    function visit(p) {
        if (p.items.length === 0)
            return;
        const content = (p.w - 2 * p.node.p) * (p.h - 2 * p.node.p - p.node.t);
        structural += area(p) - content;
        let children = 0;
        for (const item of p.items) {
            children += area(item.plan);
            visit(item.plan);
        }
        residual += content - children;
    }
    visit(root);
    const rootArea = area(root), frame = frameArea(root, ctx.o.aspectRatio);
    const leaves = ctx.stats.inputLeafCount * ctx.lw * ctx.lh, s = ctx.o.gridSize ** 2;
    if (rootArea !== leaves + structural + residual || residual < 0)
        fail('Internal error: disjoint area accounting failed.');
    return { leafCount: ctx.stats.inputLeafCount, leafArea: leaves * s, rootArea: rootArea * s,
        frameArea: frame * s, leafCoverage: leaves / rootArea, frameLeafCoverage: leaves / frame,
        structuralArea: structural * s, contentResidualArea: residual * s,
        frameResidualArea: (frame - rootArea) * s, objectiveValue: objective(root, ctx.o) * s };
}
function layoutBcm(input, options = {}, adapter) {
    const o = resolveOptions(options);
    const stats = { inputNodeCount: 0, inputLeafCount: 0, inputMaxDepth: 0, passes: 0,
        shapesCreated: 0, frontierTruncations: 0, widthSampleTruncations: 0, restrictedShelfNodes: 0,
        rowWindows: 0, widthsTried: 0, balancedSlicingNodes: 0, skippedSlicingNodes: 0, skippedMaxRectsNodes: 0,
        maxRectsAttempts: 0, maxRectsSuccesses: 0, maxRectsFreeListAborts: 0 };
    const ctx = { o, lw: Math.round(o.leafWidth / o.gridSize), lh: Math.round(o.leafHeight / o.gridSize),
        gap: Math.round(o.gap / o.gridSize), stats };
    const fallback = {
        id: source => source.id,
        label: source => { const n = source; return n.label ?? n.name ?? n.id; },
        children: source => source.children,
    };
    const root = normalise(input, adapter ?? fallback, ctx);
    const ordered = buildPass(root, 'ordered', ctx), baselinePlans = ordered.get(root);
    const incumbent = best(baselinePlans, o);
    let winner = incumbent, selectedEngine = 'ordered';
    const all = [...baselinePlans];
    if (o.mode === 'compact') {
        const hybridPlans = buildPass(root, 'hybrid', ctx, ordered).get(root);
        all.push(...hybridPlans);
        const challenger = best(hybridPlans, o);
        if (compare(challenger, incumbent, o) < 0) {
            winner = challenger;
            selectedEngine = 'hybrid';
        }
    }
    const nodes = emit(winner, ctx), u = o.gridSize, scale = u * u;
    const alternatives = frontier(all, o.frontierLimit, ctx).sort((a, b) => compare(a, b, o)).map(p => ({
        width: p.w * u, height: p.h * u, objectiveValue: objective(p, o) * scale, placement: p.method,
    }));
    const result = {
        version: '1.0.0', rootId: root.id, width: winner.w * u, height: winner.h * u,
        frameWidth: Math.max(winner.w, winner.h * o.aspectRatio) * u,
        frameHeight: Math.max(winner.h, winner.w / o.aspectRatio) * u,
        nodes, options: o, metrics: measure(winner, ctx), stats: { ...stats }, selectedEngine,
        preservesSiblingOrder: selectedEngine === 'ordered',
        orderedBaselineObjective: objective(incumbent, o) * scale, alternatives, optimality: 'heuristic',
    };
    if (o.validation === 'full') {
        const issues = validateBcmLayout(result);
        if (issues.length)
            fail(`Output validation failed: ${issues.slice(0, 8).map(e => `${e.code}:${e.nodeId} ${e.message}`).join('; ')}`);
    }
    return result;
}
// ============================================================================
// Independent validator: geometry, hierarchy, source-count metadata and metrics.
// No access to the packing engine's private plans is needed.
// ============================================================================
function validateBcmLayout(layout) {
    const issues = [];
    const issue = (code, id, message) => { issues.push({ code, nodeId: id, message }); };
    const nodes = new Map(), o = layout.options, grid = o.gridSize;
    if (!Number.isFinite(grid) || grid <= 0) {
        issue('grid', layout.rootId, 'Invalid gridSize.');
        return issues;
    }
    const near = (a, b) => Number.isFinite(a) && Number.isFinite(b)
        && Math.abs(a - b) <= Math.max(1e-7, Math.abs(a), Math.abs(b)) * 1e-9;
    const unit = (v) => Math.round(v / grid);
    let leafCount = 0, structural = 0, residual = 0;
    const validGeometry = new Set();
    for (const n of layout.nodes) {
        if (nodes.has(n.id))
            issue('duplicate', n.id, 'Duplicate output id.');
        nodes.set(n.id, n);
        const values = [n.x, n.y, n.width, n.height, n.localX, n.localY, n.padding, n.headerHeight];
        const valid = values.every(v => Number.isFinite(v) && v >= 0 && Math.abs(v / grid - Math.round(v / grid)) <= 1e-6)
            && n.width > 0 && n.height > 0;
        if (!valid)
            issue('geometry', n.id, 'Dimensions/positions must be finite, nonnegative lattice values with positive width/height.');
        else
            validGeometry.add(n.id);
        if (!Number.isInteger(n.depth) || n.depth < 0 || !Number.isInteger(n.siblingIndex) || n.siblingIndex < 0)
            issue('index', n.id, 'Depth and siblingIndex must be nonnegative integers.');
        if (new Set(n.childIds).size !== n.childIds.length)
            issue('membership', n.id, 'Duplicate child ids.');
        if (n.isLeaf !== (n.childIds.length === 0))
            issue('leaf', n.id, 'Leaf flag disagrees with child membership.');
        if (n.isLeaf) {
            leafCount++;
            if (!near(n.width, o.leafWidth) || !near(n.height, o.leafHeight))
                issue('leaf-size', n.id, 'Leaf dimensions were changed.');
            if (n.padding !== 0 || n.headerHeight !== 0 || n.contentRect !== null || n.headerRect !== null)
                issue('leaf-frame', n.id, 'Leaves cannot have parent frames.');
        }
        else {
            const expectedP = n.synthetic ? o.syntheticRoot.padding : o.padding;
            const expectedT = n.synthetic ? o.syntheticRoot.headerHeight : o.headerHeight;
            if (!near(n.padding, expectedP) || !near(n.headerHeight, expectedT))
                issue('frame', n.id, 'Parent padding/header differs from settings.');
            const expectedHeader = { x: n.x + n.padding, y: n.y + n.padding,
                width: n.width - 2 * n.padding, height: n.headerHeight };
            const expectedContent = { x: n.x + n.padding, y: n.y + n.padding + n.headerHeight,
                width: n.width - 2 * n.padding, height: n.height - 2 * n.padding - n.headerHeight };
            for (const [name, actual, expected] of [
                ['header', n.headerRect, expectedHeader], ['content', n.contentRect, expectedContent],
            ]) {
                if (!actual || !['x', 'y', 'width', 'height'].every(k => near(actual[k], expected[k])))
                    issue('frame-rect', n.id, `Invalid ${name} rectangle.`);
            }
            if (expectedContent.width <= 0 || expectedContent.height <= 0)
                issue('content', n.id, 'Nonpositive content area.');
        }
    }
    const root = nodes.get(layout.rootId);
    if (!root) {
        issue('root', layout.rootId, 'Root id is absent.');
        return issues;
    }
    if (root.parentId !== null || root.depth !== 0 || root.siblingIndex !== 0 || root.x !== 0 || root.y !== 0
        || root.localX !== 0 || root.localY !== 0)
        issue('root', root.id, 'Root must be at the origin with no parent.');
    if (!near(root.width, layout.width) || !near(root.height, layout.height))
        issue('root-size', root.id, 'Root dimensions disagree with result.');
    const ownership = new Map();
    for (const n of layout.nodes) {
        if (n.synthetic && n.id !== root.id)
            issue('synthetic', n.id, 'Only the root can be synthetic.');
        if (n.id !== root.id && (n.parentId === null || !nodes.has(n.parentId)))
            issue('parent', n.id, 'Missing parent.');
        const children = [];
        for (let i = 0; i < n.childIds.length; i++) {
            const id = n.childIds[i], c = nodes.get(id);
            ownership.set(id, (ownership.get(id) ?? 0) + 1);
            if (!c) {
                issue('membership', n.id, `Child ${id} is absent.`);
                continue;
            }
            children.push(c);
            if (c.parentId !== n.id || c.depth !== n.depth + 1 || c.siblingIndex !== i)
                issue('hierarchy', c.id, 'Parent/depth/siblingIndex mismatch.');
            if (!near(c.x, n.x + c.localX) || !near(c.y, n.y + c.localY))
                issue('coordinates', c.id, 'Absolute and parent-relative coordinates disagree.');
            if (validGeometry.has(n.id) && validGeometry.has(c.id)) {
                if (unit(c.x) < unit(n.x) + unit(n.padding) || unit(c.y) < unit(n.y) + unit(n.padding) + unit(n.headerHeight)
                    || unit(c.x) + unit(c.width) > unit(n.x) + unit(n.width) - unit(n.padding)
                    || unit(c.y) + unit(c.height) > unit(n.y) + unit(n.height) - unit(n.padding))
                    issue('containment', c.id, 'Child crosses its parent content/header boundary.');
            }
        }
        // Sweep by x; only siblings with overlapping gap-inflated x projections remain.
        // In the worst case (one column), pair checks are quadratic; no checks are skipped.
        const sorted = children.filter(c => validGeometry.has(c.id)).sort((a, b) => a.x - b.x || a.y - b.y);
        let active = [];
        const gap = unit(o.gap);
        for (const c of sorted) {
            active = active.filter(a => unit(a.x) + unit(a.width) + gap > unit(c.x));
            for (const a of active) {
                if (!(unit(a.y) + unit(a.height) + gap <= unit(c.y) || unit(c.y) + unit(c.height) + gap <= unit(a.y)))
                    issue('overlap-gap', c.id, `Overlaps or violates the sibling gap with ${a.id}.`);
            }
            active.push(c);
        }
        if (layout.preservesSiblingOrder) {
            const scan = [...children].sort((a, b) => a.y - b.y || a.x - b.x);
            if (scan.some((c, i) => c.id !== n.childIds[i]))
                issue('order', n.id, 'Row-major order differs from input order.');
        }
        if (!n.isLeaf) {
            // Reconstruct areas in grid units to avoid cancellation in decimal units
            // (e.g. a perfectly tiled zero residual must stay exactly zero).
            const content = (unit(n.width) - 2 * unit(n.padding))
                * (unit(n.height) - 2 * unit(n.padding) - unit(n.headerHeight));
            structural += unit(n.width) * unit(n.height) - content;
            residual += content - children.reduce((sum, c) => sum + unit(c.width) * unit(c.height), 0);
        }
    }
    for (const n of layout.nodes) {
        if ((ownership.get(n.id) ?? 0) !== (n.id === root.id ? 0 : 1))
            issue('ownership', n.id, 'Node must occur under exactly one parent (zero for root).');
    }
    const reachable = new Set(), stack = [root.id];
    while (stack.length) {
        const id = stack.pop();
        if (reachable.has(id))
            continue;
        reachable.add(id);
        const n = nodes.get(id);
        if (n)
            for (const child of n.childIds)
                stack.push(child);
    }
    for (const id of nodes.keys())
        if (!reachable.has(id))
            issue('disconnected', id, 'Node is not reachable from the root.');
    if (layout.nodes.length !== layout.stats.inputNodeCount || leafCount !== layout.stats.inputLeafCount)
        issue('counts', root.id, 'Output membership disagrees with input-count metadata.');
    const A = unit(root.width) * unit(root.height), L = leafCount * unit(o.leafWidth) * unit(o.leafHeight);
    const F = Math.max(unit(root.width) ** 2 / o.aspectRatio, unit(root.height) ** 2 * o.aspectRatio);
    const scale = grid * grid;
    const expectedMetrics = {
        leafCount, leafArea: L * scale, rootArea: A * scale, frameArea: F * scale, leafCoverage: L / A, frameLeafCoverage: L / F,
        structuralArea: structural * scale, contentResidualArea: residual * scale, frameResidualArea: (F - A) * scale,
        objectiveValue: (o.objective === 'area' ? A : F) * scale,
    };
    for (const key of Object.keys(expectedMetrics)) {
        if (!near(expectedMetrics[key], layout.metrics[key]))
            issue('metrics', root.id, `Invalid metric ${key}.`);
    }
    if (!near(A, L + structural + residual) || residual < -1e-7)
        issue('area', root.id, 'Disjoint area accounting failed.');
    if (!near(layout.frameWidth, Math.max(root.width, root.height * o.aspectRatio))
        || !near(layout.frameHeight, Math.max(root.height, root.width / o.aspectRatio)))
        issue('frame-size', root.id, 'Containing frame dimensions are incorrect.');
    if (layout.metrics.objectiveValue > layout.orderedBaselineObjective && !near(layout.metrics.objectiveValue, layout.orderedBaselineObjective))
        issue('incumbent', root.id, 'Selected geometry is worse than its ordered incumbent.');
    return issues;
}
function runBcmLayoutSelfTests() {
    const cases = [];
    const assert = (condition, message) => { if (!condition)
        fail(`Self-test: ${message}`); };
    const test = (name, run) => { run(); cases.push(name); };
    const throws = (run) => { try {
        run();
        return false;
    }
    catch (e) {
        return e instanceof BcmLayoutError;
    } };
    const leaves = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));
    test('single leaf is exact in both modes', () => {
        for (const mode of ['ordered', 'compact']) {
            const r = layoutBcm({ id: 'leaf' }, { mode });
            assert(r.width === 160 && r.height === 56 && r.nodes.length === 1, 'single-leaf geometry');
        }
    });
    test('flat 13 matches exhaustive grid objectives', () => {
        const tree = { id: 'root', children: leaves('l', 13) };
        for (const objective of ['area', 'frame'])
            for (const ratio of [0.5, 1, 4 / 3, 16 / 9, 3]) {
                const r = layoutBcm(tree, { objective, aspectRatio: ratio, frontierLimit: 4 });
                let optimum = Infinity;
                for (let c = 1; c <= 13; c++) {
                    const w = c * 160 + (c - 1) * 8 + 16, rows = Math.ceil(13 / c);
                    const h = rows * 56 + (rows - 1) * 8 + 40;
                    optimum = Math.min(optimum, objective === 'area' ? w * h : Math.max(w * w / ratio, h * h * ratio));
                }
                assert(Math.abs(r.metrics.objectiveValue - optimum) < 1e-6, 'flat grid optimum');
            }
    });
    test('forest root avoids identifier collisions', () => {
        const r = layoutBcm([{ id: '__bcm_root__' }, { id: 'b' }], { syntheticRoot: { padding: 0, headerHeight: 0 } });
        assert(r.rootId !== '__bcm_root__' && r.nodes[0].synthetic && r.nodes[0].padding === 0, 'synthetic root');
        assert(throws(() => layoutBcm([{ id: 'a' }], { syntheticRoot: { id: 'a' } })), 'explicit root collision rejected');
    });
    test('invalid input, shared nodes and cycles rejected', () => {
        assert(throws(() => layoutBcm([])), 'empty forest');
        assert(throws(() => layoutBcm({ id: 'r', children: [{ id: 'x' }, { id: 'x' }] })), 'duplicate ids');
        const shared = { id: 's' };
        assert(throws(() => layoutBcm({ id: 'r', children: [shared, shared] })), 'shared node');
        const cyclic = { id: 'cycle', children: [] };
        cyclic.children.push(cyclic);
        assert(throws(() => layoutBcm(cyclic)), 'cycle');
        assert(throws(() => layoutBcm({ id: 'r' }, { leafWidth: 161 })), 'off-grid leaf');
        assert(throws(() => layoutBcm({ id: 'r' }, { gridSize: 0 })), 'zero grid');
        assert(throws(() => layoutBcm({ id: 'r' }, { aspectRatio: NaN })), 'NaN aspect');
        assert(throws(() => layoutBcm([{ id: 'a' }], { maxNodes: 1 })), 'synthetic node budget');
    });
    test('custom adapter and fractional dimensions', () => {
        const r = layoutBcm({ key: 'r', title: 'Root', sub: [{ key: 'x', title: 'Child' }] }, { gridSize: 0.5, leafWidth: 100.5, leafHeight: 40.5, padding: 1.5, headerHeight: 10.5, gap: 0 }, { id: n => n.key, label: n => n.title, children: n => ('sub' in n ? n.sub : undefined) });
        assert(r.nodes[1].width === 100.5 && r.nodes[1].label === 'Child', 'adapter and fractional sizing');
    });
    test('decimal grids and zero residuals avoid floating-point false positives', () => {
        for (const gridSize of [0.1, 0.2, 0.3]) {
            const r = layoutBcm({ id: 'r', children: leaves('l', 4) }, { mode: 'compact', gridSize, leafWidth: 20 * gridSize, leafHeight: 7 * gridSize,
                padding: 0, headerHeight: 0, gap: 0, maxRectsSeeds: 1 });
            assert(validateBcmLayout(r).length === 0 && r.metrics.contentResidualArea === 0, 'decimal lattice accounting');
        }
    });
    test('validator detects corrupted size and overlap', () => {
        const r = layoutBcm({ id: 'r', children: leaves('l', 5) });
        const bad = JSON.parse(JSON.stringify(r));
        bad.nodes[1].width += 8;
        assert(validateBcmLayout(bad).some(e => e.code === 'leaf-size'), 'changed leaf');
        const bad2 = JSON.parse(JSON.stringify(r));
        bad2.nodes[2].x = bad2.nodes[1].x;
        bad2.nodes[2].y = bad2.nodes[1].y;
        assert(validateBcmLayout(bad2).some(e => e.code === 'overlap-gap'), 'overlap');
    });
    test('single-child chains and exact padding/header offsets', () => {
        let tree = { id: 'leaf' };
        for (let i = 0; i < 30; i++)
            tree = { id: `p${i}`, children: [tree] };
        const r = layoutBcm(tree, { mode: 'compact' });
        assert(r.width === 160 + 30 * 16 && r.height === 56 + 30 * 40, 'chain shells');
        assert(throws(() => layoutBcm(tree, { maxDepth: 10 })), 'depth guard');
    });
    test('bounded high-fan-out paths remain valid', () => {
        const tree = { id: 'r', children: Array.from({ length: 28 }, (_, i) => ({ id: `p${i}`, children: leaves(`${i}:`, 2 + i % 5) })) };
        const r = layoutBcm(tree, { mode: 'compact', maxRowLength: 4, slicingMaxChildren: 8, maxRectsMaxChildren: 8, widthSamples: 12 });
        assert(r.stats.restrictedShelfNodes > 0 && r.stats.skippedSlicingNodes > 0 && r.stats.skippedMaxRectsNodes > 0, 'search restrictions surfaced');
        assert(validateBcmLayout(r).length === 0, 'restricted geometry');
    });
    test('seeded trees: geometry, determinism, immutability and compact incumbent', () => {
        for (let seed = 1; seed <= 24; seed++) {
            let state = seed, id = 0;
            const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
            function make(depth) {
                const key = `n${id++}`;
                if (depth === 0 || (depth < 3 && random() < 0.28))
                    return { id: key };
                return { id: key, children: Array.from({ length: 1 + Math.floor(random() * 4) }, () => make(depth - 1)) };
            }
            const tree = make(3), snapshot = JSON.stringify(tree);
            const options = { objective: seed % 2 ? 'frame' : 'area', aspectRatio: [1, 4 / 3, 16 / 9][seed % 3], frontierLimit: 12, widthSamples: 24 };
            const ordered = layoutBcm(tree, options), compact = layoutBcm(tree, { ...options, mode: 'compact' });
            assert(validateBcmLayout(ordered).length === 0 && validateBcmLayout(compact).length === 0, `geometry seed ${seed}`);
            assert(compact.metrics.objectiveValue <= ordered.metrics.objectiveValue + 1e-7, `incumbent seed ${seed}`);
            assert(JSON.stringify(compact) === JSON.stringify(layoutBcm(tree, { ...options, mode: 'compact' })), `determinism seed ${seed}`);
            assert(JSON.stringify(tree) === snapshot, `input mutation seed ${seed}`);
        }
    });
    return { passed: cases.length, cases };
}

return exports; })();
