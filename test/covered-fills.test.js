'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {opaqueImageBytes,imageCoversShape,pruneCoveredImageFills}=require('../figma-plugin/code.js');
const image=(overrides={})=>({type:'IMAGE',imageHash:'photo',scaleMode:'FILL',opacity:1,blendMode:'NORMAL',...overrides});
const jpeg=new Uint8Array([255,216,255,224,0,2,255,217]);
function png(type=2,transparent=false){
    const chunk=(name,bytes)=>{const b=Buffer.alloc(bytes.length+12);b.writeUInt32BE(bytes.length);b.write(name,4);Buffer.from(bytes).copy(b,8);return b;};
    const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=type;
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(transparent?[chunk('tRNS',[0,0,0,0,0,0])]:[]),chunk('IDAT',[1]),chunk('IEND',[])]);
}
function host(bytes=jpeg){let reads=0;return {api:{getImageByHash:()=>({getBytesAsync:async()=>{reads++;return bytes;}})},reads:()=>reads};}
function rect(fills){return {type:'RECTANGLE',fills};}
test('JPEG and non-alpha PNG headers establish opacity; alpha or unknown files retain their stack',()=>{
    assert.equal(opaqueImageBytes(jpeg),true);
    for(const type of [0,2,3])assert.equal(opaqueImageBytes(png(type)),true);
    for(const bytes of [png(6),png(4),png(2,true),png(3,true),new Uint8Array([1,2]),png().slice(0,30)])assert.equal(opaqueImageBytes(bytes),false);
});
test('coverage rejects fit, tiles, uncertain rotations, gaps and malformed crops',()=>{
    assert.equal(imageCoversShape(image()),true);
    assert.equal(imageCoversShape(image({rotation:90})),true);
    assert.equal(imageCoversShape(image({scaleMode:'CROP',imageTransform:[[.5,0,.25],[0,1,0]]})),true);
    for(const overrides of [{scaleMode:'FIT'},{scaleMode:'TILE'},{rotation:45},{scaleMode:'CROP'},{scaleMode:'CROP',imageTransform:[[1,0,.1],[0,1,0]]},{scaleMode:'CROP',imageTransform:[[1,.1,0],[0,1,0]]},{scaleMode:'CROP',imageTransform:[[NaN,0,0],[0,1,0]]}])assert.equal(imageCoversShape(image(overrides)),false);
});
test('last API paint is the top fill: preserve it and overlays while removing the bottom images',async()=>{
    const top=image({imageHash:'top-photo'}),overlay={type:'SOLID',opacity:.25},original=[image({imageHash:'bottom-photo'}),{type:'SOLID'},top,overlay];
    const clone=rect(original),h=host();const stats=await pruneCoveredImageFills(clone,h.api,new Map());
    assert.deepEqual(clone.fills,[top,overlay]);assert.equal(original.length,4);
    assert.equal(stats.removedImageFills,1);assert.equal(stats.removedPaints,2);assert.equal(stats.optimizedLayers,1);
});
test('a partially transparent or blended top image remains, with its visible supporting image',async()=>{
    for(const change of [{opacity:.5},{blendMode:'MULTIPLY'},{scaleMode:'FIT'}]){
        const top=image(change),base=image({imageHash:'base'}),node=rect([image({imageHash:'old'}),base,top]);
        const h=host();await pruneCoveredImageFills(node,h.api,new Map());assert.deepEqual(node.fills,[base,top]);
    }
});
test('transparent pixels or unavailable image bytes prevent pruning',async()=>{
    for(const api of [host(png(6)).api,{getImageByHash:()=>null},{getImageByHash:()=>({getBytesAsync:async()=>{throw new Error('Not available');}})}]){
        const fills=[image(),image({imageHash:'old'})],node=rect(fills);const result=await pruneCoveredImageFills(node,api,new Map());
        assert.equal(node.fills,fills);assert.equal(result.removedImageFills,0);
    }
});
test('opacity checks are cached by content hash across layers and repeated exports',async()=>{
    const cache=new Map(),h=host();
    for(let i=0;i<2;i++)await pruneCoveredImageFills({type:'FRAME',children:[rect([image(),image()]),rect([image(),image()])]},h.api,cache);
    assert.equal(h.reads(),1);assert.equal(await cache.get('photo'),true);
});
test('hidden fills cannot occlude, and text/vector region fills are left unchanged',async()=>{
    const h=host(),fills=[image({visible:false}),image({opacity:.5}),image({opacity:.5})];
    const nodes=[rect(fills),{type:'TEXT',fills:[image(),image()]},{type:'VECTOR',fills:[image(),image()]}];
    const result=await pruneCoveredImageFills({type:'FRAME',children:nodes},h.api,new Map());
    assert.equal(result.removedImageFills,0);assert.equal(nodes[0].fills,fills);assert.equal(h.reads(),0);
});
test('an unsupported fill assignment leaves the export usable',async()=>{
    const fills=[image(),image()],node={type:'RECTANGLE',get fills(){return fills;},set fills(v){throw new Error('Read only');}};
    assert.equal((await pruneCoveredImageFills(node,host().api,new Map())).removedImageFills,0);
    assert.equal(node.fills,fills);
});
