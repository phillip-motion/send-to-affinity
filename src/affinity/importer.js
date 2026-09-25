/* Send to Affinity importer. The Figma plugin embeds everything above the
 * export marker at the bottom and runs it through Affinity's MCP execute_script.
 * SVG geometry is handled by Affinity's native SVG importer.
 * compile() also runs in Node for testing.
 */
'use strict';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function fail(message) { throw new Error(message); }
function layerName(packet, id) { return packet?.layers?.find(l=>l.marker===id)?.name || 'A layer'; }
function warn(list, message) { if (!list.includes(message)) list.push(message); }
function finite(n, label) { if (!Number.isFinite(n)) fail('Invalid ' + label); return n; }
function number(s, label) {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(String(s).trim())) fail('Invalid ' + label + ': ' + s);
    return finite(Number(s), label);
}
function splitTop(s, delimiter) {
    let level = 0, quote = '', start = 0, result = [];
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) { if (c === quote && s[i - 1] !== '\\') quote = ''; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '(') level++;
        else if (c === ')') { if (--level < 0) fail('Unbalanced parentheses.'); }
        else if (c === delimiter && !level) { result.push(s.slice(start, i).trim()); start = i + 1; }
    }
    if (level || quote) fail('Unclosed value.');
    result.push(s.slice(start).trim());
    return result;
}

function colour(s) {
    s = s.trim();
    if (/^#[\da-f]{3,4}$|^#[\da-f]{6}$|^#[\da-f]{8}$/i.test(s)) {
        let h = s.slice(1); if (h.length <= 4) h = h.split('').map(c => c + c).join('');
        return {colour: '#' + h.slice(0, 6), opacity: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1};
    }
    if (/^(white|black|red|green|blue|yellow|gray|grey|purple|orange|pink)$/i.test(s)) return {colour: s, opacity: 1};
    if (s === 'transparent') return {colour: '#000000', opacity: 0};
    const m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
        const values = m[1].split(',').map(x => x.trim());
        if (values.length !== 3 && values.length !== 4) fail('Use comma-separated rgb()/rgba() colours.');
        const rgb = values.slice(0, 3).map(v => {
            const n = number(v.replace(/%$/, ''), 'colour') * (v.endsWith('%') ? 255 / 100 : 1);
            if (n < 0 || n > 255) fail('Colour channel outside 0–255.');
            return Math.round(n);
        });
        const a = values.length === 4 ? number(values[3], 'alpha') : 1;
        if (a < 0 || a > 1) fail('Colour alpha outside 0–1.');
        return {colour: 'rgb(' + rgb.join(',') + ')', opacity: a};
    }
    fail('Unsupported colour: ' + s);
}

