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
    // The helper becomes a white mask shape for a background-blur live filter, built after import.
    assert.equal(elements(parseXml(r.svg),'rect').length,5);
    assert.deepEqual(r.warnings,[]);
    assert.equal(r.backdrops.length,1);assert.match(r.svg,new RegExp('<rect[^>]*id="'+r.backdrops[0].marker+'"[^>]*fill="white"'));
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
test('background blur retains transfer artboards and names the affected layer',()=>{
    const svg=fixture('figma-backdrop-blur.svg').replace('<rect width="640"','<g id="FP_1"><rect width="640"').replace('<defs>','</g><g id="FP_3"/><defs>');
    const packet={format:'figma-affinity',version:2,name:'Two boards',frame:{width:640,height:360},
        svg,warnings:[],texts:[],layers:[{marker:'FP_1',name:'First'},{marker:'FP_2',name:'Dock Background'},{marker:'FP_3',name:'Second'}],
        artboards:[{marker:'FP_1',name:'First',x:0,y:0,width:640,height:360,layerMarkers:['FP_1','FP_2']},
        {marker:'FP_3',name:'Second',x:0,y:0,width:40,height:40,layerMarkers:['FP_3']}]};
    const r=compile(JSON.stringify(packet));
    assert.equal(r.artboards.length,2);
    assert.equal(r.artboards[0].name,'First');
    assert.deepEqual(r.warnings,[]);assert.equal(r.backdrops[0].name,'Dock Background');
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
    for (const input of ['<g transform="scale(2)"><rect filter="url(#f)"/></g>', '<g filter="url(#f)" transform="scale(2)"><rect/></g>']) {
        const r = compile('<svg><defs><filter id="f"><feGaussianBlur stdDeviation="4"/></filter></defs>' + input + '</svg>');
        assert.equal(r.effects.length, 0); assert.ok(r.warnings.length);
    }
    // Affinity draws effects in page space, so a scaled shape inside the blurred group is fine.
    assert.equal(compile('<svg><defs><filter id="f"><feGaussianBlur stdDeviation="4"/></filter></defs><g filter="url(#f)"><rect transform="scale(2)"/></g></svg>').effects.length, 1);
    const alpha = compile('<svg><defs><filter id="f"><feGaussianBlur in="SourceAlpha" stdDeviation="4"/></filter></defs><rect filter="url(#f)"/></svg>');
    assert.equal(alpha.effects.length, 0);
});

const blurred=transform=>'<svg width="400" height="400" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg"><g id="Blur" filter="url(#f)"><circle cx="50" cy="50" r="50" transform="'+transform+'" fill="#5BAAFF"/></g><defs><filter id="f" x="-500" y="-500" width="1400" height="1400" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="350" result="effect1_foregroundBlur"/></filter></defs></svg>';
test('layer blur survives rotated, flipped, skewed and scaled shapes inside the blurred group', () => {
    // Exact matrices from Figma exports: rotation plus a flip, a 0.1° rounding skew, and a real 28° skew.
    for (const transform of ['matrix(0.968309 -0.249754 -0.249754 -0.968309 100 200)', 'matrix(0.834695 0.550712 -0.549269 0.835646 1183.83 -61.7052)', 'matrix(-0.691249 0.722617 -0.963922 -0.266185 887.746 339.286)', 'scale(2)']) {
        const r = compile(blurred(transform));
        assert.equal(r.effects.length, 1, transform); assert.deepEqual(r.warnings, []);
    }
});

test('SVG text tracking is recorded in em so Affinity’s loader scaling can be corrected', () => {
    const svg = body => compile('<svg width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>').textTracking;
    assert.deepEqual(svg('<text id="A" font-size="100" letter-spacing="-0.035em"><tspan x="0" y="100">Hi</tspan></text>'), [{marker: 'A', characterSpacing: -0.035}]);
    assert.deepEqual(svg('<text id="B" font-size="100" letter-spacing="-4px"><tspan x="0" y="100">Hi</tspan></text>'), [{marker: 'B', characterSpacing: -0.04}]);
    assert.deepEqual(svg('<text id="C" font-size="100" letter-spacing="-0.04em"><tspan letter-spacing="0.1em">A</tspan><tspan>B</tspan></text>'), []);
    assert.deepEqual(svg('<text id="D" font-size="100"><tspan x="0" y="100">Hi</tspan></text>'), []);
});

test('SVG text font faces are recorded so variable-font weights can be restored', () => {
    const fonts = body => compile('<svg width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>').textFonts;
    assert.deepEqual(fonts('<text id="A" font-family="Affinity Serif Variable" font-style="italic" font-weight="bold"><tspan x="0" y="100">all</tspan></text>'), [{marker: 'A', family: 'Affinity Serif Variable', weight: 700, italic: true}]);
    assert.deepEqual(fonts('<g font-family="\'Inter\', sans-serif" font-weight="500"><text id="B"><tspan>new</tspan></text></g>'), [{marker: 'B', family: 'Inter', weight: 500, italic: false}]);
    assert.deepEqual(fonts('<text id="C" font-family="Inter"><tspan font-weight="bold">A</tspan><tspan>B</tspan></text>'), []);
});

