'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {compile,parseXml}=require('../affinity/importer.js');
const {selectionInfo,selectionKey,selectionRoots,exportSelection}=require('../figma-plugin/code.js');
const fixture=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/artboards.figma-affinity.json'),'utf8'));
const run=p=>compile(JSON.stringify(p));

test('artboard transfer keeps names, unequal sizes, spacing, editable text and native effects',()=>{
    const p=fixture(),result=run(p);
    assert.equal(result.artboards.length,3);
    assert.deepEqual(result.artboards.map(b=>[b.name,b.x,b.y,b.width,b.height]),[
        ['Text board',0,0,720,420],['Effects board',780,80,300,240],['Empty board',1140,40,240,160]
    ]);
    assert.equal(result.texts.length,2);assert.equal(result.effects[0].native[0].kind,'outerShadow');
    const nodes=[];(function visit(n){nodes.push(n);(n.children||[]).forEach(visit);})(parseXml(result.svg));
    for(const board of result.artboards) {
        const group=nodes.find(n=>n.attrs?.id===board.containerMarker);
        assert.ok(group);
        assert.ok(group.children.some(n=>n.attrs?.id===board.anchorMarker && n.attrs['fill-opacity']==='0'));
    }
});
test('invalid artboard membership, dimensions and mismatched SVG bounds fail before import',()=>{
    for(const change of [
        p=>p.artboards.pop(),p=>p.artboards[1].marker='FP_1',p=>p.artboards[1].layerMarkers.push('FP_2'),
        p=>p.artboards[0].x=-1,p=>p.artboards[0].width=0,p=>p.artboards[1].width=10000,
        p=>p.artboards[1].layerMarkers=['FP_5','FP_999'],p=>p.artboards[1].layerMarkers=['FP_6'],
        p=>p.frame.width+=100,p=>p.version=1,
        p=>p.svg=p.svg.replace('id="FP_5"','id="lost"'),
        p=>p.svg=p.svg.replace('id="FP_6"','id="FPAB_1"'),
        p=>p.svg=p.svg.replace('</defs>','</defs><rect id="FP_2" width="5" height="5"/>')
    ]) { const p=fixture();change(p);assert.throws(()=>run(p)); }
});
test('empty frames are valid artboards and duplicate display names remain distinct',()=>{
    const p=fixture();p.artboards.forEach(b=>b.name='Same');
    const out=run(p);assert.equal(new Set(out.artboards.map(b=>b.containerMarker)).size,3);
    assert.equal(out.artboards[2].name,'Same');
});

function host(failExport=false) {
    const source=fixture().texts[0],copies=[],settings=[];
    const page={selection:[],appendChild(n){n.parent=this;}};
    const wrapper={children:[],resizeWithoutConstraints(w,h){this.width=w;this.height=h;},appendChild(n){this.children.push(n);n.parent=this;},remove(){this.removed=true;},async exportAsync(s){
        settings.push(s);if(failExport)throw new Error('Export failed');
        return '<svg width="780" height="420"><g id="'+this.children[0].name+'"><text id="'+this.children[0].children[0].name+'">Made to edit.</text></g><g id="'+this.children[1].name+'"><text id="'+this.children[1].children[0].name+'">Made to edit.</text></g></svg>';
    }};
    const make=(id,x,y,w,h)=>{
        const text={...source,id:id+'text',type:'TEXT',absoluteTransform:[[1,0,x+48],[0,1,y+40]],getStyledTextSegments:()=>source.runs};
        const node={id,name:'Frame '+id,type:'FRAME',width:w,height:h,parent:page,absoluteTransform:[[1,0,x],[0,1,y]],children:[text],exportAsync:async()=>'',clone(){
            const copy={name:node.name,children:[{name:text.name}],remove(){this.removed=true;}};copies.push(copy);return copy;
        }};text.parent=node;return node;
    };
    const first=make('a',-500,100,400,420),second=make('b',-20,180,300,240);
    page.selection=[first,second];
    return {api:{currentPage:page,createFrame:()=>wrapper},first,second,wrapper,copies,settings};
}
test('multiple selected frames export once with globally unique IDs and canvas-relative text positions',async()=>{
    const h=host(),selection=h.api.currentPage.selection.slice(),info=selectionInfo(h.api);
    assert.equal(info.valid,true);assert.equal(info.artboards,2);
    const out=await exportSelection(h.api,()=>{},{selectionId:info.selectionId});
    assert.equal(out.packet.version,2);assert.equal(h.settings.length,1);assert.equal(h.settings[0].format,'SVG_STRING');
    assert.deepEqual(out.packet.frame,{width:780,height:420});
    assert.deepEqual(out.packet.artboards.map(b=>[b.marker,b.x,b.y,b.width,b.height]),[['FP_1',0,0,400,420],['FP_3',480,80,300,240]]);
    assert.deepEqual(out.packet.texts.map(t=>t.transform),[[1,0,0,1,48,40],[1,0,0,1,528,120]]);
    assert.equal(new Set(out.packet.layers.map(l=>l.marker)).size,4);
    assert.deepEqual(h.copies.map(c=>c.relativeTransform),[[[1,0,0],[0,1,0]],[[1,0,480],[0,1,80]]]);
    assert.equal(h.wrapper.fills.length,0);assert.equal(h.wrapper.clipsContent,false);
    assert.ok(h.wrapper.removed && h.copies.every(c=>c.removed));
    assert.equal(h.first.name,'Frame a');assert.equal(h.second.name,'Frame b');
    assert.deepEqual(h.api.currentPage.selection,selection);
    assert.equal(run(out.packet).artboards.length,2);
});
test('selection order does not invalidate a multi-frame transfer; selected descendants are not exported twice',()=>{
    const h=host(),[a,b]=h.api.currentPage.selection;
    assert.equal(selectionKey([a,b]),selectionKey([b,a]));
    assert.deepEqual(selectionRoots([a,a.children[0],b]),[a,b]);
});
test('changed selection, unsupported multi-layer types and transformed frames fail before cloning',async()=>{
    for(const change of [h=>h.second.type='GROUP',h=>h.second.absoluteTransform=[[0,-1,0],[1,0,0]],h=>h.second.visible=false,h=>h.second.width=0]) {
        const h=host();change(h);assert.equal(selectionInfo(h.api).valid,false);
        await assert.rejects(exportSelection(h.api,()=>{}));assert.equal(h.copies.length,0);
    }
    const h=host();await assert.rejects(exportSelection(h.api,()=>{},{selectionId:'old-selection'}),/Selection changed/);assert.equal(h.copies.length,0);
});
test('export failure removes all temporary frames and leaves the original selection intact',async()=>{
    const h=host(true),selection=h.api.currentPage.selection.slice();
    await assert.rejects(exportSelection(h.api,()=>{}),/Export failed/);
    assert.ok(h.wrapper.removed && h.copies.every(c=>c.removed));assert.deepEqual(h.api.currentPage.selection,selection);
});
test('a failed clone is cleaned up along with copies made earlier in the batch',async()=>{
    const h=host();h.second.clone=()=>{throw new Error('Clone failed');};
    await assert.rejects(exportSelection(h.api,()=>{}),/Clone failed/);
    assert.ok(h.wrapper.removed && h.copies.every(c=>c.removed));
});
