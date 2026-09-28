/* Send to Affinity, a Figma plugin.
 * Exports the selection as live SVG plus text/effect metadata (approach informed by Quiver)
 * and the panel sends it to Affinity's local SDK. Original layers are never renamed.
 */
'use strict';

function plain(value) {
    if (value == null || typeof value === 'symbol') return null;
    return JSON.parse(JSON.stringify(value, (key, v) => typeof v === 'symbol' ? null : v));
}

function multiply(a, b) {
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
        a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
        a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
function matrix(t) { return [t[0][0],t[1][0],t[0][1],t[1][1],t[0][2],t[1][2]]; }
function inverse(t) {
    const d=t[0]*t[3]-t[1]*t[2];
    if (Math.abs(d)<1e-12) throw new Error('The selected layer has a collapsed transform.');
    return [t[3]/d,-t[1]/d,-t[2]/d,t[0]/d,(t[2]*t[5]-t[3]*t[4])/d,(t[1]*t[4]-t[0]*t[5])/d];
}

function textRecord(node, marker, origin) {
    const fields=['fontName','fontWeight','fontSize','fills','textDecoration','textCase','letterSpacing','lineHeight','paragraphSpacing','paragraphIndent','listOptions'];
    const runs=node.getStyledTextSegments(fields).map(segment => plain(segment));
    return {
        marker, name:node.name, characters:node.characters,
        width:node.width, height:node.height,
        transform:multiply(origin,matrix(node.absoluteTransform)),
        textAlignHorizontal:node.textAlignHorizontal, textAlignVertical:node.textAlignVertical,
        textAutoResize:node.textAutoResize, runs,
        strokes:plain(node.strokes) || [], effects:plain(node.effects) || [],
        hasMissingFont:!!node.hasMissingFont,
        blendMode:node.blendMode,
        opacity:node.opacity == null ? 1 : node.opacity
    };
}

function selectionRoots(selection) {
    const ids=new Set(selection.map(node=>node.id));
    return selection.filter(node=>{
        for(let parent=node.parent;parent;parent=parent.parent)if(ids.has(parent.id))return false;
        return true;
    });
}
function selectionKey(selection) {
    return selection.length===1 ? selection[0].id : JSON.stringify(selection.map(node=>node.id).sort());
}
function selectionPlan(api) {
    const selection=selectionRoots(api.currentPage.selection);
    if(!selection.length)throw new Error('Select one layer, or multiple frames to create artboards.');
    for(const node of selection) {
        if(typeof node.exportAsync!=='function' || typeof node.clone!=='function')throw new Error('This selection contains a layer that cannot be exported.');
        if(!(node.width>0 && node.height>0) || node.visible===false)throw new Error('Select visible layers with non-zero dimensions.');
    }
    if(selection.length===1)return {selection,selectionId:selectionKey(selection),name:selection[0].name,width:selection[0].width,height:selection[0].height};
    const frames=selection.map(node=>{
        if(!['FRAME','COMPONENT','INSTANCE'].includes(node.type))throw new Error('For multiple artboards, select frames, components or instances. Send other layers individually.');
        const m=matrix(node.absoluteTransform);
        if(m.some(v=>!Number.isFinite(v)) || Math.abs(m[0]-1)>1e-6 || Math.abs(m[3]-1)>1e-6 || Math.abs(m[1])>1e-6 || Math.abs(m[2])>1e-6)throw new Error('For multiple artboards, select upright, unscaled frames. Send rotated frames individually.');
        return {node,x:m[4],y:m[5],width:node.width,height:node.height};
    });
    const x=Math.min(...frames.map(f=>f.x)),y=Math.min(...frames.map(f=>f.y));
    const width=Math.max(...frames.map(f=>f.x+f.width))-x,height=Math.max(...frames.map(f=>f.y+f.height))-y;
    return {selection,selectionId:selectionKey(selection),name:selection.length+' Figma frames',frames:frames.map(f=>({...f,x:f.x-x,y:f.y-y})),x,y,width,height};
}
function selectionInfo(api) {
    let plan;
    if(!api.currentPage.selection.length)return {valid:false,empty:true,label:'Nothing selected'};
    try {plan=selectionPlan(api);}catch(e){return {valid:false,label:e.message};}
    const {selection,selectionId,name,width,height}=plan;
    let text=0, layers=0, effects=0;
    function visit(n) {
        if(n.visible===false) return;
        layers++; if(n.type==='TEXT') text++;
        if(Array.isArray(n.effects)) effects+=n.effects.filter(e=>e.visible!==false).length;
        if(n.children) n.children.forEach(visit);
    }
    selection.forEach(visit);
    const artboards=plan.frames ? plan.frames.length : 0;
    return {valid:true,selectionId,name,width,height,layers,text,effects,artboards,label:artboards ? artboards+' frames selected' : '1 layer selected'};
}

// Figma paint arrays are bottom-first: the last paint is the top UI fill.
// Verified against the actual stacked-photo export. Only prune a clone, never the
// original design. Content-addressed image hashes let us cache opacity facts
// without keeping a second copy of the image bytes in memory.
const imageOpacityCache=new Map();
function opaqueImageBytes(bytes) {
    if(bytes.length>=3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return true; // JPEG
    const signature=[137,80,78,71,13,10,26,10];
    if(bytes.length<33 || signature.some((v,i)=>bytes[i]!==v))return false;
    const u32=i=>bytes[i]*16777216+bytes[i+1]*65536+bytes[i+2]*256+bytes[i+3];
    const type=i=>String.fromCharCode(...bytes.slice(i,i+4));
    if(u32(8)!==13 || type(12)!=='IHDR' || ![0,2,3].includes(bytes[25]))return false;
    for(let at=8;at+12<=bytes.length;) {
        const size=u32(at),kind=type(at+4);
        if(at+size+12>bytes.length)return false;
        if(kind==='tRNS')return false;
        if(kind==='IDAT')return true; // PNG transparency must precede image data.
        at+=size+12;
    }
    return false; // Alpha-channel PNGs and unknown formats keep their stack.
}
function imageCoversShape(paint) {
    if(paint.scaleMode==='FILL')return !paint.rotation || Math.abs(paint.rotation%90)<1e-8;
    if(paint.scaleMode!=='CROP')return false; // FIT can leave gaps; retain TILE and unknown modes.
    const m=paint.imageTransform;
    if(!Array.isArray(m) || m.length!==2 || m.some(r=>!Array.isArray(r)||r.length!==3||r.some(v=>!Number.isFinite(v))))return false;
    // Figma's normalized crop maps the shape into image coordinates. Keep
    // rotated/skewed crops conservatively; an inset axis-aligned crop covers it.
    if(Math.abs(m[0][1])>1e-8 || Math.abs(m[1][0])>1e-8 || !m[0][0] || !m[1][1])return false;
    return [[0,0],[1,0],[0,1],[1,1]].every(([x,y])=>{
        const u=m[0][0]*x+m[0][2],v=m[1][1]*y+m[1][2];
        return u>=0 && u<=1 && v>=0 && v<=1;
    });
}
async function pruneCoveredImageFills(root,api,cache=imageOpacityCache) {
    const stats={removedImageFills:0,removedPaints:0,optimizedLayers:0,examinedStacks:0},nodes=[];
    function visit(node){if(node.visible===false)return;nodes.push(node);if(node.children)node.children.forEach(visit);}
    visit(root);
    for(const node of nodes) {
        // Text ranges and vector-region overrides need their own paint mapping.
        if(!['RECTANGLE','ELLIPSE','FRAME','COMPONENT','INSTANCE','POLYGON','STAR'].includes(node.type))continue;
        const fills=node.fills;
        if(!Array.isArray(fills) || fills.filter(p=>p.type==='IMAGE' && p.visible!==false).length<2)continue;
        stats.examinedStacks++;
        for(let i=fills.length-1;i>0;i--) {
            const paint=fills[i],covered=fills.slice(0,i).filter(p=>p.type==='IMAGE' && p.visible!==false);
            if(!covered.length)break;
            if(paint.type!=='IMAGE'||paint.visible===false||(paint.opacity!=null&&paint.opacity!==1)||(paint.blendMode&&paint.blendMode!=='NORMAL')||!paint.imageHash||!imageCoversShape(paint))continue;
            const hash=paint.imageHash;
            if(!cache.has(hash))cache.set(hash,(async()=>{
                try{const image=api.getImageByHash(hash);return image ? opaqueImageBytes(await image.getBytesAsync()) : false;}
                catch(e){cache.delete(hash);return false;}
            })());
            if(!await cache.get(hash))continue;
            try{node.fills=plain(fills.slice(i));}catch(e){break;}
            stats.removedImageFills+=covered.length;stats.removedPaints+=i;stats.optimizedLayers++;
            break;
        }
    }
    return stats;
}

async function exportSelection(api, progress, options={}) {
    const started=Date.now(),timings={};
    const plan=selectionPlan(api),original=plan.selection[0];
    if(options.selectionId && plan.selectionId!==options.selectionId)throw new Error('Selection changed while connecting. Send the current selection again.');
    let clone;const copies=[];
    const warnings=[], layers=[], texts=[];
    const origin=plan.frames ? [1,0,0,1,-plan.x,-plan.y] : inverse(matrix(original.absoluteTransform));
    try {
        progress('Reading layers and text…');
        if(plan.frames) {
            clone=api.createFrame();clone.name='Figma Paste temporary export';
            clone.layoutMode='NONE';clone.fills=[];clone.clipsContent=false;
            clone.resizeWithoutConstraints(plan.width,plan.height);
            clone.relativeTransform=[[1,0,0],[0,1,0]];
            for(const frame of plan.frames) {
                const copy=frame.node.clone();copies.push(copy);
                clone.appendChild(copy);
                copy.relativeTransform=[[1,0,frame.x],[0,1,frame.y]];
            }
        } else {
            clone=original.clone();
            // Move immediately so a clone inside auto layout cannot remain in that layout.
            api.currentPage.appendChild(clone);
            clone.relativeTransform=[[1,0,0],[0,1,0]];
        }
        timings.cloneMs=Date.now()-started;
        const metadataStarted=Date.now();
        let serial=0;
        // Figma's glass effect has no SVG representation at all (unlike background
        // blur), so it can only travel through this JSON metadata. Figma itself
        // renders only the first of GLASS/BACKGROUND_BLUR it finds on a layer, so
        // mirror that: a BACKGROUND_BLUR earlier in the list means glass is not
        // actually visible, and neither should warn about the other.
        function visibleGlass(effects) {
            for(const e of effects) {
                if(!e || e.visible===false) continue;
                if(e.type==='GLASS') return e;
                if(e.type==='BACKGROUND_BLUR') return null;
            }
            return null;
        }
        function visit(source, copy) {
            const marker='FP_'+(++serial);
            copy.name=marker;
            if(source.visible===false) return;
            const record={marker,name:source.name,type:source.type,effects:plain(source.effects) || []};
            const glass=visibleGlass(record.effects);
            // Glass is rebuilt in Affinity from the metadata above; keep whatever Figma
            // might export for it out of the SVG. (A feTurbulence filter in the export
            // is Figma's separate Texture effect, which this doesn't touch.)
            if(Array.isArray(copy.effects) && copy.effects.some(e=>e && e.type==='GLASS'))
                copy.effects=copy.effects.filter(e=>!e || e.type!=='GLASS');
            // Figma leaves fill-less shapes out of the SVG, and glass is often on exactly
            // those. A 1% stand-in fill keeps the geometry; Affinity removes it again.
            if(glass && Array.isArray(copy.fills) && !copy.fills.some(p=>p && p.visible!==false && (p.opacity==null || p.opacity>0))) {
                copy.fills=[{type:'SOLID',color:{r:1,g:1,b:1},opacity:0.01}];
                record.glassFillless=true;
            }
            // Progressive blur points and glass's own displacement are both fractions/effects
            // of Figma's own layer bounds, which Affinity's imported bounds don't always
            // match, so send the real frame for those layers.
            if((record.effects.some(e=>e && e.blurType==='PROGRESSIVE') || glass) && source.width>0 && source.height>0 && source.absoluteTransform)
                Object.assign(record,{width:source.width,height:source.height,transform:multiply(origin,matrix(source.absoluteTransform))});
            layers.push(record);
            if(source.type==='TEXT') {
                try {
                    const record=textRecord(source,marker,origin);
                    texts.push(record);
                    if(record.hasMissingFont) warnings.push(source.name+': a font is missing in Figma. Install it, then send again.');
                } catch(e) { /* ponytail: SVG text is used instead, still editable. */ }
            }
            if(Array.isArray(source.effects)) for(const e of source.effects) {
                if(e.visible!==false && e.type==='GLASS') continue; // handled above; a GLASS eclipsed by an earlier BACKGROUND_BLUR is silently dropped by Figma too
                if(e.visible!==false && !['LAYER_BLUR','DROP_SHADOW','INNER_SHADOW'].includes(e.type)) warnings.push(source.name+': '+(e.type==='BACKGROUND_BLUR' ? 'background blur' : e.type.toLowerCase().replace(/_/g,' ')+' effect')+' isn’t supported. Add it in Affinity if you need it.');
            }
            if(source.children) {
                if(!copy.children || source.children.length!==copy.children.length) throw new Error('The export copy has a different layer structure. Try a frame or group.');
                source.children.forEach((child,i)=>visit(child,copy.children[i]));
            }
        }
        const artboards=[];
        if(plan.frames)plan.frames.forEach((frame,i)=>{
            const first=layers.length;
            visit(frame.node,copies[i]);
            artboards.push({marker:copies[i].name,name:frame.node.name,x:frame.x,y:frame.y,width:frame.width,height:frame.height,layerMarkers:layers.slice(first).map(l=>l.marker)});
        });
        else visit(original,clone);
        timings.metadataMs=Date.now()-metadataStarted;
        const optimizeStarted=Date.now();
        progress('Checking for covered image fills…');
        const imageOptimization=await pruneCoveredImageFills(clone,api);
        timings.imageOptimizationMs=Date.now()-optimizeStarted;
        progress('Exporting editable vectors…');
        const svgStarted=Date.now();
        const svg=await clone.exportAsync({format:'SVG_STRING',svgOutlineText:false,svgIdAttribute:true,svgSimplifyStroke:false,contentsOnly:true,useAbsoluteBounds:true,colorProfile:'SRGB'});
        if(typeof svg!=='string' || !svg.trim().startsWith('<svg')) throw new Error('Figma did not return SVG text.');
        timings.svgMs=Date.now()-svgStarted;
        const packet={format:'figma-affinity',version:plan.frames ? 2 : 1,exporterVersion:'__VERSION__',name:plan.name,
            frame:{width:plan.width,height:plan.height},svg,layers,texts,warnings,imageOptimization};
        if(plan.frames)packet.artboards=artboards;
        timings.totalMs=Date.now()-started;
        return {packet,selectionId:plan.selectionId,timings};
    } finally {
        for(const copy of copies)if(!copy.removed)copy.remove();
        if(clone && !clone.removed) clone.remove();
    }
}

const WIDTH=271;
function start(api) {
    api.showUI(__html__,{width:WIDTH,height:89,themeColors:true});
    let busy=false;
    const selection=()=>api.ui.postMessage({type:'selection',...selectionInfo(api)});
    api.on('selectionchange',selection);
    api.ui.onmessage=async message=>{
        if(!message || typeof message.type!=='string') return;
        if(message.type==='ready') selection();
        if(message.type==='resize') api.ui.resize(WIDTH,Math.min(600,Math.max(60,Math.ceil(message.height))));
        if(message.type==='prepare' && !busy) {
            busy=true;
            try {
                const exported=await exportSelection(api,text=>api.ui.postMessage({type:'progress',message:text}),{selectionId:message.selectionId});
                api.ui.postMessage({type:'prepared',...exported});
            } catch(e) { api.ui.postMessage({type:'error',message:e.message || String(e)}); }
            finally { busy=false; }
        }
    };
}

if(typeof figma!=='undefined') start(figma);
if(typeof module==='object') module.exports={plain,multiply,inverse,matrix,textRecord,selectionInfo,selectionRoots,selectionKey,selectionPlan,exportSelection,opaqueImageBytes,imageCoversShape,pruneCoveredImageFills};
