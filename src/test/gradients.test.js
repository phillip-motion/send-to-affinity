'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {compile,svgTransform,multiplyAffine}=require('../affinity/importer.js');
const source=fs.readFileSync(__dirname+'/fixtures/linear-gradient-text.svg','utf8');
test('linear text gradients keep their SVG text and record its coordinate system',()=>{
    const r=compile(source);
    assert.deepEqual(r.linearTextGradients.map(p=>p.marker),['Plain','Rotated','Mixed styles']);
    assert.deepEqual(r.linearTextGradients[0].svgToSpread,[1,0,0,1,0,0]);
    assert.deepEqual(r.linearTextGradients[0].gradientToSpread,[540,100,-100,540,80,80]);
    assert.deepEqual(r.linearTextGradients[2].svgToSpread,[1,0,0,1,0,300]);
    assert.deepEqual(r.linearTextGradients[1].svgToSpread,svgTransform('translate(70 180) rotate(-8)'));
    assert.deepEqual(r.linearTextGradients[1].gradientToSpread,multiplyAffine(svgTransform('translate(70 180) rotate(-8)'),[540,100,-100,540,80,80]));
    assert.match(r.svg,/<text/);assert.match(r.svg,/font-weight="bold"/);assert.match(r.svg,/stop-opacity="0.6"/);
    assert.match(r.svg,/<rect id="Shape gradient"[^>]*fill="url\(#linear\)"/);
});
test('gradient transforms, inherited coordinates and percentage endpoints are resolved',()=>{
    const r=compile('<svg width="1000" height="500"><defs><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="10%" y1="20%" x2="90%" y2="40%"><stop/><stop offset="1"/></linearGradient><linearGradient id="b" xlink:href="#a" gradientTransform="translate(5 10) scale(2 3)"/></defs><g transform="translate(50 70)"><text fill="url(#b)"><tspan x="60" y="100">Research</tspan></text></g></svg>');
    assert.equal(r.linearTextGradients.length,1);
    assert.deepEqual(r.linearTextGradients[0].gradientToSpread,[1600,300,-200,2400,255,380]);
});
test('raw SVG gradient text receives a unique marker without losing opacity',()=>{
    const r=compile(source.replace('id="Plain"','opacity="0.7" fill-opacity="0.8"'));
    assert.match(r.linearTextGradients[0].marker,/^FigmaPasteGradientText/);
    assert.match(r.svg,/opacity="0.7" fill-opacity="0.8"/);
});
test('mixed paints and unsupported text coordinate systems are reported, not flattened',()=>{
    for(const svg of [
        source.replace('<tspan font-style="italic">','<tspan font-style="italic" fill="#FF0000">'),
        source.replace('<tspan font-style="italic">','<tspan font-style="italic" fill-opacity="0.5">'),
        source.replace('translate(0 300)','translate(0px 300px)')
    ]) {
        const r=compile(svg);
        assert.ok(!r.linearTextGradients.some(p=>p.marker==='Mixed styles'));
        assert.match(r.warnings.join('\n'),/Mixed styles: check the gradient on this text/);
    }
});
test('gradient definitions and cyclic inheritance do not become repair targets',()=>{
    const r=compile(source.replace('<clipPath id="clip">','<clipPath id="clip"><text fill="url(#linear)">Masked</text>'));
    assert.equal(r.linearTextGradients.length,3);
    const cyclic=compile('<svg><defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs><text fill="url(#a)">Text</text></svg>');
    assert.deepEqual(cyclic.linearTextGradients,[]);
});
test('SVG transforms compose in order and keep rotations around their centre',()=>{
    assert.deepEqual(svgTransform('translate(10,20) scale(2,3)'),[2,0,0,3,10,20]);
    const r=svgTransform('rotate(90 10 20)');
    assert.ok(Math.abs((r[0]*10+r[2]*20+r[4])-10)<1e-9);
    assert.ok(Math.abs((r[1]*10+r[3]*20+r[5])-20)<1e-9);
    assert.deepEqual(svgTransform('matrix(1 2 3 4 5 6)'),[1,2,3,4,5,6]);
    assert.deepEqual(multiplyAffine([1,0,0,1,5,6],[2,0,0,3,0,0]),[2,0,0,3,5,6]);
    assert.throws(()=>svgTransform('scale(0)'));
});
const angular=fs.readFileSync(__dirname+'/fixtures/figma-angular-gradient.svg','utf8');
test('Figma angular gradient helper is dropped and rebuilt as a native conical gradient',()=>{
    const r=compile(angular);
    assert.deepEqual(r.warnings,[]);
    assert.doesNotMatch(r.svg,/foreignObject|data-figma-skip-parse|data-figma-gradient-fill/);
    assert.match(r.svg,/<path[^>]*fill="rgb\(128,0,128\)"[^>]*id="FigmaPasteAngular1"/);
    const [spec]=r.angularGradients;
    assert.equal(spec.marker,'FigmaPasteAngular1');assert.deepEqual(spec.gradientToSpread,[200,0,0,200,100,100]);
    assert.deepEqual(spec.stops.map(s=>s.position),[0,.25,.75,1]);
    assert.deepEqual(spec.stops[0].rgba,spec.stops[3].rgba);
});
test('angular wrap colour matches the colour Figma writes at 0°',()=>{
    // Stops from a real export; Figma's CSS helper starts at rgba(220, 197, 73).
    const paint=JSON.stringify({type:'GRADIENT_ANGULAR',stops:[{color:{r:0,g:.50196,b:.035294,a:1},position:.403846},{color:{r:.858824,g:.078431,b:.172549,a:1},position:.538462},{color:{r:.956863,g:.803922,b:.313726,a:1},position:.956731}],transform:{m00:124.05,m01:-169.97,m02:421.47,m10:169.97,m11:124.05,m12:533.04},opacity:1});
    const r=compile(angular.replace(/data-figma-gradient-fill="[^"]*"/,'data-figma-gradient-fill="'+paint.replace(/"/g,'&#34;')+'"'));
    r.angularGradients[0].stops[0].rgba.slice(0,3).forEach((v,i)=>assert.ok(Math.abs(v*255-[220,197,73][i])<1));
});
test('diamond gradients import with a warning instead of blocking the design',()=>{
    const r=compile(angular.replace('GRADIENT_ANGULAR','GRADIENT_DIAMOND'));
    assert.equal(r.angularGradients.length,0);assert.doesNotMatch(r.svg,/foreignObject/);
    assert.match(r.warnings.join('\n'),/diamond gradients aren’t supported/);
});
