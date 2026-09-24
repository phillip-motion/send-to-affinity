'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {AffinityConnection,nativeImportScript,readImportResult}=require('../figma/bridge.js');

function transport({endpoint='/message?sessionId=test',reply,failFetch=false}={}) {
    let stream;const sent=[];
    class Events {
        constructor(url){this.url=url;stream=this;}
        addEventListener(name,fn){if(name==='endpoint')queueMicrotask(()=>fn({data:endpoint}));}
        close(){this.closed=true;}
    }
    async function fetchFn(url,options) {
        assert.equal(this,globalThis,'browser fetch requires its Window receiver');
        const request=JSON.parse(options.body);sent.push(request);
        assert.equal(url,'http://localhost:6767/message?sessionId=test');
        if(failFetch)throw new Error('Connection lost');
        if(request.id && reply!==false)queueMicrotask(()=>stream.onmessage({data:JSON.stringify({id:request.id,...(reply || {result:{content:[{type:'text',text:'ok'}]}})})}));
        return {ok:true,status:202};
    }
    return {connection:new AffinityConnection({EventSourceClass:Events,fetchFn,timeoutMs:20}),sent,stream:()=>stream};
}
test('local connection initializes and reads the SDK preamble before importing',async()=>{
    const t=transport();await t.connection.connect();
    assert.deepEqual(t.sent.map(r=>r.method),['initialize','notifications/initialized','tools/call']);
    assert.equal(t.sent[2].params.name,'read_sdk_documentation_topic');
    assert.equal(await t.connection.tool('execute_script',{script:'test'}),'ok');
    t.connection.close();assert.equal(t.stream().closed,true);assert.equal(t.connection.pending.size,0);
});
test('server cannot redirect the transfer to another host or route',async()=>{
    for(const endpoint of ['https://example.com/message','http://localhost:9000/message','/other']){
        const t=transport({endpoint});await assert.rejects(t.connection.connect(),/Unexpected/);
        assert.equal(t.sent.length,0);assert.ok(t.stream().closed);
    }
});
test('disconnects, protocol errors and timeouts do not replay imports',async()=>{
    for(const options of [{failFetch:true},{reply:{error:{message:'Rejected'}}},{reply:false}]){
        const t=transport(options);await assert.rejects(t.connection.connect());
        assert.equal(t.sent.length,1);assert.equal(t.connection.pending.size,0);assert.ok(t.stream().closed);
    }
});
test('native transfer treats quotes, Unicode and script-looking design data as data',()=>{
    const input='世界 👋 </script> ` ${throwError()} \";globalThis.injected=true;//\n';
    let received,reported;
    const context={compile:value=>(received=value,{packet:{name:'Test'}}),workingFolder:()=>'/allowed',
        importPrepared:()=>({document:{sessionUuid:'test'},counts:{},imageLayers:1,textLayers:2,warnings:[]}),
        require:()=>({Environment:{fileSystemRoots:[],hasPermission:()=>true},EnvironmentPermission:{FileSystem:1}}),
        console:{log:value=>reported=value}};
    vm.runInNewContext(nativeImportScript('',input),context);
    assert.equal(received,input);assert.equal(context.injected,undefined);
    assert.equal(readImportResult(reported).documentId,'test');
});
test('missing or incomplete completion reports cannot be shown as successful',()=>{
    assert.throws(()=>readImportResult('Error: Could not load document'),/did not confirm/);
    assert.throws(()=>readImportResult('FIGMA_PASTE_RESULT:{}'),/incomplete/);
});
test('preflight failures report that import never started and do not call the importer',()=>{
    for(const failure of ['compile','permissions']) {
        let called=false,reported;
        vm.runInNewContext(nativeImportScript('','bad transfer'),{
            compile:()=>{if(failure==='compile')throw new Error('Unsupported HTML');return {};},
            workingFolder:()=>{throw new Error('No allowed folder');},
            importPrepared:()=>{called=true;},
            require:()=>({Environment:{fileSystemRoots:[],hasPermission:()=>true},EnvironmentPermission:{FileSystem:1}}),
            console:{log:value=>reported=value}
        });
        assert.equal(called,false);
        assert.throws(()=>readImportResult(reported),new RegExp('Import did not start.*'+(failure==='compile'?'Unsupported HTML':'No allowed folder')));
        assert.doesNotMatch(reported,/FIGMA_PASTE_RESULT/);
    }
});
test('failures after import begins retain the partial-document warning',()=>{
    let reported;
    vm.runInNewContext(nativeImportScript('','<svg/>'),{
        compile:()=>({}),workingFolder:()=>'/allowed',importPrepared:()=>{throw new Error('Native failure');},
        require:()=>({Environment:{fileSystemRoots:[],hasPermission:()=>true},EnvironmentPermission:{FileSystem:1}}),
        console:{log:value=>reported=value}
    });
    assert.throws(()=>readImportResult(reported),/Import stopped.*Check Affinity.*Native failure/);
});
test('built panel embeds the importer verbatim, stamps the version and parses',()=>{
    const {files,importer}=require('../scripts/build.js');
    const built=files('9.9.9');
    for(const name of ['code.js','ui.html'])assert.doesNotMatch(built[name],/__VERSION__/);
    assert.match(built['ui.html'],/9\.9\.9/);
    const js=built['ui.html'].slice(built['ui.html'].indexOf('<script>')+8,built['ui.html'].lastIndexOf('</script>'));
    new vm.Script(js);
    const literal=js.split('\n').find(l=>l.startsWith('const NATIVE_IMPORTER='));
    assert.equal(vm.runInNewContext(literal+'NATIVE_IMPORTER;'),importer());
    assert.doesNotMatch(importer(),/module\.exports/);
    assert.equal(built['ui.html'].match(/<script>/g).length,1);
});
test('refused connection explains how to enable Affinity MCP',async()=>{
    class Refused {constructor(){queueMicrotask(()=>this.onerror());} addEventListener(){} close(){}}
    await assert.rejects(new AffinityConnection({EventSourceClass:Refused,fetchFn:()=>{}}).connect(),/Enable Affinity MCP/);
});
function panel(tool) {
    const elements=new Map(),posted=[],timers=[];
    const element=id=>{
        if(!elements.has(id))elements.set(id,{hidden:false,textContent:'',getBoundingClientRect:()=>({bottom:84}),classList:{toggle(){},remove(){}},replaceChildren(...nodes){this.textContent=nodes.map(n=>n.textContent).join('');}});
        return elements.get(id);
    };
    const context={document:{getElementById:element,createElement:()=>({}),createTextNode:textContent=>({textContent}),body:{},documentElement:{scrollHeight:106},body:{}},
        parent:{postMessage:m=>posted.push(JSON.parse(JSON.stringify(m.pluginMessage)))},window:{addEventListener(){}},
        ResizeObserver:class {observe(){}},timers,setTimeout:fn=>timers.push(fn),clearTimeout(){},
        AffinityConnection:class {async connect(){} tool(){return tool;} close(){}},
        nativeImportScript:()=>'',readImportResult};
    const html=fs.readFileSync(path.join(__dirname,'../figma/ui.html'),'utf8');
    const script=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>')).replace('/* NATIVE_IMPORTER_AND_BRIDGE */',"const NATIVE_IMPORTER='';");
    vm.createContext(context);vm.runInContext(script,context);
    const receive=message=>context.window.onmessage({data:{pluginMessage:message}});
    return {element,posted,receive,timers};
}
test('changing selection during send preserves completion and re-enables Send',async()=>{
    let finish;const sent=new Promise(resolve=>finish=resolve);
    const {element,posted,receive,timers}=panel(sent);
    await receive({type:'selection',selectionId:'first',valid:true,label:'1 layer selected'});
    await element('send').onclick();
    assert.deepEqual(posted.at(-1),{type:'prepare',selectionId:'first'});
    const running=receive({type:'prepared',selectionId:'first',packet:{name:'First',svg:'<svg/>',texts:[],warnings:[]},timings:{totalMs:1}});
    await Promise.resolve();
    await receive({type:'selection',selectionId:'second',valid:true,label:'2 frames selected'});
    finish('FIGMA_PASTE_RESULT:'+JSON.stringify({documentId:'native',name:'First',imageLayers:1,textLayers:2,warnings:['Font missing'],timings:{compileMs:1,importMs:1}}));
    await running;
    assert.equal(element('status').textContent,'Done');assert.equal(element('status').className,'success');
    timers.at(-1)();assert.equal(element('status').textContent,'2 frames selected');
    assert.equal(element('review').hidden,false);
    assert.equal(element('send').disabled,false);
});
test('errors show a short title with formatted instructions below',async()=>{
    const {element,receive}=panel();
    await receive({type:'error',message:'Can’t reach Affinity. Go to **Settings** and turn on *Enable Affinity MCP*.'});
    assert.equal(element('status').textContent,'Can’t reach Affinity.');assert.equal(element('status').className,'error');
    assert.equal(element('detail').textContent,'Go to Settings and turn on Enable Affinity MCP.');assert.equal(element('detail').hidden,false);
    await receive({type:'selection',selectionId:'a',valid:true,label:'1 layer selected'});
    assert.equal(element('detail').hidden,true);
});
