'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {compile,readTransfer,indexLayersByName}=require('../affinity/importer.js');
const {exportSelection,multiply,inverse}=require('../figma/code.js');
const example=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/editable-text.figma-affinity.json'),'utf8'));
const run=p=>compile(JSON.stringify(p));

test('transfer preserves original paragraphs, mixed runs, transforms and duplicate layer names',()=>{
    const p=example();p.layers.forEach(l=>l.name='Same name');
    const out=run(p);
    assert.equal(out.type,'Figma transfer');assert.equal(out.texts.length,2);
    assert.equal(out.texts[0].runs.length,2);
    assert.equal(out.texts[1].characters,'Keep the words, colours and styles.\nA second line stays editable.');
    assert.deepEqual(out.texts[1].transform,[1,0,0,1,48,140]);
    assert.equal(out.packet.layers.filter(l=>l.name==='Same name').length,p.layers.length);
});
test('invalid transfer identities, transforms and run boundaries fail before importing',()=>{
    for(const change of [p=>p.version=99,p=>p.layers.push(p.layers[0]),p=>p.texts[0].transform=[1,2],p=>p.texts[0].runs[0].end++,p=>p.texts[0].runs.pop()]){
        const p=example();change(p);assert.throws(()=>run(p));
    }
});
test('UTF-16 ranges preserve emoji and non-Latin characters without outlining',()=>{
    const p=example(),t=p.texts[0];t.characters='Hi 👋 世界';t.runs=[{...t.runs[0],start:0,end:t.characters.length,characters:t.characters}];
    assert.equal(readTransfer(JSON.stringify(p)).texts[0].characters,t.characters);
});
test('unsupported text features quietly keep editable SVG text',()=>{
    for(const change of [t=>t.textAlignVertical='CENTER',t=>t.blendMode='MULTIPLY',t=>t.strokes=[{type:'SOLID'}],t=>t.runs[0].fills=[{type:'GRADIENT_LINEAR'}],t=>t.runs[0].listOptions={type:'ORDERED'}]){
        const p=example();change(p.texts[0]);const out=run(p);
        assert.equal(out.texts.length,1);assert.match(out.svg,/Made/);assert.deepEqual(out.warnings,[]);
    }
});
test('SVG and Figma bounds must match before rebuilding frame text',()=>{
    const p=example();p.frame.width+=100;
    assert.equal(run(p).texts.length,0);
});
test('clipped text and unconverted text filters retain SVG instead of losing styling',()=>{
    for(const attr of ['clip-path="url(#clip)"','filter="url(#unknown)"']){
        const p=example();p.svg=p.svg.replace('id="FP_2"','id="FP_2" '+attr);
        const out=run(p);assert.equal(out.texts.length,1);assert.ok(out.svg.includes(attr));
    }
});
test('whole-layer native blur stays associated with a rebuilt multi-style text frame',()=>{
    const p=example();p.svg=p.svg.replace('id="FP_2"','id="FP_2" filter="url(#blur)"').replace('</svg>','<defs><filter id="blur"><feGaussianBlur stdDeviation="4"/></filter></defs></svg>');
    const out=run(p);assert.equal(out.texts.length,2);assert.equal(out.effects[0].marker,'FP_2');assert.equal(out.effects[0].native[0].kind,'blur');
});
test('inline style and direct drop-shadow convert into editable shadow specifications',()=>{
    const out=compile('<svg><defs><filter id="f"><feDropShadow dx="3" dy="5" stdDeviation="7" flood-color="#123456" flood-opacity="0.4"/></filter></defs><rect id="r" style="fill:#fff;filter:url(#f)"/></svg>');
    const fx=out.effects[0].native[0];assert.equal(fx.kind,'outerShadow');assert.equal(fx.sigma,7);assert.equal(fx.dx,3);assert.equal(fx.dy,5);assert.equal(fx.opacity,.4);assert.ok(!out.svg.includes('filter="url(#f)"'));
});
test('feMerge resolves Figma-compatible shadow alpha chains',()=>{
    const out=compile('<svg><defs><filter id="f"><feGaussianBlur in="SourceAlpha" stdDeviation="3"/><feOffset dx="2" dy="4"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0" result="shadow"/><feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect filter="url(#f)"/></svg>');
    assert.equal(out.effects[0].native[0].kind,'outerShadow');assert.equal(out.effects[0].native[0].dy,4);
});
test('there is no 5 MiB pasted-input cap',()=>{
    const padding='a'.repeat(6*1024*1024);
    assert.equal(compile('<svg><desc>'+padding+'</desc><rect width="1" height="1"/></svg>').type,'SVG');
});

