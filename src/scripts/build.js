'use strict';
// Builds manifest.json, code.js and ui.html at the repo root, the ready-to-import Figma plugin:
// the importer is embedded in the panel and __VERSION__ comes from package.json.
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const MARKER='// Everything above is embedded in the Figma plugin';

function importer() {
    const source=read('affinity/importer.js');
    if(!source.includes(MARKER))throw new Error('affinity/importer.js is missing its export marker.');
    return source.split(MARKER)[0];
}
function files(version=JSON.parse(read('package.json')).version) {
    const stamp=file=>read(file).replaceAll('__VERSION__',version);
    const literal=JSON.stringify(importer()).replace(/</g,'\\u003c');
    return {
        'manifest.json':read('figma/manifest.json'),
        'code.js':stamp('figma/code.js'),
        'ui.html':stamp('figma/ui.html').replace('/* NATIVE_IMPORTER_AND_BRIDGE */',()=>'const NATIVE_IMPORTER='+literal+';\n'+stamp('figma/bridge.js')),
    };
}

if(require.main===module) {
    const out=path.join(root,'..');
    fs.mkdirSync(out,{recursive:true});
    for(const [name,content] of Object.entries(files()))fs.writeFileSync(path.join(out,name),content);
    console.log('Built the plugin at the repo root. In Figma, import manifest.json.');
}
module.exports={files,importer};
