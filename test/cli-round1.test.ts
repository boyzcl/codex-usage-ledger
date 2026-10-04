import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/store.js';
import {initialState,parseLine} from '../src/parser.js';
import {localDay} from '../src/report.js';
test('R1 actual CLI hides empirical defaults and preserves strict reasons in explicit experiments',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cux-cli-round1-'));try{
 const data=join(dir,'data'),home=join(dir,'source');mkdirSync(data);mkdirSync(home);writeFileSync(join(data,'config.json'),JSON.stringify({codex_home:home,timezone:'UTC',poll_seconds:60,codex_binary:'/nonexistent',estimator:{weight_basis:'verified',bucket_models:{}}}));
 const now=Date.now(),time=(mins:number)=>new Date(now+mins*60000).toISOString(),reset=Math.floor(now/1000)+3600;
 const db=new Ledger(join(data,'usage.db'));db.insertUsage(parseLine(JSON.stringify({timestamp:time(-30),type:'token_usage_record',payload:{response_id:'synthetic',usage:{input_tokens:100,output_tokens:0,total_tokens:100}}}),initialState()).usage[0]);
 for(const [mins,percent] of [[-40,10],[-20,20]])db.insertQuota({id:time(mins),timestamp:time(mins),limit_id:'codex',slot:'primary',window_duration_mins:10080,resets_at:reset,used_percent:percent,source:'app_server',raw_json:'{}'});
 db.set('latest_estimates',[{limit_id:'codex',slot:'primary',window_duration_mins:10080,resets_at:reset,reason:'unknown_bucket_model_mapping',estimated_capacity:null}]);db.close();
 const run=(args:string[])=>JSON.parse(execFileSync(process.execPath,[new URL('../src/cli.js',import.meta.url).pathname,...args,'--json','--data-home',data],{encoding:'utf8'}));
 const normal=run(['status']);assert.equal(normal.capacity[0].status,'unverified');assert.ok(normal.capacity[0].source);assert.ok(normal.capacity[0].limitations.length);assert.equal(normal.capacity[0].empirical,null);assert.equal(normal.capacity[0].estimated_capacity,null);assert.equal(normal.capacity[0].strict_reason,'unknown_bucket_model_mapping');
 const experimental=run(['status','--experimental-empirical']);assert.equal(experimental.capacity[0].status,'experimental_unverified');assert.equal(experimental.capacity[0].empirical.status,'experimental_unverified');assert.equal(experimental.capacity[0].empirical.estimated_tokens,1000);assert.equal(experimental.capacity[0].strict_reason,'unknown_bucket_model_mapping');
 const args=['report','--from',localDay(time(-40),'UTC'),'--to',localDay(time(0),'UTC')];const report=run(args);assert.ok(report.plan_cycles.every((p:any)=>p.estimated_tokens===null&&p.status==='unverified'&&p.source&&p.limitations.length));
 const example=run([...args,'--experimental-empirical']);assert.equal(example.plan_cycles[0].estimated_tokens,1000);assert.equal(example.plan_cycles[0].strict_reason,'unverified_account_window_attribution');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('CLI help exposes the conflict and preserved-estimate audit exports',()=>{
 const help=execFileSync(process.execPath,[new URL('../src/cli.js',import.meta.url).pathname,'--help'],{encoding:'utf8'});
 assert.match(help,/conflicts/);assert.match(help,/estimate-history/);
});