// A small XML reader for inspection and targeted filter repair. SVG geometry stays native.
function decode(s) {
    return s.replace(/&([^;]+);/g, (_, name) => {
        const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
        if (Object.hasOwnProperty.call(entities, name)) return entities[name];
        if (/^#x[\da-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
        if (/^#\d+$/.test(name)) return String.fromCodePoint(parseInt(name.slice(1), 10));
        fail('Unsupported XML entity: &' + name + ';');
    });
}
function parseXml(source) {
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('SVG with a DOCTYPE or entity declarations is not supported.');
    const holder = {children: []}, stack = [holder]; let at = 0, elements = 0;
    const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w:.-]*(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|[^<]+/gy;
    let m;
    while (at < source.length) {
        token.lastIndex = at; m = token.exec(source);
        if (!m) fail('Malformed SVG XML near character ' + at + '.');
        at = token.lastIndex; const t = m[0], parent = stack[stack.length - 1];
        if (t.startsWith('<!--') || t.startsWith('<?')) continue;
        if (t.startsWith('<![CDATA[')) { parent.children.push({text: t.slice(9, -3)}); continue; }
        if (t.startsWith('</')) {
            if (stack.length === 1 || t.slice(2, -1).trim() !== parent.tag) fail('Mismatched SVG closing tag.');
            stack.pop(); continue;
        }
        if (!t.startsWith('<')) { parent.children.push({text: decode(t)}); continue; }
        const tag = /^<([\w:.-]+)/.exec(t)[1], attrs = Object.create(null);
        let rest = t.slice(tag.length + 1).replace(/\/?\s*>$/, '');
        while (rest.trim()) {
            const a = /^\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
            if (!a || a[1] in attrs) fail('Invalid or duplicate SVG attribute in ' + tag + '.');
            attrs[a[1]] = decode(a[2] == null ? a[3] : a[2]); rest = rest.slice(a[0].length);
        }
        const node = {tag, attrs, children: []}; parent.children.push(node);
        if (++elements > 50000 || stack.length > 128) fail('SVG is too complex for this importer.');
        if (!/\/\s*>$/.test(t)) stack.push(node);
    }
    if (stack.length !== 1) fail('Unclosed SVG element.');
    const roots = holder.children.filter(n => n.tag || n.text.trim());
    if (roots.length !== 1 || roots[0].tag !== 'svg') fail('Paste one complete <svg>…</svg> element.');
    return roots[0];
}
function walk(node, fn) { if (!node.tag) return; fn(node); node.children.forEach(n => walk(n, fn)); }
function xml(node) {
    if (!node.tag) return esc(node.text);
    return '<' + node.tag + Object.keys(node.attrs).map(k => ' ' + k + '="' + esc(node.attrs[k]) + '"').join('') + (node.children.length ? '>' + node.children.map(xml).join('') + '</' + node.tag + '>' : '/>');
}

function readTransfer(source) {
    let packet;
    try { packet=JSON.parse(source); } catch (e) { fail('The Figma transfer is not valid JSON. Send it again from Figma.'); }
    if (!packet || packet.format!=='figma-affinity' || ![1,2].includes(packet.version) || typeof packet.svg!=='string') fail('This isn’t a Send to Affinity transfer. Update the plugin, then send again.');
    if (!packet.frame || ![packet.frame.width,packet.frame.height].every(v=>typeof v==='number' && Number.isFinite(v) && v>0)) fail('The transfer has invalid frame dimensions.');
    if (!Array.isArray(packet.layers) || !Array.isArray(packet.texts)) fail('The transfer is missing its layer or text records.');
    const markers=new Set();
    for (const layer of packet.layers) {
        if (!layer || typeof layer.marker!=='string' || !/^FP_\d+$/.test(layer.marker) || typeof layer.name!=='string' || markers.has(layer.marker)) fail('The transfer contains invalid or repeated layer identifiers.');
        markers.add(layer.marker);
    }
    if(packet.version===2) {
        if(!Array.isArray(packet.artboards) || packet.artboards.length<2)fail('The multi-frame transfer is missing its artboards.');
        const roots=new Set(),members=new Set();
        for(const board of packet.artboards) {
            if(!board || !markers.has(board.marker) || roots.has(board.marker) || typeof board.name!=='string')fail('Invalid or repeated artboard identifier.');
            roots.add(board.marker);
            if(![board.x,board.y,board.width,board.height].every(v=>typeof v==='number' && Number.isFinite(v)) || board.x<0 || board.y<0 || board.width<=0 || board.height<=0 || board.x+board.width>packet.frame.width+0.01 || board.y+board.height>packet.frame.height+0.01)fail('Invalid artboard bounds for '+board.name+'.');
            if(!Array.isArray(board.layerMarkers) || !board.layerMarkers.includes(board.marker))fail('Missing artboard layer membership.');
            for(const marker of board.layerMarkers) {
                if(!markers.has(marker) || members.has(marker))fail('Artboard layers must belong to exactly one frame.');
                members.add(marker);
            }
        }
        if(members.size!==markers.size)fail('The transfer contains layers outside its artboards.');
    } else if(packet.artboards!=null)fail('Artboard transfers require version 2. Update the Figma panel and Affinity script.');
    const textMarkers=new Set();
    for (const t of packet.texts) {
        if (!t || !markers.has(t.marker) || textMarkers.has(t.marker) || typeof t.characters!=='string' || !Array.isArray(t.runs)) fail('The transfer contains an invalid text record.');
        textMarkers.add(t.marker);
        if (![t.width,t.height].every(v=>typeof v==='number' && Number.isFinite(v) && v>0) || !Array.isArray(t.transform) || t.transform.length!==6 || !t.transform.every(v=>typeof v==='number' && Number.isFinite(v))) fail('Invalid text dimensions or transform for '+t.marker+'.');
        let end=0;
        for (const r of t.runs) {
            if (!r || r.start!==end || !Number.isInteger(r.end) || r.end<=r.start || r.end>t.characters.length || r.characters!==t.characters.slice(r.start,r.end)) fail('Invalid text style ranges for '+t.marker+'.');
            if (!(typeof r.fontSize==='number' && Number.isFinite(r.fontSize) && r.fontSize>0) || !r.fontName || typeof r.fontName.family!=='string' || typeof r.fontName.style!=='string') fail('Invalid font information for '+t.marker+'.');
            end=r.end;
        }
        if (end!==t.characters.length) fail('Incomplete text style ranges for '+t.marker+'.');
    }
    packet.warnings=Array.isArray(packet.warnings) ? packet.warnings.filter(w=>typeof w==='string') : [];
    return packet;
}

function textRebuildIssue(t) {
    if (!t.characters) return 'empty text';
    if (t.textAlignVertical!=='TOP') return 'vertical alignment is preserved through SVG text';
    if (t.textAutoResize==='TRUNCATE') return 'truncated text is preserved through SVG text';
    if (!['LEFT','CENTER','RIGHT','JUSTIFIED'].includes(t.textAlignHorizontal)) return 'unsupported paragraph alignment';
    if ((t.strokes || []).some(p=>p.visible!==false)) return 'text strokes are preserved through SVG text';
    if (t.blendMode && !['NORMAL','PASS_THROUGH'].includes(t.blendMode)) return 'text blending is preserved through SVG text';
    if ((t.effects || []).some(e=>e.visible!==false && !['LAYER_BLUR','DROP_SHADOW','INNER_SHADOW'].includes(e.type))) return 'this text effect is preserved through SVG text';
    let paragraphStyle=null;
    for (const r of t.runs) {
        const fills=(r.fills || []).filter(p=>p.visible!==false);
        if (fills.length!==1 || fills[0].type!=='SOLID' || !fills[0].color) return 'gradient, image or multiple text fills are preserved through SVG text';
        if (fills[0].blendMode && fills[0].blendMode!=='NORMAL') return 'text fill blending is preserved through SVG text';
        if (![fills[0].color.r,fills[0].color.g,fills[0].color.b,fills[0].opacity == null ? 1 : fills[0].opacity].every(v=>typeof v==='number' && Number.isFinite(v) && v>=0 && v<=1)) return 'invalid text colour';
        if (r.textCase && r.textCase!=='ORIGINAL') return 'text case styling is preserved through SVG text';
        if ((r.listOptions && r.listOptions.type!=='NONE') || r.paragraphIndent) return 'list or indented text is preserved through SVG text';
        if (r.fontName.variationSettings && Object.keys(r.fontName.variationSettings).length) return 'custom variable-font axes are preserved through SVG text';
        for (const spacing of [r.letterSpacing,r.lineHeight]) {
            if (spacing && spacing.unit!=='AUTO' && (!['PIXELS','PERCENT'].includes(spacing.unit) || !Number.isFinite(spacing.value))) return 'invalid text spacing';
        }
        const style=JSON.stringify([r.lineHeight || null,r.paragraphSpacing || 0]);
        if (paragraphStyle!==null && paragraphStyle!==style) return 'mixed paragraph spacing is preserved through SVG text';
        paragraphStyle=r.characters.endsWith('\n') ? null : style;
    }
    return null;
}

// Figma exports presentation properties in both attributes and inline styles.
function promoteInlineStyles(root) {
    const supported=new Set(['filter','fill','fill-opacity','stroke','stroke-opacity','stroke-width','opacity','font-family','font-size','font-weight','font-style','letter-spacing','text-anchor','text-decoration']);
    walk(root,n=>{
        if (!n.attrs.style) return;
        const remaining=[];
        for (const part of splitTop(n.attrs.style,';')) {
            if (!part) continue;
            const colon=part.indexOf(':');
            if (colon<0) { remaining.push(part); continue; }
            const name=part.slice(0,colon).trim().toLowerCase(), value=part.slice(colon+1).trim();
            if (supported.has(name) && !/!important\s*$/.test(value)) n.attrs[name]=value;
            else remaining.push(part);
        }
        if (remaining.length) n.attrs.style=remaining.join(';'); else delete n.attrs.style;
    });
}

function blurSigma(value) {
    const values = String(value == null ? '0' : value).trim().split(/[\s,]+/).map(v => number(v, 'blur deviation'));
    if (values.length > 2 || values.some(v => v < 0) || (values.length === 2 && values[0] !== values[1])) fail('Different horizontal and vertical blur amounts have no single native effect equivalent.');
    return values[0];
}

// Resolve the filter graph, including Figma's transparent-background and
// hard-alpha scaffolding. Only remove a filter after its entire graph maps.
function nativeFilterPlan(filter) {
    const source = {kind: 'shape', effects: []};
    const alpha = {kind: 'alpha', dx: 0, dy: 0, sigma: 0, original: true};
    const values = new Map([['SourceGraphic', source], ['SourceAlpha', alpha]]);
    let previous = source;
    function get(name, fallback) {
        if (!name) return fallback;
        if (!values.has(name)) fail('Unsupported filter input ' + name + '.');
        return values.get(name);
    }
    function blend(a, b) {
        if (a.kind === 'transparent') return b;
        if (b.kind === 'transparent') return a;
        if (a.kind === 'shape' && b.kind === 'shadows') return {kind: 'shape', effects: b.effects.concat(a.effects)};
        if (b.kind === 'shape' && a.kind === 'shadows') return {kind: 'shape', effects: b.effects.concat(a.effects)};
        if (a.kind === 'shadows' && b.kind === 'shadows') return {kind: 'shadows', effects: b.effects.concat(a.effects)};
        fail('This filter blends images that cannot be represented by native layer effects.');
    }
    for (const primitive of filter.children.filter(n => n.tag)) {
        const a = primitive.attrs;
        const input = get(a.in, previous);
        let out;
        switch (primitive.tag) {
        case 'feDropShadow': {
            if (input.kind!=='shape') fail('Only source-image drop shadows are supported.');
            const c=colour(a['flood-color'] || '#000000');
            const named={black:'#000000',white:'#ffffff',red:'#ff0000',green:'#008000',blue:'#0000ff'};
            const hex=named[c.colour.toLowerCase()] || c.colour;
            if (!/^#[a-f\d]{6}$/i.test(hex)) fail('Unsupported drop-shadow colour.');
            const opacity=c.opacity*number(a['flood-opacity'] || '1','shadow opacity');
            if (opacity<0 || opacity>1) fail('Invalid shadow opacity.');
            out={kind:'shape',effects:input.effects.concat([{kind:'outerShadow',sigma:blurSigma(a.stdDeviation == null ? '2' : a.stdDeviation),dx:number(a.dx == null ? '2' : a.dx,'shadow offset'),dy:number(a.dy == null ? '2' : a.dy,'shadow offset'),rgb:[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255),opacity,knocksOut:false}])};
            break;
        }
        case 'feMerge': {
            const inputs=primitive.children.filter(n=>n.tag);
            out={kind:'transparent'};
            for (const node of inputs) {
                if (node.tag!=='feMergeNode') fail('Invalid SVG filter merge.');
                out=blend(get(node.attrs.in,previous),out);
            }
            break;
        }
        case 'feFlood':
            if (Number(a['flood-opacity']) !== 0) fail('Only transparent filter background floods are supported.');
            out = {kind: 'transparent'};
            break;
        case 'feBlend':
            if ((a.mode || 'normal') !== 'normal') fail('Non-normal filter blend modes need manual conversion.');
            out = blend(input, get(a.in2, source));
            break;
        case 'feGaussianBlur': {
            const sigma = blurSigma(a.stdDeviation);
            if (input.kind === 'shape') {
                if (input.effects.some(e => e.kind === 'blur')) fail('Multiple layer-blur stages need manual conversion.');
                out = {kind: 'shape', effects: input.effects.concat([{kind: 'blur', sigma}])};
            } else if (input.kind === 'alpha' && !input.cut) {
                out = Object.assign({}, input, {sigma: Math.hypot(input.sigma, sigma), original: false});
            } else fail('Blur input cannot be translated to a native layer effect.');
            break;
        }
        case 'feOffset':
            if (input.kind !== 'alpha' || input.cut) fail('Only shadow offsets are supported.');
            out = Object.assign({}, input, {dx: input.dx + number(a.dx || '0', 'shadow x offset'), dy: input.dy + number(a.dy || '0', 'shadow y offset'), original: false});
            break;
        case 'feMorphology': {
            if(input.kind!=='alpha' || input.cut || !['dilate','erode'].includes(a.operator || 'erode'))fail('Only shadow spread morphology is supported.');
            const spread=blurSigma(a.radius || '0')*((a.operator || 'erode')==='dilate'?1:-1);
            out=Object.assign({},input,{spread:(input.spread || 0)+spread,original:false});
            break;
        }
        case 'feColorMatrix': {
            if ((a.type || 'matrix') !== 'matrix' || input.kind !== 'alpha') fail('This colour-matrix filter has no supported native mapping.');
            const m = (a.values || '').trim().split(/[\s,]+/).map(v => number(v, 'colour matrix'));
            if (m.length !== 20 || [0,1,2,3,5,6,7,8,10,11,12,13,15,16,17].some(i => m[i] !== 0)) fail('This colour matrix changes source colours and is not a shadow tint.');
            if (input.original && m[4] === 0 && m[9] === 0 && m[14] === 0 && m[18] === 127 && (m[19] === -1 || m[19] === 0)) {
                out = Object.assign({}, input, {hard: true});
            } else {
                if (m[19] !== 0 || [m[4],m[9],m[14],m[18]].some(v => v < 0 || v > 1)) fail('Unsupported shadow tint or opacity.');
                out = {kind: 'shadows', effects: [{kind: input.cut === 'inner' ? 'innerShadow' : 'outerShadow', sigma: input.sigma, dx: input.dx, dy: input.dy, rgb: [m[4],m[9],m[14]], opacity: m[18], knocksOut: input.cut === 'outer'}]};
                if(input.spread)out.effects[0].spread=input.spread*(input.cut==='inner'?-1:1);
            }
            break;
        }
        case 'feComposite': {
            const other = get(a.in2, null);
            if (input.kind !== 'alpha' || input.cut || !other || other.kind !== 'alpha' || !other.original) fail('Unsupported filter compositing.');
            if (a.operator === 'out') out = Object.assign({}, input, {cut: 'outer'});
            else if (a.operator === 'arithmetic' && Number(a.k1 || 0) === 0 && Number(a.k2 || 0) === -1 && Number(a.k3 || 0) === 1 && Number(a.k4 || 0) === 0) out = Object.assign({}, input, {cut: 'inner'});
            else fail('This composite filter is not a Figma shadow mask.');
            break;
        }
        default:
            fail(primitive.tag + ' has no implemented native mapping.');
        }
        previous = out;
        if (a.result) values.set(a.result, out);
    }
    if (previous.kind !== 'shape') fail('The filter replaces the source image instead of applying supported layer effects.');
    return previous.effects;
}

// Figma's negative inner spread dilates the alpha before blurring its
// complement. Affinity's Inner Shadow intensity cannot express that. For
// rectangles, retain the complement as editable vector geometry, blur it
// natively, and clip it to the original silhouette.
function innerSpreadGeometry(node, spread, dx, dy, sigma) {
    if (node.attrs.transform || node.attrs.stroke || node.attrs.mask || node.attrs['clip-path']) return null;
    const a=node.attrs, grow=-spread;
    let hole, bounds;
    if (node.tag==='rect' && !a.rx && !a.ry) {
        const x=Number(a.x || 0),y=Number(a.y || 0),w=Number(a.width),h=Number(a.height);
        if (![x,y,w,h].every(Number.isFinite) || w<=0 || h<=0) return null;
        bounds=[x,y,x+w,y+h];
        hole=`M${x-grow+dx} ${y-grow+dy}H${x+w+grow+dx}V${y+h+grow+dy}H${x-grow+dx}Z`;
    } else if (node.tag==='path') {
        const tokens=(a.d || '').match(/[a-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/ig) || [];
        const commands=[],arity={M:2,C:6,H:1,V:1,Z:0};
        for(let i=0;i<tokens.length;){
            const op=tokens[i++],count=arity[op];
            if(count==null || i+count>tokens.length)return null;
            const values=tokens.slice(i,i+count).map(Number);i+=count;
            if(!values.every(Number.isFinite))return null;
            commands.push({op,values});
        }
        if(commands.map(c=>c.op).join('')!=='MCHCVCHCVZ')return null;
        const v=commands.map(c=>c.values),left=v[0][0],top=v[1][5],right=v[3][4],bottom=v[5][5];
        const close=(x,y)=>Math.abs(x-y)<.06;
        // Only Figma's axis-aligned convex rounded-rectangle silhouette.
        if(!(right>left && bottom>top) || !close(v[1][0],left) || !close(v[1][3],top) ||
            !close(v[3][1],top) || !close(v[3][2],right) || !close(v[5][0],right) ||
            !close(v[5][3],bottom) || !close(v[7][1],bottom) || !close(v[7][2],left) ||
            !close(v[7][4],left) || !close(v[3][5],v[0][1]) || !close(v[8][0],v[0][1]) ||
            !close(v[1][4],v[6][0]) || !close(v[2][0],v[5][4]) || !close(v[4][0],v[7][5]))return null;
        for(const [index,sx,sy] of [[0,-1,-1],[1,-1,-1],[3,1,-1],[5,1,1],[7,-1,1]])
            commands[index].values=commands[index].values.map((n,i)=>n+(i%2?dy+sy*grow:dx+sx*grow));
        commands[2].values[0]+=dx+grow;commands[4].values[0]+=dy+grow;
        commands[6].values[0]+=dx-grow;commands[8].values[0]+=dy-grow;
        hole=commands.map(c=>c.op+c.values.join(' ')).join('');bounds=[left,top,right,bottom];
    } else return null;
    const margin=grow+3*sigma+Math.abs(dx)+Math.abs(dy)+4;
    const [l,t,r,b]=bounds.map((n,i)=>n+(i<2?-margin:margin));
    return {d:`M${l} ${t}H${r}V${b}H${l}Z`+hole,
        clip:{tag:node.tag,attrs:Object.fromEntries(Object.entries(a).filter(([k])=>['d','x','y','width','height','rx','ry','fill-rule'].includes(k))),children:[]}};
}

function imageAssetName(name, index, mime) {
    const stem=String(name || 'image').replace(/\.[a-z0-9]{2,5}$/i,'').replace(/[^a-z0-9_-]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,72) || 'image';
    return String(index).padStart(3,'0')+'-'+stem+'.'+({png:'png',jpeg:'jpg',webp:'webp'})[mime];
}

// Decode directly into a typed array in both Affinity and Node, without atob/Buffer globals.
function decodeImageBase64(value) {
    const s=value.replace(/\s/g,'');
    if (!s.length || s.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) fail('An embedded image has invalid base64 data.');
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', table=new Int16Array(128);
    table.fill(-1);for(let i=0;i<64;i++)table[alphabet.charCodeAt(i)]=i;
    const result=new Uint8Array(s.length/4*3-(s.endsWith('==')?2:s.endsWith('=')?1:0));
    let at=0;
    for(let i=0;i<s.length;i+=4){
        const a=table[s.charCodeAt(i)],b=table[s.charCodeAt(i+1)],c=s[i+2]==='='?0:table[s.charCodeAt(i+2)],d=s[i+3]==='='?0:table[s.charCodeAt(i+3)];
        result[at++]=(a<<2)|(b>>4);if(at<result.length)result[at++]=(b<<4)|(c>>2);if(at<result.length)result[at++]=(c<<6)|d;
    }
    return result;
}

// Exact geometry bounds of SVG path data (objectBoundingBox excludes control
// points), for image fills on Figma vector shapes. Arcs aren't needed for Figma
// exports and fail so the fill is reported rather than misplaced.
function pathBox(d) {
    const tokens=String(d).match(/[a-df-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
    let i=0,x=0,y=0,sx=0,sy=0,cmd='',px=null,py=null;
    const xs=[],ys=[],num=()=>{const v=Number(tokens[i++]);if(!Number.isFinite(v))fail('the image fill’s path could not be read');return v;};
    const add=(ax,ay)=>{xs.push(ax);ys.push(ay);};
    const extrema=(p0,p1,p2,p3,out)=>{ // cubic roots of the derivative, within (0,1)
        const a=-p0+3*p1-3*p2+p3,b=2*(p0-2*p1+p2),c=p1-p0,ts=[];
        if(Math.abs(a)<1e-12){if(Math.abs(b)>1e-12)ts.push(-c/b);}
        else{const disc=b*b-4*a*c;if(disc>=0){ts.push((-b+Math.sqrt(disc))/(2*a),(-b-Math.sqrt(disc))/(2*a));}}
        for(const t of ts)if(t>0 && t<1)out.push(t);
    };
    const cubic=(x1,y1,x2,y2,x3,y3)=>{
        const ts=[];extrema(x,x1,x2,x3,ts);extrema(y,y1,y2,y3,ts);
        for(const t of ts){const u=1-t;add(u*u*u*x+3*u*u*t*x1+3*u*t*t*x2+t*t*t*x3,u*u*u*y+3*u*u*t*y1+3*u*t*t*y2+t*t*t*y3);}
        px=x2;py=y2;x=x3;y=y3;add(x,y);
    };
    while(i<tokens.length) {
        if(/[a-z]/i.test(tokens[i]))cmd=tokens[i++];
        else if(!cmd)fail('the image fill’s path could not be read');
        const rel=cmd===cmd.toLowerCase(),C=cmd.toUpperCase(),ox=rel?x:0,oy=rel?y:0;
        if(C==='M'){x=ox+num();y=oy+num();sx=x;sy=y;add(x,y);px=null;cmd=rel?'l':'L';}
        else if(C==='L'){x=ox+num();y=oy+num();add(x,y);px=null;}
        else if(C==='H'){x=ox+num();add(x,y);px=null;}
        else if(C==='V'){y=oy+num();add(x,y);px=null;}
        else if(C==='C'){const a=[num(),num(),num(),num(),num(),num()];cubic(ox+a[0],oy+a[1],ox+a[2],oy+a[3],ox+a[4],oy+a[5]);}
        else if(C==='S'){const r=px==null?[x,y]:[2*x-px,2*y-py],a=[num(),num(),num(),num()];cubic(r[0],r[1],ox+a[0],oy+a[1],ox+a[2],oy+a[3]);}
        else if(C==='Q'){const qx=ox+num(),qy=oy+num(),ex=ox+num(),ey=oy+num();cubic(x+2/3*(qx-x),y+2/3*(qy-y),ex+2/3*(qx-ex),ey+2/3*(qy-ey),ex,ey);}
        else if(C==='Z'){x=sx;y=sy;px=null;}
        else fail('the image fill’s path uses an unsupported command');
    }
    if(!xs.length)fail('the image fill’s path is empty');
    const x0=Math.min(...xs),y0=Math.min(...ys);
    return [x0,y0,Math.max(...xs)-x0,Math.max(...ys)-y0];
}

function prepareImages(root, warnings, packet) {
    const assets=[], byData=new Map(), ids=new Map();
    walk(root,n=>{if(n.attrs.id)ids.set(n.attrs.id,n);});
    walk(root,n=>{
        if(n.tag!=='image')return;
        const href=n.attrs.href || n.attrs['xlink:href'] || '';
        const match=/^data:image\/(png|jpeg|webp);base64,([a-z\d+/=\s]+)$/i.exec(href);
        if(!match){warn(warnings,'An image couldn’t be read and may be missing. Check the images in Affinity.');return;}
        let asset=byData.get(href);
        if(!asset){
            let token='FigmaPasteAsset'+(assets.length+1);while(ids.has(token))token+='x';
            asset={token,mime:match[1].toLowerCase(),base64:match[2],name:n.attrs['data-name'] || n.attrs.id || 'image',width:n.attrs.width,height:n.attrs.height};
            asset.filename=imageAssetName(asset.name,assets.length+1,asset.mime);assets.push(asset);byData.set(href,asset);
        }
        delete n.attrs.href;n.attrs['xlink:href']='#'+asset.token;
    });
    if(assets.length)root.attrs['xmlns:xlink']='http://www.w3.org/1999/xlink';
    let converted=0,serial=0;
    const addedDefs=[],tiles=[];
    const vb=(root.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
    const rootScaled=vb.length===4 && ((root.attrs.width && parseFloat(root.attrs.width)!==vb[2]) || (root.attrs.height && parseFloat(root.attrs.height)!==vb[3]));
    // Figma "Tile" fills: one image scaled to exactly one repeat of the pattern.
    // They become native repeating bitmap fills after import; SVG patterns don't load.
    function tile(n,pattern,matrix) {
        const p=pattern.attrs;
        const contents=pattern.children.filter(c=>c.tag && !['title','desc'].includes(c.tag));
        const use=contents[0], ref=use?.attrs.href || use?.attrs['xlink:href'];
        const source=use?.tag==='use' && ref?.[0]==='#' ? ids.get(ref.slice(1)) : null;
        const asset=source?.tag==='image' && assets.find(a=>'#'+a.token===(source.attrs.href || source.attrs['xlink:href']));
        if(contents.length!==1 || !asset || !matrix || Number(use.attrs.x || 0)!==0 || Number(use.attrs.y || 0)!==0)fail('this tiled pattern is not supported');
        const [sx,b,c,sy,e,f]=svgTransform(use.attrs.transform),iw=number(source.attrs.width,'image width'),ih=number(source.attrs.height,'image height');
        const pw=number(p.width,'tile width'),ph=number(p.height,'tile height');
        if(b || c || e || f || !(iw>0 && ih>0 && pw>0 && ph>0) || Math.abs(iw*sx/pw-1)>1e-3 || Math.abs(ih*sy/ph-1)>1e-3)fail('this tiled pattern is not supported');
        const [x,y,w,h]=box(n);if(!(w>0 && h>0))fail('the image has empty bounds');
        if(!n.attrs.id){let id='FigmaPasteTile'+(tiles.length+1);while(ids.has(id))id+='x';ids.set(id,n);n.attrs.id=id;}
        // Affinity has no fill opacity for bitmap fills, so it becomes layer opacity,
        // which only matches when nothing else (stroke, effects) is on the layer.
        const fillOpacity=n.attrs['fill-opacity']==null ? 1 : number(n.attrs['fill-opacity'],'fill opacity');
        const plain=!(n.attrs.stroke && n.attrs.stroke!=='none') && !n.attrs.filter;
        if(fillOpacity!==1 && !plain)warn(warnings,layerName(packet,n.attrs.id)+': the tiled image fill’s opacity wasn’t applied. Set it in Affinity.');
        // A bitmap fill spans −1…1 around the fill origin; one bitmap covers one tile.
        const tw=pw*w,th=ph*h;
        tiles.push({marker:n.attrs.id,token:asset.token,opacity:plain ? fillOpacity*(n.attrs.opacity==null ? 1 : number(n.attrs.opacity,'opacity')) : null,fillToSpread:multiplyAffine(matrix,[tw/2,0,0,th/2,x+tw/2,y+th/2])});
        n.attrs.fill='none';delete n.attrs['fill-opacity'];
        return n;
    }
    function box(n){
        const a=n.attrs, num=(k,d=0)=>a[k]==null?d:number(a[k],k);
        if(n.tag==='rect')return [num('x'),num('y'),num('width'),num('height')];
        if(n.tag==='circle'){const r=num('r');return[num('cx')-r,num('cy')-r,2*r,2*r];}
        if(n.tag==='ellipse'){const rx=num('rx'),ry=num('ry');return[num('cx')-rx,num('cy')-ry,2*rx,2*ry];}
        if(n.tag==='path')return pathBox(a.d || '');
        fail('only rectangle, circle, ellipse and path image fills are currently rebuilt');
    }
    function convert(parent,matrix){
        parent.children=parent.children.map(n=>{
            if(!n.tag)return n;
            if(n.tag==='defs')return n;
            let own=null;try{own=matrix && multiplyAffine(matrix,svgTransform(n.attrs.transform));}catch(ignore){}
            convert(n,own);
            const match=/^url\(\s*['"]?#([^'"\s)]+)['"]?\s*\)$/.exec(n.attrs.fill || '');
            const pattern=match && ids.get(match[1]);
            if(!pattern || pattern.tag!=='pattern')return n;
            try{
                const p=pattern.attrs;
                if((p.patternUnits || 'objectBoundingBox')==='objectBoundingBox' && p.patternContentUnits==='objectBoundingBox' && !p.patternTransform && !p.viewBox && !p.href && !p['xlink:href'] && Number(p.x || 0)===0 && Number(p.y || 0)===0 && (Number(p.width)!==1 || Number(p.height)!==1))return tile(n,pattern,own);
                if((p.patternUnits || 'objectBoundingBox')!=='objectBoundingBox' || p.patternContentUnits!=='objectBoundingBox' || Number(p.width)!==1 || Number(p.height)!==1 || Number(p.x || 0)!==0 || Number(p.y || 0)!==0 || p.patternTransform || p.viewBox || p.href || p['xlink:href'])fail('this tiled or transformed pattern is not supported');
                const contents=pattern.children.filter(c=>c.tag && !['title','desc'].includes(c.tag));
                if(contents.length!==1 || !['use','image'].includes(contents[0].tag))fail('the pattern contains more than one image');
                const use=contents[0], ref=use.attrs.href || use.attrs['xlink:href'];
                const source=use.tag==='image'?use:ref && ref[0]==='#'?ids.get(ref.slice(1)):null;
                if(!source || source.tag!=='image' || !assets.some(a=>'#'+a.token===(source.attrs.href || source.attrs['xlink:href'])))fail('the embedded image could not be resolved');
                const [x,y,w,h]=box(n);if(!(w>0 && h>0))fail('the image has empty bounds');
                let clip='FigmaPasteImageClip'+(++serial);while(ids.has(clip))clip+='x';ids.set(clip,true);
                const shape={tag:n.tag,attrs:{...n.attrs},children:[]};
                for(const key of ['id','transform','fill','fill-opacity','stroke','stroke-width','stroke-opacity','filter','clip-path','mask','opacity','style'])delete shape.attrs[key];
                shape.attrs.fill='#ffffff';
                addedDefs.push({tag:'clipPath',attrs:{id:clip,clipPathUnits:'userSpaceOnUse'},children:[shape]});
                const bitmap={tag:'image',attrs:{...source.attrs},children:[]};delete bitmap.attrs.id;delete bitmap.attrs['data-name'];
                let content=bitmap;
                if(use!==source){
                    const attrs={};for(const key of ['transform','opacity','style'])if(use.attrs[key]!=null)attrs[key]=use.attrs[key];
                    if(Number(use.attrs.x || 0)!==0 || Number(use.attrs.y || 0)!==0)fail('offset pattern references need manual conversion');
                    content={tag:'g',attrs,children:[bitmap]};
                }
                const wrapper={tag:'g',attrs:{...n.attrs,'data-figma-image-fill':'true'},children:[{tag:'g',attrs:{'clip-path':'url(#'+clip+')'},children:[{tag:'g',attrs:{transform:'translate('+x+' '+y+') scale('+w+' '+h+')'},children:[content]}]}]};
                for(const key of ['x','y','width','height','rx','ry','r','cx','cy','fill','fill-opacity','stroke','stroke-width','stroke-opacity'])delete wrapper.attrs[key];
                if(n.attrs['fill-opacity']!=null)wrapper.children[0].attrs.opacity=n.attrs['fill-opacity'];
                if(n.attrs.stroke && n.attrs.stroke!=='none'){
                    const stroke={tag:n.tag,attrs:{...n.attrs,fill:'none'},children:[]};
                    for(const key of ['id','transform','opacity','filter','clip-path','mask','style','fill-opacity'])delete stroke.attrs[key];
                    wrapper.children.push(stroke);
                }
                converted++;return wrapper;
            }catch(e){warn(warnings,'An image fill couldn’t be converted and may be missing. Check the images in Affinity.');return n;}
        });
    }
    convert(root,rootScaled ? null : vb.length===4 ? [1,0,0,1,-vb[0],-vb[1]] : [1,0,0,1,0,0]);
    if(addedDefs.length){let defs=root.children.find(n=>n.tag==='defs');if(!defs){defs={tag:'defs',attrs:{},children:[]};root.children.push(defs);}defs.children.push(...addedDefs);}
    return {assets,imageFills:converted,imageTiles:tiles};
}

// Affinity's SVG loader ignores local image hrefs. Embed one definition per
// distinct image geometry and reuse it, while keeping separate original files.
function embedImageAssets(svg,assets) {
    const root=parseXml(svg),byToken=new Map(assets.map(a=>['#'+a.token,a])),ids=new Set(),shared=new Map(),definitions=[];
    walk(root,n=>{if(n.attrs.id)ids.add(n.attrs.id);});
    walk(root,n=>{
        if(n.tag!=='image')return;
        const asset=byToken.get(n.attrs.href || n.attrs['xlink:href']);if(!asset)return;
        const attrs={...n.attrs};delete attrs.id;delete attrs.href;delete attrs['xlink:href'];delete attrs['data-name'];
        const key=asset.token+'\n'+JSON.stringify(Object.keys(attrs).sort().map(k=>[k,attrs[k]]));
        let id=shared.get(key);
        if(!id){
            id=asset.token+'Embedded'+(definitions.length+1);while(ids.has(id))id+='x';ids.add(id);shared.set(key,id);
            definitions.push({tag:'image',attrs:{...attrs,id,'xlink:href':'data:image/'+asset.mime+';base64,'+asset.base64},children:[]});
        }
        const originalId=n.attrs.id;n.tag='use';n.attrs={'xlink:href':'#'+id};if(originalId)n.attrs.id=originalId;n.children=[];
    });
    let defs=root.children.find(n=>n.tag==='defs');if(!defs){defs={tag:'defs',attrs:{},children:[]};root.children.push(defs);}defs.children.push(...definitions);
    return xml(root);
}

// Figma exports backdrop blur as an empty XHTML div beside the real SVG artwork.
// Recognize only that exact inert scaffold, never general embedded HTML. Removing
// it lets the artwork import, but does not reproduce the backdrop effect.
function omitFigmaBackdropHelpers(root, warnings, packet) {
    const clips=new Map();
    walk(root,n=>{if(n.tag==='clipPath' && n.attrs.id)clips.set(n.attrs.id,(clips.get(n.attrs.id)||0)+1);});
    const numeric=/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
    const significant=children=>children.filter(n=>n.tag || n.text.trim());
    function recognized(node,next) {
        if(node.tag!=='foreignObject' || Object.keys(node.attrs).some(k=>!['x','y','width','height'].includes(k)))return false;
        if(!['x','y','width','height'].every(k=>numeric.test(node.attrs[k]) && Number.isFinite(Number(node.attrs[k]))))return false;
        if(Number(node.attrs.width)<0 || Number(node.attrs.height)<0)return false;
        const children=significant(node.children),div=children[0];
        if(children.length!==1 || div.tag!=='div' || significant(div.children).length)return false;
        if(div.attrs.xmlns!=='http://www.w3.org/1999/xhtml' || Object.keys(div.attrs).some(k=>!['xmlns','style'].includes(k)))return false;
        const style=Object.create(null);
        for(const entry of (div.attrs.style || '').split(';').filter(s=>s.trim())) {
            const colon=entry.indexOf(':');if(colon<0)return false;
            const key=entry.slice(0,colon).trim(),value=entry.slice(colon+1).trim();
            if(key in style || !['backdrop-filter','clip-path','height','width'].includes(key))return false;
            style[key]=value;
        }
        if(style.height!=='100%' || style.width!=='100%')return false;
        const blur=/^blur\((\d+(?:\.\d+)?|\.\d+)px\)$/.exec(style['backdrop-filter'] || '');
        const clip=/^url\(#(bgblur_[\w.-]+_clip_path)\)$/.exec(style['clip-path'] || '');
        if(!blur || !clip || clips.get(clip[1])!==1)return false;
        const radius=next?.attrs?.['data-figma-bg-blur-radius'];
        return !!next?.tag && numeric.test(radius) && Math.abs(Number(radius)-2*Number(blur[1]))<=0.02 && {blur:Number(blur[1]),clip:clip[1]};
    }
    // Background blur becomes an Affinity Gaussian Blur live filter behind the layer,
    // masked to the frosted area. The mask is a white copy of Figma's blur clip shape,
    // left where the helper was; the live filter is added around it after import.
    const clipById=new Map();walk(root,n=>{if(n.tag==='clipPath' && n.attrs.id)clipById.set(n.attrs.id,n);});
    const backdrops=[];let backdropSerial=0;
    function backdropMask(node,found) {
        const clip=clipById.get(found.clip),shapes=clip ? significant(clip.children).filter(c=>c.tag) : [];
        if(shapes.length!==1 || !['rect','path','circle','ellipse'].includes(shapes[0].tag))return null;
        const shape=shapes[0],attrs={...shape.attrs};delete attrs.id;delete attrs['clip-path'];delete attrs.style;
        const transform=['translate('+node.attrs.x+' '+node.attrs.y+')',clip.attrs.transform,shape.attrs.transform].filter(Boolean).join(' ');
        let id;do{id='FigmaPasteBackdrop'+(++backdropSerial);}while(clipById.has(id) || root.attrs.id===id);
        Object.assign(attrs,{id,fill:'white',transform});delete attrs['fill-opacity'];delete attrs.opacity;delete attrs.stroke;
        return {tag:shape.tag,attrs,children:[]};
    }
    // Figma renders angular/diamond gradients with an HTML helper group
    // (data-figma-skip-parse) and describes the real paint as JSON on the next
    // sibling. Drop the helper; angular paints are rebuilt as native conical
    // gradients after import.
    const ids=new Set(),angular=[];let serial=0;
    walk(root,n=>{if(n.attrs.id)ids.add(n.attrs.id);});
    const vb=(root.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
    const htmlOnly=node=>{let ok=true;walk(node,n=>{if(!['g','foreignObject','div'].includes(n.tag) || (n.tag==='div' && significant(n.children).length))ok=false;});return ok;};
    function gradientHelper(node,next,matrix,owner) {
        if(node.tag!=='g' || node.attrs['data-figma-skip-parse']!=='true' || !htmlOnly(node) || !next?.tag)return false;
        let paint;try{paint=JSON.parse(next.attrs['data-figma-gradient-fill']);}catch(e){return false;}
        if(!paint || !['GRADIENT_ANGULAR','GRADIENT_DIAMOND'].includes(paint.type))return false;
        const name=layerName(packet,next.attrs.id || owner);
        const stops=figmaGradientStops(paint);
        delete next.attrs['data-figma-gradient-fill'];
        if(stops){const [r,g,b,a]=stops[0].rgba;next.attrs.fill='rgb('+[r,g,b].map(v=>Math.round(v*255)).join(',')+')';next.attrs['fill-opacity']=String(a);}
        const t=paint.transform,m=t && [t.m00,t.m10,t.m01,t.m11,t.m02,t.m12];
        if(paint.type!=='GRADIENT_ANGULAR' || !stops || !matrix || !m?.every(Number.isFinite)) {
            warn(warnings,name+': '+(paint.type==='GRADIENT_DIAMOND' ? 'diamond gradients aren’t supported. Recreate it in Affinity.' : 'check the angular gradient on this layer.'));
            return true;
        }
        if(!next.attrs.id){let id;do{id='FigmaPasteAngular'+(++serial);}while(ids.has(id));ids.add(id);next.attrs.id=id;}
        angular.push({marker:next.attrs.id,name,stops,gradientToSpread:multiplyAffine(matrix,m)});
        return true;
    }
    function visit(parent,matrix=vb.length===4 ? [1,0,0,1,-vb[0],-vb[1]] : [1,0,0,1,0,0],owner) {
        const children=significant(parent.children),omitted=new Set();
        for(let i=0;i<children.length;i++) {
            const node=children[i];if(!node.tag)continue;
            if(gradientHelper(node,children[i+1],matrix,owner)){omitted.add(node);continue;}
            if(node.tag.split(':').pop().toLowerCase()==='foreignobject') {
                const next=children[i+1];
                const found=recognized(node,next);
                if(!found)fail('Embedded HTML (foreignObject) is not supported. Only Figma’s empty backdrop-blur helper can be skipped. No import has been started.');
                const layer=packet?.layers.find(l=>l.marker===next.attrs.id),name=layer?.name || 'A layer';
                const mask=backdropMask(node,found);
                if(mask){parent.children[parent.children.indexOf(node)]=mask;backdrops.push({marker:mask.attrs.id,radius:found.blur,name});}
                else{warn(warnings,name+': background blur isn’t supported. Add it in Affinity if you need it.');omitted.add(node);}
            } else {
                let child=null;try{child=matrix && multiplyAffine(matrix,svgTransform(node.attrs.transform));}catch(ignore){}
                visit(node,child,node.attrs.id || owner);
            }
        }
        if(omitted.size)parent.children=parent.children.filter(n=>!omitted.has(n));
    }
    visit(root);
    return {angular,backdrops};
}

// Figma angular gradients wrap from the last stop back to the first; Affinity's
// conical gradient does not, so both ends get the colour where the wrap crosses 0°.
function figmaGradientStops(paint) {
    const opacity=paint.opacity ?? 1;
    const stops=(paint.stops || []).map(s=>({position:s.position,rgba:[s.color?.r,s.color?.g,s.color?.b,(s.color?.a ?? 1)*opacity]}))
        .filter(s=>[s.position,...s.rgba].every(v=>Number.isFinite(v) && v>=0 && v<=1)).sort((a,b)=>a.position-b.position);
    if(!stops.length || stops.length!==(paint.stops || []).length)return null;
    const first=stops[0],last=stops[stops.length-1],gap=1-last.position+first.position;
    const t=gap>0 ? (1-last.position)/gap : 0,wrap=last.rgba.map((v,i)=>v+(first.rgba[i]-v)*t);
    if(first.position>0)stops.unshift({position:0,rgba:wrap});
    if(last.position<1)stops.push({position:1,rgba:wrap});
    return stops;
}

function multiplyAffine(a,b) {
    return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
}
function svgTransform(value) {
    let out=[1,0,0,1,0,0],rest=(value || '').trim();
    while(rest) {
        const match=/^(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?\s*/.exec(rest);
        if(!match)fail('unsupported SVG transform');
        const a=match[2].trim().split(/[\s,]+/).map(v=>number(v,'SVG transform'));let m;
        if(match[1]==='matrix' && a.length===6)m=a;
        else if(match[1]==='translate' && [1,2].includes(a.length))m=[1,0,0,1,a[0],a[1] || 0];
        else if(match[1]==='scale' && [1,2].includes(a.length))m=[a[0],0,0,a.length===1?a[0]:a[1],0,0];
        else if(match[1]==='rotate' && [1,3].includes(a.length)) {
            const r=a[0]*Math.PI/180,c=Math.cos(r),s=Math.sin(r);m=[c,s,-s,c,0,0];
            if(a.length===3)m=multiplyAffine(multiplyAffine([1,0,0,1,a[1],a[2]],m),[1,0,0,1,-a[1],-a[2]]);
        } else if(['skewX','skewY'].includes(match[1]) && a.length===1) {
            const t=Math.tan(a[0]*Math.PI/180);m=match[1]==='skewX'?[1,0,t,1,0,0]:[1,t,0,1,0,0];
        } else fail('unsupported SVG transform');
        out=multiplyAffine(out,m);rest=rest.slice(match[0].length);
    }
    if(!out.every(Number.isFinite) || Math.abs(out[0]*out[3]-out[1]*out[2])<1e-12)fail('collapsed SVG transform');
    return out;
}

// Affinity imports a userSpaceOnUse text gradient in SVG coordinates, but its
// glyph fill consumes text-local coordinates. Keep the native gradient's stops
// and opacity; record the SVG coordinate system so it can be rebased after load.
// Affinity's SVG loader scales em letter-spacing wrongly (−0.04em arrives as
// −0.0048), so record each SVG text's tracking in em and set it after loading.
function planTextTracking(root) {
    const ids=new Set(),plans=[];let serial=0;
    walk(root,n=>{if(n.attrs.id)ids.add(n.attrs.id);});
    function em(value,fontSize) {
        const m=/^(-?(?:\d+\.?\d*|\.\d+))(em|px)?$/.exec(String(value).trim());
        if(!m)return null;
        if(m[2]==='em')return Number(m[1]);
        const size=parseFloat(fontSize);
        return size>0 ? Number(m[1])/size : null;
    }
    function visit(node,spacing,fontSize) {
        if(!node.tag || ['defs','clipPath','mask','symbol','pattern'].includes(node.tag))return;
        spacing=node.attrs['letter-spacing'] ?? spacing;fontSize=node.attrs['font-size'] ?? fontSize;
        if(node.tag==='text') {
            const values=new Set();
            (function spans(n,ls,fs){if(!n.tag)return;ls=n.attrs['letter-spacing'] ?? ls;fs=n.attrs['font-size'] ?? fs;values.add(ls==null || ls==='normal' ? 0 : em(ls,fs));n.children.forEach(c=>spans(c,ls,fs));})(node,spacing,fontSize);
            const [value]=values;
            if(values.size===1 && Number.isFinite(value) && value!==0) {
                if(!node.attrs.id){let id;do{id='FigmaPasteText'+(++serial);}while(ids.has(id));ids.add(id);node.attrs.id=id;}
                plans.push({marker:node.attrs.id,characterSpacing:value});
            }
            return;
        }
        node.children.forEach(c=>visit(c,spacing,fontSize));
    }
    visit(root,null,null);
    return plans;
}

// Affinity's SVG loader ignores font-weight for variable fonts (Bold loads as
// Regular), so record the requested face and switch to it after loading.
function planTextFonts(root) {
    const ids=new Set(),plans=[];let serial=0;
    walk(root,n=>{if(n.attrs.id)ids.add(n.attrs.id);});
    const weight=v=>v==null || v==='normal' ? 400 : v==='bold' ? 700 : /^\d{3}$/.test(v) ? Number(v) : null;
    function visit(node,inherited) {
        if(!node.tag || ['defs','clipPath','mask','symbol','pattern'].includes(node.tag))return;
        const style=n=>({family:n.attrs['font-family'] ?? inherited?.family,weight:n.attrs['font-weight'] ?? inherited?.weight,italic:n.attrs['font-style'] ?? inherited?.italic});
        const own=style(node);
        if(node.tag==='text') {
            const faces=new Set();
            (function spans(n,s){if(!n.tag)return;s={family:n.attrs['font-family'] ?? s.family,weight:n.attrs['font-weight'] ?? s.weight,italic:n.attrs['font-style'] ?? s.italic};faces.add(JSON.stringify(s));n.children.forEach(c=>spans(c,s));})(node,own);
            const [face]=[...faces].map(f=>JSON.parse(f));
            const family=String(face?.family || '').split(',')[0].trim().replace(/^(['"])(.*)\1$/,'$2');
            if(faces.size===1 && family && weight(face.weight)!=null) {
                if(!node.attrs.id){let id;do{id='FigmaPasteFont'+(++serial);}while(ids.has(id));ids.add(id);node.attrs.id=id;}
                plans.push({marker:node.attrs.id,family,weight:weight(face.weight),italic:/^(italic|oblique)/.test(face.italic || '')});
            }
            return;
        }
        node.children.forEach(c=>visit(c,own));
    }
    visit(root,null);
    return plans;
}

const namedWeights={thin:100,hairline:100,extralight:200,ultralight:200,light:300,regular:400,normal:400,book:400,roman:400,medium:500,semibold:600,demibold:600,bold:700,extrabold:800,ultrabold:800,black:900,heavy:900};
function fontFaceWeight(font,variable) {
    // Variable families report 400 for every named instance; read the style name instead.
    const style=String(font.postscriptName || '').split('-').pop().toLowerCase().replace(/italic|oblique/g,'');
    return variable ? namedWeights[style || 'regular'] ?? font.weight : font.weight;
}

function restoreTextFonts(doc,plans) {
    if(!plans.length)return;
    const {StoryDelta}=require('/storydelta.js');
    const {Selection}=require('/selections.js');
    const {FontFamily}=require('/fonts.js');
    const index=indexLayersByName(doc.layers.all.toArray()),families=new Map();
    for(const plan of plans) {
        try {
            const matches=index.get(plan.marker) || [];
            if(matches.length!==1)continue;
            const texts=[];
            (function visit(n){if(n.isTextNode)texts.push(n);else for(const c of n.children.toArray())visit(c);})(matches[0]);
            const key=plan.family.toLowerCase();
            if(!families.has(key))families.set(key,FontFamily.all.find(f=>f.name.toLowerCase()===key) || null);
            const family=families.get(key);if(!family || !texts.length)continue;
            const fonts=[...Array(family.fontCount)].map((_,i)=>family.getFont(i));
            const target=fonts.find(f=>!!f.isItalic===plan.italic && fontFaceWeight(f,family.hasVariations)===plan.weight);
            const wrong=texts.filter(t=>t.story.getGlyphAtts(t.storyRange.begin).font.postscriptName!==target?.postscriptName);
            if(target && wrong.length)doc.formatText(StoryDelta.createPostscriptName(target.postscriptName),Selection.create(doc,wrong));
        } catch(e) { /* ponytail: leave Affinity's face; missing fonts are reported separately. */ }
    }
}

function restoreTextTracking(doc,plans,packet,warnings) {
    if(!plans.length)return;
    const {StoryDelta,GlyphAttDoubleType}=require('/storydelta.js');
    const {Selection}=require('/selections.js');
    const index=indexLayersByName(doc.layers.all.toArray());
    for(const plan of plans) {
        const matches=index.get(plan.marker) || [];
        if(matches.length!==1)continue; // ponytail: text Affinity split or renamed keeps the loader's spacing.
        const texts=[];
        (function visit(n){if(n.isTextNode)texts.push(n);else for(const c of n.children.toArray())visit(c);})(matches[0]);
        try{if(texts.length)doc.formatText(StoryDelta.createGlyphDouble(GlyphAttDoubleType.CharacterSpacing,plan.characterSpacing),Selection.create(doc,texts));}
        catch(e){warn(warnings,layerName(packet,plan.marker)+': check the letter spacing on this text.');}
    }
}

function planLinearTextGradients(root,warnings,packet) {
    const gradients=new Map(),ids=new Set(),plans=[];let serial=0;
    walk(root,n=>{if(n.attrs.id)ids.add(n.attrs.id);if(n.tag==='linearGradient' && n.attrs.id)gradients.set(n.attrs.id,n);});
    function attributes(id,seen=new Set()) {
        if(seen.has(id))return null;seen.add(id);
        const g=gradients.get(id);if(!g)return null;
        const href=g.attrs.href || g.attrs['xlink:href'];
        const parent=href?.startsWith('#') ? attributes(href.slice(1),seen) : {};
        return parent ? {...parent,...g.attrs} : null;
    }
    const vb=(root.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
    let initial=[1,0,0,1,0,0];
    if(vb.length===4) {
        initial=[1,0,0,1,-vb[0],-vb[1]];
        if((root.attrs.width && parseFloat(root.attrs.width)!==vb[2]) || (root.attrs.height && parseFloat(root.attrs.height)!==vb[3]))initial=null;
    }
    function visit(node,parentMatrix,fill,fillOpacity,inDefs) {
        if(!node.tag)return;
        inDefs=inDefs || ['defs','clipPath','mask','symbol','pattern'].includes(node.tag);
        let matrix=null;
        try {if(parentMatrix && (node===root || node.tag!=='svg'))matrix=multiplyAffine(parentMatrix,svgTransform(node.attrs.transform));}catch(ignore){}
        fill=node.attrs.fill ?? fill;fillOpacity=node.attrs['fill-opacity'] ?? fillOpacity;
        if(node.tag==='text' && !inDefs) {
            const paints=new Set();let transformedSpan=false;
            function paintsIn(n,paint,alpha) {
                if(!n.tag){if(n.text.trim())paints.add(JSON.stringify([paint,alpha]));return;}
                if(n!==node && n.attrs.transform)transformedSpan=true;
                for(const child of n.children)paintsIn(child,n.attrs.fill ?? paint,n.attrs['fill-opacity'] ?? alpha);
            }
            paintsIn(node,fill,fillOpacity);
            const refs=Array.from(paints,p=>/^url\(\s*['"]?#([^'"\s)]+)['"]?\s*\)$/.exec(JSON.parse(p)[0] || '')?.[1]);
            if(refs.some(id=>attributes(id)?.gradientUnits==='userSpaceOnUse')) {
                const label=packet?.layers.find(l=>l.marker===node.attrs.id)?.name || node.attrs.id || 'Gradient text';
                if(paints.size!==1 || transformedSpan || !matrix)warn(warnings,label+': check the gradient on this text.');
                else {
                    try {
                        const attrs=attributes(refs[0]);
                        const coordinate=(value,axis)=>{
                            if(/%$/.test(value))return number(value.slice(0,-1),'gradient percentage')/100*(vb.length===4?vb[axis+2]:number(root.attrs[axis?'height':'width'],'SVG viewport'));
                            return number(String(value).replace(/px$/,''),'gradient coordinate');
                        };
                        const x=coordinate(attrs.x1 ?? '0',0),y=coordinate(attrs.y1 ?? '0',1);
                        const dx=coordinate(attrs.x2 ?? '100%',0)-x,dy=coordinate(attrs.y2 ?? '0',1)-y;
                        if(Math.hypot(dx,dy)<1e-12)fail('the gradient has no length');
                        const gradientToSvg=multiplyAffine(svgTransform(attrs.gradientTransform),[dx,dy,-dy,dx,x,y]);
                        if(!node.attrs.id){let id;do{id='FigmaPasteGradientText'+(++serial);}while(ids.has(id));ids.add(id);node.attrs.id=id;}
                        plans.push({marker:node.attrs.id,name:label,svgToSpread:matrix,gradientToSpread:multiplyAffine(matrix,gradientToSvg)});
                    } catch(e){warn(warnings,label+': check the gradient on this text.');}
                }
            }
        }
        for(const child of node.children)visit(child,matrix,fill,fillOpacity,inDefs);
    }
    visit(root,initial,'black','1',false);
    return plans;
}

// Figma's SVG export drops layer blurs on mask shapes, though Figma renders
// them (a blurred mask ellipse gives a soft edge). Affinity imports SVG masks as
// pixel masks, so the blur goes back into the SVG mask where the loader bakes it in.
function bakeMaskBlurs(root,filters,packet) {
    const inMask=new Set(),ids=new Set();let serial=0,defs=null;
    walk(root,n=>{if(n.attrs.id)ids.add(n.attrs.id);if(n.tag==='mask')walk(n,c=>{if(c!==n)inMask.add(c);});});
    if(!packet)return inMask;
    const blurs=new Map();
    for(const layer of packet.layers) {
        const found=(layer.effects || []).filter(e=>e.type==='LAYER_BLUR' && e.visible!==false && (e.blurType || 'NORMAL')==='NORMAL' && Number.isFinite(e.radius) && e.radius>0);
        if(found.length===1)blurs.set(layer.marker,found[0].radius/2);
    }
    walk(root,mask=>{
        if(mask.tag!=='mask')return;
        const num=k=>Number(mask.attrs[k]);
        for(const shape of mask.children) {
            const sigma=shape.tag && blurs.get(shape.attrs.id);
            if(!sigma || shape.attrs.filter)continue;
            let id;do{id='FigmaPasteMaskBlur'+(++serial);}while(ids.has(id));ids.add(id);
            const filter={tag:'filter',attrs:{id,'color-interpolation-filters':'sRGB'},children:[{tag:'feGaussianBlur',attrs:{stdDeviation:String(sigma)},children:[]}]};
            // Grow the mask and filter regions by 3σ so the soft edge isn't cropped. The filter
            // region is relative to the shape's own box, which also holds for transformed shapes.
            const pad=3*sigma,a=shape.attrs,size=shape.tag==='rect' ? [Number(a.width),Number(a.height)] : shape.tag==='circle' ? [2*a.r,2*a.r] : shape.tag==='ellipse' ? [2*a.rx,2*a.ry] : null;
            const [fx,fy]=size && size.every(v=>v>0) ? size.map(v=>pad/v) : [.5,.5];
            Object.assign(filter.attrs,{x:String(-fx),y:String(-fy),width:String(1+2*fx),height:String(1+2*fy)});
            if(mask.attrs.maskUnits==='userSpaceOnUse' && ['x','y','width','height'].every(k=>Number.isFinite(num(k))))
                Object.assign(mask.attrs,{x:String(num('x')-pad),y:String(num('y')-pad),width:String(num('width')+2*pad),height:String(num('height')+2*pad)});
            if(!defs){defs=root.children.find(n=>n.tag==='defs');if(!defs){defs={tag:'defs',attrs:{},children:[]};root.children.push(defs);}}
            defs.children.push(filter);filters.set(id,filter);
            shape.attrs.filter='url(#'+id+')';
        }
    });
    return inMask;
}

// Affinity's SVG loader applies every mask by luminance and ignores
// mask-type:alpha. Figma's alpha masks are drawn in colours (#D9D9D9, or the
// layer's own colour), so they came through 45–85% transparent. Paint alpha-mask
// contents white, keeping their opacity, so luminance equals the intended alpha.
function alphaMasksAsLuminance(root,warnings,packet) {
    const ids=new Set(),gradients=new Map();let serial=0,defs=null;
    walk(root,n=>{if(n.attrs.id)ids.add(n.attrs.id);if(/Gradient$/.test(n.tag) && n.attrs.id)gradients.set(n.attrs.id,n);});
    const clone=n=>n.tag ? {tag:n.tag,attrs:{...n.attrs},children:n.children.map(clone)} : {...n};
    function whiteGradient(id) {
        const source=gradients.get(id),stops=source?.children.filter(c=>c.tag==='stop');
        if(!stops?.length)return null;
        const copy=clone(source);let newId;do{newId='FigmaPasteAlphaMask'+(++serial);}while(ids.has(newId));ids.add(newId);
        copy.attrs.id=newId;
        for(const stop of copy.children.filter(c=>c.tag==='stop')) {
            // Keep each stop's alpha, including any alpha carried in its colour.
            let alpha=Number(stop.attrs['stop-opacity'] ?? 1);
            try{alpha*=colour(stop.attrs['stop-color'] || 'black').opacity;}catch(e){}
            stop.attrs['stop-color']='white';stop.attrs['stop-opacity']=String(alpha);delete stop.attrs.style;
        }
        if(!defs){defs=root.children.find(c=>c.tag==='defs');if(!defs){defs={tag:'defs',attrs:{},children:[]};root.children.push(defs);}}
        defs.children.push(copy);
        return 'url(#'+newId+')';
    }
    function paint(n,key) {
        const value=n.attrs[key];
        if(value==null || value==='none')return;
        const ref=/^url\(\s*['"]?#([^'"\s)]+)['"]?\s*\)/.exec(value);
        if(ref){const white=whiteGradient(ref[1]);if(white)n.attrs[key]=white;return;}
        let alpha=1;try{alpha=colour(value).opacity;}catch(e){}
        n.attrs[key]='white';
        if(alpha!==1)n.attrs[key+'-opacity']=String(alpha*Number(n.attrs[key+'-opacity'] ?? 1));
    }
    walk(root,mask=>{
        if(mask.tag!=='mask' || !/mask-type\s*:\s*alpha/i.test(mask.attrs.style || '') && mask.attrs['mask-type']!=='alpha')return;
        mask.attrs.fill='white'; // unfilled shapes would otherwise default to black
        walk(mask,n=>{
            if(n===mask)return;
            if(n.tag==='image')warn(warnings,layerName(packet,n.attrs.id)+': an image used as a mask may look lighter or darker. Check it in Affinity.');
            paint(n,'fill');paint(n,'stroke');
        });
    });
}

// Figma exports inside/outside strokes as a double-width centre stroke, clipped to
// the shape (inside) or masked by "everything but the shape" (outside). Affinity's
// SVG loader ignores that mask, drawing the full double width. Rebuild them as
// native half-width Inside/Outside strokes instead.
function planStrokeAlignment(root) {
    const byId=new Map(),ids=new Set(),plans=[];let serial=0;
    walk(root,n=>{if(n.attrs.id){byId.set(n.attrs.id,n);ids.add(n.attrs.id);}});
    const ref=v=>/^url\(\s*['"]?#([^'"\s)]+)['"]?\s*\)$/.exec(v || '')?.[1];
    const geometry=['d','x','y','width','height','rx','ry','cx','cy','r','transform'];
    const same=(a,b)=>a?.tag===b?.tag && geometry.every(k=>(a.attrs[k] ?? '')===(b.attrs[k] ?? ''));
    const drawn=n=>n.children.filter(c=>c.tag && !['title','desc'].includes(c.tag));
    const black=(n,inherited)=>['black','#000','#000000'].includes(String(n.attrs.fill ?? inherited ?? 'black').toLowerCase());
    walk(root,n=>{
        const width=Number(n.attrs['stroke-width'] ?? 1);
        if(!['path','rect','circle','ellipse'].includes(n.tag) || !n.attrs.stroke || n.attrs.stroke==='none' || !(width>0))return;
        let alignment=null;
        const mask=byId.get(ref(n.attrs.mask)),clip=byId.get(ref(n.attrs['clip-path']));
        if(mask?.tag==='mask' && !n.attrs['clip-path']) {
            const [cover,shape]=drawn(mask);
            const white=(e,inherited)=>['white','#fff','#ffffff'].includes(String(e?.attrs.fill ?? inherited ?? 'black').toLowerCase());
            if(drawn(mask).length===2 && cover.tag==='rect' && white(cover) && same(shape,n) && black(shape,mask.attrs.fill))alignment='Outside';
            // Figma's inside stroke as a mask: just the shape itself, in white.
            else if(drawn(mask).length===1 && same(cover,n) && white(cover,mask.attrs.fill))alignment='Inside';
        } else if(clip?.tag==='clipPath' && !n.attrs.mask && drawn(clip).length===1 && same(drawn(clip)[0],n))alignment='Inside';
        if(!alignment)return;
        delete n.attrs[n.attrs.mask ? 'mask' : 'clip-path'];
        n.attrs['stroke-width']=String(width/2);
        if(!n.attrs.id){let id;do{id='FigmaPasteStroke'+(++serial);}while(ids.has(id));ids.add(id);n.attrs.id=id;}
        plans.push({marker:n.attrs.id,alignment});
    });
    return plans;
}

function restoreStrokeAlignment(doc,plans,packet,warnings) {
    if(!plans.length)return;
    const {StrokeAlignment}=require('/commands.js');
    const index=indexLayersByName(doc.layers.all.toArray());
    for(const plan of plans) {
        const matches=index.get(plan.marker) || [];
        try{if(matches.length!==1)fail('not found');doc.setStrokeAlignment(StrokeAlignment[plan.alignment],matches[0]);}
        catch(e){warn(warnings,layerName(packet,plan.marker)+': set this stroke to '+plan.alignment.toLowerCase()+' in Affinity.');}
    }
}

function prepareSvg(svg, warnings, repairBlur, packet) {
    const root = parseXml(svg), filters = new Map(), effects = [];
    const {angular:angularGradients,backdrops}=omitFigmaBackdropHelpers(root,warnings,packet);
    promoteInlineStyles(root);
    alphaMasksAsLuminance(root,warnings,packet);
    const strokeAlignments=planStrokeAlignment(root);
    let texts=[];
    const textTargets=new Map();
    if (packet) {
        const vb=(root.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
        const width=vb.length===4 ? vb[2] : parseFloat(root.attrs.width), height=vb.length===4 ? vb[3] : parseFloat(root.attrs.height);
        const matchingFrame=Math.abs(width-packet.frame.width)<1 && Math.abs(height-packet.frame.height)<1 && (vb.length!==4 || (vb[0]===0 && vb[1]===0));
        if(packet.artboards && !matchingFrame)fail('The SVG bounds do not match the artboard layout. Export the frames again.');
        for (const text of packet.texts) {
            let issue=matchingFrame ? textRebuildIssue(text) : 'SVG bounds differ from the Figma frame';
            const matches=[]; walk(root,n=>{if(n.attrs.id===text.marker) matches.push(n);});
            if (matches.length!==1) issue='the text layer could not be uniquely matched';
            if (!issue) {
                let target=matches[0];
                let unsafe=false;
                walk(target,n=>{if(n.attrs['clip-path'] || n.attrs.mask || /mix-blend-mode\s*:\s*(?!normal)/i.test(n.attrs.style || '')) unsafe=true;});
                if (unsafe) continue;
                // Keep a stable identifier even when Affinity collapses a one-child group.
                while (target.tag==='g') {
                    const visible=target.children.filter(n=>n.tag && !['defs','title','desc'].includes(n.tag));
                    if (visible.length!==1 || !['g','text'].includes(visible[0].tag) || target.attrs.opacity || target.attrs.filter) break;
                    delete target.attrs.id; target=visible[0]; target.attrs.id=text.marker;
                }
                let hasText=false, onlyText=true;
                walk(target,n=>{if(n.tag==='text') hasText=true;if(!['g','text','tspan','title','desc'].includes(n.tag)) onlyText=false;});
                if (hasText && onlyText) { texts.push(text); textTargets.set(text.marker,target); } else issue='the SVG text contains additional artwork';
            }
            // ponytail: no warning for `issue`; the SVG text fallback still imports as editable text.
        }
    }
    const scaled = new Set(), rotated = new Set();
    function trackScale(n, inherited, inheritedRotation) {
        if (!n.tag) return;
        // Rotations and flips at 100% keep blur radii exact; only real scale or skew needs manual conversion.
        let m = null; try { m = svgTransform(n.attrs.transform); } catch (e) {}
        const rigid = !!m && Math.abs(m[0]*m[0]+m[1]*m[1]-1) < 5e-3 && Math.abs(m[2]*m[2]+m[3]*m[3]-1) < 5e-3 && Math.abs(m[0]*m[2]+m[1]*m[3]) < 5e-3;
        const hasScale = inherited || !rigid;
        const hasRotation = inheritedRotation || (rigid && (Math.abs(m[1]) > 1e-9 || m[0] < 0 || m[3] < 0));
        if (hasScale) scaled.add(n);
        if (hasRotation) rotated.add(n);
        n.children.forEach(child => trackScale(child, hasScale, hasRotation));
    }
    const vb = (root.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
    const rootScale = vb.length === 4 && ((root.attrs.width && parseFloat(root.attrs.width) !== vb[2]) || (root.attrs.height && parseFloat(root.attrs.height) !== vb[3]));
    trackScale(root, rootScale);
    walk(root, n => {
        const localTag=n.tag.split(':').pop();
        if (/^(script|foreignObject|animate|animateTransform|set)$/i.test(localTag)) fail('Active SVG content is not supported: ' + n.tag);
        if (localTag.toLowerCase() === 'style') fail('SVG style sheets are not supported yet. Export SVG with presentation attributes.');
        for (const [key, value] of Object.entries(n.attrs)) {
            if (/^on/i.test(key)) fail('SVG event handlers are not supported.');
            if (/(?:^|:)href$/.test(key) && !/^#/.test(value) && !/^data:image\/(png|jpeg|webp);base64,[a-z\d+/=\s]+$/i.test(value)) fail('SVG references an external asset. Embed the image in Figma before copying.');
            const urls = value.match(/url\([^)]*\)/gi) || [];
            for (const url of urls) {
                const target = url.slice(4, -1).trim().replace(/^(['"])(.*)\1$/, '$2');
                if (!/^#[^\s]+$/.test(target)) fail('Only internal SVG url(#id) references are supported.');
            }
        }
        if (n.tag === 'filter' && n.attrs.id) filters.set(n.attrs.id, n);
    });
    const images=prepareImages(root,warnings,packet);
    const inMask=bakeMaskBlurs(root,filters,packet);
    let serial = 0;
    const clipPaths=new Map(),progressiveBlurs=[];walk(root,c=>{if(c.tag==='clipPath' && c.attrs.id)clipPaths.set(c.attrs.id,c);});
    const drawn=c=>c.tag && !['title','desc','defs','mask','clipPath'].includes(c.tag);
    const drawable=n=>{let found=false;walk(n,c=>{if(['path','rect','circle','ellipse','line','polyline','polygon','text','image','use'].includes(c.tag))found=true;});return found;};
    const opaqueShape=c=>['rect','path','circle','ellipse'].includes(c?.tag) && !c.attrs.transform && !c.attrs.filter && !c.attrs.mask && !c.attrs['clip-path']
        && (c.attrs.opacity==null || Number(c.attrs.opacity)===1) && (c.attrs['fill-opacity']==null || Number(c.attrs['fill-opacity'])===1)
        && c.attrs.fill && c.attrs.fill!=='none' && !/^url\(/.test(c.attrs.fill) && (()=>{try{return colour(c.attrs.fill).opacity===1;}catch(e){return false;}})();
    const sameShape=(a,b)=>a.tag===b.tag && ['d','x','y','width','height','rx','ry','cx','cy','r'].every(k=>(a.attrs[k] ?? '')===(b.attrs[k] ?? ''));
    // The shadow-casting silhouette, when it is one known opaque shape: a lone shape, or
    // a Figma frame whose clipped content starts with a background matching its clip.
    function outerSilhouette(n) {
        const kids=n.children.filter(drawn);
        if(kids.length===1 && opaqueShape(kids[0]))return kids[0];
        const clip=kids.length===1 && kids[0].tag==='g' && !kids[0].attrs.transform && clipPaths.get(/^url\(#([^)]+)\)$/.exec(kids[0].attrs['clip-path'] || '')?.[1]);
        const clipShape=clip && clip.children.filter(drawn),first=clip && kids[0].children.filter(drawn)[0];
        return clipShape?.length===1 && opaqueShape(first) && sameShape(first,clipShape[0]) ? first : null;
    }
    function insetShape(shape,d) {
        const a=shape.attrs,num=(k,f=0)=>a[k]==null ? f : Number(a[k]);
        if(shape.tag==='rect') {
            const w=num('width'),h=num('height');if(!(w>2*d && h>2*d))return null;
            const rx=Math.max(0,num('rx',num('ry'))-d),ry=Math.max(0,num('ry',num('rx'))-d);
            return {tag:'rect',attrs:{x:String(num('x')+d),y:String(num('y')+d),width:String(w-2*d),height:String(h-2*d),...(rx||ry ? {rx:String(rx),ry:String(ry)} : {})},children:[]};
        }
        if(shape.tag==='circle' || shape.tag==='ellipse') {
            const rx=shape.tag==='circle' ? num('r') : num('rx'),ry=shape.tag==='circle' ? num('r') : num('ry');if(!(rx>d && ry>d))return null;
            return {tag:'ellipse',attrs:{cx:String(num('cx')),cy:String(num('cy')),rx:String(rx-d),ry:String(ry-d)},children:[]};
        }
        // ponytail: other paths scale inward about their centre; close to erosion once blurred, not exact for concave shapes.
        const [x,y,w,h]=pathBox(a.d || '');if(!(w>2*d && h>2*d))return null;
        const cx=x+w/2,cy=y+h/2;
        return {tag:'path',attrs:{d:a.d,...(a['fill-rule'] ? {'fill-rule':a['fill-rule']} : {}),transform:'translate('+cx+' '+cy+') scale('+(w-2*d)/w+' '+(h-2*d)/h+') translate('+(-cx)+' '+(-cy)+')'},children:[]};
    }
    walk(root, n => {
        if (inMask.has(n)) return; // Affinity rasterises masks, so SVG filters inside them are baked in.
        if (n.attrs.filter && !drawable(n)) { delete n.attrs.filter; return; } // an empty layer casts nothing
        const ref = /^url\(\s*['"]?#([^'"\s)]+)['"]?\s*\)$/.exec(n.attrs.filter || '');
        if (!ref) {
            if (n.attrs.style && /filter\s*:/.test(n.attrs.style)) warn(warnings, layerName(packet,n.attrs.id)+': an effect couldn’t be converted. Check it in Affinity.');
            return;
        }
        const f = filters.get(ref[1]);
        const lost = layerName(packet,n.attrs.id)+': an effect couldn’t be converted. Check it in Affinity.';
        if (!f) { warn(warnings, lost); return; }
        if (!repairBlur || scaled.has(n) || (f.attrs.primitiveUnits && f.attrs.primitiveUnits !== 'userSpaceOnUse')) {
            warn(warnings, lost); return;
        }
        let plan;
        try { plan = nativeFilterPlan(f); }
        catch (e) { warn(warnings, lost); return; }
        if (!plan.length) return;
        // Figma's inspector radius is twice its SVG stdDeviation. Prefer the
        // original inspector value when the companion supplies it, and avoid
        // halving SVG/CSS standard deviation for a second time.
        const layer=packet && packet.layers.find(layer=>layer.marker===n.attrs.id);
        const figmaBlurs=layer && Array.isArray(layer.effects) ? layer.effects.filter(e=>e.type==='LAYER_BLUR' && e.visible!==false) : [];
        if(figmaBlurs.length===1 && Number.isFinite(figmaBlurs[0].radius) && figmaBlurs[0].radius>=0){
            const blur=plan.find(e=>e.kind==='blur');if(blur)blur.figmaRadius=figmaBlurs[0].radius;
        }
        // Figma's SVG export flattens a progressive blur to one uniform blur at its end
        // radius. Leave it out of the layer effects; a live filter with a transparency
        // gradient rebuilds the fade after import.
        const point=v=>Number.isFinite(v?.x) && Number.isFinite(v?.y);
        const progressive=figmaBlurs.length===1 && figmaBlurs[0].blurType==='PROGRESSIVE' && figmaBlurs[0].radius>0 && point(figmaBlurs[0].startOffset) && point(figmaBlurs[0].endOffset) ? figmaBlurs[0] : null;
        if(progressive)plan=plan.filter(e=>e.kind!=='blur');
        // Rename the target, not a disposable one-child group: Affinity flattens those groups.
        let target = n;
        while (target.tag === 'g' && textTargets.get(target.attrs.id)!==target && !target.attrs['data-figma-image-fill']) {
            const visible = target.children.filter(c => c.tag && !['title','desc','defs'].includes(c.tag));
            if (visible.length !== 1 || visible[0].attrs.filter) break;
            target = visible[0];
        }
        // Affinity draws effects in page space, so only the filtered node's own space matters,
        // not transforms on the shapes inside it (verified with scaled and skewed children).
        if (rotated.has(n) && plan.some(e => e.kind !== 'blur')) { warn(warnings, lost); return; }
        const visible=n.tag==='g' ? n.children.filter(c=>c.tag && !['title','desc','defs'].includes(c.tag)) : [];
        const silhouette=visible[0];
        // Recognize a background rectangle followed by label text (Figma buttons).
        let button=!!silhouette && visible.length>1;
        for(const child of visible.slice(1))walk(child,c=>{
            if(!['g','text','tspan'].includes(c.tag) || c.attrs.transform || c.attrs.filter)button=false;
        });
        if(button)plan=plan.filter(effect=>{
            if(effect.kind!=='innerShadow' || !(effect.spread<0))return true;
            const geometry=innerSpreadGeometry(silhouette,effect.spread,effect.dx,effect.dy,effect.sigma);
            if(!geometry)return true;
            let helper;do{helper='FigmaPasteInnerSpread'+(++serial);}while(svg.includes(helper));
            const clip=helper+'Clip',rgb=effect.rgb.map(c=>Math.round(c*255));
            n.children.push({tag:'defs',attrs:{},children:[{tag:'clipPath',attrs:{id:clip,clipPathUnits:'userSpaceOnUse'},children:[geometry.clip]}]},
                {tag:'g',attrs:{'clip-path':'url(#'+clip+')'},children:[{tag:'path',attrs:{id:helper,d:geometry.d,'fill-rule':'evenodd',fill:'rgb('+rgb.join(',')+')','fill-opacity':String(effect.opacity)},children:[]}]});
            effects.push({marker:helper,name:'Inner shadow (spread '+effect.spread+' px)',native:[{kind:'blur',sigma:effect.sigma,countAs:'innerShadow'}]});
            target=n;
            return false;
        });
        // Negative drop-shadow spread erodes the silhouette before blurring. Affinity's
        // intensity can only grow a shadow, so draw the eroded silhouette as a blurred
        // vector behind the layer instead: exact for rectangles and ellipses.
        if(plan.length===1 && plan[0].kind==='outerShadow' && plan[0].spread<0 && !plan[0].knocksOut) {
            const effect=plan[0],shape=outerSilhouette(n),inset=shape && insetShape(shape,-effect.spread);
            if(inset) {
                let helper;do{helper='FigmaPasteOuterSpread'+(++serial);}while(svg.includes(helper));
                Object.assign(inset.attrs,{id:helper,fill:'rgb('+effect.rgb.map(c=>Math.round(c*255)).join(',')+')','fill-opacity':String(effect.opacity),
                    transform:'translate('+effect.dx+' '+effect.dy+')'+(inset.attrs.transform ? ' '+inset.attrs.transform : '')});
                n.children.unshift(inset);
                effects.push({marker:helper,name:'Drop shadow (spread '+effect.spread+' px)',native:[{kind:'blur',sigma:effect.sigma,countAs:'outerShadow'}]});
                plan=[];target=n;
            }
        }
        // Affinity's intensity can only grow a shadow; negative spread would need the silhouette shrunk first.
        if(plan.some(e=>e.spread<0))warn(warnings,layerName(packet,n.attrs.id)+': negative shadow spread isn’t supported. Adjust the shadow in Affinity.');
        let marker = target.attrs.id;
        if (!marker) do { marker = 'FigmaPasteBlur' + (++serial); } while (svg.includes(marker));
        const name = n.attrs.id || target.attrs.id || (target.tag === 'ellipse' ? 'Blurred ellipse' : 'Blurred ' + target.tag);
        target.attrs.id = marker;
        delete n.attrs.filter;
        if(plan.length)effects.push({marker, name, sigma: plan[0].sigma, native: plan});
        if(progressive) {
            // Affinity draws layer effects after a layer's child filters, so a filter inside the
            // layer would leave its inner shadows sharp. Wrap the layer and blur the wrapper instead.
            let parent=null;walk(root,p=>{if(!parent && p.children.includes(target))parent=p;});
            let wrapper;do{wrapper='FigmaPasteProgressive'+(++serial);}while(svg.includes(wrapper));
            if(parent)parent.children[parent.children.indexOf(target)]={tag:'g',attrs:{id:wrapper},children:[target]};
            const frame=layer?.width>0 && layer?.height>0 && Array.isArray(layer.transform) && layer.transform.length===6 && layer.transform.every(Number.isFinite) ? {width:layer.width,height:layer.height,transform:layer.transform} : null;
            progressiveBlurs.push({marker,wrapper:parent ? wrapper : marker,frame,name:layerName(packet,n.attrs.id),radius:progressive.radius,startRadius:Math.max(0,Math.min(progressive.radius,progressive.startRadius || 0)),
                start:[progressive.startOffset.x,progressive.startOffset.y],end:[progressive.endOffset.x,progressive.endOffset.y]});
        }
    });
    texts=texts.filter(text=>{
        let delegated=false;
        const target=textTargets.get(text.marker);
        walk(target,n=>{if(n.attrs.filter || /filter\s*:/.test(n.attrs.style || '')) delegated=true;});
        const childEffects=[];
        walk(target,n=>{if(n!==target && effects.some(e=>e.marker===n.attrs.id)) childEffects.push(n);});
        if (childEffects.length) delegated=true;
        if (!delegated) {
            let node=target;
            while(node.tag==='g' && !node.attrs.opacity) {
                const children=node.children.filter(n=>n.tag && !['defs','title','desc'].includes(n.tag));
                if(children.length!==1 || !['g','text'].includes(children[0].tag)) break;
                delete node.attrs.id; node=children[0]; node.attrs.id=text.marker;
            }
        }
        return !delegated;
    });
    const linearTextGradients=planLinearTextGradients(root,warnings,packet);
    const textTracking=planTextTracking(root),textFonts=planTextFonts(root);
    const artboards=packet?.artboards ? prepareArtboards(root,packet.artboards) : [];
    return {svg: xml(root), effects, texts, artboards, linearTextGradients, angularGradients, backdrops, progressiveBlurs, textTracking, textFonts, strokeAlignments, ...images};
}

// Keep a stable outer group even for empty frames and frames containing one
// object. Bounds anchors are transparent and removed after native artboard creation.
function prepareArtboards(root,boards) {
    const byId=new Map(),parents=new Map();
    function index(node,parent) {
        if(node.attrs?.id) {
            const items=byId.get(node.attrs.id) || [];items.push(node);byId.set(node.attrs.id,items);
        }
        if(parent)parents.set(node,parent);
        for(const child of node.children || [])index(child,node);
    }
    index(root,null);
    return boards.map((board,i)=>{
        const matches=byId.get(board.marker) || [],members=new Set(board.layerMarkers);
        if(matches.length>1 || matches[0]===root)fail('Could not uniquely identify artboard '+board.name+'.');
        const target=matches[0];
        if(!target && board.layerMarkers.some(marker=>byId.has(marker)))fail('Could not identify the frame around '+board.name+'.');
        if(target)for(const marker of board.layerMarkers)for(const node of byId.get(marker) || []) {
            let parent=node;while(parent && parent!==target)parent=parents.get(parent);
            if(!parent)fail('A layer lies outside its artboard: '+board.name+'.');
        }
        if(target)walk(target,n=>{if(/^FP_\d+$/.test(n.attrs.id || '') && !members.has(n.attrs.id))fail('Artboards contain overlapping layer records.');});
        const containerMarker='FPAB_'+(i+1),anchorMarker='FPAB_BOUNDS_'+(i+1);
        if(byId.has(containerMarker) || byId.has(anchorMarker))fail('The SVG contains reserved artboard identifiers.');
        const anchor={tag:'rect',attrs:{id:anchorMarker,x:String(board.x),y:String(board.y),width:String(board.width),height:String(board.height),fill:'#000000','fill-opacity':'0'},children:[]};
        const wrapper={tag:'g',attrs:{id:containerMarker},children:target ? [anchor,target] : [anchor]};
        if(target) {
            const parent=parents.get(target);parent.children[parent.children.indexOf(target)]=wrapper;
        } else root.children.push(wrapper);
        return {...board,containerMarker,anchorMarker};
    });
}

function compile(source, options) {
    options = options || {};
    source = String(source || '').trim().replace(/^\uFEFF/, '');
    if (!source) fail('Nothing to import.');
    const packet=source.startsWith('{') ? readTransfer(source) : null;
    if (!packet && !source.startsWith('<')) fail('Expected a Send to Affinity transfer or SVG.');
    const type = packet ? 'Figma transfer' : 'SVG';
    const result = {svg: packet ? packet.svg : source, warnings: packet ? packet.warnings.slice() : []};
    const prepared = prepareSvg(result.svg, result.warnings, options.repairBlur !== false,packet);
    return Object.assign(result, prepared, {type,packet});
}

function workingFolder(roots, fileSystemAllowed) {
    if (!fileSystemAllowed) fail('Affinity needs file access to save images. In Affinity, go to **Settings** → **Model Context Protocol**, turn on *Access Files on your Desktop*, then send again.');
    const allowed = (roots || []).filter(root => typeof root === 'string' && root.trim());
    if (!allowed.length) fail('Affinity has no folder it can save images to. In Affinity, go to **Settings** → **Model Context Protocol**, turn on *Access Files on your Desktop*, then send again.');
    const root = allowed.find(path => /(?:^|[\\/])Figma Paste Sources[\\/]*$/.test(path)) || allowed[0];
    return root.trim().replace(/[\\/]+$/, '') || '/';
}

function nativeStep(label, folder, operation) {
    try { return operation(); }
    catch (e) {
        const message = e.message || String(e);
        if (/PERMISSION_DENIED|permission denied/i.test(message)) {
            fail('Affinity denied file access while ' + label + '.\n\nWorking folder: ' + folder + '\n\nIn Affinity, go to **Settings** → **Model Context Protocol**, turn on *Access Files on your Desktop*, then send again.');
        }
        fail('Could not complete ' + label + ': ' + message);
    }
}

function indexLayersByName(nodes) {
    const index=new Map();
    for(const node of nodes) {
        // Each native getter crosses the SDK boundary. Read each name once,
        // while retaining duplicate matches so ambiguous imports still fail.
        for(const name of new Set([node.userDescription,node.description])) {
            if(!name)continue;
            if(!index.has(name))index.set(name,[]);
            index.get(name).push(node);
        }
    }
    return index;
}

// Affinity places a frame's first baseline by its own ascent rule, which can sit
// well above Figma's (0.42 em for Canva Sans). The SVG text is on Figma's exact
// baseline, so while both exist, shift the frame along its own y axis until their
// glyph ink lines up. Only when the ink boxes match in size, i.e. the same layout.
function alignFirstBaseline(doc,created,original,m) {
    const {Transform}=require('/geometry.js');
    const {DocumentCommand}=require('/commands.js');
    const {Selection}=require('/selections.js');
    const a=created.getExactSpreadVisibleBox(),b=original.getExactSpreadVisibleBox();
    if(![a,b].every(r=>r && [r.x,r.y,r.width,r.height].every(Number.isFinite)) || Math.abs(a.width-b.width)>1 || Math.abs(a.height-b.height)>1)return;
    const [,,c,d]=m,len2=c*c+d*d,k=((b.x-a.x)*c+(b.y-a.y)*d)/len2;
    if(!(len2>0) || Math.abs(k)*Math.sqrt(len2)<0.01)return;
    doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc,created),Transform.createTranslate(k*c,k*d),{}));
}

function rebuildTextFrames(doc, specs, warnings) {
    if (!specs.length) return 0;
    const {StoryBuilder}=require('/storybuilder.js');
    const {Font,FontFamily,FontWeight,FontWidth}=require('/fonts.js');
    const {ParagraphAlignXType,ParagraphLeadingType}=require('/paragraphatts.js');
    const {TypographicLineType}=require('/glyphatts.js');
    const {FillDescriptor}=require('/fills.js');
    const {RGBAuf}=require('/colours.js');
    const {FrameTextNodeDefinition,NodeChildType}=require('/nodes.js');
    const {Rectangle,Transform}=require('/geometry.js');
    const {AddChildNodesCommandBuilder,DocumentCommand,NodeMoveType}=require('/commands.js');
    const families=new Map(FontFamily.all.map(f=>[f.name.toLowerCase(),f]));
    const fonts=new Map();
    function fontFor(run) {
        const name=run.fontName, key=name.family+'\n'+name.style+'\n'+run.fontWeight;
        if (fonts.has(key)) return fonts.get(key);
        const family=families.get(name.family.toLowerCase());
        if (!family) fail('Font “'+name.family+'” is not installed.');
        const normalize=s=>s.toLowerCase().replace(/[\s-]/g,'');
        let font=family.fonts.find(f=>normalize(f.traitsName)===normalize(name.style));
        if (!font) {
            const weight=Number.isFinite(run.fontWeight) ? run.fontWeight : /bold/i.test(name.style) ? 700 : 400;
            const enumWeight=FontWeight.keys.map(k=>FontWeight[k]).sort((a,b)=>Math.abs(a.value-weight)-Math.abs(b.value-weight))[0];
            font=Font.create(name.family,enumWeight,/italic|oblique/i.test(name.style),FontWidth.Normal);
            warn(warnings,'“'+name.family+' '+name.style+'” isn’t installed in Affinity, so the closest style was used.');
        }
        fonts.set(key,font); return font;
    }
    const originals=indexLayersByName(doc.layers.all.toArray());
    let rebuilt=0;
    for (const text of specs) {
        let created=null;
        try {
            const original=originals.get(text.marker) || [];
            if (original.length!==1) fail('The imported layer could not be uniquely matched.');
            const sb=StoryBuilder.create().setToFrameTextDefaultStyle(doc.dpi,doc.rasterFormat);
            const defaultGlyph=sb.glyphAtts.clone(), defaultParagraph=sb.paragraphAtts.clone();
            for (const run of text.runs) {
                const glyph=defaultGlyph.clone(), paragraph=defaultParagraph.clone();
                glyph.font=fontFor(run); glyph.height=run.fontSize;
                const paint=run.fills.filter(p=>p.visible!==false)[0];
                glyph.brushFill=FillDescriptor.createSolid(RGBAuf(paint.color.r,paint.color.g,paint.color.b,paint.opacity == null ? 1 : paint.opacity));
                glyph.underlineType=run.textDecoration==='UNDERLINE' ? TypographicLineType.Single : TypographicLineType.None;
                glyph.strikeoutType=run.textDecoration==='STRIKETHROUGH' ? TypographicLineType.Single : TypographicLineType.None;
                glyph.characterSpacing=run.letterSpacing ? run.letterSpacing.unit==='PERCENT' ? run.letterSpacing.value/100 : run.letterSpacing.value/run.fontSize : 0;
                paragraph.alignXType=({LEFT:ParagraphAlignXType.Left,CENTER:ParagraphAlignXType.Centre,RIGHT:ParagraphAlignXType.Right,JUSTIFIED:ParagraphAlignXType.JustifyLeft})[text.textAlignHorizontal];
                paragraph.isAutoHyphenate=false; paragraph.spaceBefore=0; paragraph.spaceAfter=Number.isFinite(run.paragraphSpacing) ? run.paragraphSpacing : 0;
                if (run.lineHeight && run.lineHeight.unit==='PIXELS') {
                    paragraph.leadingType=ParagraphLeadingType.ExactlyAbsolute; paragraph.absoluteLeading=run.lineHeight.value;
                } else if (run.lineHeight && run.lineHeight.unit==='PERCENT') {
                    paragraph.leadingType=ParagraphLeadingType.RelativeToHeight; paragraph.relativeLeading=run.lineHeight.value/100;
                }
                sb.setGlyphAtts(glyph); sb.setParagraphAtts(paragraph);
                run.characters.split('\n').forEach((line,i)=>{if(i) sb.addParagraphBreak(); if(line) sb.addText(line);});
            }
            const definition=FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(0,0,text.width,text.height),sb);
            const transform=new Transform(), m=text.transform;
            [m[0],m[2],m[4],m[1],m[3],m[5]].forEach((v,i)=>{transform.data[i]=v;});
            definition.transform=transform; definition.userDescription=text.marker;
            const builder=AddChildNodesCommandBuilder.create(); builder.setInsertionTarget(doc.currentSpread); builder.addNode(definition);
            const command=builder.createCommand(); doc.executeCommand(command); created=command.newNodes[0];
            if (!created || !created.isTextNode || created.text!==text.characters) fail('Affinity did not retain the complete editable text.');
            doc.executeCommand(DocumentCommand.createMoveNodes(created.selfSelection,original[0],NodeMoveType.Before,NodeChildType.Main));
            alignFirstBaseline(doc,created,original[0],text.transform);
            if (typeof text.opacity==='number' && text.opacity!==1) doc.setOpacity(text.opacity,created);
            // Keep SVG artwork until its replacement is complete and verified.
            original[0].delete(); rebuilt++; created=null;
        } catch (e) {
            // ponytail: silent; the original SVG text stays and is still editable.
            if (created) { try {created.delete();} catch(ignore) {} }
        }
    }
    return rebuilt;
}

function restoreLinearTextGradients(doc,specs,warnings) {
    if(!specs.length)return 0;
    const {FillType,GradientFillType}=require('/fills.js');
    const {Transform}=require('/geometry.js');
    const index=indexLayersByName(doc.layers.all.toArray());let restored=0;
    for(const spec of specs) {
        try {
            const matches=index.get(spec.marker) || [];
            if(matches.length!==1)fail('could not uniquely identify the imported text');
            const texts=[];
            function visit(n){if(n.isTextNode)texts.push(n);else for(const c of n.children.toArray())visit(c);}
            visit(matches[0]);
            if(!texts.length)fail('the imported layer contains no editable text');
            const world=new Transform(),m=spec.gradientToSpread;
            [m[0],m[2],m[4],m[1],m[3],m[5]].forEach((v,i)=>{world.data[i]=v;});
            for(const text of texts) {
                if(!text.text)continue;
                const old=text.story.getGlyphAtts(text.storyRange.begin).brushFill;
                if(old.fillType.value!==FillType.Gradient.value || (old.fill.gradientFillType.value ?? old.fill.gradientFillType)!==GradientFillType.Linear.value)fail('Affinity did not retain the linear gradient');
                const transform=text.baseToSpreadTransform.inverted.multiply(world);
                const fill=old.cloneWithNewTransformInfo(transform,false);
                doc.setBrushFillDescriptor(fill,text);
                const applied=text.story.getGlyphAtts(text.storyRange.begin).brushFill;
                if(applied.fillType.value!==FillType.Gradient.value || Array.from(applied.transform.data).some((v,i)=>Math.abs(v-transform.data[i])>0.001))fail('Affinity changed the gradient coordinates');
                restored++;
            }
        } catch(e){warn(warnings,spec.name+': check the gradient on this text.');}
    }
    return restored;
}

function restoreAngularGradients(doc,specs,warnings) {
    if(!specs.length)return 0;
    const {GradientFill,GradientFillType,FillDescriptor,BlendMode}=require('/fills.js');
    const {Gradient,Colour}=require('/colours.js');
    const {Transform}=require('/geometry.js');
    const index=indexLayersByName(doc.layers.all.toArray());let restored=0;
    for(const spec of specs) {
        try {
            const matches=index.get(spec.marker) || [];
            if(matches.length!==1)fail('could not uniquely identify the imported layer');
            const gradient=Gradient.create(spec.stops.map(s=>{const [r,g,b,alpha]=s.rgba.map(v=>Math.round(v*255));return {colour:Colour.createRGBA8({r,g,b,alpha}),position:s.position,midpoint:.5,smoothness:0};}));
            // Figma's angular centre is the middle of its unit square; Affinity's conical centre is the origin.
            const world=new Transform(),m=multiplyAffine(spec.gradientToSpread,[1,0,0,1,.5,.5]);
            [m[0],m[2],m[4],m[1],m[3],m[5]].forEach((v,i)=>{world.data[i]=v;});
            const transform=matches[0].baseToSpreadTransform.inverted.multiply(world);
            doc.setBrushFillDescriptor(FillDescriptor.create(GradientFill.create(gradient,GradientFillType.Conical),true,transform,BlendMode.Normal,false),matches[0]);
            restored++;
        } catch(e){warn(warnings,spec.name+': check the angular gradient on this layer.');}
    }
    return restored;
}

function restoreImageTiles(doc,tiles,assets,assetFolder,packet,warnings) {
    if(!tiles.length)return 0;
    const {BitmapFill,FillDescriptor,BlendMode,RasterExtendType,RasterResamplerType}=require('/fills.js');
    const {Bitmap}=require('/rasterobject.js');
    const {Transform}=require('/geometry.js');
    const index=indexLayersByName(doc.layers.all.toArray()),bitmaps=new Map();let restored=0;
    for(const spec of tiles) {
        try {
            const matches=index.get(spec.marker) || [],asset=assets.find(a=>a.token===spec.token);
            if(matches.length!==1 || !asset || !assetFolder)fail('could not identify the imported layer');
            if(!bitmaps.has(asset.token))bitmaps.set(asset.token,Bitmap.loadFromFile(assetFolder+'/'+asset.filename));
            // Affinity's Repeat stretches edge pixels; Wrap is what tiles.
            const fill=BitmapFill.create(bitmaps.get(asset.token),RasterExtendType.Wrap,RasterResamplerType.Default,false);
            const world=new Transform(),m=spec.fillToSpread;
            [m[0],m[2],m[4],m[1],m[3],m[5]].forEach((v,i)=>{world.data[i]=v;});
            doc.setBrushFillDescriptor(FillDescriptor.create(fill,true,matches[0].baseToSpreadTransform.inverted.multiply(world),BlendMode.Normal,false),matches[0]);
            if(spec.opacity!=null && spec.opacity!==1)doc.setOpacity(spec.opacity,matches[0]);
            restored++;
        } catch(e){warn(warnings,layerName(packet,spec.marker)+': the tiled image fill couldn’t be applied. Add it in Affinity.');}
    }
    return restored;
}

// Progressive blur: a tilt-shift Depth of Field live filter nested at the top of the
// layer, so it blurs only that layer: sharp at Figma's start point, reaching the full
// radius at its end point. Its radius equals Figma's (both are 2σ, checked against the
// Gaussian live filter). Figma's offsets are fractions of the layer's own bounds.
function restoreProgressiveBlurs(doc,specs,warnings) {
    if(!specs.length)return;
    const {DepthOfFieldFilterParameters,DepthOfFieldFilterRasterNodeDefinition}=require('/nodes.js');
    const {AddChildNodesCommandBuilder,InsertionMode}=require('/commands.js');
    const index=indexLayersByName(doc.layers.all.toArray());
    const apply=(m,[x,y])=>[m[0]*x+m[1]*y+m[2],m[3]*x+m[4]*y+m[5]]; // Transform.data is [a,c,e,b,d,f]
    const invert=m=>{const det=m[0]*m[4]-m[1]*m[3];return [m[4]/det,-m[1]/det,(m[1]*m[5]-m[4]*m[2])/det,-m[3]/det,m[0]/det,(m[3]*m[2]-m[0]*m[5])/det];};
    for(const spec of specs) {
        try {
            const matches=index.get(spec.marker) || [],holders=index.get(spec.wrapper) || [];
            if(matches.length!==1 || holders.length!==1)fail('layer not found');
            const node=matches[0],holder=holders[0],box=node.baseBox,local=Array.from(node.baseToSpreadTransform.data);
            // Figma's own layer frame when the plugin sent it (SVG coordinates, which are the page's).
            const f=spec.frame,at=f ? ([u,v])=>{const [a,b,c,d,e,g]=f.transform;return [a*u*f.width+c*v*f.height+e,b*u*f.width+d*v*f.height+g];}
                : ([u,v])=>apply(local,[box.x+u*box.width,box.y+v*box.height]);
            function definition(space) {
                const [x0,y0]=apply(space,at(spec.start)),[x1,y1]=apply(space,at(spec.end)),dx=x1-x0,dy=y1-y0,length=Math.hypot(dx,dy);
                if(length<1e-6)fail('the blur has no length');
                // A non-zero start radius: begin the ramp before the start so it matches there.
                const lead=spec.startRadius>0 ? spec.startRadius*length/(spec.radius-spec.startRadius || 1e-6) : 0;
                const params=DepthOfFieldFilterParameters.create();
                params.radius=Math.min(1024,spec.radius); // setting tiltShiftParams selects tilt-shift mode
                params.tiltShiftParams={position:{x:x0-dx/length*lead,y:y0-dy/length*lead},rotation:Math.PI/2-Math.atan2(dy,dx), // 0 blurs toward +y; Affinity's angle runs the other way to atan2
                    top:-1e6,inFocusTop:-1e6+1,inFocusBottom:0.001,bottom:length+lead};
                return DepthOfFieldFilterRasterNodeDefinition.create(params);
            }
            const add=space=>{
                const builder=AddChildNodesCommandBuilder.create();builder.setInsertionTarget(holder);builder.setInsertionMode(InsertionMode.Inside_AtBack); // top of the wrapper, above the layer and its effects
                builder.addNode(definition(space));const command=builder.createCommand(false);doc.executeCommand(command);
                const filter=command.newNodes[0];if(!filter)fail('Affinity did not create the live filter');return filter;
            };
            let filter=add([1,0,0,0,1,0]);
            // The filter's settings are in its own coordinates; redo it there if that isn't the page.
            const own=Array.from(filter.baseToSpreadTransform.data);
            if(own.some((v,i)=>Math.abs(v-[1,0,0,0,1,0][i])>1e-9)){filter.delete();filter=add(invert(own));}
            filter.userDescription=spec.name+' progressive blur';
            if(holder!==node)holder.userDescription=spec.name;
        } catch(e){warn(warnings,spec.name+': the progressive blur couldn’t be rebuilt. Add a Depth of Field live filter in Affinity.');}
    }
}

function restoreBackdrops(doc,specs,warnings) {
    if(!specs.length)return;
    const {GaussianBlurFilterParameters,GaussianBlurFilterRasterNodeDefinition,NodeChildType}=require('/nodes.js');
    const {AddChildNodesCommandBuilder,DocumentCommand,InsertionMode,NodeMoveType}=require('/commands.js');
    const {Selection}=require('/selections.js');
    const index=indexLayersByName(doc.layers.all.toArray());
    for(const spec of specs) {
        const matches=index.get(spec.marker) || [];
        try {
            if(matches.length!==1)fail('mask not found');
            // Live filter radius equals the CSS blur, i.e. half Figma's background blur (checked against Chrome).
            const params=GaussianBlurFilterParameters.create();params.radius=spec.radius;
            const builder=AddChildNodesCommandBuilder.create();builder.setInsertionTarget(matches[0]);builder.setInsertionMode(InsertionMode.Behind);
            builder.addNode(GaussianBlurFilterRasterNodeDefinition.create(params));
            const command=builder.createCommand(false);doc.executeCommand(command);
            const filter=command.newNodes[0];if(!filter)fail('Affinity did not create the live filter');
            doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,matches[0]),filter,NodeMoveType.Inside,NodeChildType.Enclosure));
            filter.userDescription=spec.name+' background blur';
        } catch(e) {
            if(matches.length===1)try{matches[0].delete();}catch(ignore){}
            warn(warnings,spec.name+': background blur couldn’t be added. Add a Gaussian Blur live filter in Affinity.');
        }
    }
}

function affinityBlurRadius(effect) {
    return Number.isFinite(effect.figmaRadius) ? effect.figmaRadius/2 : effect.sigma;
}

// Affinity 3.3: Gaussian Blur's panel displays SDK radius / 3. The
// shadow panels display the SDK radius directly, but render the same kernel.
// Verified with panel values and matching rendered edge profiles, not getters.
// Spread maps to intensity: Affinity's shadow is a solid core of intensity × radius
// with the blur falloff over the rest, so radius = blur + spread and intensity = spread / radius.
function affinityEffectSettings(effect) {
    const kernelRadius = 3 * affinityBlurRadius(effect);
    if (effect.kind === 'blur') return {radius: kernelRadius};
    const spread = Math.max(0, effect.spread || 0);
    const radius = kernelRadius + spread;
    return {radius, offset: Math.hypot(effect.dx, effect.dy),
        angle: Math.atan2(effect.dy, effect.dx), intensity: radius ? spread/radius : 0};
}

function rebuildArtboards(doc,boards) {
    if(!boards.length)return 0;
    const {DocumentCommand,NodeMoveType}=require('/commands.js');
    const {ShapeNodeDefinition,NodeChildType}=require('/nodes.js');
    const {ShapeRectangle}=require('/shapes.js');
    const {Rectangle}=require('/geometry.js');
    const {FillDescriptor}=require('/fills.js');
    const nodes=indexLayersByName(doc.layers.all.toArray());
    // Check every frame before starting to rearrange the document.
    const targets=boards.map(board=>{
        const containers=nodes.get(board.containerMarker) || [],anchors=nodes.get(board.anchorMarker) || [];
        if(containers.length!==1 || anchors.length!==1)fail('Affinity could not identify the artboard contents for '+board.name+'. The source SVG was kept.');
        return {board,content:containers[0],anchor:anchors[0]};
    });
    for(const {board,content,anchor} of targets) {
        const definition=ShapeNodeDefinition.create(ShapeRectangle.create(),new Rectangle(board.x,board.y,board.width,board.height),FillDescriptor.createNone(),FillDescriptor.createNone());
        const command=DocumentCommand.createAddArtboard(definition,false,false);doc.executeCommand(command);
        const created=command.newNodes[0];
        if(!created?.isArtboardEnabled)fail('Affinity did not create artboard '+board.name+'.');
        created.userDescription=board.name;
        doc.executeCommand(DocumentCommand.createMoveNodes(content.selfSelection,created,NodeMoveType.Inside,NodeChildType.Main));
        const box=created.artboardInterface.spreadBaseBox;
        if(Math.abs(box.x-board.x)>0.01 || Math.abs(box.y-board.y)>0.01 || Math.abs(box.width-board.width)>0.01 || Math.abs(box.height-board.height)>0.01)fail('Affinity changed the bounds of artboard '+board.name+'.');
        content.userDescription=board.name+' — content';
        anchor.delete();
    }
    if(doc.artboards.length!==boards.length)fail('Affinity did not retain every artboard. Check the open document before sending again.');
    return boards.length;
}

function importPrepared(result, folder) {
    const started=Date.now(),timings={};let stage=started;
    const {File, FileSystemApi} = require('/fs.js');
    const {DocumentApi} = require('affinity:dom');
    const {Document, LoadDocumentOptions} = require('/document.js');
    const {GaussianBlurLayerEffect, OuterShadowLayerEffect, InnerShadowLayerEffect, BlendMode} = require('/layereffects.js');
    const {RGBAuf} = require('/colours.js');
    folder = folder.trim().replace(/[\\/]+$/, '');
    if (!folder) fail('Affinity has no folder it can save images to.');
    if (!/(?:^|[\\/])Figma Paste Sources$/.test(folder)) folder += '/Figma Paste Sources';
    nativeStep('preparing the working folder', folder, () => {
        if (!FileSystemApi.exists(folder)) FileSystemApi.createDirectories(folder);
        if (!FileSystemApi.isDirectory(folder)) fail('The Figma Paste Sources working folder is unavailable.');
    });
    const importId='Figma-Paste-'+Date.now()+'-'+Math.random().toString(36).slice(2,10);
    const assets=result.assets || [], assetFolder=assets.length ? folder+'/'+importId+'/Images' : null;
    const path=folder+'/'+importId+(assets.length ? '/Design.svg' : '.svg');
    let preparedSvg=result.svg;
    function writeBytes(destination,bytes){
        if(FileSystemApi.exists(destination))fail('A generated file already exists. Please retry.');
        const file=File.create(destination,'wb');if(!file.isOpen)fail('Cannot write '+destination);
        try{file.write(bytes,bytes.length);file.flush();if(file.getLength(false)!==bytes.length)fail('Could not write the complete file: '+destination);}finally{file.close();}
    }
    if(assets.length)nativeStep('preserving the original image files',folder,()=>{
        const {Buffer}=require('/buffer.js');
        FileSystemApi.createDirectories(assetFolder);
        for(const asset of assets){
            const decoded=decodeImageBase64(asset.base64),bytes=Buffer.create(decoded.length);bytes.array.set(decoded);
            writeBytes(assetFolder+'/'+asset.filename,bytes);
        }
        preparedSvg=embedImageAssets(result.svg,assets);
        const manifest={version:1,design:result.packet ? result.packet.name : 'Pasted SVG',imageFillsRebuilt:result.imageFills || 0,images:assets.map(a=>({file:'Images/'+a.filename,originalName:a.name,mime:'image/'+a.mime,width:a.width,height:a.height}))};
        writeBytes(folder+'/'+importId+'/Images.json',Buffer.utf8(JSON.stringify(manifest,null,2)));
    });
    timings.imagesMs=Date.now()-stage;stage=Date.now();
    nativeStep('saving the SVG source', folder, () => {
        if (FileSystemApi.exists(path)) fail('Working file already exists. Please retry.');
        const file = File.create(path, 'wb');
        if (!file.isOpen) fail('Cannot write to the working folder. Turn on *Access Files on your Desktop* in Affinity’s **Model Context Protocol** settings.');
        try {
            const {Buffer} = require('/buffer.js');
            const bytes = Buffer.utf8(preparedSvg);
            file.write(bytes, bytes.length);
            file.flush();
            if (file.getLength(false) !== bytes.length) fail('Could not write the complete SVG source.');
        } finally { file.close(); }
    });
    timings.sourceWriteMs=Date.now()-stage;stage=Date.now();
    // Keep the generated SVG as a recoverable source; never overwrite an existing document.
    // SVG coordinates enter Affinity in points. Image-heavy SVGs can otherwise
    // open at 600 DPI, leaving geometry 8.33 times larger than pixel-based FX.
    // At 72 DPI one source coordinate, document point and effect pixel agree.
    const loadOptions=LoadDocumentOptions.createDefault();loadOptions.dpi=72;
    const loaded = nativeStep('opening the SVG source', folder, () => DocumentApi.load(path,loadOptions.handle));
    if (!loaded || !loaded.document) fail('Affinity could not open the generated SVG. Source: ' + path);
    const doc = new Document(loaded.document), warnings = result.warnings.slice();
    timings.loadMs=Date.now()-stage;stage=Date.now();
    restoreStrokeAlignment(doc,result.strokeAlignments || [],result.packet,warnings);
    restoreTextFonts(doc,result.textFonts || []);
    restoreTextTracking(doc,result.textTracking || [],result.packet,warnings);
    const textFrames=rebuildTextFrames(doc,result.texts || [],warnings);
    const linearGradientTextLayers=restoreLinearTextGradients(doc,result.linearTextGradients || [],warnings);
    restoreAngularGradients(doc,result.angularGradients || [],warnings);
    restoreBackdrops(doc,result.backdrops || [],warnings);
    restoreProgressiveBlurs(doc,result.progressiveBlurs || [],warnings);
    const imageTiles=restoreImageTiles(doc,result.imageTiles || [],assets,assetFolder,result.packet,warnings);
    timings.textMs=Date.now()-stage;stage=Date.now();
    const nodes = indexLayersByName(doc.layers.all.toArray());
    let repaired = 0;
    const counts = {blur: 0, outerShadow: 0, innerShadow: 0};
    for (const spec of result.effects) {
        const matches = nodes.get(spec.marker) || [];
        if (matches.length !== 1) { warn(warnings, layerName(result.packet,spec.marker) + ': effects couldn’t be applied. Add them in Affinity.'); continue; }
        try {
            let outerIndex = 0, innerIndex = 0;
            for (const effect of spec.native) {
                let fx, applied;
                if (effect.kind === 'blur') {
                    fx = GaussianBlurLayerEffect.create();
                    fx.enabled = true; fx.opacity = 1; fx.preserveAlpha = false; fx.radius = affinityEffectSettings(effect).radius;
                    doc.setGaussianBlurLayerEffect(matches[0], fx);
                    applied = matches[0].quickFX.find(e => e.isGaussianBlurLayerEffect && e.enabled);
                } else {
                    const inner = effect.kind === 'innerShadow';
                    fx = inner ? InnerShadowLayerEffect.create() : OuterShadowLayerEffect.create();
                    fx.enabled = true; fx.opacity = effect.opacity;
                    fx.colour = RGBAuf(effect.rgb[0], effect.rgb[1], effect.rgb[2], 1);
                    Object.assign(fx, affinityEffectSettings(effect));
                    fx.blendMode = BlendMode.Normal;
                    if (inner) {
                        doc.setInnerShadowLayerEffect(matches[0], fx, innerIndex);
                        applied = matches[0].quickFX.filter(e => e.isInnerShadowLayerEffect && e.enabled)[innerIndex++];
                    } else {
                        fx.fillKnocksOut = effect.knocksOut;
                        doc.setOuterShadowLayerEffect(matches[0], fx, outerIndex);
                        applied = matches[0].quickFX.filter(e => e.isOuterShadowLayerEffect && e.enabled)[outerIndex++];
                    }
                }
                if (!applied) fail('Affinity did not attach the ' + effect.kind + ' effect.');
                repaired++; counts[effect.countAs || effect.kind]++;
            }
            matches[0].userDescription = spec.name;
        } catch (e) { warn(warnings, layerName(result.packet,spec.marker) + ': some effects couldn’t be applied. Check them in Affinity.'); }
    }
    timings.effectsMs=Date.now()-stage;stage=Date.now();
    const artboards=rebuildArtboards(doc,result.artboards || []);
    timings.artboardsMs=Date.now()-stage;stage=Date.now();
    if (result.packet) {
        const names=new Map(result.packet.layers.map(layer=>[layer.marker,layer.name]));
        for (const node of doc.layers.all.toArray()) {
            const name=names.get(node.userDescription) || names.get(node.description);
            if (name!=null) node.userDescription=name;
        }
    }
    for(const node of doc.layers.all.toArray()){
        if(!node.isImageNode)continue;
        const asset=assets.find(a=>(node.userDescription || '').startsWith(a.token+'Embedded'));
        if(asset)node.userDescription=asset.name;
    }
    const textLayers=doc.layers.all.toArray().filter(node=>node.isTextNode).length;
    const imageLayers=doc.layers.all.toArray().filter(node=>node.isImageNode || node.isRasterNode).length;
    if(assets.length && !imageLayers && !imageTiles)warn(warnings,'Images may be missing. The originals were saved to '+assetFolder+'.');
    doc.enumerateFontNames((name,installed)=>{if(!installed) warn(warnings,'“'+name+'” isn’t installed in Affinity. Install it so the text looks the same.');return require('affinity:common').EnumerationResult.Continue;});
    console.log('Figma Paste:', result.type, 'source:', path, 'editable effects:', repaired, 'text frames:', textFrames, 'warnings:', warnings);
    timings.finishMs=Date.now()-stage;timings.totalMs=Date.now()-started;
    return {document: doc, warnings, repaired, counts, path, textLayers, textFrames, linearGradientTextLayers, artboards, imageLayers, imageFiles:assets.length, imageFills:result.imageFills || 0, assetFolder,timings};
}

// Everything above is embedded in the Figma plugin; Node only exports helpers.
if (typeof process === 'object' && process.versions && process.versions.node) {
    module.exports = {compile, parseXml, importPrepared, workingFolder, nativeStep, readTransfer, textRebuildIssue, decodeImageBase64, imageAssetName, embedImageAssets, affinityBlurRadius, affinityEffectSettings, innerSpreadGeometry,indexLayersByName,svgTransform,multiplyAffine,restoreLinearTextGradients};
}