test('Figma layer blurs on mask shapes are baked back into the SVG mask', () => {
    // Figma's SVG export drops the blur on a mask layer; Affinity rasterises SVG masks, so it goes back in the SVG.
    const svg = '<svg width="400" height="400" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg"><g id="FP_1"><mask id="m" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="100"><ellipse id="FP_2" cx="100" cy="50" rx="100" ry="50" fill="#D9D9D9"/></mask><g mask="url(#m)"><rect width="400" height="400" fill="#5A32FA"/></g></g></svg>';
    const packet = effects => JSON.stringify({format: 'figma-affinity', version: 1, name: 'Mask', frame: {width: 400, height: 400}, svg, texts: [], warnings: [],
        layers: [{marker: 'FP_1', name: 'Frame', type: 'FRAME', effects: []}, {marker: 'FP_2', name: 'Ellipse', type: 'ELLIPSE', effects}]});
    const r = compile(packet([{type: 'LAYER_BLUR', radius: 20, visible: true}]));
    assert.deepEqual(r.warnings, []); assert.equal(r.effects.length, 0);
    assert.match(r.svg, /<ellipse id="FP_2"[^>]*filter="url\(#FigmaPasteMaskBlur1\)"/);
    assert.match(r.svg, /<feGaussianBlur stdDeviation="10"\/>/);
    assert.match(r.svg, /<mask id="m"[^>]*x="-30" y="-30" width="260" height="160"/);
    assert.doesNotMatch(compile(packet([])).svg, /FigmaPasteMaskBlur/);
});

test('alpha masks are painted white so Affinity’s luminance masking keeps their opacity', () => {
    const r = compile('<svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">'
        + '<mask id="a" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><path d="M0 0H100V100H0Z" fill="#A956E0"/><rect y="100" width="200" height="100" fill="url(#g)"/><circle cx="50" cy="50" r="10" fill="#FF000080"/></mask>'
        + '<mask id="l" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200"><rect width="200" height="200" fill="#808080"/></mask>'
        + '<g mask="url(#a)"><rect width="200" height="200" fill="#00f"/></g><g mask="url(#l)"><rect width="200" height="200" fill="#f00"/></g>'
        + '<defs><linearGradient id="g" x1="0" y1="100" x2="0" y2="200" gradientUnits="userSpaceOnUse"><stop stop-color="#D9D9D9"/><stop offset="1" stop-color="#D9D9D9" stop-opacity="0"/></linearGradient></defs></svg>');
    const alpha = r.svg.match(/<mask id="a"[\s\S]*?<\/mask>/)[0];
    assert.match(alpha, /<path[^>]*fill="white"/); assert.match(alpha, /fill="url\(#FigmaPasteAlphaMask1\)"/);
    assert.match(alpha, /<circle[^>]*fill="white"[^>]*fill-opacity="0.50196/);
    assert.match(r.svg, /<linearGradient id="FigmaPasteAlphaMask1"[\s\S]*?stop-color="white" stop-opacity="1"[\s\S]*?stop-color="white" stop-opacity="0"/);
    assert.match(r.svg, /<linearGradient id="g"[\s\S]*?stop-color="#D9D9D9"/); // the original gradient is untouched
    assert.match(r.svg, /<mask id="l"[\s\S]*?fill="#808080"/); // luminance masks are left alone
});

test('Figma inside and outside strokes become native half-width aligned strokes', () => {
    const d = 'M10 10H90V90H10Z';
    const r = compile('<svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">'
        + '<mask id="out" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100" fill="black"><rect fill="white" x="0" y="0" width="100" height="100"/><path d="' + d + '"/></mask>'
        + '<path d="' + d + '" fill="#FF6105"/><path d="' + d + '" stroke="white" stroke-width="13.3" mask="url(#out)"/>'
        + '<clipPath id="in"><rect x="110" y="10" width="80" height="80" rx="8"/></clipPath>'
        + '<rect x="110" y="10" width="80" height="80" rx="8" stroke="#000" stroke-width="4" clip-path="url(#in)"/></svg>');
    assert.deepEqual(r.strokeAlignments.map(p => p.alignment), ['Outside', 'Inside']);
    assert.match(r.svg, /<path d="M10 10H90V90H10Z" stroke="white" stroke-width="6.65" id="FigmaPasteStroke1"\/>/);
    assert.match(r.svg, /<rect x="110"[^>]*stroke-width="2" id="FigmaPasteStroke2"\/>/);
    assert.deepEqual(r.warnings, []);
});