function host(throws=false){
    const source=example().texts[0];let removed=false;const settings=[];
    const child={...source,name:'Repeated',type:'TEXT',absoluteTransform:[[0,-1,90],[1,0,220]],getStyledTextSegments:()=>source.runs};
    const copyChild={name:child.name};
    const clone={children:[copyChild],remove(){removed=true;},async exportAsync(s){settings.push(s);if(throws)throw new Error('Export failed');return s.format==='SVG_STRING'?'<svg width="720" height="420"><text id="FP_2">Made to edit.</text></svg>':new Uint8Array([0]);}};
    const root={name:'Repeated',width:720,height:420,type:'FRAME',absoluteTransform:[[0,-1,100],[1,0,200]],children:[child],exportAsync:clone.exportAsync,clone:()=>clone};
    const api={currentPage:{selection:[root],appendChild(){}},base64Encode:()=>''};
    return {api,root,clone,copyChild,settings,removed:()=>removed};
}
test('Figma exporter uses a temporary copy, live text and stable IDs without renaming originals',async()=>{
    const h=host();const {packet}=await exportSelection(h.api,()=>{});
    assert.equal(h.root.name,'Repeated');assert.equal(h.root.children[0].name,'Repeated');assert.ok(h.removed());
    assert.equal(h.copyChild.name,'FP_2');assert.deepEqual(packet.texts[0].transform,[1,0,0,1,20,10]);
    assert.equal(h.settings[0].svgOutlineText,false);assert.equal(h.settings[0].svgIdAttribute,true);assert.equal(h.settings[0].svgSimplifyStroke,false);
    assert.equal(packet.texts[0].characters,'Made to edit.');assert.deepEqual(h.api.currentPage.selection,[h.root]);
});
test('Figma exporter removes its temporary copy after export failure',async()=>{
    const h=host(true);await assert.rejects(exportSelection(h.api,()=>{}),/Export failed/);assert.ok(h.removed());
});
test('a selection change during connection fails before cloning a different design',async()=>{
    const h=host();let cloned=false;h.root.clone=()=>{cloned=true;return h.clone;};
    h.root.id='new-selection';
    await assert.rejects(exportSelection(h.api,()=>{},{selectionId:'original-selection'}),/Selection changed/);
    assert.equal(cloned,false);
});
test('native layer lookup preserves ambiguous matches and reads SDK names only once',()=>{
    let reads=0;
    const a={get userDescription(){reads++;return 'FP_1';},get description(){reads++;return 'FP_1';}};
    const b={get userDescription(){reads++;return 'FP_2';},get description(){reads++;return 'FP_1';}};
    const index=indexLayersByName([a,b]);
    assert.deepEqual(index.get('FP_1'),[a,b]);assert.deepEqual(index.get('FP_2'),[b]);
    for(let i=0;i<100;i++)index.get('FP_1');
    assert.equal(reads,4);
});
test('export produces only the SVG, no raster preview',async()=>{
    const h=host();const out=await exportSelection(h.api,()=>{});
    assert.deepEqual(h.settings.map(s=>s.format),['SVG_STRING']);assert.ok(out.timings.totalMs>=0);
});
test('nested rotated/scaled coordinates round-trip and singular transforms fail',()=>{
    const t=[0,2,-3,0,100,200];multiply(inverse(t),t).forEach((v,i)=>assert.ok(Math.abs(v-[1,0,0,1,0,0][i])<1e-10));assert.throws(()=>inverse([0,0,0,0,0,0]));
});
