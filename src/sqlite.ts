// Silence only Node's known SQLite experimental notice during module initialization.
// All other warnings and all SQLite exceptions retain their normal behavior.
const original=process.emitWarning;
let sqlite:typeof import('node:sqlite');
try {
 process.emitWarning=((...args:any[])=>{
  const warning=args[0],kind=typeof args[1]==='string'?args[1]:args[1]?.type;
  const message=warning instanceof Error?warning.message:warning;
  const type=warning instanceof Error?warning.name:kind;
  if(type==='ExperimentalWarning'&&message==='SQLite is an experimental feature and might change at any time')return;
  Reflect.apply(original,process,args);
 }) as typeof process.emitWarning;
 sqlite=await import('node:sqlite');
}finally{process.emitWarning=original;}
export const DatabaseSync=sqlite.DatabaseSync;
export type DatabaseSync=import('node:sqlite').DatabaseSync;

export const backup=sqlite.backup;
