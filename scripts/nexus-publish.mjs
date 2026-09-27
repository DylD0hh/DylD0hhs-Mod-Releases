// Nexus v3 schema: Nexus-Mods/upload-action/src/openapi.schema.ts.
// Runs only in GitHub Actions. No key is accepted by the application or synced.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export async function publishNexus(p,{fetcher=fetch,checkpoint=async()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),log=console.log}={}){
 const id=v=>{if(!/^[A-Za-z0-9-]+$/.test(String(v||'')))throw Error('Invalid Nexus identifier');return String(v);};
 const api=async(path,method='GET',body)=>{let r;try{r=await fetcher('https://api.nexusmods.com/v3'+path,{method,headers:{apikey:p.apiKey,'Content-Type':'application/json','User-Agent':'DylD0hhs-Release-Manager'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});}catch{throw Error(`Nexus ${method} ${path.split('/')[1]} network failure; inspect the existing attempt before retrying.`);}log(`service=nexus operation=${method} ${path.replace(/[a-f0-9-]{20,}/gi,'{id}')} status=${r.status}`);if(!r.ok)throw Error(`Nexus ${method} ${path.split('/')[1]} HTTP ${r.status}. No credentials or raw response included.`);return (await r.json()).data;};
 const mod=await api('/games/7daystodie/mods/'+id(p.modId));if(String(mod.game_scoped_id)!==p.modId)throw Error('Nexus game-scoped identity mismatch');
 const globalId=id(mod.id),existing=await api(`/mods/${globalId}/files`);if(!Array.isArray(existing.mod_files))throw Error('Nexus file inventory unavailable');
 if(!p.fileId){if(p.version!=='1.0'||existing.mod_files.length)throw Error('First-file creation requires v1.0 and an empty Nexus page. Existing files need an explicit permanent mapping.');}
 else{if(!existing.mod_files.some(f=>String(f.id)===p.fileId))throw Error('Saved Nexus file does not belong to the registered mod page');const versions=await api(`/mod-files/${id(p.fileId)}/versions`);if(!Array.isArray(versions.versions)||versions.versions.some(v=>v.version.replace(/^v/,'')===p.version))throw Error('Nexus version exists or inventory is ambiguous. No duplicate will be created.');}
 // Persist a fail-closed attempt marker before ANY Nexus mutation. A lost response must not create a second chain.
 await checkpoint();
 const upload=await api('/uploads/multipart','POST',{filename:p.filename,size_bytes:String(p.bytes.length)});
 if(!Array.isArray(upload.part_presigned_urls)||!Number.isSafeInteger(Number(upload.part_size_bytes))||Number(upload.part_size_bytes)<=0||Math.ceil(p.bytes.length/Number(upload.part_size_bytes))!==upload.part_presigned_urls.length)throw Error('Unexpected multipart upload response');
 const external=async(url,options)=>{if(new URL(url).protocol!=='https:')throw Error('Unsafe upload destination');const r=await fetcher(url,{...options,signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error(`Nexus archive transfer HTTP ${r.status}`);return r;};
 const parts=[];for(let n=0;n<upload.part_presigned_urls.length;n++){const bytes=p.bytes.subarray(n*Number(upload.part_size_bytes),(n+1)*Number(upload.part_size_bytes));const r=await external(upload.part_presigned_urls[n],{method:'PUT',body:bytes,headers:{'Content-Type':'application/octet-stream'}});const etag=r.headers.get('etag')?.replace(/"/g,'');if(!etag||!/^[-\w]+$/.test(etag))throw Error('Upload part confirmation missing');parts.push(`<Part><PartNumber>${n+1}</PartNumber><ETag>${etag}</ETag></Part>`);}
 const completed=await external(upload.complete_presigned_url,{method:'POST',headers:{'Content-Type':'application/xml'},body:`<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`});if((await completed.text()).includes('<Error>'))throw Error('Multipart completion returned an error');
 await api(`/uploads/${id(upload.id)}/finalise`,'POST');let available=false;for(let n=0;n<60;n++){if((await api(`/uploads/${id(upload.id)}`)).state==='available'){available=true;break;}await wait(2000);}if(!available)throw Error('Nexus upload processing is still pending. Inspect before retrying.');
 const body={upload_id:upload.id,name:p.displayName,version:p.version,description:p.description,file_category:'main',primary_mod_manager_download:true,allow_mod_manager_download:true,show_requirements_pop_up:false,update_mod_version:true};
 let fileId=p.fileId,versionId;
 if(!fileId){const first=await api('/mod-files','POST',{...body,mod_id:globalId});fileId=id(first.id);const versions=await api(`/mod-files/${fileId}/versions`);const matching=versions.versions?.filter(v=>v.version.replace(/^v/,'')===p.version);if(matching?.length!==1)throw Error('First Nexus file created but version confirmation is ambiguous. Inspect before retrying.');versionId=id(matching[0].id);}
 else{const next=await api(`/mod-files/${id(fileId)}/versions`,'POST',{...body,archive_existing_file:p.archiveExisting});if(String(next.file?.id)!==fileId)throw Error('Nexus returned a different file chain');versionId=id(next.version?.id);}
 const result={fileId,versionId,modId:p.modId,version:p.version,requestId:p.requestId,playerSha256:createHash('sha256').update(p.bytes).digest('hex')};
 // File publication already succeeded; a changelog failure must not cause a duplicate upload retry.
 if(p.changelog)try{await api(`/mods/${globalId}/changelogs`,'POST',{version:p.version,changelog:p.changelog});}catch{result.warning='File uploaded; changelog needs manual follow-up.';log('service=nexus operation=changelog status=Warning');}
 return result;
}
async function main(){
 const p={apiKey:process.env.NEXUSMODS_API_KEY,modId:process.env.MOD_ID||'',fileId:process.env.FILE_ID||'',filename:process.env.ZIP_NAME||'',version:process.env.MOD_VERSION||'',displayName:process.env.DISPLAY_NAME||'',description:process.env.DESCRIPTION||'',changelog:process.env.CHANGELOG||'',archiveExisting:process.env.ARCHIVE_EXISTING==='true',requestId:process.env.REQUEST_ID||''};
 if(!p.apiKey||!/^\d+$/.test(p.modId)||!/^\d+\.0$/.test(p.version)||!/^[a-f0-9-]{36}$/.test(p.requestId)||!/^v[1-9]\d*\.0$/.test(process.env.RELEASE_TAG||'')||!/^[A-Za-z0-9_. -]+\.zip$/.test(p.filename)||p.filename.startsWith('-'))throw Error('Invalid approved release inputs');
 const repo=process.env.GITHUB_REPOSITORY,tag=process.env.RELEASE_TAG,gh=args=>execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const release=JSON.parse(gh(['release','view',tag,'--repo',repo,'--json','body,isDraft,assets']));if(release.isDraft||!release.body.includes('nova-release:'+p.requestId))throw Error('Expected an approved public GitHub release');
 const marker=`nexus-attempt-${p.requestId}.json`,receipt=`nexus-result-${p.requestId}.json`;
 if(release.assets.some(a=>a.name===receipt)){gh(['release','download',tag,'--repo',repo,'--pattern',receipt]);writeFileSync('nexus-result.json',readFileSync(receipt));return;}
 if(release.assets.some(a=>a.name===marker))throw Error('An earlier Nexus attempt may have succeeded. Inspect Nexus and recover its receipt; automatic repetition is blocked.');
 gh(['release','download',tag,'--repo',repo,'--pattern',p.filename]);p.bytes=readFileSync(p.filename);const checksum=createHash('sha256').update(p.bytes).digest('hex');if(release.body.match(/SHA-256: ([a-f0-9]{64})/)?.[1]!==checksum)throw Error('Approved player ZIP checksum mismatch');
 const result=await publishNexus(p,{checkpoint:async()=>{writeFileSync(marker,JSON.stringify({requestId:p.requestId,modId:p.modId,version:p.version,sha256:checksum}));gh(['release','upload',tag,marker,'--repo',repo]);}});
 writeFileSync('nexus-result.json',JSON.stringify(result));writeFileSync(receipt,JSON.stringify(result));gh(['release','upload',tag,receipt,'--repo',repo]);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e instanceof Error&&!('stderr' in e)?e.message:'GitHub workflow operation failed; inspect repository permissions and existing attempt.');process.exitCode=1;});
