'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {compile, parseXml, workingFolder, nativeStep} = require('../affinity/importer.js');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const elements = (node, tag) => [node, ...node.children.flatMap(n => n.tag ? elements(n, '*') : [])].filter(n => tag === '*' || n.tag === tag);

test('working-folder selection respects the script permission and only uses configured roots', () => {
    assert.throws(() => workingFolder(['/test/Desktop'], false), /needs file access/);
    assert.throws(() => workingFolder([], true), /no folder/);
    assert.equal(workingFolder(['/test/Desktop'], true), '/test/Desktop');
    assert.equal(workingFolder(['/test/Desktop', '/test/Figma Paste Sources/'], true), '/test/Figma Paste Sources');
});

test('file permission failures identify the blocked step and folder', () => {
    assert.throws(() => nativeStep('saving the SVG source', '/test/Figma Paste Sources', () => { throw new Error('PERMISSION_DENIED'); }), error => {
        assert.match(error.message, /saving the SVG source/);
        assert.match(error.message, /\/test\/Figma Paste Sources/);
        assert.match(error.message, /Model Context Protocol/);
        return true;
    });
    assert.equal(nativeStep('test', '/test', () => 12), 12);
});

test('CommonJS loading exports the importer without opening an Affinity dialog', () => {
    const sandbox = {process: {versions: {node: 'test'}}, module: {exports: {}}, require() { assert.fail('Node import must not open Affinity'); }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../affinity/importer.js'), 'utf8'), sandbox, {timeout:1000});
    assert.equal(typeof sandbox.module.exports.compile, 'function');
});

test('native import explicitly loads at 72 DPI and applies calibrated kernel radii',()=>{
    let loadOptions,storedBytes;
    const node={userDescription:'blur',quickFX:[]};
    const doc={layers:{all:{toArray:()=>[node]}},enumerateFontNames(){},
        setGaussianBlurLayerEffect(n,fx){n.quickFX.push(fx);}};
    const libs={
        '/fs.js':{FileSystemApi:{exists:()=>false,createDirectories(){},isDirectory:()=>true},File:{create:()=>({isOpen:true,write(b){storedBytes=b;},flush(){},getLength:()=>storedBytes.length,close(){}})}},
        '/buffer.js':{Buffer:{utf8:s=>Buffer.from(s)}},
        'affinity:dom':{DocumentApi:{load(p,options){loadOptions=options;return {document:doc};}}},
        '/document.js':{Document:class{constructor(){return doc;}},LoadDocumentOptions:{createDefault:()=>({get handle(){return this;}})}},
        '/layereffects.js':{GaussianBlurLayerEffect:{create:()=>({isGaussianBlurLayerEffect:true})}},
        '/colours.js':{}
    };
    const sandbox={process:{versions:{node:'test'}},module:{exports:{}},console:{log(){}},require:id=>{assert.ok(libs[id],id);return libs[id];}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../affinity/importer.js'),'utf8'),sandbox);
    const out=sandbox.module.exports.importPrepared({svg:'<svg/>',warnings:[],effects:[{marker:'blur',name:'Figma blur',native:[{kind:'blur',sigma:195.3,figmaRadius:390.6}]}]},'/test');
    assert.equal(loadOptions.dpi,72);assert.equal(out.counts.blur,1);
    assert.ok(Math.abs(node.quickFX[0].radius/3-195.3)<1e-10);
});

test('provided SVG keeps exact logo geometry and all three editable blur specifications', () => {
    const source = fixture('figma-template.svg'), output = compile(source);
    const original = parseXml(source), result = parseXml(output.svg);
    assert.equal(elements(result, 'path')[0].attrs.d, elements(original, 'path')[0].attrs.d);
    assert.equal(elements(result, 'ellipse').length, 3);
    assert.deepEqual(output.effects.map(e => e.sigma), [181.933, 200, 181.933]);
    assert.equal(result.attrs.width, '1920'); assert.equal(result.attrs.height, '1080');
    assert.equal(elements(result, 'clipPath').length, 1);
    assert.equal(elements(result, 'linearGradient').length, 1);
    assert.equal(elements(result, 'g').filter(n => n.attrs.filter).length, 0);
});
test('native-filter mode preserves source filter references', () => {
    const r = compile(fixture('figma-template.svg'), {repairBlur:false});
    assert.equal(r.effects.length, 0);
    assert.equal(elements(parseXml(r.svg), 'g').filter(n => n.attrs.filter).length, 3);
});
test('Figma shadow filter graphs preserve shadow kinds, tint, opacity and offsets', () => {
    const result = compile(fixture('native-shadow-test.svg'));
    assert.equal(result.effects.length, 2);
    const [outer, inner] = result.effects.map(spec => spec.native[0]);
    assert.deepEqual(outer, {kind:'outerShadow', sigma:4, dx:0, dy:24, rgb:[0,0,0], opacity:0.7, knocksOut:true});
    assert.equal(inner.kind, 'innerShadow');
    assert.equal(inner.dy, 24);
    assert.equal(inner.sigma, 4);
    assert.equal(elements(parseXml(result.svg), 'rect').filter(n => n.attrs.filter).length, 0);
});
test('unknown filter inputs and missing definitions keep their filters and report them', () => {
    for (const svg of ['<svg><rect filter="url(#missing)"/></svg>', '<svg><defs><filter id="f"><feGaussianBlur in="BackgroundImage" stdDeviation="4"/></filter></defs><rect filter="url(#f)"/></svg>']) {
        const result=compile(svg);
        assert.equal(result.effects.length, 0);
        assert.ok(result.warnings.length);
        assert.ok(elements(parseXml(result.svg),'rect')[0].attrs.filter);
    }
});
test('unsupported filters are retained with a warning', () => {
    const r = compile('<svg><defs><filter id="f"><feOffset dx="2"/><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="5" height="5" filter="url(#f)"/></svg>');
    assert.equal(r.effects.length, 0); assert.match(r.warnings[0], /effect couldn’t be converted/);
    assert.equal(elements(parseXml(r.svg), 'rect')[0].attrs.filter, 'url(#f)');
});
test('malformed XML and active or externally linked SVG are rejected', () => {
    const inputs = ['', '<svg><g></svg>', '<svg/>garbage', '<svg/><svg/>', '<svg x="1" x="2"/>', '<!DOCTYPE svg><svg/>', '<svg><script/></svg>', '<svg onload="evil()"/>', '<svg><image href="file:///tmp/private.png"/></svg>', '<svg><image href="https://example.com/image.png"/></svg>', '<svg><rect fill="url(https://example.com/p)"/></svg>'];
    for (const input of inputs) assert.throws(() => compile(input), undefined, input);
});
test('Figma backdrop helper does not block artwork or its native shadow',()=>{
    const r=compile(fixture('figma-backdrop-blur.svg'));
    assert.doesNotMatch(r.svg,/foreignObject|<div/);
    assert.equal(r.effects.length,1);
    assert.equal(r.effects[0].name,'FP_2');
    assert.ok(elements(parseXml(r.svg),'rect').find(n=>n.attrs.id===r.effects[0].marker));
    assert.equal(r.effects[0].native[0].kind,'outerShadow');
    assert.equal(r.effects[0].native[0].sigma,4);
    assert.equal(elements(parseXml(r.svg),'rect').length,4);
    assert.match(r.warnings.join('\n'),/background blur isn’t supported/);
    assert.equal(r.effects.filter(e=>e.native.some(f=>f.kind==='blur')).length,0,'do not blur the foreground instead');
    assert.doesNotThrow(()=>compile(fixture('figma-backdrop-blur.svg'),{repairBlur:false}));
});
test('foreignObject exception cannot discard meaningful HTML or active content',()=>{
    const svg=fixture('figma-backdrop-blur.svg');
    const invalid=[
        svg.replace('</div>','Actual label</div>'),
        svg.replace('</div>','<script>alert(1)</script></div>'),
        svg.replace('</div>','<img src="https://example.com/a.png"/></div>'),
        svg.replace('<div xmlns','<div onload="alert(1)" xmlns'),
        svg.replace('<foreignObject x','<foreignObject onload="alert(1)" x'),
        svg.replace('height:100%','background:red;height:100%'),
        svg.replace('url(#bgblur_1_2_clip_path)','url(https://example.com/clip)'),
        svg.replace('data-figma-bg-blur-radius="40"','data-figma-bg-blur-radius="60"'),
        svg.replace('id="bgblur_1_2_clip_path"','id="other"'),
        svg.replace(/foreignObject/g,'svg:foreignObject'),
        '<svg><foreignObject><div>Text</div></foreignObject></svg>',
        '<svg><svg:script xmlns:svg="http://www.w3.org/2000/svg"/></svg>',
        '<svg><svg:style xmlns:svg="http://www.w3.org/2000/svg"/></svg>'
    ];
    for(const input of invalid)assert.throws(()=>compile(input),/foreignObject|Active SVG|style sheets/);
});
test('backdrop omission retains transfer artboards and names the affected layer',()=>{
    const svg=fixture('figma-backdrop-blur.svg').replace('<rect width="640"','<g id="FP_1"><rect width="640"').replace('<defs>','</g><g id="FP_3"/><defs>');
    const packet={format:'figma-affinity',version:2,name:'Two boards',frame:{width:640,height:360},
        svg,warnings:[],texts:[],layers:[{marker:'FP_1',name:'First'},{marker:'FP_2',name:'Dock Background'},{marker:'FP_3',name:'Second'}],
        artboards:[{marker:'FP_1',name:'First',x:0,y:0,width:640,height:360,layerMarkers:['FP_1','FP_2']},
        {marker:'FP_3',name:'Second',x:0,y:0,width:40,height:40,layerMarkers:['FP_3']}]};
    const r=compile(JSON.stringify(packet));
    assert.equal(r.artboards.length,2);
    assert.equal(r.artboards[0].name,'First');
    assert.match(r.warnings.join('\n'),/Dock Background: background blur isn’t supported/);
    assert.ok(r.effects.find(e=>e.name==='FP_2'));
});
test('XML entities, self-closing SVG and internal references are accepted', () => {
    const r = compile('<svg width="10" height="10"><title>A &amp; B</title><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>');
    assert.equal(elements(parseXml(r.svg), 'title')[0].children[0].text, 'A & B');
    assert.equal(compile('<svg/>').effects.length, 0);
    assert.doesNotThrow(() => compile('<svg><rect fill="url( #g )"/></svg>'));
    assert.doesNotThrow(() => compile('<svg><rect fill="url(&quot;#g&quot;)"/></svg>'));
});
test('existing IDs remain intact when assigning a native blur', () => {
    const r = compile('<svg><defs><filter id="f"><feGaussianBlur stdDeviation="4"/></filter></defs><rect id="box" filter="url(#f)"/><use href="#box"/></svg>');
    assert.equal(r.effects[0].marker, 'box');
    assert.equal(elements(parseXml(r.svg), 'use')[0].attrs.href, '#box');
});
test('scaled and SourceAlpha filters remain delegated instead of receiving an incorrect native effect', () => {
    for (const input of ['<g transform="scale(2)"><rect filter="url(#f)"/></g>', '<g filter="url(#f)"><rect transform="scale(2)"/></g>']) {
        const r = compile('<svg><defs><filter id="f"><feGaussianBlur stdDeviation="4"/></filter></defs>' + input + '</svg>');
        assert.equal(r.effects.length, 0); assert.ok(r.warnings.length);
    }
    const alpha = compile('<svg><defs><filter id="f"><feGaussianBlur in="SourceAlpha" stdDeviation="4"/></filter></defs><rect filter="url(#f)"/></svg>');
    assert.equal(alpha.effects.length, 0);
});
