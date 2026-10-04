import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {backup,requireBackupSupport} from '../src/sqlite.js';
import {consistentBackup,repairPreview} from '../src/repair.js';
import {Ledger} from '../src/store.js';
import {formatError} from '../src/display.js';
test('R1 repair capability is checked before any output mutation; normal query remains available',async()=>{
 if(typeof backup==='function'){assert.doesNotThrow(requireBackupSupport);return;}
 const dir=mkdtempSync(join(tmpdir(),'cux-runtime-'));try{
  const home=join(dir,'source'),data=join(dir,'data');mkdirSync(home);mkdirSync(data);
  writeFileSync(join(data,'config.json'),JSON.stringify({codex_home:home,timezone:'UTC',poll_seconds:60,estimator:{weight_basis:'verified',bucket_models:{}}}));
  const input=join(data,'usage.db'),db=new Ledger(input);db.close();const original=readFileSync(input);
  const output=join(dir,'rollback.db'),outDir=join(dir,'uncreated-parent','preview');
  assert.throws(requireBackupSupport,/^Error: sqlite_backup_unavailable$/);
  await assert.rejects(consistentBackup(input,output),/^Error: sqlite_backup_unavailable$/);
  await assert.rejects(repairPreview(input,home,outDir),/^Error: sqlite_backup_unavailable$/);
  assert.equal(existsSync(output),false);assert.equal(existsSync(join(dir,'uncreated-parent')),false);assert.deepEqual(readFileSync(input),original);
  const run=(args:string[])=>spawnSync(process.execPath,[new URL('../src/cli.js',import.meta.url).pathname,...args],{encoding:'utf8'});
  for(const args of [
   ['repair-preview','--input',input,'--codex-home',home,'--out-dir',outDir],
   ['repair-rollback','--input',input,'--out',output]
  ]){const result=run([...args,'--json']);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.deepEqual(JSON.parse(result.stderr),{error:'sqlite_backup_unavailable'});}
  assert.equal(existsSync(output),false);assert.equal(existsSync(join(dir,'uncreated-parent')),false);assert.deepEqual(readFileSync(input),original);
  const normal=run(['models','--json','--data-home',data]);assert.equal(normal.status,0,normal.stderr);assert.equal(JSON.parse(normal.stdout).totals.records,0);
  assert.match(formatError('sqlite_backup_unavailable'),/22\.16\.0/);assert.match(formatError('sqlite_backup_unavailable'),/未创建输出/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
