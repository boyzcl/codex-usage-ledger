import {readdir,stat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
export async function discover(home:string):Promise<string[]>{
 const result:string[]=[];
 async function walk(dir:string,archived=false){let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw Error('rollout_directory_unreadable');}
  for(const e of entries){const p=join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())await walk(p,archived);else if(e.isFile()&&e.name.endsWith('.jsonl')&&(archived||e.name.startsWith('rollout-')))result.push(p);}
 }
 for(const name of ['sessions','archived_sessions'])await walk(join(home,name),name==='archived_sessions');return result.sort((a,b)=>a.split('/').at(-1)!.localeCompare(b.split('/').at(-1)!));
}
// Consume complete lines only. A partially written trailing line stays uncheckpointed.
export async function* lines(path:string,start:number,end:number,handle?:FileHandle):AsyncGenerator<{line:string;end:number;oversize?:boolean}>{
 const f=handle??await open(path,'r');let pos=start,carry=Buffer.alloc(0),discard=false;const max=32*1024*1024;
 try{while(pos<end){const buf=Buffer.allocUnsafe(Math.min(1024*1024,end-pos));const {bytesRead}=await f.read(buf,0,buf.length,pos);if(!bytesRead)break;pos+=bytesRead;
  const all=carry.length?Buffer.concat([carry,buf.subarray(0,bytesRead)]):buf.subarray(0,bytesRead);let from=0;
  for(let n=all.indexOf(10);n>=0;n=all.indexOf(10,from)){
   const part=all.subarray(from,n);yield {line:discard||part.length>max?'':part.toString('utf8'),end:pos-(all.length-n-1),oversize:discard||part.length>max};discard=false;from=n+1;
  }
  carry=Buffer.from(all.subarray(from));if(carry.length>max){carry=Buffer.alloc(0);discard=true;}
 }}finally{if(!handle)await f.close();}
}
export {stat};

// Hash all bytes, including unprojected records, without retaining their content.
export async function digests(f:FileHandle,end:number,prefix:number){
 const full=createHash('sha256'),consumed=createHash('sha256');let pos=0;
 while(pos<end){const buf=Buffer.allocUnsafe(Math.min(1024*1024,end-pos));const {bytesRead}=await f.read(buf,0,buf.length,pos);if(!bytesRead)throw Error('source_changed_during_read');
  const chunk=buf.subarray(0,bytesRead);full.update(chunk);if(pos<prefix)consumed.update(chunk.subarray(0,Math.min(bytesRead,prefix-pos)));pos+=bytesRead;
 }
 return {full:full.digest('hex'),prefix:consumed.digest('hex'),bytes:pos};
}
