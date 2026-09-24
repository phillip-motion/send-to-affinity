/* Local transport only. Import logic executes inside Affinity, never in a helper. */
'use strict';
const SETUP_MESSAGE='Can’t reach Affinity. Open Affinity, then go to **Settings** → **Model Context Protocol** and turn on both *Enable Affinity MCP* and *Access Files on your Desktop*.';
class AffinityConnection {
    constructor({EventSourceClass=globalThis.EventSource,fetchFn=globalThis.fetch,timeoutMs=120000}={}) {
        this.EventSourceClass=EventSourceClass;this.fetchFn=fetchFn.bind(globalThis);this.timeoutMs=timeoutMs;
        this.base='http://localhost:6767';this.pending=new Map();this.serial=0;
    }
    async connect() {
        this.close();
        try {
            this.endpoint=await new Promise((resolve,reject)=>{
                const stream=this.stream=new this.EventSourceClass(this.base+'/sse');
                let opened=false;
                const timeout=setTimeout(()=>reject(new Error(SETUP_MESSAGE)),4000);
                stream.addEventListener('endpoint',event=>{
                    clearTimeout(timeout);opened=true;
                    try{
                        const url=new URL(event.data,this.base);
                        if(url.origin!==this.base || url.pathname!=='/message')throw new Error('Unexpected Affinity connection address.');
                        resolve(url.href);
                    }catch(e){reject(e);}
                });
                stream.onmessage=event=>{
                    let message;try{message=JSON.parse(event.data);}catch(e){return;}
                    const p=this.pending.get(message.id);if(!p)return;
                    this.pending.delete(message.id);clearTimeout(p.timer);
                    if(message.error)p.reject(new Error(message.error.message || 'Affinity rejected the request.'));
                    else p.resolve(message.result);
                };
                stream.onerror=()=>{
                    clearTimeout(timeout);
                    const error=new Error(opened ? 'The connection to Affinity closed. If import had started, check Affinity before sending again.' : SETUP_MESSAGE);
                    reject(error);this.close(error);
                };
            });
            await this.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Send to Affinity',version:'__VERSION__'}});
            await this.rpc('notifications/initialized',{},true);
            await this.tool('read_sdk_documentation_topic',{filename:'preamble'});
        } catch(e){this.close(e);throw e;}
    }
    rpc(method,params,notification=false) {
        if(!this.stream || !this.endpoint)return Promise.reject(new Error('Connect to Affinity first.'));
        const id=++this.serial,body={jsonrpc:'2.0',method,params};if(!notification)body.id=id;
        return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{
                this.pending.delete(id);
                reject(new Error('Affinity has not replied yet. Check Affinity before sending again; it may still be importing.'));
            },this.timeoutMs);
            if(!notification)this.pending.set(id,{resolve,reject,timer});
            this.fetchFn(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
                .then(response=>{
                    if(!response.ok)throw new Error('Affinity returned HTTP '+response.status+'.');
                    if(notification){clearTimeout(timer);resolve();}
                }).catch(error=>{clearTimeout(timer);this.pending.delete(id);reject(error);});
        });
    }
    async tool(name,args) {
        const result=await this.rpc('tools/call',{name,arguments:args});
        const output=(result?.content || []).filter(c=>c.type==='text').map(c=>c.text).join('\n');
        if(result?.isError)throw new Error(output || 'Affinity could not complete the import.');
        return output;
    }
    close(error=new Error('Connection closed.')) {
        if(this.stream)this.stream.close();this.stream=null;this.endpoint=null;
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    }
}
function nativeImportScript(source,transfer) {
    // Both layers of serialization are intentional: design data is a string
    // literal passed to the parser, never executable JavaScript.
    return source+'\nconst __transfer='+JSON.stringify(transfer)+';\n'+
        "let __stage='preflight';try {\n"+
        "const {Environment,EnvironmentPermission}=require('/environment.js');\n"+
        'const __start=Date.now();const __compiled=compile(__transfer);const __compileMs=Date.now()-__start;\n'+
        'const __folder=workingFolder(Environment.fileSystemRoots,Environment.hasPermission(EnvironmentPermission.FileSystem));\n'+
        "__stage='import';const __imported=importPrepared(__compiled,__folder);\n"+
        "console.log('FIGMA_PASTE_RESULT:'+JSON.stringify({documentId:__imported.document.sessionUuid,name:__compiled.packet?.name || 'Figma design',artboards:__imported.artboards,counts:__imported.counts,imageLayers:__imported.imageLayers,linearGradientTextLayers:__imported.linearGradientTextLayers,textLayers:__imported.textLayers,warnings:__imported.warnings,stages:__imported.timings,timings:{compileMs:__compileMs,importMs:Date.now()-__start-__compileMs,totalMs:Date.now()-__start}}));\n"+
        "} catch(__error) { console.log('FIGMA_PASTE_ERROR:'+JSON.stringify({stage:__stage,message:__error.message || String(__error)})); }";
}
function readImportResult(output) {
    const errorPrefix='FIGMA_PASTE_ERROR:',errorAt=output.lastIndexOf(errorPrefix);
    if(errorAt>=0) {
        const error=JSON.parse(output.slice(errorAt+errorPrefix.length).trim());
        throw new Error((error.stage==='preflight' ? 'Import did not start. ' : 'Import stopped. Check Affinity’s document tabs before sending again. ')+(error.message || 'Affinity could not import this design.'));
    }
    const prefix='FIGMA_PASTE_RESULT:',at=output.lastIndexOf(prefix);
    if(at<0)throw new Error('Affinity did not confirm completion. Check its document tabs before sending again. '+output.slice(0,1200));
    const result=JSON.parse(output.slice(at+prefix.length).trim());
    if(!result.documentId)throw new Error('Affinity returned an incomplete import report.');
    return result;
}
if(typeof module==='object')module.exports={AffinityConnection,nativeImportScript,readImportResult};
