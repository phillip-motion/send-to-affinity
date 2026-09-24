'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {compile,parseXml,decodeImageBase64,imageAssetName,embedImageAssets,affinityBlurRadius,affinityEffectSettings,innerSpreadGeometry}=require('../affinity/importer.js');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image='<image id="photo" data-name="My photo.png" width="100" height="80" preserveAspectRatio="none" xlink:href="data:image/png;base64,'+png+'"/>';
const pattern='<pattern id="crop" patternContentUnits="objectBoundingBox" width="1" height="1"><use xlink:href="#photo" transform="matrix(.02 0 0 .0125 -.5 0)"/></pattern>';
const svg=shape=>'<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="120"><defs>'+image+pattern+'</defs>'+shape+'</svg>';
const all=n=>[n,...n.children.flatMap(c=>c.tag?all(c):[])];

test('Figma pattern crop becomes a clipped placed image while retaining geometry and original bytes',()=>{
    const r=compile(svg('<rect id="picture" x="10" y="20" width="100" height="80" rx="12" fill="url(#crop)" transform="rotate(10 60 60)" opacity=".6"/>'));
    assert.equal(r.assets.length,1);assert.equal(r.imageFills,1);
    assert.deepEqual(decodeImageBase64(r.assets[0].base64),new Uint8Array(Buffer.from(png,'base64')));
    const nodes=all(parseXml(r.svg)), wrapper=nodes.find(n=>n.attrs.id==='picture');
    assert.equal(wrapper.tag,'g');assert.equal(wrapper.attrs.opacity,'.6');assert.equal(wrapper.attrs.transform,'rotate(10 60 60)');
    assert.ok(nodes.some(n=>n.attrs.transform==='translate(10 20) scale(100 80)'));
    assert.ok(nodes.some(n=>n.attrs.transform==='matrix(.02 0 0 .0125 -.5 0)'));
    assert.equal(nodes.find(n=>n.tag==='clipPath').children[0].attrs.rx,'12');
});
test('repeated images share one saved file and independent crops',()=>{
    const r=compile(svg('<rect width="100" height="80" fill="url(#crop)"/><rect x="110" width="50" height="40" fill="url(#crop)"/>'));
    assert.equal(r.assets.length,1);assert.equal(r.imageFills,2);
    assert.equal(all(parseXml(r.svg)).filter(n=>n.tag==='clipPath').length,2);
});
test('direct embedded images are preserved and long image names cannot escape the image folder',()=>{
    const r=compile('<svg>'+image+'</svg>');assert.equal(r.assets.length,1);assert.equal(r.imageFills,0);
    const filename=imageAssetName('../../outside/evil:$().JPG',1,'jpeg');assert.equal(filename,'001-outside-evil.jpg');
    assert.ok(imageAssetName('x'.repeat(200),2,'png').length<90);
});
test('image fill opacity and vector outline remain separate',()=>{
    const r=compile(svg('<rect width="100" height="80" fill="url(#crop)" fill-opacity=".5" stroke="#ff0000" stroke-width="3"/>'));
    const group=all(parseXml(r.svg)).find(n=>n.attrs['data-figma-image-fill']);
    assert.equal(group.children[0].attrs.opacity,'.5');assert.equal(group.children[1].attrs.fill,'none');assert.equal(group.children[1].attrs.stroke,'#ff0000');
});
test('unsupported tiled patterns and path bounds are reported instead of guessing an image crop',()=>{
    for(const s of [svg('<path d="M0 0H100V80H0Z" fill="url(#crop)"/>'),svg('<rect width="100" height="80" fill="url(#crop)"/>').replace('patternContentUnits="objectBoundingBox" width="1"','patternContentUnits="objectBoundingBox" width=".5"')]){
        const r=compile(s);assert.equal(r.imageFills,0);assert.equal(r.assets.length,1);assert.ok(r.warnings.some(w=>/image fill couldn’t be converted/.test(w)));assert.match(r.svg,/fill="url\(#crop\)"/);
    }
});
test('base64 binary decoding handles padding and whitespace and rejects malformed data',()=>{
    for(let size=1;size<100;size++){
        const b=Buffer.from(Array.from({length:size},(_,i)=>(i*73+size)%256));assert.deepEqual(Buffer.from(decodeImageBase64(b.toString('base64'))),b);
    }
    assert.equal(Buffer.from(decodeImageBase64(' YW Jj\n')).toString(),'abc');
    for(const bad of ['','a','ab=c','!!!!','===='])assert.throws(()=>decodeImageBase64(bad));
});
test('untrusted external image links are still rejected',()=>{
    for(const link of ['file:///tmp/image.png','/tmp/image.png','Images/photo.png','https://example.com/photo.png'])assert.throws(()=>compile('<svg><image href="'+link+'"/></svg>'),/external asset/);
});
test('prepared SVG embeds each image geometry once and reuses it without external paths',()=>{
    const r=compile(svg('<rect width="100" height="80" fill="url(#crop)"/><rect width="100" height="80" x="100" fill="url(#crop)"/>'));
    const embedded=embedImageAssets(r.svg,r.assets),nodes=all(parseXml(embedded));
    assert.equal(nodes.filter(n=>n.tag==='image').length,1);
    assert.equal(nodes.find(n=>n.tag==='image').attrs['xlink:href'],'data:image/png;base64,'+png);
    assert.ok(nodes.filter(n=>n.tag==='use').length>=2);assert.ok(!embedded.includes('Images/'));
});
test('Figma 100 maps to Affinity 50 without halving an SVG standard deviation again',()=>{
    assert.equal(affinityBlurRadius({sigma:50}),50);
    assert.equal(affinityBlurRadius({sigma:100,figmaRadius:100}),50);
    const packet={format:'figma-affinity',version:1,frame:{width:200,height:200},texts:[],warnings:[],layers:[{marker:'FP_1',name:'Blur',effects:[{type:'LAYER_BLUR',radius:100,visible:true}]}],svg:'<svg width="200" height="200"><defs><filter id="f"><feGaussianBlur stdDeviation="50"/></filter></defs><rect id="FP_1" width="100" height="100" filter="url(#f)"/></svg>'};
    const out=compile(JSON.stringify(packet));assert.equal(affinityBlurRadius(out.effects[0].native[0]),50);
});
test('Gaussian SDK radius accounts for the panel dividing by three: Figma 390.6 displays 195.3',()=>{
    for(const effect of [{kind:'blur',sigma:195.3},{kind:'blur',sigma:195.3,figmaRadius:390.6}]){
        const applied=affinityEffectSettings(effect);
        assert.ok(Math.abs(applied.radius-585.9)<1e-10);
        assert.ok(Math.abs(applied.radius/3-195.3)<1e-10);
    }
});
test('shadow kernel radius matches Gaussian softness while preserving offsets and both directions',()=>{
    for(const kind of ['outerShadow','innerShadow'])for(const dy of [-4,4]){
        const fx=affinityEffectSettings({kind,sigma:10,dx:3,dy});
        assert.equal(fx.radius,30);assert.equal(fx.offset,5);assert.equal(fx.intensity,0);
        assert.ok(Math.abs(Math.cos(fx.angle)*fx.offset-3)<1e-10);
        assert.ok(Math.abs(Math.sin(fx.angle)*fx.offset-dy)<1e-10);
    }
    assert.deepEqual(affinityEffectSettings({kind:'outerShadow',sigma:0,spread:2,dx:0,dy:0}),{radius:2,offset:0,angle:0,intensity:1});
});
const roundedButton='<path d="M10 20C10 14.477 14.477 10 20 10H100C105.523 10 110 14.477 110 20V40C110 45.523 105.523 50 100 50H20C14.477 50 10 45.523 10 40V20Z" fill="#8B3DFF"/>';
test('negative inner spread retains a square dilation and a separate unchanged clip silhouette',()=>{
    const shape=parseXml('<svg>'+roundedButton+'</svg>').children[0];
    const result=innerSpreadGeometry(shape,-5,0,8,6);
    assert.ok(result);assert.match(result.d,/M5 23C5 17.477 9.477 13 15 13H105/);
    assert.equal(result.clip.attrs.d,shape.attrs.d);assert.equal(result.clip.attrs.fill,undefined);
    assert.equal(innerSpreadGeometry({...shape,attrs:{...shape.attrs,transform:'scale(2)'}},-5,0,8,6),null);
    assert.equal(innerSpreadGeometry({tag:'path',attrs:{d:'M0 0L40 0L20 30Z'},children:[]},-5,0,8,6),null);
});
test('button negative spread becomes a clipped editable blur, with no duplicate native inner shadow',()=>{
    const filter='<filter id="inner"><feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hard"/><feMorphology in="SourceAlpha" operator="dilate" radius="5"/><feOffset dy="8"/><feGaussianBlur stdDeviation="6"/><feComposite in2="hard" operator="arithmetic" k2="-1" k3="1"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .16 0"/><feBlend in2="SourceGraphic"/></filter>';
    const source='<svg><defs>'+filter+'</defs><g id="Button" filter="url(#inner)">'+roundedButton+'<text x="25" y="35">Share</text></g></svg>';
    const r=compile(source),fx=r.effects.flatMap(e=>e.native),nodes=all(parseXml(r.svg));
    assert.equal(fx.length,1);assert.equal(fx[0].kind,'blur');assert.equal(fx[0].countAs,'innerShadow');assert.equal(affinityEffectSettings(fx[0]).radius,18);
    assert.ok(nodes.some(n=>n.tag==='clipPath'));assert.ok(nodes.some(n=>n.attrs['fill-rule']==='evenodd'));
    assert.ok(!r.warnings.some(w=>/shadow spread isn’t supported/i.test(w)));
    const unsupported=compile(source.replace(roundedButton,'<path d="M0 0L40 0L20 30Z"/>'));
    assert.ok(unsupported.warnings.some(w=>/shadow spread isn’t supported/i.test(w)));
});
test('new Figma hard-alpha and spread graphs retain their native shadow stack',()=>{
    const hard='<feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hard"/>';
    const tint='<feColorMatrix values="0 0 0 0 0.1 0 0 0 0 0.2 0 0 0 0 0.3 0 0 0 0.4 0"/>';
    const source='<svg><defs><filter id="f">'+hard+'<feOffset dx="3" dy="8"/><feGaussianBlur stdDeviation="4"/><feComposite in2="hard" operator="out"/>'+tint+'<feBlend in2="SourceGraphic" result="shape"/>'+hard+'<feMorphology in="SourceAlpha" operator="dilate" radius="2"/><feComposite in2="hard" operator="out"/>'+tint+'<feBlend in2="shape"/></filter></defs><rect width="50" height="50" filter="url(#f)"/></svg>';
    const out=compile(source),fx=out.effects[0].native;
    assert.equal(fx.length,2);assert.equal(fx[0].dy,8);assert.equal(fx[0].opacity,.4);assert.equal(fx[1].spread,2);assert.ok(out.warnings.some(w=>/shadow spread is approximate/.test(w)));
});
